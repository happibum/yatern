(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.YAtern = f()}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
'use strict';

var util = require('util');

function getNodeList(ast, startNum) {
    var nodeList = [];

    var num = startNum === undefined ? 0 : startNum;

    function assignId(node) {
        node['@label'] = num;
        nodeList.push(node);
        num++;
    }

    // Label every AST node with property 'type'
    function labelNodeWithType(node) {
        if (node && node.hasOwnProperty('type')) {
            assignId(node);
        }
        if (node && typeof node === 'object') {
            for (var p in node) {
                labelNodeWithType(node[p]);
            }
        }
    }

    labelNodeWithType(ast);

    return nodeList;
}

function showUnfolded(obj) {
    console.log(util.inspect(obj, { depth: null }));
}

exports.getNodeList = getNodeList;
exports.showUnfolded = showUnfolded;

},{"util":20}],2:[function(require,module,exports){
'use strict';

var types = require('../domains/types');
var walk = require('acorn/dist/walk');
var status = require('../domains/status');
var cstr = require('./constraints');

// arguments are " oldStatus (, name, val)* "
function changedStatus(oldStatus) {
    var newStatus = new status.Status();
    for (var i = 1; i < arguments.length; i = i + 2) {
        newStatus[arguments[i]] = arguments[i + 1];
    }for (var p in oldStatus) {
        if (newStatus[p] === undefined) newStatus[p] = oldStatus[p];
    }
    return newStatus;
}

// returns [access type, prop value]
function propAccess(node) {
    var prop = node.property;
    if (!node.computed) {
        return ['dotAccess', prop.name];
    }
    if (prop.type === 'Literal') {
        if (typeof prop.value === 'string') return ['stringLiteral', prop.value];
        if (typeof prop.value === 'number')
            // convert number to string
            return ['numberLiteral', prop.value + ''];
    }
    return ["computed", null];
}

function unopResultType(op) {
    switch (op) {
        case '+':case '-':case '~':
            return types.PrimNumber;
        case '!':
            return types.PrimBoolean;
        case 'typeof':
            return types.PrimString;
        case 'void':case 'delete':
            return null;
    }
}

function binopIsBoolean(op) {
    switch (op) {
        case '==':case '!=':case '===':case '!==':
        case '<':case '>':case '>=':case '<=':
        case 'in':case 'instanceof':
            return true;
    }
    return false;
}

// To prevent recursion,
// we remember the status used in addConstraints
var visitedStatus = [];
var constraints = [];
function clearConstraints() {
    visitedStatus.length = 0;
    constraints.length = 0;
}

var rtCX = undefined;
function addConstraints(ast, initStatus, newRtCX) {

    // set rtCX
    rtCX = newRtCX || rtCX;
    var Ĉ = rtCX.Ĉ;

    // Check whether we have processed 'initStatus' before
    for (var i = 0; i < visitedStatus.length; i++) {
        if (initStatus.equals(visitedStatus[i])) {
            // If so, do nothing
            // signifying we didn't add constraints
            return false;
        }
    }
    // If the initStatus is new, push it.
    // We do not record ast since ast node depends on the status
    visitedStatus.push(initStatus);

    function readMember(node, curStatus, c) {
        var ret = Ĉ.get(node, curStatus.delta);
        var objAVal = c(node.object, curStatus, undefined);
        if (node.property.type !== 'Identifier') {
            // return from property is ignored
            c(node.property, curStatus, undefined);
        }

        var _propAccess = propAccess(node);

        var propName = _propAccess[1];

        constraints.push({ OBJ: objAVal,
            PROP: propName,
            READ_TO: ret });
        objAVal.propagate(new cstr.ReadProp(propName, ret));

        // returns AVal for receiver and read member
        return [objAVal, ret];
    }

    // constraint generating walker for expressions
    var constraintGenerator = walk.make({

        Identifier: function Identifier(node, curStatus, c) {
            var av = curStatus.sc.getAValOf(node.name);
            // use aval in the scope
            Ĉ.set(node, curStatus.delta, av);
            return av;
        },

        ThisExpression: function ThisExpression(node, curStatus, c) {
            var av = curStatus.self;
            // use aval for 'this'
            Ĉ.set(node, curStatus.delta, av);
            return av;
        },

        Literal: function Literal(node, curStatus, c) {
            var res = Ĉ.get(node, curStatus.delta);
            if (node.regex) {
                // not implemented yet
                // throw new Error('regex literal is not implemented yet');
                return res;
            }
            switch (typeof node.value) {
                case 'number':
                    constraints.push({ TYPE: types.PrimNumber,
                        INCL_SET: res });
                    res.addType(types.PrimNumber);
                    break;
                case 'string':
                    constraints.push({ TYPE: types.PrimString,
                        INCL_SET: res });
                    res.addType(types.PrimString);
                    break;
                case 'boolean':
                    constraints.push({ TYPE: types.PrimBoolean,
                        INCL_SET: res });
                    res.addType(types.PrimBoolean);
                    break;
                case 'object':
                    // I guess: Literal && object ==> node.value == null
                    // null is ignored, so nothing to add
                    break;
                case 'function':
                    throw new Error('I guess function is impossible here.');
            }
            return res;
        },

        AssignmentExpression: function AssignmentExpression(node, curStatus, c) {
            var rhsAVal = c(node.right, curStatus, undefined);
            if (node.left.type === 'Identifier') {
                // LHS is a simple variable.
                var varName = node.left.name;
                var lhsAVal = curStatus.sc.getAValOf(varName);
                // lhs is not visited. Need to handle here.
                // Use aval found in the scope for lhs
                Ĉ.set(node.left, curStatus.delta, lhsAVal);

                if (node.operator === '=') {
                    // simple assignment
                    constraints.push({
                        FROM: rhsAVal,
                        TO: lhsAVal
                    });
                    rhsAVal.propagate(lhsAVal);
                    // node's AVal from RHS
                    Ĉ.set(node, curStatus.delta, rhsAVal);
                    return rhsAVal;
                }
                // updating assignment
                var resAVal = Ĉ.get(node, curStatus.delta);
                if (node.operator === '+=') {
                    // concatenating update
                    constraints.push({
                        ADD_OPRD1: lhsAVal,
                        ADD_OPRD2: rhsAVal,
                        RESULT: resAVal
                    });
                    lhsAVal.propagate(new cstr.IsAdded(rhsAVal, resAVal));
                    rhsAVal.propagate(new cstr.IsAdded(lhsAVal, resAVal));
                } else {
                    // arithmetic update
                    constraints.push({
                        TYPE: types.PrimNumber,
                        INCL_SET: resAVal
                    });
                    resAVal.addType(types.PrimNumber);
                }
                return resAVal;
            } else if (node.left.type === 'MemberExpression') {
                var objAVal = c(node.left.object, curStatus, undefined);

                var _propAccess2 = propAccess(node.left);

                var accType = _propAccess2[0];
                var propName = _propAccess2[1];

                if (node.operator === '=') {
                    // assignment to member
                    constraints.push({
                        OBJ: objAVal,
                        PROP: propName,
                        WRITE_WITH: rhsAVal
                    });
                    objAVal.propagate(new cstr.WriteProp(propName, rhsAVal));
                    // if property is number literal, also write to 'unknown'
                    if (accType === 'numberLiteral') {
                        objAVal.propagate(new cstr.WriteProp(null, rhsAVal));
                    }
                    // node's AVal from RHS
                    Ĉ.set(node, curStatus.delta, rhsAVal);
                    return rhsAVal;
                }
                // updating assignment
                var resAVal = Ĉ.get(node, curStatus.delta);

                var _readMember = readMember(node.left, curStatus, c);

                var retAVal = _readMember[1];

                if (node.operator === '+=') {
                    // concatenating update
                    constraints.push({
                        ADD_OPRD1: retAVal,
                        ADD_OPRD2: rhsAVal,
                        RESULT: resAVal
                    });
                    retAVal.propagate(new cstr.IsAdded(rhsAVal, resAVal));
                    rhsAVal.propagate(new cstr.IsAdded(retAVal, resAVal));
                } else {
                    // arithmetic update
                    constraints.push({
                        TYPE: types.PrimNumber,
                        INCL_SET: resAVal
                    });
                    resAVal.addType(types.PrimNumber);
                }
                return resAVal;
            } else {
                console.info('Assignment using pattern is not implemented');
            }
        },

        VariableDeclaration: function VariableDeclaration(node, curStatus, c) {
            for (var i = 0; i < node.declarations.length; i++) {
                var decl = node.declarations[i];
                var lhsAVal = curStatus.sc.getAValOf(decl.id.name);
                // declared var node is 'id'
                Ĉ.set(decl.id, curStatus.delta, lhsAVal);
                if (decl.init) {
                    var rhsAVal = c(decl.init, curStatus, undefined);
                    Ĉ.set(decl.init, curStatus.delta, rhsAVal);
                    constraints.push({ FROM: rhsAVal,
                        TO: lhsAVal });
                    rhsAVal.propagate(lhsAVal);
                }
            }
        },

        LogicalExpression: function LogicalExpression(node, curStatus, c) {
            var res = Ĉ.get(node, curStatus.delta);
            var left = c(node.left, curStatus, undefined);
            var right = c(node.right, curStatus, undefined);
            constraints.push({ FROM: left, TO: res }, { FROM: right, TO: res });
            left.propagate(res);
            right.propagate(res);
            return res;
        },

        ConditionalExpression: function ConditionalExpression(node, curStatus, c) {
            var res = Ĉ.get(node, curStatus.delta);
            c(node.test, curStatus, undefined);
            var cons = c(node.consequent, curStatus, undefined);
            var alt = c(node.alternate, curStatus, undefined);
            constraints.push({ FROM: cons, TO: res }, { FROM: alt, TO: res });
            cons.propagate(res);
            alt.propagate(res);
            return res;
        },

        NewExpression: function NewExpression(node, curStatus, c) {
            var ret = Ĉ.get(node, curStatus.delta);
            var callee = c(node.callee, curStatus, undefined);
            var args = [];
            for (var i = 0; i < node.arguments.length; i++) {
                args.push(c(node.arguments[i], curStatus, undefined));
            }
            var newDelta = curStatus.delta.appendOne(node['@label']);
            constraints.push({ CONSTRUCTOR: callee,
                ARGS: args,
                RET: ret,
                EXC: curStatus.exc,
                DELTA: newDelta });
            callee.propagate(new cstr.IsCtor(args, ret, curStatus.exc, newDelta));
            return ret;
        },

        ArrayExpression: function ArrayExpression(node, curStatus, c) {
            var ret = Ĉ.get(node, curStatus.delta);
            // NOTE prototype object is not recorded in Ĉ
            var arrType = new types.ArrType(new types.AVal(rtCX.protos.Array));
            // add length property
            arrType.getProp('length').addType(types.PrimNumber);

            constraints.push({ TYPE: arrType, INCL_SET: ret });
            ret.addType(arrType);

            // add array elements
            for (var i = 0; i < node.elements.length; i++) {
                var eltAVal = c(node.elements[i], curStatus, undefined);

                var prop = i + '';
                constraints.push({ OBJ: ret, PROP: prop, AVAL: eltAVal });
                constraints.push({ OBJ: ret, PROP: null, AVAL: eltAVal });
                ret.propagate(new cstr.WriteProp(prop, eltAVal));
                ret.propagate(new cstr.WriteProp(null, eltAVal));
            }
            return ret;
        },

        ObjectExpression: function ObjectExpression(node, curStatus, c) {
            var ret = Ĉ.get(node, curStatus.delta);
            // NOTE prototype object is not recorded in Ĉ
            var objType = new types.ObjType(new types.AVal(rtCX.protos.Object));
            constraints.push({ TYPE: objType, INCL_SET: ret });
            ret.addType(objType);

            for (var i = 0; i < node.properties.length; i++) {
                var propPair = node.properties[i];
                var propKey = propPair.key;
                var _name = undefined;
                var propExpr = propPair.value;

                var fldAVal = c(propExpr, curStatus, undefined);

                if (propKey.type === 'Identifier') {
                    _name = propKey.name;
                } else if (typeof propKey.value === 'string') {
                    _name = propKey.value;
                } else if (typeof propKey.value === 'number') {
                    // convert number to string
                    _name = propKey.value + '';
                }
                constraints.push({ OBJ: ret, PROP: _name, AVAL: fldAVal });
                ret.propagate(new cstr.WriteProp(_name, fldAVal));
            }
            return ret;
        },

        FunctionExpression: function FunctionExpression(node, curStatus, c) {
            if (!node.fnInstances) {
                node.fnInstances = [];
            }
            var fnInstance = null;
            node.fnInstances.forEach(function (fnType) {
                if (fnType.sc === curStatus.sc) {
                    fnInstance = fnType;
                }
            });
            if (!fnInstance) {
                // NOTE prototype object is not recorded in Ĉ
                fnInstance = new types.FnType(new types.AVal(rtCX.protos.Function), '[anonymous function]', node.body['@block'].getParamVarNames(), curStatus.sc, node, rtCX.protos.Object);
                node.fnInstances.push(fnInstance);
                // NOTE prototype object is not recorded in Ĉ
                var prototypeObject = new types.ObjType(new types.AVal(rtCX.protos.Object), '?.prototype');
                // For .prototype
                var prototypeProp = fnInstance.getProp('prototype');
                constraints.push({ TYPE: prototypeObject,
                    INCL_SET: prototypeProp });
                prototypeProp.addType(prototypeObject);
                // For .prototype.constructor
                var constructorProp = prototypeObject.getProp('constructor');
                constraints.push({ TYPE: fnInstance,
                    INCL_SET: constructorProp });
                constructorProp.addType(fnInstance);
            }
            var ret = Ĉ.get(node, curStatus.delta);
            constraints.push({ TYPE: fnInstance,
                INCL_SET: ret });
            ret.addType(fnInstance);
            return ret;
        },

        FunctionDeclaration: function FunctionDeclaration(node, curStatus, c) {
            // Drop initial catch scopes
            var sc0 = curStatus.sc.removeInitialCatchBlocks();
            if (!node.fnInstances) {
                node.fnInstances = [];
            }
            var fnInstance = null;
            node.fnInstances.forEach(function (fnType) {
                if (fnType.sc === sc0) {
                    fnInstance = fnType;
                }
            });
            if (!fnInstance) {
                // NOTE prototype object is not recorded in Ĉ
                fnInstance = new types.FnType(new types.AVal(rtCX.protos.Function), node.id.name, node.body['@block'].getParamVarNames(), sc0, node, rtCX.protos.Object);
                node.fnInstances.push(fnInstance);
                // for each fnInstance, assign one prototype object
                // NOTE prototype object is not recorded in Ĉ
                var prototypeObject = new types.ObjType(new types.AVal(rtCX.protos.Object), node.id.name + '.prototype');
                // For .prototype
                var prototypeProp = fnInstance.getProp('prototype');
                constraints.push({ TYPE: prototypeObject,
                    INCL_SET: prototypeProp });
                prototypeProp.addType(prototypeObject);
                // For .prototype.constructor
                var constructorProp = prototypeObject.getProp('constructor');
                constraints.push({ TYPE: fnInstance,
                    INCL_SET: constructorProp });
                constructorProp.addType(fnInstance);
            }
            var lhsAVal = sc0.getAValOf(node.id.name);
            constraints.push({ TYPE: fnInstance,
                INCL_SET: lhsAVal });
            lhsAVal.addType(fnInstance);
            // nothing to return
            return types.AValNull;
        },

        SequenceExpression: function SequenceExpression(node, curStatus, c) {
            var lastIndex = node.expressions.length - 1;
            for (var i = 0; i < lastIndex; i++) {
                c(node.expressions[i], curStatus, undefined);
            }
            var lastAVal = c(node.expressions[lastIndex], curStatus, undefined);
            Ĉ.set(node, curStatus.delta, lastAVal);
            return lastAVal;
        },

        UnaryExpression: function UnaryExpression(node, curStatus, c) {
            c(node.argument, curStatus, undefined);
            var res = Ĉ.get(node, curStatus.delta);
            var type = unopResultType(node.operator);
            if (type) {
                constraints.push({ TYPE: type,
                    INCL_SET: res });
                res.addType(type);
            }
            return res;
        },

        UpdateExpression: function UpdateExpression(node, curStatus, c) {
            c(node.argument, curStatus, undefined);
            var res = Ĉ.get(node, curStatus.delta);
            constraints.push({ TYPE: types.PrimNumber,
                INCL_SET: res });
            res.addType(types.PrimNumber);
            // We ignore the effect of updating to number type
            return res;
        },

        BinaryExpression: function BinaryExpression(node, curStatus, c) {
            var lOprd = c(node.left, curStatus, undefined);
            var rOprd = c(node.right, curStatus, undefined);
            var res = Ĉ.get(node, curStatus.delta);

            if (node.operator == '+') {
                constraints.push({ ADD_OPRD1: lOprd,
                    ADD_OPRD2: rOprd,
                    RESULT: res });
                lOprd.propagate(new cstr.IsAdded(rOprd, res));
                rOprd.propagate(new cstr.IsAdded(lOprd, res));
            } else {
                if (binopIsBoolean(node.operator)) {
                    constraints.push({ TYPE: types.PrimBoolean,
                        INCL_SET: res });
                    res.addType(types.PrimBoolean);
                } else {
                    constraints.push({ TYPE: types.PrimNumber,
                        INCL_SET: res });
                    res.addType(types.PrimNumber);
                }
            }
            return res;
        },

        TryStatement: function TryStatement(node, curStatus, c) {
            // construct scope chain for catch block
            var catchBlockSC = node.handler.body['@block'].getScopeInstance(curStatus.sc, curStatus.delta);
            // get the AVal for exception parameter
            var excAVal = catchBlockSC.getAValOf(node.handler.param.name);

            // for try block
            var tryStatus = changedStatus(curStatus, 'exc', excAVal);
            c(node.block, tryStatus, undefined);

            // for catch block
            var catchStatus = changedStatus(curStatus, 'sc', catchBlockSC);
            c(node.handler.body, catchStatus, undefined);

            // for finally block
            if (node.finalizer !== null) c(node.finalizer, curStatus, undefined);
        },

        ThrowStatement: function ThrowStatement(node, curStatus, c) {
            var thr = c(node.argument, curStatus, undefined);
            constraints.push({ FROM: thr,
                TO: curStatus.exc });
            thr.propagate(curStatus.exc);
        },

        CallExpression: function CallExpression(node, curStatus, c) {
            var resAVal = Ĉ.get(node, curStatus.delta);
            var argAVals = [];

            // get AVals for each arguments
            for (var i = 0; i < node.arguments.length; i++) {
                argAVals.push(c(node.arguments[i], curStatus, undefined));
            }
            // append current call site to the context
            var newDelta = curStatus.delta.appendOne(node['@label']);

            if (node.callee.type === 'MemberExpression') {
                // method call
                // var recv = c(node.callee.object, curStatus, undefined);
                // var methodName = immedProp(node.callee);
                // constraints.push({
                //   RECV: recv,
                //   PROPNAME: methodName,
                //   PARAMS: argAVals,
                //   RET: resAVal,
                //   EXC: curStatus.exc,
                //   DELTA: newDelta

                var _readMember2 = readMember(node.callee, curStatus, c);

                var recvAVal = _readMember2[0];
                var retAVal = _readMember2[1];

                retAVal.propagate(new cstr.IsCallee(recvAVal, argAVals, resAVal, curStatus.exc, newDelta));
            } else {
                // normal function call
                var calleeAVal = c(node.callee, curStatus, undefined);
                // callee의 return을 call expression으로
                // callee의 exception을 호출 측의 exception에 전달해야
                constraints.push({
                    CALLEE: calleeAVal,
                    SELF: rtCX.globalObject,
                    PARAMS: argAVals,
                    RET: resAVal,
                    EXC: curStatus.exc,
                    DELTA: newDelta
                });
                calleeAVal.propagate(new cstr.IsCallee(new types.AVal(rtCX.globalObject), argAVals, resAVal, curStatus.exc, newDelta));
            }
            return resAVal;
        },

        MemberExpression: function MemberExpression(node, curStatus, c) {
            var _readMember3 = readMember(node, curStatus, c);

            var retAVal = _readMember3[1];

            return retAVal;
        },

        ReturnStatement: function ReturnStatement(node, curStatus, c) {
            if (!node.argument) return;
            var ret = c(node.argument, curStatus, undefined);
            constraints.push({ FROM: ret,
                TO: curStatus.ret });
            ret.propagate(curStatus.ret);
        }
    });

    recursiveWithReturn(ast, initStatus, constraintGenerator);

    // We actually added constraints
    return true;
}

function recursiveWithReturn(node, state, visitor) {
    function c(node, st, override) {
        return visitor[override || node.type](node, st, c);
    }
    return c(node, state);
}

exports.constraints = constraints;
exports.addConstraints = addConstraints;
exports.clearConstraints = clearConstraints;
// });

},{"../domains/status":5,"../domains/types":6,"./constraints":3,"acorn/dist/walk":16}],3:[function(require,module,exports){
'use strict';

var types = require('../domains/types');
var status = require('../domains/status');
var cGen = require('./cGen');

function CSTR() {}
CSTR.prototype = Object.create(null);
CSTR.prototype.equals = function (other) {
    return this === other;
};

function ReadProp(prop, to) {
    this.prop = prop;
    this.to = to;
}
ReadProp.prototype = Object.create(CSTR.prototype);
ReadProp.prototype.addType = function (obj) {
    if (!(obj instanceof types.ObjType)) return;
    // when obj is ObjType,
    var ownProp = obj.getProp(this.prop, true);
    if (ownProp) {
        // when the object has the prop,
        ownProp.propagate(this.to);
    } else if (obj.getProp('__proto__', true)) {
        // use prototype chain
        obj.getProp('__proto__').propagate(new ReadProp(this.prop, this.to));
    }
};
ReadProp.prototype.equals = function (other) {
    if (!(other instanceof ReadProp)) return false;
    return this.prop === other.prop && this.to.equals(other.to);
};

function WriteProp(prop, from) {
    this.prop = prop;
    this.from = from;
}
WriteProp.prototype = Object.create(CSTR.prototype);
WriteProp.prototype.addType = function (obj) {
    if (!(obj instanceof types.ObjType)) return;
    var ownProp = obj.getProp(this.prop);
    this.from.propagate(ownProp);
};

function IsAdded(other, target) {
    this.other = other;
    this.target = target;
}
IsAdded.prototype = Object.create(CSTR.prototype);
IsAdded.prototype.addType = function (type) {
    if ((type === types.PrimNumber || type === types.PrimBoolean) && (this.other.hasType(types.PrimNumber) || this.other.hasType(types.PrimBoolean))) {
        this.target.addType(types.PrimNumber);
    }
    if (type === types.PrimString && !this.other.isEmpty()) {
        this.target.addType(types.PrimString);
    }
};

function IsCallee(self, args, ret, exc, delta) {
    this.self = self;
    this.args = args;
    this.ret = ret;
    this.exc = exc;
    this.delta = delta;
}
IsCallee.prototype = Object.create(CSTR.prototype);
IsCallee.prototype.addType = function (f) {
    if (!(f instanceof types.FnType)) return;
    var funEnv = f.getFunEnv(this.delta);
    var newSC = f.originNode.body['@block'].getScopeInstance(f.sc, this.delta);
    var funStatus = new status.Status(funEnv[0], funEnv[1], funEnv[2], this.delta, newSC);
    // pass this object
    this.self.propagate(funEnv[0]);

    var minLen = Math.min(this.args.length, f.paramNames.length);
    for (var i = 0; i < minLen; i++) {
        this.args[i].propagate(newSC.getAValOf(f.paramNames[i]));
    }

    // for arguments object
    if (f.originNode.body['@block'].useArgumentsObject) {
        var argObj = f.getArgumentsObject(this.delta);
        newSC.getAValOf('arguments').addType(argObj);
        for (var i = 0; i < this.args.length; i++) {
            this.args[i].propagate(argObj.getProp(i + ''));
            this.args[i].propagate(argObj.getProp(null));
        }
        argObj.getProp('callee').addType(f);
        argObj.getProp('length').addType(types.PrimNumber);
    }

    // constraint generation for the function body
    cGen.addConstraints(f.originNode.body, funStatus);

    // get return
    funEnv[1].propagate(this.ret);
    // get exception
    funEnv[2].propagate(this.exc);
};

function IsCtor(args, ret, exc, delta) {
    this.args = args;
    this.ret = ret;
    this.exc = exc;
    this.delta = delta;
}
IsCtor.prototype = Object.create(CSTR.prototype);
IsCtor.prototype.addType = function (f) {
    if (!(f instanceof types.FnType)) return;
    var funEnv = f.getFunEnv(this.delta);
    var newSC = f.originNode.body['@block'].getScopeInstance(f.sc, this.delta);
    var funStatus = new status.Status(funEnv[0], new IfObjType(funEnv[1]), funEnv[2], this.delta, newSC);
    // pass this object
    var newObj = f.getInstance();
    funEnv[0].addType(newObj);

    var minLen = Math.min(this.args.length, f.paramNames.length);
    for (var i = 0; i < minLen; i++) {
        this.args[i].propagate(newSC.getAValOf(f.paramNames[i]));
    }

    // for arguments object
    if (f.originNode.body['@block'].useArgumentsObject) {
        var argObj = f.getArgumentsObject(this.delta);
        newSC.getAValOf('arguments').addType(argObj);
        for (var i = 0; i < this.args.length; i++) {
            this.args[i].propagate(argObj.getProp(i + ''));
            this.args[i].propagate(argObj.getProp(null));
        }
        argObj.getProp('callee').addType(f);
        argObj.getProp('length').addType(types.PrimNumber);
    }

    // constraint generation for the function body
    cGen.addConstraints(f.originNode.body, funStatus);

    // by explicit return, only ObjType are propagated
    funEnv[1].propagate(this.ret);
    // return new object
    this.ret.addType(newObj);
    // get exception
    funEnv[2].propagate(this.exc);
};

// ignore non object types
function IfObjType(aval) {
    this.aval = aval;
}
IfObjType.prototype = Object.create(CSTR.prototype);
IfObjType.prototype.addType = function (type) {
    if (!(type instanceof types.ObjType)) return;
    this.aval.addType(type);
};

exports.ReadProp = ReadProp;
exports.WriteProp = WriteProp;
exports.IsAdded = IsAdded;
exports.IsCallee = IsCallee;
exports.IsCtor = IsCtor;

},{"../domains/status":5,"../domains/types":6,"./cGen":2}],4:[function(require,module,exports){
// Context for k-CFA analysis
//
// Assume a context is an array of numbers.
// A number in such list denotes a call site, that is @label of a CallExpression.
// We keep the most recent 'k' callsites.
// Equality on contexts should look into the numbers.

"use strict";

var callSiteContextParameter = {
    // maximum length of context
    maxDepthK: 0,
    // function list for sensitive analysis
    sensFuncs: {}
};

function CallSiteContext(csList) {
    if (csList) this.csList = csList;else this.csList = [];
}

CallSiteContext.prototype.equals = function (other) {
    if (this.csList.length != other.csList.length) return false;
    for (var i = 0; i < this.csList.length; i++) {
        if (this.csList[i] !== other.csList[i]) return false;
    }
    return true;
};

CallSiteContext.prototype.appendOne = function (callSite) {
    // use concat to create a new array
    // oldest one comes first
    var appended = this.csList.concat(callSite);
    if (appended.length > callSiteContextParameter.maxDepthK) {
        appended.shift();
    }
    return new CallSiteContext(appended);
};

CallSiteContext.prototype.toString = function () {
    return this.csList.toString();
};

exports.callSiteContextParameter = callSiteContextParameter;
exports.CallSiteContext = CallSiteContext;

},{}],5:[function(require,module,exports){
// Status:
// { self  : AVal,
//   ret   : AVal,
//   exc   : AVal,
//   delta : Context,
//   sc    : ScopeChain }

"use strict";

function Status(self, ret, exc, delta, sc) {
    this.self = self;
    this.ret = ret;
    this.exc = exc;
    this.delta = delta;
    this.sc = sc;
}

Status.prototype.equals = function (other) {
    return this.self === other.self && this.ret === other.ret && this.exc === other.exc && this.delta.equals(other.delta) && this.sc === other.sc;
};

exports.Status = Status;

},{}],6:[function(require,module,exports){
'use strict';

// for DEBUG

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

var count = 0;
/**
 * the abstract value for a concrete value
 * which is a set of types.
 * @constructor
 * @param {Type} type - give a type to make AVal with a single type
 */
function AVal(type) {
    // type: contained types
    // We assume types are distinguishable by '==='
    if (type) this.types = new Set([type]);else this.types = new Set();
    // forwards: propagation targets
    // We assume targets are distinguishable by 'equals' method
    this.forwards = new Set();
    // for DEBUG
    this._id = count++;
}
/** Check whether it has any type
 * @returns {boolean}
 */
AVal.prototype.isEmpty = function () {
    return this.types.size === 0;
};

/**
 * @returns {[Type]}
 */
AVal.prototype.getTypes = function () {
    return this.types;
};

/**
 * @returns {boolean}
 */
AVal.prototype.hasType = function (type) {
    return this.types.has(type);
};

/**
 * Add a type.
 * @param {Type} type
 */
AVal.prototype.addType = function (type) {
    if (this.types.has(type)) return;
    // given type is new
    this.types.add(type);
    // send to propagation targats
    this.forwards.forEach(function (fwd) {
        fwd.addType(type);
    });
};
/**
 * @param {AVal} target
 */
AVal.prototype.propagate = function (target) {
    if (!this.addForward(target)) return;
    // target is newly added
    // send types to the new target
    this.types.forEach(function (type) {
        target.addType(type);
    });
};

AVal.prototype.addForward = function (fwd) {
    for (var _iterator = this.forwards, _isArray = Array.isArray(_iterator), _i = 0, _iterator = _isArray ? _iterator : _iterator[Symbol.iterator]();;) {
        var _ref;

        if (_isArray) {
            if (_i >= _iterator.length) break;
            _ref = _iterator[_i++];
        } else {
            _i = _iterator.next();
            if (_i.done) break;
            _ref = _i.value;
        }

        var oldFwd = _ref;

        if (fwd.equals(oldFwd)) return false;
    }
    this.forwards.add(fwd);
    return true;
};

AVal.prototype.equals = function (other) {
    // simple reference comparison
    return this === other;
};

/**
 * TODO: check whether we really need this method.
 * @param {string} prop
 * @returns {AVal}
 */
AVal.prototype.getProp = function (prop) {
    if (prop === '✖') {
        // ✖ is the bogus property name added for error recovery.
        return AValNull;
    }
    if (this.props.has(prop)) {
        return this.props.get(prop);
    } else {
        return AValNull;
    }
};

/**
 * the super class of all types
 * each type should be distinguishable by '===' operation.
 * @constructor
 */
function Type(name) {
    this.name = name;
}
Type.prototype = Object.create(null);
Type.prototype.getName = function () {
    return this.name;
};

/**
 * 1. object types
 * @param {AVal} proto - AVal of constructor's prototype
 * @param {string} name - guessed name
 */
function ObjType(proto, name) {
    this.name = name;
    this.props = new Map();

    // share proto with __proto__
    this.setProp('__proto__', proto);
}
ObjType.prototype = Object.create(Type.prototype);
/**
 * @param {string|null} prop - null for computed props
 * @param {boolean} readOnly - if false, create AVal for prop if necessary
 * @returns {AVal} AVal of the property
 */
ObjType.prototype.getProp = function (prop, readOnly) {
    if (prop === '✖') {
        // ✖ is the bogus property name added during parsing error recovery.
        return AValNull;
    }
    if (this.props.has(prop)) {
        return this.props.get(prop);
    } else if (readOnly) {
        return null;
    } else {
        var newPropAVal = new AVal();
        this.props.set(prop, newPropAVal);
        return newPropAVal;
    }
};
/**
 * We use this function to share .prototype with instances __proto__
 * It is possible to use this function to merge AVals to optimize the analyzer.
 * @param {string|null} prop - null for computed props
 * @param {AVal} aval
 */
ObjType.prototype.setProp = function (prop, aval) {
    if (prop === '✖') {
        // ✖ is the bogus property name added during parsing error recovery.
        return;
    }
    this.props.set(prop, aval);
};
/**
 * TODO: Check this function's necessity
 * @param {string} prop
 * @returns {boolean}
 */
ObjType.prototype.hasProp = function (prop) {
    if (prop === '✖') return false;
    return this.props.has(prop);
};
/**
 * TODO: Check this function's necessity
 * @param {Type} type
 * @param {string} prop
 */
ObjType.prototype.addTypeToProp = function (type, prop) {
    if (prop === '✖') return;
    if (!this.props.has(prop)) {
        this.props.set(prop, new AVal());
    }
    if (this.props.get(prop).hasType(type)) return;
    this.props.get(prop).addType(type);
};
/**
 * TODO: Check this function's necessity
 * @param {AVal} aval
 * @param {string} prop
 */
ObjType.prototype.joinAValToProp = function (aval, prop) {
    var self = this;
    aval.getTypes().forEach(function (type) {
        self.addTypeToProp(type, prop);
    });
};

// make an Obj from the global scope
function mkObjFromGlobalScope(gScope) {
    var gObj = new ObjType(AValNull, '*global scope*');
    gObj.props = gScope.varMap;
    // Override getProp method for global object
    // We ignore 'readOnly' parameter to always return its own prop AVal
    gObj.getProp = function (prop) {
        return ObjType.prototype.getProp.call(this, prop);
    };
    return gObj;
}

/**
 * 2. primitive types
 * @constructor
 * @param {string} name
 */
function PrimType(name) {
    this.name = name;
}
PrimType.prototype = Object.create(Type.prototype);

/**
 * 3. function types
 * the name is used for the type of the instances from the function
 * @constructor
 * @param {AVal} fn_proto - AVal for constructor's .prototype
 * @param {string} name - guessed name
 * @param {[string]} argNames - list of parameter names
 * @param {Scope} sc - functions scope chain, or closure
 * @param {node} originNode - AST node for the function
 * @param {Type} argProto - prototype for arguments object
 */
function FnType(fn_proto, name, argNames, sc, originNode, argProto) {
    ObjType.call(this, fn_proto, name);
    this.paramNames = argNames;
    this.sc = sc;
    this.originNode = originNode;
    this.argProto = argProto;
    // funEnv : CallContext -> [self, ret, exc]
    this.funEnv = new Map();
}
FnType.prototype = Object.create(ObjType.prototype);

/**
 * construct Status for function
 * @param {CallContext} delta - call context
 * @returns {[AVal, AVal, AVal]} - for self, return and exception AVals
 */
FnType.prototype.getFunEnv = function (delta) {
    if (this.funEnv.has(delta)) {
        return this.funEnv.get(delta);
    } else {
        var triple = [new AVal(), new AVal(), new AVal()];
        this.funEnv.set(delta, triple);
        return triple;
    }
};

FnType.prototype.getArgumentsObject = function (delta) {
    this.argObjMap = this.argObjMap || new Map();
    if (this.argObjMap.has(delta)) {
        return this.argObjMap.get(delta);
    } else {
        var argObj = new ObjType(new AVal(this.argProto), '*arguments object*');
        this.argObjMap.set(delta, argObj);
        return argObj;
    }
};

/**
 * get Object made by the function
 * TODO: use additional information to create multiple instances
 * @returns {ObjType}
 */
FnType.prototype.getInstance = function () {
    // objInstance is the object made by the functioann
    if (this.objInstance) return this.objInstance;
    // we unify constructor's .prototype and instance's __proto__
    this.objInstance = new ObjType(this.getProp('prototype'));
    return this.objInstance;
};

/** 
 * 4. array types
 * @constructor
 */
function ArrType(arr_proto) {
    ObjType.call(this, arr_proto, 'Array');
}
ArrType.prototype = Object.create(ObjType.prototype);

// Make primitive types
var PrimNumber = new PrimType('number');
var PrimString = new PrimType('string');
var PrimBoolean = new PrimType('boolean');

// AbsNull represents all empty abstract values.
var AValNull = new AVal();
// You should not add any properties to it.
AValNull.props = null;
// Adding types are ignored.
AValNull.addType = function () {};

var AbsCache = (function () {
    function AbsCache() {
        _classCallCheck(this, AbsCache);

        this.map = new Map();
    }

    // export

    /**
     * Get if one exists, if not create one
     * @param loc
     * @param ctx
     * @returns {*}
     */

    AbsCache.prototype.get = function get(loc, ctx) {
        if (!this.map.has(loc)) {
            // create inner map
            this.map.set(loc, new Map());
        }
        var mapLoc = this.map.get(loc);
        if (!mapLoc.has(ctx)) {
            var av = new AVal();
            mapLoc.set(ctx, av);
            return av;
        } else {
            return mapLoc.get(ctx);
        }
    };

    /**
     * To use av made by others (e.g. scope)
     * @param loc
     * @param ctx
     * @param av
     */

    AbsCache.prototype.set = function set(loc, ctx, av) {
        if (!this.map.has(loc)) {
            // create inner map
            this.map.set(loc, new Map());
        }
        this.map.get(loc).set(ctx, av);
    };

    /**
     * Check whether it has one for loc and ctx
     * @param loc
     * @param ctx
     * @returns {boolean}
     */

    AbsCache.prototype.has = function has(loc, ctx) {
        return this.map.has(loc) && this.map.get(loc).has(ctx);
    };

    /**
     * Get all the types of the loc
     * @param loc
     * @returns [Type]
     */

    AbsCache.prototype.getTypeOfLoc = function getTypeOfLoc(loc) {
        if (!this.map.has(loc)) {
            // no type is available
            return null;
        }
        var tps = [];
        for (var _iterator2 = this.map.get(loc).values(), _isArray2 = Array.isArray(_iterator2), _i2 = 0, _iterator2 = _isArray2 ? _iterator2 : _iterator2[Symbol.iterator]();;) {
            var _ref2;

            if (_isArray2) {
                if (_i2 >= _iterator2.length) break;
                _ref2 = _iterator2[_i2++];
            } else {
                _i2 = _iterator2.next();
                if (_i2.done) break;
                _ref2 = _i2.value;
            }

            var av = _ref2;

            for (var _iterator3 = av.getTypes(), _isArray3 = Array.isArray(_iterator3), _i3 = 0, _iterator3 = _isArray3 ? _iterator3 : _iterator3[Symbol.iterator]();;) {
                var _ref3;

                if (_isArray3) {
                    if (_i3 >= _iterator3.length) break;
                    _ref3 = _iterator3[_i3++];
                } else {
                    _i3 = _iterator3.next();
                    if (_i3.done) break;
                    _ref3 = _i3.value;
                }

                var tp = _ref3;

                if (tps.indexOf(tp) === -1) {
                    tps.push(tp);
                }
            }
        }
        return tps;
    };

    return AbsCache;
})();

exports.Type = Type;
exports.ObjType = ObjType;
exports.FnType = FnType;
exports.ArrType = ArrType;
exports.PrimNumber = PrimNumber;
exports.PrimString = PrimString;
exports.PrimBoolean = PrimBoolean;
exports.mkObjFromGlobalScope = mkObjFromGlobalScope;

exports.AVal = AVal;
exports.AValNull = AValNull;

exports.AbsCache = AbsCache;

},{}],7:[function(require,module,exports){
'use strict';

var myWalker = require('./util/myWalker');

function getTypeData(ast, Ĉ, start, end) {
    'use strict';
    var node = myWalker.findSurroundingNode(ast, start, end);
    var nodeTypes = Ĉ.getTypeOfLoc(node);
    var hasType = undefined;
    var typeString = '';
    if (!nodeTypes) {
        hasType = false;
        typeString = 'No expression at the given range';
    } else {
        hasType = true;
        typeString = '';
        nodeTypes.forEach(function (tp, i) {
            typeString += tp.getName();
            if (i !== nodeTypes.length - 1) {
                typeString += ', ';
            }
        });
    }
    return {
        hasType: hasType,
        typeString: typeString,
        nodeStart: node.start,
        nodeEnd: node.end
    };
}

exports.getTypeData = getTypeData;

},{"./util/myWalker":11}],8:[function(require,module,exports){
// import necessary libraries
'use strict';

var acorn = require('acorn/dist/acorn');
var acorn_loose = require('acorn/dist/acorn_loose');
var aux = require('./aux');
var types = require('./domains/types');
var context = require('./domains/context');
var status = require('./domains/status');
var varBlock = require('./varBlock');
var cGen = require('./constraint/cGen');
var varRefs = require('./varrefs');
var retOccur = require('./retOccur');
var thisOccur = require('./thisOccur');
var myWalker = require('./util/myWalker');
var getTypeData = require('./getTypeData');

function analyze(input, retAll) {
    // the Scope object for global scope
    // scope.Scope.globalScope = new scope.Scope(null);

    // parsing input program
    var ast;
    var acornOptions = { ecmaVersion: 6 };
    try {
        ast = acorn.parse(input, acornOptions);
    } catch (e) {
        ast = acorn_loose.parse_dammit(input, acornOptions);
    }

    var nodeArrayIndexedByList = aux.getNodeList(ast);

    // Show AST before scope resolution
    // aux.showUnfolded(ast);

    varBlock.annotateBlockInfo(ast);
    var gBlock = ast['@block'];
    var initialContext = new context.CallSiteContext();
    var gScope = gBlock.getScopeInstance(null, initialContext);
    var gObject = types.mkObjFromGlobalScope(gScope);
    var initStatus = new status.Status(gObject, types.AValNull, types.AValNull, initialContext, gScope);
    // the prototype object of Object
    var ObjProto = new types.ObjType(null, 'Object.prototype');
    var rtCX = {
        globalObject: gObject,
        // temporal
        protos: {
            Object: ObjProto,
            Function: new types.ObjType(new types.AVal(ObjProto), 'Function.prototype'),
            Array: new types.ObjType(new types.AVal(ObjProto), 'Array.prototype'),
            RegExp: new types.ObjType(new types.AVal(ObjProto), 'RegExp.prototype'),
            String: new types.ObjType(new types.AVal(ObjProto), 'String.prototype'),
            Number: new types.ObjType(new types.AVal(ObjProto), 'Number.prototype'),
            Boolean: new types.ObjType(new types.AVal(ObjProto), 'Boolean.prototype')
        },
        Ĉ: new types.AbsCache()
    };
    cGen.addConstraints(ast, initStatus, rtCX);
    var constraints = cGen.constraints;
    //aux.showUnfolded(gBlockAndAnnotatedAST.ast);
    // aux.showUnfolded(constraints);
    // aux.showUnfolded(gBlock);
    // console.log(util.inspect(gBlock, {depth: 10}));
    if (retAll) {
        return {
            gObject: gObject,
            AST: ast,
            gBlock: gBlock,
            gScope: gScope,
            Ĉ: rtCX.Ĉ
        };
    } else {
        return gObject;
    }
}

exports.analyze = analyze;
exports.findIdentifierAt = myWalker.findIdentifierAt;
exports.findVarRefsAt = varRefs.findVarRefsAt;
exports.onFunctionOrReturnKeyword = retOccur.onFunctionOrReturnKeyword;
exports.findReturnStatements = retOccur.findReturnStatements;
exports.onThisKeyword = thisOccur.onThisKeyword;
exports.findThisExpressions = thisOccur.findThisExpressions;
exports.findSurroundingNode = myWalker.findSurroundingNode;
exports.getTypeData = getTypeData.getTypeData;

},{"./aux":1,"./constraint/cGen":2,"./domains/context":4,"./domains/status":5,"./domains/types":6,"./getTypeData":7,"./retOccur":9,"./thisOccur":10,"./util/myWalker":11,"./varBlock":12,"./varrefs":13,"acorn/dist/acorn":14,"acorn/dist/acorn_loose":15}],9:[function(require,module,exports){
'use strict';

var walk = require('acorn/dist/walk');
var myWalker = require('./util/myWalker');

/**
 * Check whether given pos is on a function keyword
 * @param ast - AST of a program
 * @param pos - index position
 * @returns {*} - function node or null
 */
function onFunctionOrReturnKeyword(ast, pos) {
    "use strict";

    // find function node
    // st is the enclosing function
    var walker = myWalker.wrapWalker(walk.base,
    // pre
    function (node, st) {
        if (node.start > pos || node.end < pos) {
            return false;
        }

        // on a function keyword, 8 is the length of 'function'
        // or on return keyword, 6 is the length of 'return'
        if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') && (node.start <= pos && pos <= node.start + 8) || node.type === 'ReturnStatement' && (node.start <= pos && pos <= node.start + 6)) {
            throw st;
        }
        return true;
    },
    // post
    undefined,
    // stChange
    function (node, st) {
        if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') {
            return node;
        } else {
            return st;
        }
    });

    try {
        walk.recursive(ast, undefined, walker);
    } catch (e) {
        if (e && e.type && (e.type === 'FunctionExpression' || e.type === 'FunctionDeclaration')) {
            return e;
        } else {
            throw e;
        }
    }
    // identifier not found
    return null;
}

/**
 * Given a function node, find its return nodes
 *
 * @param fNode - AST node of a function, possibly with no annotation
 * @returns {*} - array of AST nodes
 */
function getReturnNodes(fNode) {
    "use strict";
    var rets = [];
    if (fNode.type !== 'FunctionExpression' && fNode.type !== 'FunctionDeclaration') {
        throw Error('fNode should be a function node');
    }

    var walker = walk.make({
        ReturnStatement: function ReturnStatement(node) {
            return rets.push(node);
        },
        Function: function Function() {
            // not visit inner functions
        }
    }, walk.base);

    walk.recursive(fNode.body, undefined, walker);

    return rets;
}

/**
 * Find return nodes corresponding to the position
 * if the pos is on a function keyword
 *
 * @param ast - AST node of a program, possibly with no annotation
 * @param pos - cursor position
 * @param includeFunctionKeyword - whether to include function keyword range
 * @returns {Array} - array of AST nodes of return statements
 */
function findReturnStatements(ast, pos, includeFunctionKeyword) {
    "use strict";

    var fNode = onFunctionOrReturnKeyword(ast, pos);
    if (!fNode) {
        // pos is not on function keyword
        return null;
    }

    var rets = getReturnNodes(fNode);
    // when function does not have return statements,
    // indicate it by the closing brace of the function body
    if (rets.length === 0) {
        rets.push({ start: fNode.end - 1, end: fNode.end });
    }
    if (includeFunctionKeyword) {
        rets.push({ start: fNode.start, end: fNode.start + 8 });
    }
    return rets;
}

exports.onFunctionOrReturnKeyword = onFunctionOrReturnKeyword;
exports.findReturnStatements = findReturnStatements;

},{"./util/myWalker":11,"acorn/dist/walk":16}],10:[function(require,module,exports){
'use strict';

var walk = require('acorn/dist/walk');
var myWalker = require('./util/myWalker');

/**
 * Check whether given pos is on a this keyword
 * @param ast - AST of a program
 * @param pos - index position
 * @returns {*} - function node or null
 */
function onThisKeyword(ast, pos) {
    "use strict";

    // find function node
    // st is the enclosing function
    var walker = myWalker.wrapWalker(walk.base,
    // pre
    function (node, st) {
        if (node.start > pos || node.end < pos) {
            return false;
        }

        if (node.type === 'ThisExpression') {
            throw st;
        }
        return true;
    },
    // post
    undefined,
    // stChange
    function (node, st) {
        if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') {
            return node;
        } else {
            return st;
        }
    });

    try {
        walk.recursive(ast, undefined, walker);
    } catch (e) {
        if (e && e.type && (e.type === 'FunctionExpression' || e.type === 'FunctionDeclaration')) {
            return e;
        } else {
            throw e;
        }
    }
    // identifier not found
    return null;
}

/**
 * Given a function node, find its this nodes
 *
 * @param fNode - AST node of a function, possibly with no annotation
 * @returns {*} - array of AST nodes
 */
function getThisNodes(fNode) {
    "use strict";
    var rets = [];
    if (fNode.type !== 'FunctionExpression' && fNode.type !== 'FunctionDeclaration') {
        throw Error('fNode should be a function node');
    }

    var walker = walk.make({
        ThisExpression: function ThisExpression(node) {
            return rets.push(node);
        },
        Function: function Function() {
            // not visit inner functions
        }
    }, walk.base);

    walk.recursive(fNode.body, undefined, walker);

    return rets;
}

/**
 * Find this nodes if the pos is on a this keyword
 *
 * @param ast - AST node of a program, possibly with no annotation
 * @param pos - cursor position
 * @param includeFunctionKeyword - whether to include function keyword range
 * @returns {Array} - array of AST nodes of return statements
 */
function findThisExpressions(ast, pos, includeFunctionKeyword) {
    "use strict";

    var fNode = onThisKeyword(ast, pos);
    if (!fNode) {
        // pos is not on this keyword
        return null;
    }

    var rets = getThisNodes(fNode);
    if (includeFunctionKeyword) {
        rets.push({ start: fNode.start, end: fNode.start + 8 });
    }
    return rets;
}

exports.onThisKeyword = onThisKeyword;
exports.findThisExpressions = findThisExpressions;

},{"./util/myWalker":11,"acorn/dist/walk":16}],11:[function(require,module,exports){
'use strict';

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

var walk = require('acorn/dist/walk');

/**
 * a walker that visits each id even though it is var declaration
 * the parameter vb denote varBlock
 */
var varWalker = walk.make({
    Function: function Function(node, vb, c) {
        'use strict';
        var innerVb = node.body['@block'];
        if (node.id) c(node.id, innerVb);
        for (var i = 0; i < node.params.length; i++) {
            c(node.params[i], innerVb);
        }c(node.body, innerVb);
    },
    TryStatement: function TryStatement(node, vb, c) {
        c(node.block, vb);
        if (node.handler) {
            c(node.handler, vb);
        }
        if (node.finalizer) {
            c(node.finalizer, vb);
        }
    },
    CatchClause: function CatchClause(node, vb, c) {
        var catchVb = node.body['@block'];
        c(node.param, catchVb);
        c(node.body, catchVb);
    },
    VariableDeclaration: function VariableDeclaration(node, vb, c) {
        'use strict';
        for (var i = 0; i < node.declarations.length; ++i) {
            var decl = node.declarations[i];
            c(decl.id, vb);
            if (decl.init) c(decl.init, vb);
        }
    },
    VariablePattern: function VariablePattern(node, vb, c) {
        'use strict';
        c(node, vb, 'Identifier');
    }
});

/**
 * Wrap a walker with pre- and post- actions
 *
 * @param preNode - Apply before visiting the current node.
 * If returns false, do not visit the node.
 * @param postNode - Apply after visiting the current node.
 * If given, return values are overridden.
 * @returns {*} - a new walker
 */
function wrapWalker(walker, preNode, postNode, stChange) {
    'use strict';
    var retWalker = {};
    // wrapping each function preNode and postNode

    var _loop = function (nodeType) {
        if (!walker.hasOwnProperty(nodeType)) {
            return 'continue';
        }
        retWalker[nodeType] = function (node, st, c) {
            var ret = undefined;
            var newSt = st;
            if (stChange) {
                newSt = stChange(node, st);
            }
            if (!preNode || preNode(node, newSt, c)) {
                ret = walker[nodeType](node, newSt, c);
            } else {
                return;
            }
            if (postNode) {
                ret = postNode(node, newSt, c);
            }
            return ret;
        };
    };

    for (var nodeType in walker) {
        var _ret = _loop(nodeType);

        if (_ret === 'continue') continue;
    }
    return retWalker;
}

var Found = function Found(info) {
    _classCallCheck(this, Found);

    this.info = info;
};

function findIdentifierAt(ast, pos) {
    "use strict";

    // find the node
    var walker = wrapWalker(varWalker, function (node, vb) {
        if (node.start > pos || node.end < pos) {
            return false;
        }
        if (node.type === 'Identifier' && node.name !== '✖') {
            throw new Found({ node: node, vb: vb });
        }
        return true;
    });

    try {
        walk.recursive(ast, ast['@block'], walker);
    } catch (e) {
        if (e instanceof Found) {
            return e.info;
        } else {
            throw e;
        }
    }
    // identifier not found
    return null;
}

function findSurroundingNode(ast, start, end) {
    "use strict";

    var walker = wrapWalker(varWalker, function (node) {
        return !(node.start > start || node.end < end);
    }, function (node) {
        throw new Found(node);
    });

    try {
        walk.recursive(ast, undefined, walker);
    } catch (e) {
        if (e instanceof Found) {
            return e.info;
        } else {
            throw e;
        }
    }
    // node not found
    return null;
}

exports.Found = Found;
exports.wrapWalker = wrapWalker;
exports.varWalker = varWalker;
exports.findIdentifierAt = findIdentifierAt;
exports.findSurroundingNode = findSurroundingNode;

},{"acorn/dist/walk":16}],12:[function(require,module,exports){
/*
 JavaScript는 global, function block, catch block에 변수가 달린다.
 ES6는 일반 block에도 달린다.

 VarBlock는 각 block에 달린 변수들을 나타낸다.
 - paren      : BlockVars, 바깥 block을 나타내는 객체
 - originLabel: number, 해당 BlockVars가 선언된 AST node의 @label
    origin이 될 수 있는 node는
    Function.body, CatchClause.block 두가지다.
    두가지 모두 BlockStatement이다.
 - isCatch    : boolean,
   * true  -> catch block
   * false -> function block, or global

 - paramVarNames : 매개변수 이름 목록, 매개 변수 순서대로
 - localVarNames : 지역 변수 이름 목록, 순서 무의미
    arguments를 사용하는 경우 localVarNames에 등장하고,
    arguments object를 사용하면 useArgumentsObject == true

 - (optional) useArgumentsObject: boolean
    함수 body block인 경우에만 사용 가능
    * true  : arguments object가 사용되었다.
      즉 함수 body에서 변수 arguments를 선언 없이 사용했다.
      이 경우, arguments는 함수의 지역 변수로 등록된다.
    * false 인 경우는 없다. 그럴거면 아예 변수 자체가 없다.

 - usedVariables : 각 block의 매개변수, 지역변수 중
   사용되는 위치가 있는 것들의 목록

 - instances : Delta -> VarBlock의 변수들 -> AVal
   getInstance(delta) 를 통해 같은 delta는 같은 mapping 주게 만듬

 - scopeInstances : [Scope]
   현재 VarBlock을 마지막으로 하는 Scope를 모두 모은다.
   getScopeInstance(delta, paren) 을 통해 같은 scope chain은
   같은 객체가 되도록 만든다.
*/
'use strict';

var types = require('./domains/types');
var walk = require('acorn/dist/walk');
var aux = require('./aux');

function VarBlock(paren, originNode, isCatch) {
    this.paren = paren;
    this.originNode = originNode;
    this.originLabel = originNode['@label'];
    this.isCatch = isCatch;
    this.paramVarNames = [];
    this.localVarNames = [];

    this.usedVariables = [];
    // this.useArgumentsObject
    this.instances = Object.create(null);
    this.scopeInstances = [];
}

VarBlock.prototype = Object.create(null);

VarBlock.prototype.isGlobal = function () {
    return this.paren == null;
};
VarBlock.prototype.isFunction = function () {
    return this.paren != null && this.localVarNames != null;
};
VarBlock.prototype.isCatchBlock = function () {
    return this.isCatch;
};

VarBlock.prototype.getLocalVarNames = function () {
    return this.localVarNames;
};
VarBlock.prototype.getParamVarNames = function () {
    return this.paramVarNames;
};
VarBlock.prototype.hasLocalVar = function (varName) {
    return this.localVarNames && this.localVarNames.indexOf(varName) > -1;
};
VarBlock.prototype.hasParamVar = function (varName) {
    return this.paramVarNames.indexOf(varName) > -1;
};
VarBlock.prototype.hasVar = function (varName) {
    return this.hasParamVar(varName) || this.hasLocalVar(varName);
};

VarBlock.prototype.addDeclaredLocalVar = function (varName, isFunDecl) {
    var currBlock = this;
    // peel off initial catch blocks
    // for function decl, skip any catch blocks,
    // for variable decl, skip catch block with different varName.
    while (currBlock.isCatchBlock() && (isFunDecl || !currBlock.hasParamVar(varName))) {
        currBlock = currBlock.paren;
    }
    // if already added, do not add
    if (!currBlock.hasVar(varName)) {
        currBlock.localVarNames.push(varName);
    }
    // returns the block object that contains the variable
    return currBlock;
};
VarBlock.prototype.addParamVar = function (varName) {
    this.paramVarNames.push(varName);
};
VarBlock.prototype.findVarInChain = function (varName) {
    var currBlock = this;
    while (currBlock && currBlock.paren && !currBlock.hasVar(varName)) {
        currBlock = currBlock.paren;
    }
    // if not found, it will return the global
    return currBlock;
};

VarBlock.prototype.addUsedVar = function (varName) {
    if (this.usedVariables.indexOf(varName) === -1) {
        this.usedVariables.push(varName);
    }
};
VarBlock.prototype.getUsedVarNames = function () {
    return this.usedVariables;
};
VarBlock.prototype.isUsedVar = function (varName) {
    return this.usedVariables.indexOf(varName) > -1;
};

// returns a mapping
VarBlock.prototype.getInstance = function (delta) {
    if (this.instances[delta]) {
        return this.instances[delta];
    }
    // construct VarMap
    var varMap = new Map();
    var varNames = this.getParamVarNames().concat(this.getLocalVarNames());

    for (var i = 0; i < varNames.length; i++) {
        varMap.set(varNames[i], new types.AVal());
    }
    // remember the instance
    this.instances[delta] = varMap;
    return varMap;
};
// returns an array
VarBlock.prototype.getParamAVals = function (delta) {
    var instance = this.getInstance(delta);
    var params = [];
    this.getParamVarNames().forEach(function (name) {
        params.push(instance[aux.internalName(name)]);
    });
    return params;
};
// returns an AVal
VarBlock.prototype.getArgumentsAVal = function (delta) {
    if (!this.useArgumentsObject) {
        throw new Error('Not for this VarBlock');
    }
    return this.getInstance(delta)[aux.internalName('arguments')];
};

// get a Scope instance
VarBlock.prototype.getScopeInstance = function (paren, delta) {
    var varMap = this.getInstance(delta);
    var found = null;

    this.scopeInstances.forEach(function (sc) {
        if (sc.paren === paren && sc.varMap === varMap) found = sc;
    });

    if (found) {
        return found;
    } else {
        var newScopeInstance = new Scope(paren, varMap, this);
        this.scopeInstances.push(newScopeInstance);
        return newScopeInstance;
    }
};

var declaredVariableFinder = walk.make({
    Function: function Function(node, currBlock, c) {
        var parenBlock = currBlock;
        if (node.id) {
            var funcName = node.id.name;
            parenBlock = currBlock.addDeclaredLocalVar(funcName, true);
        }
        // create a VarBlock for function
        var funcBlock = new VarBlock(parenBlock, node);
        node.body['@block'] = funcBlock;
        // add function parameters to the scope
        for (var i = 0; i < node.params.length; i++) {
            var paramName = node.params[i].name;
            funcBlock.addParamVar(paramName);
        }
        c(node.body, funcBlock, undefined);
    },
    VariableDeclaration: function VariableDeclaration(node, currBlock, c) {
        for (var i = 0; i < node.declarations.length; i++) {
            var decl = node.declarations[i];
            var name = decl.id.name;
            currBlock.addDeclaredLocalVar(name);
        }
        if (decl.init) c(decl.init, currBlock, undefined);
    },
    TryStatement: function TryStatement(node, currScope, c) {
        c(node.block, currScope, undefined);
        if (node.handler) {
            c(node.handler, currScope, undefined);
        }
        if (node.finalizer) {
            c(node.finalizer, currScope, undefined);
        }
    },
    CatchClause: function CatchClause(node, currBlock, c) {
        var catchBlock = new VarBlock(currBlock, node, true);
        catchBlock.addParamVar(node.param.name);
        node.body['@block'] = catchBlock;
        c(node.body, catchBlock, undefined);
    }
});

// For variables in global and arguments in functions
var variableUsageCollector = walk.make({
    VariablePattern: function VariablePattern(node, currBlock, c) {
        c(node, currBlock, 'Identifier');
    },

    Identifier: function Identifier(node, currBlock, c) {
        var containingBlock,
            varName = node.name;
        if (varName !== 'arguments') {
            containingBlock = currBlock.findVarInChain(varName);
            if (containingBlock.isGlobal()) {
                containingBlock.addDeclaredLocalVar(varName);
            }
            containingBlock.addUsedVar(varName);
        } else {
            // varName == 'arguments'
            containingBlock = currBlock;
            while (containingBlock.isCatchBlock() && !containingBlock.hasParamVar(varName)) {
                containingBlock = containingBlock.paren;
            }
            if (containingBlock.hasVar(varName)) {
                // arguments is explicitly declared
                containingBlock.addUsedVar(varName);
            } else {
                // arguments is not explicitly declared
                // add it as local variable
                containingBlock.addDeclaredLocalVar(varName);
                // also it is used
                containingBlock.addUsedVar(varName);
                if (containingBlock.isFunction()) {
                    containingBlock.useArgumentsObject = true;
                }
            }
        }
    },

    ReturnStatement: function ReturnStatement(node, currBlock, c) {
        var functionBlock = currBlock;
        while (functionBlock.isCatchBlock()) {
            functionBlock = functionBlock.paren;
        }
        if (!functionBlock.isGlobal() && node.argument !== null) {
            functionBlock.useReturnWithArgument = true;
        }
        if (node.argument) {
            c(node.argument, currBlock, undefined);
        }
    },

    ScopeBody: function ScopeBody(node, currBlock, c) {
        c(node, node['@block'] || currBlock);
    }
});

function annotateBlockInfo(ast, gBlock) {
    if (!gBlock) {
        // when global block is not given, create
        gBlock = new VarBlock(null, ast);
    }
    ast['@block'] = gBlock;
    walk.recursive(ast, gBlock, null, declaredVariableFinder);
    walk.recursive(ast, gBlock, null, variableUsageCollector);
    return ast;
}

// define scope object
function Scope(paren, varMap, vb) {
    this.paren = paren;
    this.varMap = varMap;
    this.vb = vb;
}
Scope.prototype = Object.create(null);
// find AVal of a variable in the chain
Scope.prototype.getAValOf = function (varName) {
    var curr = this;
    while (curr != null) {
        if (curr.varMap.has(varName)) {
            return curr.varMap.get(varName);
        }
        curr = curr.paren;
    }
    throw new Error('Should have found the variable');
};
// remove initial catch scopes from the chain
Scope.prototype.removeInitialCatchBlocks = function () {
    var curr = this;
    while (curr.vb.isCatchBlock()) {
        curr = curr.paren;
    }
    return curr;
};

exports.VarBlock = VarBlock;
exports.annotateBlockInfo = annotateBlockInfo;
exports.Scope = Scope;

},{"./aux":1,"./domains/types":6,"acorn/dist/walk":16}],13:[function(require,module,exports){
'use strict';

var walk = require('acorn/dist/walk');
var myWalker = require('./util/myWalker');

/**
 *
 * @param ast - scope annotated AST
 * @param {number} pos - character position
 * @returns {*} - array of AST nodes
 */
function findVarRefsAt(ast, pos) {
    "use strict";
    var found = myWalker.findIdentifierAt(ast, pos);
    if (!found) {
        // pos is not at a variable
        return null;
    }
    // find refs for the id node
    var refs = findRefsToVariable(ast, found);

    return refs;
}

/**
 *
 * @param ast - scope annotated AST
 * @param found - node and varBlock of the variable
 * @returns {Array} - array of AST nodes
 */
function findRefsToVariable(ast, found) {
    "use strict";
    var varName = found.node.name;
    var vb1 = found.vb.findVarInChain(varName);
    var refs = [];

    var walker = walk.make({
        Identifier: function Identifier(node, vb) {
            if (node.name !== varName) return;
            if (vb1 === vb.findVarInChain(varName)) {
                refs.push(node);
            }
        }
    }, myWalker.varWalker);

    walk.recursive(vb1.originNode, vb1, walker);
    return refs;
}

exports.findVarRefsAt = findVarRefsAt;

},{"./util/myWalker":11,"acorn/dist/walk":16}],14:[function(require,module,exports){
(function (global){
(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.acorn = f()}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(_dereq_,module,exports){
// A recursive descent parser operates by defining functions for all
// syntactic elements, and recursively calling those, each function
// advancing the input stream and returning an AST node. Precedence
// of constructs (for example, the fact that `!x[1]` means `!(x[1])`
// instead of `(!x)[1]` is handled by the fact that the parser
// function that parses unary prefix operators is called first, and
// in turn calls the function that parses `[]` subscripts — that
// way, it'll receive the node for `x[1]` already parsed, and wraps
// *that* in the unary operator node.
//
// Acorn uses an [operator precedence parser][opp] to handle binary
// operator precedence, because it is much more compact than using
// the technique outlined above, which uses different, nesting
// functions to specify precedence, for all of the ten binary
// precedence levels that JavaScript defines.
//
// [opp]: http://en.wikipedia.org/wiki/Operator-precedence_parser

"use strict";

var _tokentype = _dereq_("./tokentype");

var _state = _dereq_("./state");

var _identifier = _dereq_("./identifier");

var _util = _dereq_("./util");

var pp = _state.Parser.prototype;

// Check if property name clashes with already added.
// Object/class getters and setters are not allowed to clash —
// either with each other or with an init property — and in
// strict mode, init properties are also not allowed to be repeated.

pp.checkPropClash = function (prop, propHash) {
  if (this.options.ecmaVersion >= 6 && (prop.computed || prop.method || prop.shorthand)) return;
  var key = prop.key,
      name = undefined;
  switch (key.type) {
    case "Identifier":
      name = key.name;break;
    case "Literal":
      name = String(key.value);break;
    default:
      return;
  }
  var kind = prop.kind;
  if (this.options.ecmaVersion >= 6) {
    if (name === "__proto__" && kind === "init") {
      if (propHash.proto) this.raise(key.start, "Redefinition of __proto__ property");
      propHash.proto = true;
    }
    return;
  }
  var other = undefined;
  if (_util.has(propHash, name)) {
    other = propHash[name];
    var isGetSet = kind !== "init";
    if ((this.strict || isGetSet) && other[kind] || !(isGetSet ^ other.init)) this.raise(key.start, "Redefinition of property");
  } else {
    other = propHash[name] = {
      init: false,
      get: false,
      set: false
    };
  }
  other[kind] = true;
};

// ### Expression parsing

// These nest, from the most general expression type at the top to
// 'atomic', nondivisible expression types at the bottom. Most of
// the functions will simply let the function(s) below them parse,
// and, *if* the syntactic construct they handle is present, wrap
// the AST node that the inner parser gave them in another node.

// Parse a full expression. The optional arguments are used to
// forbid the `in` operator (in for loops initalization expressions)
// and provide reference for storing '=' operator inside shorthand
// property assignment in contexts where both object expression
// and object pattern might appear (so it's possible to raise
// delayed syntax error at correct position).

pp.parseExpression = function (noIn, refShorthandDefaultPos) {
  var startPos = this.start,
      startLoc = this.startLoc;
  var expr = this.parseMaybeAssign(noIn, refShorthandDefaultPos);
  if (this.type === _tokentype.types.comma) {
    var node = this.startNodeAt(startPos, startLoc);
    node.expressions = [expr];
    while (this.eat(_tokentype.types.comma)) node.expressions.push(this.parseMaybeAssign(noIn, refShorthandDefaultPos));
    return this.finishNode(node, "SequenceExpression");
  }
  return expr;
};

// Parse an assignment expression. This includes applications of
// operators like `+=`.

pp.parseMaybeAssign = function (noIn, refShorthandDefaultPos, afterLeftParse) {
  if (this.type == _tokentype.types._yield && this.inGenerator) return this.parseYield();

  var failOnShorthandAssign = undefined;
  if (!refShorthandDefaultPos) {
    refShorthandDefaultPos = { start: 0 };
    failOnShorthandAssign = true;
  } else {
    failOnShorthandAssign = false;
  }
  var startPos = this.start,
      startLoc = this.startLoc;
  if (this.type == _tokentype.types.parenL || this.type == _tokentype.types.name) this.potentialArrowAt = this.start;
  var left = this.parseMaybeConditional(noIn, refShorthandDefaultPos);
  if (afterLeftParse) left = afterLeftParse.call(this, left, startPos, startLoc);
  if (this.type.isAssign) {
    var node = this.startNodeAt(startPos, startLoc);
    node.operator = this.value;
    node.left = this.type === _tokentype.types.eq ? this.toAssignable(left) : left;
    refShorthandDefaultPos.start = 0; // reset because shorthand default was used correctly
    this.checkLVal(left);
    this.next();
    node.right = this.parseMaybeAssign(noIn);
    return this.finishNode(node, "AssignmentExpression");
  } else if (failOnShorthandAssign && refShorthandDefaultPos.start) {
    this.unexpected(refShorthandDefaultPos.start);
  }
  return left;
};

// Parse a ternary conditional (`?:`) operator.

pp.parseMaybeConditional = function (noIn, refShorthandDefaultPos) {
  var startPos = this.start,
      startLoc = this.startLoc;
  var expr = this.parseExprOps(noIn, refShorthandDefaultPos);
  if (refShorthandDefaultPos && refShorthandDefaultPos.start) return expr;
  if (this.eat(_tokentype.types.question)) {
    var node = this.startNodeAt(startPos, startLoc);
    node.test = expr;
    node.consequent = this.parseMaybeAssign();
    this.expect(_tokentype.types.colon);
    node.alternate = this.parseMaybeAssign(noIn);
    return this.finishNode(node, "ConditionalExpression");
  }
  return expr;
};

// Start the precedence parser.

pp.parseExprOps = function (noIn, refShorthandDefaultPos) {
  var startPos = this.start,
      startLoc = this.startLoc;
  var expr = this.parseMaybeUnary(refShorthandDefaultPos);
  if (refShorthandDefaultPos && refShorthandDefaultPos.start) return expr;
  return this.parseExprOp(expr, startPos, startLoc, -1, noIn);
};

// Parse binary operators with the operator precedence parsing
// algorithm. `left` is the left-hand side of the operator.
// `minPrec` provides context that allows the function to stop and
// defer further parser to one of its callers when it encounters an
// operator that has a lower precedence than the set it is parsing.

pp.parseExprOp = function (left, leftStartPos, leftStartLoc, minPrec, noIn) {
  var prec = this.type.binop;
  if (prec != null && (!noIn || this.type !== _tokentype.types._in)) {
    if (prec > minPrec) {
      var node = this.startNodeAt(leftStartPos, leftStartLoc);
      node.left = left;
      node.operator = this.value;
      var op = this.type;
      this.next();
      var startPos = this.start,
          startLoc = this.startLoc;
      node.right = this.parseExprOp(this.parseMaybeUnary(), startPos, startLoc, prec, noIn);
      this.finishNode(node, op === _tokentype.types.logicalOR || op === _tokentype.types.logicalAND ? "LogicalExpression" : "BinaryExpression");
      return this.parseExprOp(node, leftStartPos, leftStartLoc, minPrec, noIn);
    }
  }
  return left;
};

// Parse unary operators, both prefix and postfix.

pp.parseMaybeUnary = function (refShorthandDefaultPos) {
  if (this.type.prefix) {
    var node = this.startNode(),
        update = this.type === _tokentype.types.incDec;
    node.operator = this.value;
    node.prefix = true;
    this.next();
    node.argument = this.parseMaybeUnary();
    if (refShorthandDefaultPos && refShorthandDefaultPos.start) this.unexpected(refShorthandDefaultPos.start);
    if (update) this.checkLVal(node.argument);else if (this.strict && node.operator === "delete" && node.argument.type === "Identifier") this.raise(node.start, "Deleting local variable in strict mode");
    return this.finishNode(node, update ? "UpdateExpression" : "UnaryExpression");
  }
  var startPos = this.start,
      startLoc = this.startLoc;
  var expr = this.parseExprSubscripts(refShorthandDefaultPos);
  if (refShorthandDefaultPos && refShorthandDefaultPos.start) return expr;
  while (this.type.postfix && !this.canInsertSemicolon()) {
    var node = this.startNodeAt(startPos, startLoc);
    node.operator = this.value;
    node.prefix = false;
    node.argument = expr;
    this.checkLVal(expr);
    this.next();
    expr = this.finishNode(node, "UpdateExpression");
  }
  return expr;
};

// Parse call, dot, and `[]`-subscript expressions.

pp.parseExprSubscripts = function (refShorthandDefaultPos) {
  var startPos = this.start,
      startLoc = this.startLoc;
  var expr = this.parseExprAtom(refShorthandDefaultPos);
  if (refShorthandDefaultPos && refShorthandDefaultPos.start) return expr;
  return this.parseSubscripts(expr, startPos, startLoc);
};

pp.parseSubscripts = function (base, startPos, startLoc, noCalls) {
  for (;;) {
    if (this.eat(_tokentype.types.dot)) {
      var node = this.startNodeAt(startPos, startLoc);
      node.object = base;
      node.property = this.parseIdent(true);
      node.computed = false;
      base = this.finishNode(node, "MemberExpression");
    } else if (this.eat(_tokentype.types.bracketL)) {
      var node = this.startNodeAt(startPos, startLoc);
      node.object = base;
      node.property = this.parseExpression();
      node.computed = true;
      this.expect(_tokentype.types.bracketR);
      base = this.finishNode(node, "MemberExpression");
    } else if (!noCalls && this.eat(_tokentype.types.parenL)) {
      var node = this.startNodeAt(startPos, startLoc);
      node.callee = base;
      node.arguments = this.parseExprList(_tokentype.types.parenR, false);
      base = this.finishNode(node, "CallExpression");
    } else if (this.type === _tokentype.types.backQuote) {
      var node = this.startNodeAt(startPos, startLoc);
      node.tag = base;
      node.quasi = this.parseTemplate();
      base = this.finishNode(node, "TaggedTemplateExpression");
    } else {
      return base;
    }
  }
};

// Parse an atomic expression — either a single token that is an
// expression, an expression started by a keyword like `function` or
// `new`, or an expression wrapped in punctuation like `()`, `[]`,
// or `{}`.

pp.parseExprAtom = function (refShorthandDefaultPos) {
  var node = undefined,
      canBeArrow = this.potentialArrowAt == this.start;
  switch (this.type) {
    case _tokentype.types._super:
      if (!this.inFunction) this.raise(this.start, "'super' outside of function or class");
    case _tokentype.types._this:
      var type = this.type === _tokentype.types._this ? "ThisExpression" : "Super";
      node = this.startNode();
      this.next();
      return this.finishNode(node, type);

    case _tokentype.types._yield:
      if (this.inGenerator) this.unexpected();

    case _tokentype.types.name:
      var startPos = this.start,
          startLoc = this.startLoc;
      var id = this.parseIdent(this.type !== _tokentype.types.name);
      if (canBeArrow && !this.canInsertSemicolon() && this.eat(_tokentype.types.arrow)) return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), [id]);
      return id;

    case _tokentype.types.regexp:
      var value = this.value;
      node = this.parseLiteral(value.value);
      node.regex = { pattern: value.pattern, flags: value.flags };
      return node;

    case _tokentype.types.num:case _tokentype.types.string:
      return this.parseLiteral(this.value);

    case _tokentype.types._null:case _tokentype.types._true:case _tokentype.types._false:
      node = this.startNode();
      node.value = this.type === _tokentype.types._null ? null : this.type === _tokentype.types._true;
      node.raw = this.type.keyword;
      this.next();
      return this.finishNode(node, "Literal");

    case _tokentype.types.parenL:
      return this.parseParenAndDistinguishExpression(canBeArrow);

    case _tokentype.types.bracketL:
      node = this.startNode();
      this.next();
      // check whether this is array comprehension or regular array
      if (this.options.ecmaVersion >= 7 && this.type === _tokentype.types._for) {
        return this.parseComprehension(node, false);
      }
      node.elements = this.parseExprList(_tokentype.types.bracketR, true, true, refShorthandDefaultPos);
      return this.finishNode(node, "ArrayExpression");

    case _tokentype.types.braceL:
      return this.parseObj(false, refShorthandDefaultPos);

    case _tokentype.types._function:
      node = this.startNode();
      this.next();
      return this.parseFunction(node, false);

    case _tokentype.types._class:
      return this.parseClass(this.startNode(), false);

    case _tokentype.types._new:
      return this.parseNew();

    case _tokentype.types.backQuote:
      return this.parseTemplate();

    default:
      this.unexpected();
  }
};

pp.parseLiteral = function (value) {
  var node = this.startNode();
  node.value = value;
  node.raw = this.input.slice(this.start, this.end);
  this.next();
  return this.finishNode(node, "Literal");
};

pp.parseParenExpression = function () {
  this.expect(_tokentype.types.parenL);
  var val = this.parseExpression();
  this.expect(_tokentype.types.parenR);
  return val;
};

pp.parseParenAndDistinguishExpression = function (canBeArrow) {
  var startPos = this.start,
      startLoc = this.startLoc,
      val = undefined;
  if (this.options.ecmaVersion >= 6) {
    this.next();

    if (this.options.ecmaVersion >= 7 && this.type === _tokentype.types._for) {
      return this.parseComprehension(this.startNodeAt(startPos, startLoc), true);
    }

    var innerStartPos = this.start,
        innerStartLoc = this.startLoc;
    var exprList = [],
        first = true;
    var refShorthandDefaultPos = { start: 0 },
        spreadStart = undefined,
        innerParenStart = undefined;
    while (this.type !== _tokentype.types.parenR) {
      first ? first = false : this.expect(_tokentype.types.comma);
      if (this.type === _tokentype.types.ellipsis) {
        spreadStart = this.start;
        exprList.push(this.parseParenItem(this.parseRest()));
        break;
      } else {
        if (this.type === _tokentype.types.parenL && !innerParenStart) {
          innerParenStart = this.start;
        }
        exprList.push(this.parseMaybeAssign(false, refShorthandDefaultPos, this.parseParenItem));
      }
    }
    var innerEndPos = this.start,
        innerEndLoc = this.startLoc;
    this.expect(_tokentype.types.parenR);

    if (canBeArrow && !this.canInsertSemicolon() && this.eat(_tokentype.types.arrow)) {
      if (innerParenStart) this.unexpected(innerParenStart);
      return this.parseParenArrowList(startPos, startLoc, exprList);
    }

    if (!exprList.length) this.unexpected(this.lastTokStart);
    if (spreadStart) this.unexpected(spreadStart);
    if (refShorthandDefaultPos.start) this.unexpected(refShorthandDefaultPos.start);

    if (exprList.length > 1) {
      val = this.startNodeAt(innerStartPos, innerStartLoc);
      val.expressions = exprList;
      this.finishNodeAt(val, "SequenceExpression", innerEndPos, innerEndLoc);
    } else {
      val = exprList[0];
    }
  } else {
    val = this.parseParenExpression();
  }

  if (this.options.preserveParens) {
    var par = this.startNodeAt(startPos, startLoc);
    par.expression = val;
    return this.finishNode(par, "ParenthesizedExpression");
  } else {
    return val;
  }
};

pp.parseParenItem = function (item) {
  return item;
};

pp.parseParenArrowList = function (startPos, startLoc, exprList) {
  return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), exprList);
};

// New's precedence is slightly tricky. It must allow its argument
// to be a `[]` or dot subscript expression, but not a call — at
// least, not without wrapping it in parentheses. Thus, it uses the

var empty = [];

pp.parseNew = function () {
  var node = this.startNode();
  var meta = this.parseIdent(true);
  if (this.options.ecmaVersion >= 6 && this.eat(_tokentype.types.dot)) {
    node.meta = meta;
    node.property = this.parseIdent(true);
    if (node.property.name !== "target") this.raise(node.property.start, "The only valid meta property for new is new.target");
    return this.finishNode(node, "MetaProperty");
  }
  var startPos = this.start,
      startLoc = this.startLoc;
  node.callee = this.parseSubscripts(this.parseExprAtom(), startPos, startLoc, true);
  if (this.eat(_tokentype.types.parenL)) node.arguments = this.parseExprList(_tokentype.types.parenR, false);else node.arguments = empty;
  return this.finishNode(node, "NewExpression");
};

// Parse template expression.

pp.parseTemplateElement = function () {
  var elem = this.startNode();
  elem.value = {
    raw: this.input.slice(this.start, this.end).replace(/\r\n?/g, '\n'),
    cooked: this.value
  };
  this.next();
  elem.tail = this.type === _tokentype.types.backQuote;
  return this.finishNode(elem, "TemplateElement");
};

pp.parseTemplate = function () {
  var node = this.startNode();
  this.next();
  node.expressions = [];
  var curElt = this.parseTemplateElement();
  node.quasis = [curElt];
  while (!curElt.tail) {
    this.expect(_tokentype.types.dollarBraceL);
    node.expressions.push(this.parseExpression());
    this.expect(_tokentype.types.braceR);
    node.quasis.push(curElt = this.parseTemplateElement());
  }
  this.next();
  return this.finishNode(node, "TemplateLiteral");
};

// Parse an object literal or binding pattern.

pp.parseObj = function (isPattern, refShorthandDefaultPos) {
  var node = this.startNode(),
      first = true,
      propHash = {};
  node.properties = [];
  this.next();
  while (!this.eat(_tokentype.types.braceR)) {
    if (!first) {
      this.expect(_tokentype.types.comma);
      if (this.afterTrailingComma(_tokentype.types.braceR)) break;
    } else first = false;

    var prop = this.startNode(),
        isGenerator = undefined,
        startPos = undefined,
        startLoc = undefined;
    if (this.options.ecmaVersion >= 6) {
      prop.method = false;
      prop.shorthand = false;
      if (isPattern || refShorthandDefaultPos) {
        startPos = this.start;
        startLoc = this.startLoc;
      }
      if (!isPattern) isGenerator = this.eat(_tokentype.types.star);
    }
    this.parsePropertyName(prop);
    this.parsePropertyValue(prop, isPattern, isGenerator, startPos, startLoc, refShorthandDefaultPos);
    this.checkPropClash(prop, propHash);
    node.properties.push(this.finishNode(prop, "Property"));
  }
  return this.finishNode(node, isPattern ? "ObjectPattern" : "ObjectExpression");
};

pp.parsePropertyValue = function (prop, isPattern, isGenerator, startPos, startLoc, refShorthandDefaultPos) {
  if (this.eat(_tokentype.types.colon)) {
    prop.value = isPattern ? this.parseMaybeDefault(this.start, this.startLoc) : this.parseMaybeAssign(false, refShorthandDefaultPos);
    prop.kind = "init";
  } else if (this.options.ecmaVersion >= 6 && this.type === _tokentype.types.parenL) {
    if (isPattern) this.unexpected();
    prop.kind = "init";
    prop.method = true;
    prop.value = this.parseMethod(isGenerator);
  } else if (this.options.ecmaVersion >= 5 && !prop.computed && prop.key.type === "Identifier" && (prop.key.name === "get" || prop.key.name === "set") && (this.type != _tokentype.types.comma && this.type != _tokentype.types.braceR)) {
    if (isGenerator || isPattern) this.unexpected();
    prop.kind = prop.key.name;
    this.parsePropertyName(prop);
    prop.value = this.parseMethod(false);
    var paramCount = prop.kind === "get" ? 0 : 1;
    if (prop.value.params.length !== paramCount) {
      var start = prop.value.start;
      if (prop.kind === "get") this.raise(start, "getter should have no params");else this.raise(start, "setter should have exactly one param");
    }
  } else if (this.options.ecmaVersion >= 6 && !prop.computed && prop.key.type === "Identifier") {
    prop.kind = "init";
    if (isPattern) {
      if (this.isKeyword(prop.key.name) || this.strict && (_identifier.reservedWords.strictBind(prop.key.name) || _identifier.reservedWords.strict(prop.key.name)) || !this.options.allowReserved && this.isReservedWord(prop.key.name)) this.raise(prop.key.start, "Binding " + prop.key.name);
      prop.value = this.parseMaybeDefault(startPos, startLoc, prop.key);
    } else if (this.type === _tokentype.types.eq && refShorthandDefaultPos) {
      if (!refShorthandDefaultPos.start) refShorthandDefaultPos.start = this.start;
      prop.value = this.parseMaybeDefault(startPos, startLoc, prop.key);
    } else {
      prop.value = prop.key;
    }
    prop.shorthand = true;
  } else this.unexpected();
};

pp.parsePropertyName = function (prop) {
  if (this.options.ecmaVersion >= 6) {
    if (this.eat(_tokentype.types.bracketL)) {
      prop.computed = true;
      prop.key = this.parseMaybeAssign();
      this.expect(_tokentype.types.bracketR);
      return prop.key;
    } else {
      prop.computed = false;
    }
  }
  return prop.key = this.type === _tokentype.types.num || this.type === _tokentype.types.string ? this.parseExprAtom() : this.parseIdent(true);
};

// Initialize empty function node.

pp.initFunction = function (node) {
  node.id = null;
  if (this.options.ecmaVersion >= 6) {
    node.generator = false;
    node.expression = false;
  }
};

// Parse object or class method.

pp.parseMethod = function (isGenerator) {
  var node = this.startNode();
  this.initFunction(node);
  this.expect(_tokentype.types.parenL);
  node.params = this.parseBindingList(_tokentype.types.parenR, false, false);
  var allowExpressionBody = undefined;
  if (this.options.ecmaVersion >= 6) {
    node.generator = isGenerator;
  }
  this.parseFunctionBody(node, false);
  return this.finishNode(node, "FunctionExpression");
};

// Parse arrow function expression with given parameters.

pp.parseArrowExpression = function (node, params) {
  this.initFunction(node);
  node.params = this.toAssignableList(params, true);
  this.parseFunctionBody(node, true);
  return this.finishNode(node, "ArrowFunctionExpression");
};

// Parse function body and check parameters.

pp.parseFunctionBody = function (node, allowExpression) {
  var isExpression = allowExpression && this.type !== _tokentype.types.braceL;

  if (isExpression) {
    node.body = this.parseMaybeAssign();
    node.expression = true;
  } else {
    // Start a new scope with regard to labels and the `inFunction`
    // flag (restore them to their old value afterwards).
    var oldInFunc = this.inFunction,
        oldInGen = this.inGenerator,
        oldLabels = this.labels;
    this.inFunction = true;this.inGenerator = node.generator;this.labels = [];
    node.body = this.parseBlock(true);
    node.expression = false;
    this.inFunction = oldInFunc;this.inGenerator = oldInGen;this.labels = oldLabels;
  }

  // If this is a strict mode function, verify that argument names
  // are not repeated, and it does not try to bind the words `eval`
  // or `arguments`.
  if (this.strict || !isExpression && node.body.body.length && this.isUseStrict(node.body.body[0])) {
    var nameHash = {},
        oldStrict = this.strict;
    this.strict = true;
    if (node.id) this.checkLVal(node.id, true);
    for (var i = 0; i < node.params.length; i++) {
      this.checkLVal(node.params[i], true, nameHash);
    }this.strict = oldStrict;
  }
};

// Parses a comma-separated list of expressions, and returns them as
// an array. `close` is the token type that ends the list, and
// `allowEmpty` can be turned on to allow subsequent commas with
// nothing in between them to be parsed as `null` (which is needed
// for array literals).

pp.parseExprList = function (close, allowTrailingComma, allowEmpty, refShorthandDefaultPos) {
  var elts = [],
      first = true;
  while (!this.eat(close)) {
    if (!first) {
      this.expect(_tokentype.types.comma);
      if (allowTrailingComma && this.afterTrailingComma(close)) break;
    } else first = false;

    var elt = undefined;
    if (allowEmpty && this.type === _tokentype.types.comma) elt = null;else if (this.type === _tokentype.types.ellipsis) elt = this.parseSpread(refShorthandDefaultPos);else elt = this.parseMaybeAssign(false, refShorthandDefaultPos);
    elts.push(elt);
  }
  return elts;
};

// Parse the next token as an identifier. If `liberal` is true (used
// when parsing properties), it will also convert keywords into
// identifiers.

pp.parseIdent = function (liberal) {
  var node = this.startNode();
  if (liberal && this.options.allowReserved == "never") liberal = false;
  if (this.type === _tokentype.types.name) {
    if (!liberal && (!this.options.allowReserved && this.isReservedWord(this.value) || this.strict && _identifier.reservedWords.strict(this.value) && (this.options.ecmaVersion >= 6 || this.input.slice(this.start, this.end).indexOf("\\") == -1))) this.raise(this.start, "The keyword '" + this.value + "' is reserved");
    node.name = this.value;
  } else if (liberal && this.type.keyword) {
    node.name = this.type.keyword;
  } else {
    this.unexpected();
  }
  this.next();
  return this.finishNode(node, "Identifier");
};

// Parses yield expression inside generator.

pp.parseYield = function () {
  var node = this.startNode();
  this.next();
  if (this.type == _tokentype.types.semi || this.canInsertSemicolon() || this.type != _tokentype.types.star && !this.type.startsExpr) {
    node.delegate = false;
    node.argument = null;
  } else {
    node.delegate = this.eat(_tokentype.types.star);
    node.argument = this.parseMaybeAssign();
  }
  return this.finishNode(node, "YieldExpression");
};

// Parses array and generator comprehensions.

pp.parseComprehension = function (node, isGenerator) {
  node.blocks = [];
  while (this.type === _tokentype.types._for) {
    var block = this.startNode();
    this.next();
    this.expect(_tokentype.types.parenL);
    block.left = this.parseBindingAtom();
    this.checkLVal(block.left, true);
    this.expectContextual("of");
    block.right = this.parseExpression();
    this.expect(_tokentype.types.parenR);
    node.blocks.push(this.finishNode(block, "ComprehensionBlock"));
  }
  node.filter = this.eat(_tokentype.types._if) ? this.parseParenExpression() : null;
  node.body = this.parseExpression();
  this.expect(isGenerator ? _tokentype.types.parenR : _tokentype.types.bracketR);
  node.generator = isGenerator;
  return this.finishNode(node, "ComprehensionExpression");
};

},{"./identifier":2,"./state":10,"./tokentype":14,"./util":15}],2:[function(_dereq_,module,exports){
// This is a trick taken from Esprima. It turns out that, on
// non-Chrome browsers, to check whether a string is in a set, a
// predicate containing a big ugly `switch` statement is faster than
// a regular expression, and on Chrome the two are about on par.
// This function uses `eval` (non-lexical) to produce such a
// predicate from a space-separated string of words.
//
// It starts by sorting the words by length.

"use strict";

exports.__esModule = true;
exports.isIdentifierStart = isIdentifierStart;
exports.isIdentifierChar = isIdentifierChar;
function makePredicate(words) {
  words = words.split(" ");
  var f = "",
      cats = [];
  out: for (var i = 0; i < words.length; ++i) {
    for (var j = 0; j < cats.length; ++j) {
      if (cats[j][0].length == words[i].length) {
        cats[j].push(words[i]);
        continue out;
      }
    }cats.push([words[i]]);
  }
  function compareTo(arr) {
    if (arr.length == 1) return f += "return str === " + JSON.stringify(arr[0]) + ";";
    f += "switch(str){";
    for (var i = 0; i < arr.length; ++i) {
      f += "case " + JSON.stringify(arr[i]) + ":";
    }f += "return true}return false;";
  }

  // When there are more than three length categories, an outer
  // switch first dispatches on the lengths, to save on comparisons.

  if (cats.length > 3) {
    cats.sort(function (a, b) {
      return b.length - a.length;
    });
    f += "switch(str.length){";
    for (var i = 0; i < cats.length; ++i) {
      var cat = cats[i];
      f += "case " + cat[0].length + ":";
      compareTo(cat);
    }
    f += "}";

    // Otherwise, simply generate a flat `switch` statement.
  } else {
      compareTo(words);
    }
  return new Function("str", f);
}

// Reserved word lists for various dialects of the language

var reservedWords = {
  3: makePredicate("abstract boolean byte char class double enum export extends final float goto implements import int interface long native package private protected public short static super synchronized throws transient volatile"),
  5: makePredicate("class enum extends super const export import"),
  6: makePredicate("enum await"),
  strict: makePredicate("implements interface let package private protected public static yield"),
  strictBind: makePredicate("eval arguments")
};

exports.reservedWords = reservedWords;
// And the keywords

var ecma5AndLessKeywords = "break case catch continue debugger default do else finally for function if return switch throw try var while with null true false instanceof typeof void delete new in this";

var keywords = {
  5: makePredicate(ecma5AndLessKeywords),
  6: makePredicate(ecma5AndLessKeywords + " let const class extends export import yield super")
};

exports.keywords = keywords;
// ## Character categories

// Big ugly regular expressions that match characters in the
// whitespace, identifier, and identifier-start categories. These
// are only applied when a character is found to actually have a
// code point above 128.
// Generated by `tools/generate-identifier-regex.js`.

var nonASCIIidentifierStartChars = "ªµºÀ-ÖØ-öø-ˁˆ-ˑˠ-ˤˬˮͰ-ʹͶͷͺ-ͽͿΆΈ-ΊΌΎ-ΡΣ-ϵϷ-ҁҊ-ԯԱ-Ֆՙա-ևא-תװ-ײؠ-يٮٯٱ-ۓەۥۦۮۯۺ-ۼۿܐܒ-ܯݍ-ޥޱߊ-ߪߴߵߺࠀ-ࠕࠚࠤࠨࡀ-ࡘࢠ-ࢲऄ-हऽॐक़-ॡॱ-ঀঅ-ঌএঐও-নপ-রলশ-হঽৎড়ঢ়য়-ৡৰৱਅ-ਊਏਐਓ-ਨਪ-ਰਲਲ਼ਵਸ਼ਸਹਖ਼-ੜਫ਼ੲ-ੴઅ-ઍએ-ઑઓ-નપ-રલળવ-હઽૐૠૡଅ-ଌଏଐଓ-ନପ-ରଲଳଵ-ହଽଡ଼ଢ଼ୟ-ୡୱஃஅ-ஊஎ-ஐஒ-கஙசஜஞடணதந-பம-ஹௐఅ-ఌఎ-ఐఒ-నప-హఽౘౙౠౡಅ-ಌಎ-ಐಒ-ನಪ-ಳವ-ಹಽೞೠೡೱೲഅ-ഌഎ-ഐഒ-ഺഽൎൠൡൺ-ൿඅ-ඖක-නඳ-රලව-ෆก-ะาำเ-ๆກຂຄງຈຊຍດ-ທນ-ຟມ-ຣລວສຫອ-ະາຳຽເ-ໄໆໜ-ໟༀཀ-ཇཉ-ཬྈ-ྌက-ဪဿၐ-ၕၚ-ၝၡၥၦၮ-ၰၵ-ႁႎႠ-ჅჇჍა-ჺჼ-ቈቊ-ቍቐ-ቖቘቚ-ቝበ-ኈኊ-ኍነ-ኰኲ-ኵኸ-ኾዀዂ-ዅወ-ዖዘ-ጐጒ-ጕጘ-ፚᎀ-ᎏᎠ-Ᏼᐁ-ᙬᙯ-ᙿᚁ-ᚚᚠ-ᛪᛮ-ᛸᜀ-ᜌᜎ-ᜑᜠ-ᜱᝀ-ᝑᝠ-ᝬᝮ-ᝰក-ឳៗៜᠠ-ᡷᢀ-ᢨᢪᢰ-ᣵᤀ-ᤞᥐ-ᥭᥰ-ᥴᦀ-ᦫᧁ-ᧇᨀ-ᨖᨠ-ᩔᪧᬅ-ᬳᭅ-ᭋᮃ-ᮠᮮᮯᮺ-ᯥᰀ-ᰣᱍ-ᱏᱚ-ᱽᳩ-ᳬᳮ-ᳱᳵᳶᴀ-ᶿḀ-ἕἘ-Ἕἠ-ὅὈ-Ὅὐ-ὗὙὛὝὟ-ώᾀ-ᾴᾶ-ᾼιῂ-ῄῆ-ῌῐ-ΐῖ-Ίῠ-Ῥῲ-ῴῶ-ῼⁱⁿₐ-ₜℂℇℊ-ℓℕ℘-ℝℤΩℨK-ℹℼ-ℿⅅ-ⅉⅎⅠ-ↈⰀ-Ⱞⰰ-ⱞⱠ-ⳤⳫ-ⳮⳲⳳⴀ-ⴥⴧⴭⴰ-ⵧⵯⶀ-ⶖⶠ-ⶦⶨ-ⶮⶰ-ⶶⶸ-ⶾⷀ-ⷆⷈ-ⷎⷐ-ⷖⷘ-ⷞ々-〇〡-〩〱-〵〸-〼ぁ-ゖ゛-ゟァ-ヺー-ヿㄅ-ㄭㄱ-ㆎㆠ-ㆺㇰ-ㇿ㐀-䶵一-鿌ꀀ-ꒌꓐ-ꓽꔀ-ꘌꘐ-ꘟꘪꘫꙀ-ꙮꙿ-ꚝꚠ-ꛯꜗ-ꜟꜢ-ꞈꞋ-ꞎꞐ-ꞭꞰꞱꟷ-ꠁꠃ-ꠅꠇ-ꠊꠌ-ꠢꡀ-ꡳꢂ-ꢳꣲ-ꣷꣻꤊ-ꤥꤰ-ꥆꥠ-ꥼꦄ-ꦲꧏꧠ-ꧤꧦ-ꧯꧺ-ꧾꨀ-ꨨꩀ-ꩂꩄ-ꩋꩠ-ꩶꩺꩾ-ꪯꪱꪵꪶꪹ-ꪽꫀꫂꫛ-ꫝꫠ-ꫪꫲ-ꫴꬁ-ꬆꬉ-ꬎꬑ-ꬖꬠ-ꬦꬨ-ꬮꬰ-ꭚꭜ-ꭟꭤꭥꯀ-ꯢ가-힣ힰ-ퟆퟋ-ퟻ豈-舘並-龎ﬀ-ﬆﬓ-ﬗיִײַ-ﬨשׁ-זּטּ-לּמּנּסּףּפּצּ-ﮱﯓ-ﴽﵐ-ﶏﶒ-ﷇﷰ-ﷻﹰ-ﹴﹶ-ﻼＡ-Ｚａ-ｚｦ-ﾾￂ-ￇￊ-ￏￒ-ￗￚ-ￜ";
var nonASCIIidentifierChars = "‌‍·̀-ͯ·҃-֑҇-ׇֽֿׁׂׅׄؐ-ًؚ-٩ٰۖ-ۜ۟-۪ۤۧۨ-ۭ۰-۹ܑܰ-݊ަ-ް߀-߉߫-߳ࠖ-࠙ࠛ-ࠣࠥ-ࠧࠩ-࡙࠭-࡛ࣤ-ःऺ-़ा-ॏ॑-ॗॢॣ०-९ঁ-ঃ়া-ৄেৈো-্ৗৢৣ০-৯ਁ-ਃ਼ਾ-ੂੇੈੋ-੍ੑ੦-ੱੵઁ-ઃ઼ા-ૅે-ૉો-્ૢૣ૦-૯ଁ-ଃ଼ା-ୄେୈୋ-୍ୖୗୢୣ୦-୯ஂா-ூெ-ைொ-்ௗ௦-௯ఀ-ఃా-ౄె-ైొ-్ౕౖౢౣ౦-౯ಁ-ಃ಼ಾ-ೄೆ-ೈೊ-್ೕೖೢೣ೦-೯ഁ-ഃാ-ൄെ-ൈൊ-്ൗൢൣ൦-൯ංඃ්ා-ුූෘ-ෟ෦-෯ෲෳัิ-ฺ็-๎๐-๙ັິ-ູົຼ່-ໍ໐-໙༘༙༠-༩༹༵༷༾༿ཱ-྄྆྇ྍ-ྗྙ-ྼ࿆ါ-ှ၀-၉ၖ-ၙၞ-ၠၢ-ၤၧ-ၭၱ-ၴႂ-ႍႏ-ႝ፝-፟፩-፱ᜒ-᜔ᜲ-᜴ᝒᝓᝲᝳ឴-៓៝០-៩᠋-᠍᠐-᠙ᢩᤠ-ᤫᤰ-᤻᥆-᥏ᦰ-ᧀᧈᧉ᧐-᧚ᨗ-ᨛᩕ-ᩞ᩠-᩿᩼-᪉᪐-᪙᪰-᪽ᬀ-ᬄ᬴-᭄᭐-᭙᭫-᭳ᮀ-ᮂᮡ-ᮭ᮰-᮹᯦-᯳ᰤ-᰷᱀-᱉᱐-᱙᳐-᳔᳒-᳨᳭ᳲ-᳴᳸᳹᷀-᷵᷼-᷿‿⁀⁔⃐-⃥⃜⃡-⃰⳯-⵿⳱ⷠ-〪ⷿ-゙゚〯꘠-꘩꙯ꙴ-꙽ꚟ꛰꛱ꠂ꠆ꠋꠣ-ꠧꢀꢁꢴ-꣄꣐-꣙꣠-꣱꤀-꤉ꤦ-꤭ꥇ-꥓ꦀ-ꦃ꦳-꧀꧐-꧙ꧥ꧰-꧹ꨩ-ꨶꩃꩌꩍ꩐-꩙ꩻ-ꩽꪰꪲ-ꪴꪷꪸꪾ꪿꫁ꫫ-ꫯꫵ꫶ꯣ-ꯪ꯬꯭꯰-꯹ﬞ︀-️︠-︭︳︴﹍-﹏０-９＿";

var nonASCIIidentifierStart = new RegExp("[" + nonASCIIidentifierStartChars + "]");
var nonASCIIidentifier = new RegExp("[" + nonASCIIidentifierStartChars + nonASCIIidentifierChars + "]");

nonASCIIidentifierStartChars = nonASCIIidentifierChars = null;

// These are a run-length and offset encoded representation of the
// >0xffff code points that are a valid part of identifiers. The
// offset starts at 0x10000, and each pair of numbers represents an
// offset to the next range, and then a size of the range. They were
// generated by tools/generate-identifier-regex.js
var astralIdentifierStartCodes = [0, 11, 2, 25, 2, 18, 2, 1, 2, 14, 3, 13, 35, 122, 70, 52, 268, 28, 4, 48, 48, 31, 17, 26, 6, 37, 11, 29, 3, 35, 5, 7, 2, 4, 43, 157, 99, 39, 9, 51, 157, 310, 10, 21, 11, 7, 153, 5, 3, 0, 2, 43, 2, 1, 4, 0, 3, 22, 11, 22, 10, 30, 98, 21, 11, 25, 71, 55, 7, 1, 65, 0, 16, 3, 2, 2, 2, 26, 45, 28, 4, 28, 36, 7, 2, 27, 28, 53, 11, 21, 11, 18, 14, 17, 111, 72, 955, 52, 76, 44, 33, 24, 27, 35, 42, 34, 4, 0, 13, 47, 15, 3, 22, 0, 38, 17, 2, 24, 133, 46, 39, 7, 3, 1, 3, 21, 2, 6, 2, 1, 2, 4, 4, 0, 32, 4, 287, 47, 21, 1, 2, 0, 185, 46, 82, 47, 21, 0, 60, 42, 502, 63, 32, 0, 449, 56, 1288, 920, 104, 110, 2962, 1070, 13266, 568, 8, 30, 114, 29, 19, 47, 17, 3, 32, 20, 6, 18, 881, 68, 12, 0, 67, 12, 16481, 1, 3071, 106, 6, 12, 4, 8, 8, 9, 5991, 84, 2, 70, 2, 1, 3, 0, 3, 1, 3, 3, 2, 11, 2, 0, 2, 6, 2, 64, 2, 3, 3, 7, 2, 6, 2, 27, 2, 3, 2, 4, 2, 0, 4, 6, 2, 339, 3, 24, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 7, 4149, 196, 1340, 3, 2, 26, 2, 1, 2, 0, 3, 0, 2, 9, 2, 3, 2, 0, 2, 0, 7, 0, 5, 0, 2, 0, 2, 0, 2, 2, 2, 1, 2, 0, 3, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 1, 2, 0, 3, 3, 2, 6, 2, 3, 2, 3, 2, 0, 2, 9, 2, 16, 6, 2, 2, 4, 2, 16, 4421, 42710, 42, 4148, 12, 221, 16355, 541];
var astralIdentifierCodes = [509, 0, 227, 0, 150, 4, 294, 9, 1368, 2, 2, 1, 6, 3, 41, 2, 5, 0, 166, 1, 1306, 2, 54, 14, 32, 9, 16, 3, 46, 10, 54, 9, 7, 2, 37, 13, 2, 9, 52, 0, 13, 2, 49, 13, 16, 9, 83, 11, 168, 11, 6, 9, 8, 2, 57, 0, 2, 6, 3, 1, 3, 2, 10, 0, 11, 1, 3, 6, 4, 4, 316, 19, 13, 9, 214, 6, 3, 8, 112, 16, 16, 9, 82, 12, 9, 9, 535, 9, 20855, 9, 135, 4, 60, 6, 26, 9, 1016, 45, 17, 3, 19723, 1, 5319, 4, 4, 5, 9, 7, 3, 6, 31, 3, 149, 2, 1418, 49, 4305, 6, 792618, 239];

// This has a complexity linear to the value of the code. The
// assumption is that looking up astral identifier characters is
// rare.
function isInAstralSet(code, set) {
  var pos = 0x10000;
  for (var i = 0; i < set.length; i += 2) {
    pos += set[i];
    if (pos > code) return false;
    pos += set[i + 1];
    if (pos >= code) return true;
  }
}

// Test whether a given character code starts an identifier.

function isIdentifierStart(code, astral) {
  if (code < 65) return code === 36;
  if (code < 91) return true;
  if (code < 97) return code === 95;
  if (code < 123) return true;
  if (code <= 0xffff) return code >= 0xaa && nonASCIIidentifierStart.test(String.fromCharCode(code));
  if (astral === false) return false;
  return isInAstralSet(code, astralIdentifierStartCodes);
}

// Test whether a given character is part of an identifier.

function isIdentifierChar(code, astral) {
  if (code < 48) return code === 36;
  if (code < 58) return true;
  if (code < 65) return false;
  if (code < 91) return true;
  if (code < 97) return code === 95;
  if (code < 123) return true;
  if (code <= 0xffff) return code >= 0xaa && nonASCIIidentifier.test(String.fromCharCode(code));
  if (astral === false) return false;
  return isInAstralSet(code, astralIdentifierStartCodes) || isInAstralSet(code, astralIdentifierCodes);
}

},{}],3:[function(_dereq_,module,exports){
// Acorn is a tiny, fast JavaScript parser written in JavaScript.
//
// Acorn was written by Marijn Haverbeke, Ingvar Stepanyan, and
// various contributors and released under an MIT license.
//
// Git repositories for Acorn are available at
//
//     http://marijnhaverbeke.nl/git/acorn
//     https://github.com/marijnh/acorn.git
//
// Please use the [github bug tracker][ghbt] to report issues.
//
// [ghbt]: https://github.com/marijnh/acorn/issues
//
// This file defines the main parser interface. The library also comes
// with a [error-tolerant parser][dammit] and an
// [abstract syntax tree walker][walk], defined in other files.
//
// [dammit]: acorn_loose.js
// [walk]: util/walk.js

"use strict";

exports.__esModule = true;
exports.parse = parse;
exports.parseExpressionAt = parseExpressionAt;
exports.tokenizer = tokenizer;

var _state = _dereq_("./state");

var _options = _dereq_("./options");

_dereq_("./parseutil");

_dereq_("./statement");

_dereq_("./lval");

_dereq_("./expression");

_dereq_("./location");

exports.Parser = _state.Parser;
exports.plugins = _state.plugins;
exports.defaultOptions = _options.defaultOptions;

var _locutil = _dereq_("./locutil");

exports.Position = _locutil.Position;
exports.SourceLocation = _locutil.SourceLocation;
exports.getLineInfo = _locutil.getLineInfo;

var _node = _dereq_("./node");

exports.Node = _node.Node;

var _tokentype = _dereq_("./tokentype");

exports.TokenType = _tokentype.TokenType;
exports.tokTypes = _tokentype.types;

var _tokencontext = _dereq_("./tokencontext");

exports.TokContext = _tokencontext.TokContext;
exports.tokContexts = _tokencontext.types;

var _identifier = _dereq_("./identifier");

exports.isIdentifierChar = _identifier.isIdentifierChar;
exports.isIdentifierStart = _identifier.isIdentifierStart;

var _tokenize = _dereq_("./tokenize");

exports.Token = _tokenize.Token;

var _whitespace = _dereq_("./whitespace");

exports.isNewLine = _whitespace.isNewLine;
exports.lineBreak = _whitespace.lineBreak;
exports.lineBreakG = _whitespace.lineBreakG;
var version = "2.2.0";

exports.version = version;
// The main exported interface (under `self.acorn` when in the
// browser) is a `parse` function that takes a code string and
// returns an abstract syntax tree as specified by [Mozilla parser
// API][api].
//
// [api]: https://developer.mozilla.org/en-US/docs/SpiderMonkey/Parser_API

function parse(input, options) {
  return new _state.Parser(options, input).parse();
}

// This function tries to parse a single expression at a given
// offset in a string. Useful for parsing mixed-language formats
// that embed JavaScript expressions.

function parseExpressionAt(input, pos, options) {
  var p = new _state.Parser(options, input, pos);
  p.nextToken();
  return p.parseExpression();
}

// Acorn is organized as a tokenizer and a recursive-descent parser.
// The `tokenize` export provides an interface to the tokenizer.

function tokenizer(input, options) {
  return new _state.Parser(options, input);
}

},{"./expression":1,"./identifier":2,"./location":4,"./locutil":5,"./lval":6,"./node":7,"./options":8,"./parseutil":9,"./state":10,"./statement":11,"./tokencontext":12,"./tokenize":13,"./tokentype":14,"./whitespace":16}],4:[function(_dereq_,module,exports){
"use strict";

var _state = _dereq_("./state");

var _locutil = _dereq_("./locutil");

var pp = _state.Parser.prototype;

// This function is used to raise exceptions on parse errors. It
// takes an offset integer (into the current `input`) to indicate
// the location of the error, attaches the position to the end
// of the error message, and then raises a `SyntaxError` with that
// message.

pp.raise = function (pos, message) {
  var loc = _locutil.getLineInfo(this.input, pos);
  message += " (" + loc.line + ":" + loc.column + ")";
  var err = new SyntaxError(message);
  err.pos = pos;err.loc = loc;err.raisedAt = this.pos;
  throw err;
};

pp.curPosition = function () {
  if (this.options.locations) {
    return new _locutil.Position(this.curLine, this.pos - this.lineStart);
  }
};

},{"./locutil":5,"./state":10}],5:[function(_dereq_,module,exports){
"use strict";

exports.__esModule = true;
exports.getLineInfo = getLineInfo;

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var _whitespace = _dereq_("./whitespace");

// These are used when `options.locations` is on, for the
// `startLoc` and `endLoc` properties.

var Position = (function () {
  function Position(line, col) {
    _classCallCheck(this, Position);

    this.line = line;
    this.column = col;
  }

  Position.prototype.offset = function offset(n) {
    return new Position(this.line, this.column + n);
  };

  return Position;
})();

exports.Position = Position;

var SourceLocation = function SourceLocation(p, start, end) {
  _classCallCheck(this, SourceLocation);

  this.start = start;
  this.end = end;
  if (p.sourceFile !== null) this.source = p.sourceFile;
}

// The `getLineInfo` function is mostly useful when the
// `locations` option is off (for performance reasons) and you
// want to find the line/column position for a given character
// offset. `input` should be the code string that the offset refers
// into.

;

exports.SourceLocation = SourceLocation;

function getLineInfo(input, offset) {
  for (var line = 1, cur = 0;;) {
    _whitespace.lineBreakG.lastIndex = cur;
    var match = _whitespace.lineBreakG.exec(input);
    if (match && match.index < offset) {
      ++line;
      cur = match.index + match[0].length;
    } else {
      return new Position(line, offset - cur);
    }
  }
}

},{"./whitespace":16}],6:[function(_dereq_,module,exports){
"use strict";

var _tokentype = _dereq_("./tokentype");

var _state = _dereq_("./state");

var _identifier = _dereq_("./identifier");

var _util = _dereq_("./util");

var pp = _state.Parser.prototype;

// Convert existing expression atom to assignable pattern
// if possible.

pp.toAssignable = function (node, isBinding) {
  if (this.options.ecmaVersion >= 6 && node) {
    switch (node.type) {
      case "Identifier":
      case "ObjectPattern":
      case "ArrayPattern":
      case "AssignmentPattern":
        break;

      case "ObjectExpression":
        node.type = "ObjectPattern";
        for (var i = 0; i < node.properties.length; i++) {
          var prop = node.properties[i];
          if (prop.kind !== "init") this.raise(prop.key.start, "Object pattern can't contain getter or setter");
          this.toAssignable(prop.value, isBinding);
        }
        break;

      case "ArrayExpression":
        node.type = "ArrayPattern";
        this.toAssignableList(node.elements, isBinding);
        break;

      case "AssignmentExpression":
        if (node.operator === "=") {
          node.type = "AssignmentPattern";
          delete node.operator;
        } else {
          this.raise(node.left.end, "Only '=' operator can be used for specifying default value.");
        }
        break;

      case "ParenthesizedExpression":
        node.expression = this.toAssignable(node.expression, isBinding);
        break;

      case "MemberExpression":
        if (!isBinding) break;

      default:
        this.raise(node.start, "Assigning to rvalue");
    }
  }
  return node;
};

// Convert list of expression atoms to binding list.

pp.toAssignableList = function (exprList, isBinding) {
  var end = exprList.length;
  if (end) {
    var last = exprList[end - 1];
    if (last && last.type == "RestElement") {
      --end;
    } else if (last && last.type == "SpreadElement") {
      last.type = "RestElement";
      var arg = last.argument;
      this.toAssignable(arg, isBinding);
      if (arg.type !== "Identifier" && arg.type !== "MemberExpression" && arg.type !== "ArrayPattern") this.unexpected(arg.start);
      --end;
    }
  }
  for (var i = 0; i < end; i++) {
    var elt = exprList[i];
    if (elt) this.toAssignable(elt, isBinding);
  }
  return exprList;
};

// Parses spread element.

pp.parseSpread = function (refShorthandDefaultPos) {
  var node = this.startNode();
  this.next();
  node.argument = this.parseMaybeAssign(refShorthandDefaultPos);
  return this.finishNode(node, "SpreadElement");
};

pp.parseRest = function () {
  var node = this.startNode();
  this.next();
  node.argument = this.type === _tokentype.types.name || this.type === _tokentype.types.bracketL ? this.parseBindingAtom() : this.unexpected();
  return this.finishNode(node, "RestElement");
};

// Parses lvalue (assignable) atom.

pp.parseBindingAtom = function () {
  if (this.options.ecmaVersion < 6) return this.parseIdent();
  switch (this.type) {
    case _tokentype.types.name:
      return this.parseIdent();

    case _tokentype.types.bracketL:
      var node = this.startNode();
      this.next();
      node.elements = this.parseBindingList(_tokentype.types.bracketR, true, true);
      return this.finishNode(node, "ArrayPattern");

    case _tokentype.types.braceL:
      return this.parseObj(true);

    default:
      this.unexpected();
  }
};

pp.parseBindingList = function (close, allowEmpty, allowTrailingComma) {
  var elts = [],
      first = true;
  while (!this.eat(close)) {
    if (first) first = false;else this.expect(_tokentype.types.comma);
    if (allowEmpty && this.type === _tokentype.types.comma) {
      elts.push(null);
    } else if (allowTrailingComma && this.afterTrailingComma(close)) {
      break;
    } else if (this.type === _tokentype.types.ellipsis) {
      var rest = this.parseRest();
      this.parseBindingListItem(rest);
      elts.push(rest);
      this.expect(close);
      break;
    } else {
      var elem = this.parseMaybeDefault(this.start, this.startLoc);
      this.parseBindingListItem(elem);
      elts.push(elem);
    }
  }
  return elts;
};

pp.parseBindingListItem = function (param) {
  return param;
};

// Parses assignment pattern around given atom if possible.

pp.parseMaybeDefault = function (startPos, startLoc, left) {
  left = left || this.parseBindingAtom();
  if (!this.eat(_tokentype.types.eq)) return left;
  var node = this.startNodeAt(startPos, startLoc);
  node.left = left;
  node.right = this.parseMaybeAssign();
  return this.finishNode(node, "AssignmentPattern");
};

// Verify that a node is an lval — something that can be assigned
// to.

pp.checkLVal = function (expr, isBinding, checkClashes) {
  switch (expr.type) {
    case "Identifier":
      if (this.strict && (_identifier.reservedWords.strictBind(expr.name) || _identifier.reservedWords.strict(expr.name))) this.raise(expr.start, (isBinding ? "Binding " : "Assigning to ") + expr.name + " in strict mode");
      if (checkClashes) {
        if (_util.has(checkClashes, expr.name)) this.raise(expr.start, "Argument name clash in strict mode");
        checkClashes[expr.name] = true;
      }
      break;

    case "MemberExpression":
      if (isBinding) this.raise(expr.start, (isBinding ? "Binding" : "Assigning to") + " member expression");
      break;

    case "ObjectPattern":
      for (var i = 0; i < expr.properties.length; i++) {
        this.checkLVal(expr.properties[i].value, isBinding, checkClashes);
      }break;

    case "ArrayPattern":
      for (var i = 0; i < expr.elements.length; i++) {
        var elem = expr.elements[i];
        if (elem) this.checkLVal(elem, isBinding, checkClashes);
      }
      break;

    case "AssignmentPattern":
      this.checkLVal(expr.left, isBinding, checkClashes);
      break;

    case "RestElement":
      this.checkLVal(expr.argument, isBinding, checkClashes);
      break;

    case "ParenthesizedExpression":
      this.checkLVal(expr.expression, isBinding, checkClashes);
      break;

    default:
      this.raise(expr.start, (isBinding ? "Binding" : "Assigning to") + " rvalue");
  }
};

},{"./identifier":2,"./state":10,"./tokentype":14,"./util":15}],7:[function(_dereq_,module,exports){
"use strict";

exports.__esModule = true;

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var _state = _dereq_("./state");

var _locutil = _dereq_("./locutil");

var Node = function Node(parser, pos, loc) {
  _classCallCheck(this, Node);

  this.type = "";
  this.start = pos;
  this.end = 0;
  if (parser.options.locations) this.loc = new _locutil.SourceLocation(parser, loc);
  if (parser.options.directSourceFile) this.sourceFile = parser.options.directSourceFile;
  if (parser.options.ranges) this.range = [pos, 0];
}

// Start an AST node, attaching a start offset.

;

exports.Node = Node;
var pp = _state.Parser.prototype;

pp.startNode = function () {
  return new Node(this, this.start, this.startLoc);
};

pp.startNodeAt = function (pos, loc) {
  return new Node(this, pos, loc);
};

// Finish an AST node, adding `type` and `end` properties.

function finishNodeAt(node, type, pos, loc) {
  node.type = type;
  node.end = pos;
  if (this.options.locations) node.loc.end = loc;
  if (this.options.ranges) node.range[1] = pos;
  return node;
}

pp.finishNode = function (node, type) {
  return finishNodeAt.call(this, node, type, this.lastTokEnd, this.lastTokEndLoc);
};

// Finish node at given position

pp.finishNodeAt = function (node, type, pos, loc) {
  return finishNodeAt.call(this, node, type, pos, loc);
};

},{"./locutil":5,"./state":10}],8:[function(_dereq_,module,exports){
"use strict";

exports.__esModule = true;
exports.getOptions = getOptions;

var _util = _dereq_("./util");

var _locutil = _dereq_("./locutil");

// A second optional argument can be given to further configure
// the parser process. These options are recognized:

var defaultOptions = {
  // `ecmaVersion` indicates the ECMAScript version to parse. Must
  // be either 3, or 5, or 6. This influences support for strict
  // mode, the set of reserved words, support for getters and
  // setters and other features.
  ecmaVersion: 5,
  // Source type ("script" or "module") for different semantics
  sourceType: "script",
  // `onInsertedSemicolon` can be a callback that will be called
  // when a semicolon is automatically inserted. It will be passed
  // th position of the comma as an offset, and if `locations` is
  // enabled, it is given the location as a `{line, column}` object
  // as second argument.
  onInsertedSemicolon: null,
  // `onTrailingComma` is similar to `onInsertedSemicolon`, but for
  // trailing commas.
  onTrailingComma: null,
  // By default, reserved words are not enforced. Disable
  // `allowReserved` to enforce them. When this option has the
  // value "never", reserved words and keywords can also not be
  // used as property names.
  allowReserved: true,
  // When enabled, a return at the top level is not considered an
  // error.
  allowReturnOutsideFunction: false,
  // When enabled, import/export statements are not constrained to
  // appearing at the top of the program.
  allowImportExportEverywhere: false,
  // When enabled, hashbang directive in the beginning of file
  // is allowed and treated as a line comment.
  allowHashBang: false,
  // When `locations` is on, `loc` properties holding objects with
  // `start` and `end` properties in `{line, column}` form (with
  // line being 1-based and column 0-based) will be attached to the
  // nodes.
  locations: false,
  // A function can be passed as `onToken` option, which will
  // cause Acorn to call that function with object in the same
  // format as tokenize() returns. Note that you are not
  // allowed to call the parser from the callback—that will
  // corrupt its internal state.
  onToken: null,
  // A function can be passed as `onComment` option, which will
  // cause Acorn to call that function with `(block, text, start,
  // end)` parameters whenever a comment is skipped. `block` is a
  // boolean indicating whether this is a block (`/* */`) comment,
  // `text` is the content of the comment, and `start` and `end` are
  // character offsets that denote the start and end of the comment.
  // When the `locations` option is on, two more parameters are
  // passed, the full `{line, column}` locations of the start and
  // end of the comments. Note that you are not allowed to call the
  // parser from the callback—that will corrupt its internal state.
  onComment: null,
  // Nodes have their start and end characters offsets recorded in
  // `start` and `end` properties (directly on the node, rather than
  // the `loc` object, which holds line/column data. To also add a
  // [semi-standardized][range] `range` property holding a `[start,
  // end]` array with the same numbers, set the `ranges` option to
  // `true`.
  //
  // [range]: https://bugzilla.mozilla.org/show_bug.cgi?id=745678
  ranges: false,
  // It is possible to parse multiple files into a single AST by
  // passing the tree produced by parsing the first file as
  // `program` option in subsequent parses. This will add the
  // toplevel forms of the parsed file to the `Program` (top) node
  // of an existing parse tree.
  program: null,
  // When `locations` is on, you can pass this to record the source
  // file in every node's `loc` object.
  sourceFile: null,
  // This value, if given, is stored in every node, whether
  // `locations` is on or off.
  directSourceFile: null,
  // When enabled, parenthesized expressions are represented by
  // (non-standard) ParenthesizedExpression nodes
  preserveParens: false,
  plugins: {}
};

exports.defaultOptions = defaultOptions;
// Interpret and default an options object

function getOptions(opts) {
  var options = {};
  for (var opt in defaultOptions) {
    options[opt] = opts && _util.has(opts, opt) ? opts[opt] : defaultOptions[opt];
  }if (_util.isArray(options.onToken)) {
    (function () {
      var tokens = options.onToken;
      options.onToken = function (token) {
        return tokens.push(token);
      };
    })();
  }
  if (_util.isArray(options.onComment)) options.onComment = pushComment(options, options.onComment);

  return options;
}

function pushComment(options, array) {
  return function (block, text, start, end, startLoc, endLoc) {
    var comment = {
      type: block ? 'Block' : 'Line',
      value: text,
      start: start,
      end: end
    };
    if (options.locations) comment.loc = new _locutil.SourceLocation(this, startLoc, endLoc);
    if (options.ranges) comment.range = [start, end];
    array.push(comment);
  };
}

},{"./locutil":5,"./util":15}],9:[function(_dereq_,module,exports){
"use strict";

var _tokentype = _dereq_("./tokentype");

var _state = _dereq_("./state");

var _whitespace = _dereq_("./whitespace");

var pp = _state.Parser.prototype;

// ## Parser utilities

// Test whether a statement node is the string literal `"use strict"`.

pp.isUseStrict = function (stmt) {
  return this.options.ecmaVersion >= 5 && stmt.type === "ExpressionStatement" && stmt.expression.type === "Literal" && stmt.expression.raw.slice(1, -1) === "use strict";
};

// Predicate that tests whether the next token is of the given
// type, and if yes, consumes it as a side effect.

pp.eat = function (type) {
  if (this.type === type) {
    this.next();
    return true;
  } else {
    return false;
  }
};

// Tests whether parsed token is a contextual keyword.

pp.isContextual = function (name) {
  return this.type === _tokentype.types.name && this.value === name;
};

// Consumes contextual keyword if possible.

pp.eatContextual = function (name) {
  return this.value === name && this.eat(_tokentype.types.name);
};

// Asserts that following token is given contextual keyword.

pp.expectContextual = function (name) {
  if (!this.eatContextual(name)) this.unexpected();
};

// Test whether a semicolon can be inserted at the current position.

pp.canInsertSemicolon = function () {
  return this.type === _tokentype.types.eof || this.type === _tokentype.types.braceR || _whitespace.lineBreak.test(this.input.slice(this.lastTokEnd, this.start));
};

pp.insertSemicolon = function () {
  if (this.canInsertSemicolon()) {
    if (this.options.onInsertedSemicolon) this.options.onInsertedSemicolon(this.lastTokEnd, this.lastTokEndLoc);
    return true;
  }
};

// Consume a semicolon, or, failing that, see if we are allowed to
// pretend that there is a semicolon at this position.

pp.semicolon = function () {
  if (!this.eat(_tokentype.types.semi) && !this.insertSemicolon()) this.unexpected();
};

pp.afterTrailingComma = function (tokType) {
  if (this.type == tokType) {
    if (this.options.onTrailingComma) this.options.onTrailingComma(this.lastTokStart, this.lastTokStartLoc);
    this.next();
    return true;
  }
};

// Expect a token of a given type. If found, consume it, otherwise,
// raise an unexpected token error.

pp.expect = function (type) {
  this.eat(type) || this.unexpected();
};

// Raise an unexpected token error.

pp.unexpected = function (pos) {
  this.raise(pos != null ? pos : this.start, "Unexpected token");
};

},{"./state":10,"./tokentype":14,"./whitespace":16}],10:[function(_dereq_,module,exports){
"use strict";

exports.__esModule = true;

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var _identifier = _dereq_("./identifier");

var _tokentype = _dereq_("./tokentype");

var _whitespace = _dereq_("./whitespace");

var _options = _dereq_("./options");

// Registered plugins
var plugins = {};

exports.plugins = plugins;

var Parser = (function () {
  function Parser(options, input, startPos) {
    _classCallCheck(this, Parser);

    this.options = _options.getOptions(options);
    this.sourceFile = this.options.sourceFile;
    this.isKeyword = _identifier.keywords[this.options.ecmaVersion >= 6 ? 6 : 5];
    this.isReservedWord = _identifier.reservedWords[this.options.ecmaVersion];
    this.input = String(input);

    // Used to signal to callers of `readWord1` whether the word
    // contained any escape sequences. This is needed because words with
    // escape sequences must not be interpreted as keywords.
    this.containsEsc = false;

    // Load plugins
    this.loadPlugins(this.options.plugins);

    // Set up token state

    // The current position of the tokenizer in the input.
    if (startPos) {
      this.pos = startPos;
      this.lineStart = Math.max(0, this.input.lastIndexOf("\n", startPos));
      this.curLine = this.input.slice(0, this.lineStart).split(_whitespace.lineBreak).length;
    } else {
      this.pos = this.lineStart = 0;
      this.curLine = 1;
    }

    // Properties of the current token:
    // Its type
    this.type = _tokentype.types.eof;
    // For tokens that include more information than their type, the value
    this.value = null;
    // Its start and end offset
    this.start = this.end = this.pos;
    // And, if locations are used, the {line, column} object
    // corresponding to those offsets
    this.startLoc = this.endLoc = this.curPosition();

    // Position information for the previous token
    this.lastTokEndLoc = this.lastTokStartLoc = null;
    this.lastTokStart = this.lastTokEnd = this.pos;

    // The context stack is used to superficially track syntactic
    // context to predict whether a regular expression is allowed in a
    // given position.
    this.context = this.initialContext();
    this.exprAllowed = true;

    // Figure out if it's a module code.
    this.strict = this.inModule = this.options.sourceType === "module";

    // Used to signify the start of a potential arrow function
    this.potentialArrowAt = -1;

    // Flags to track whether we are in a function, a generator.
    this.inFunction = this.inGenerator = false;
    // Labels in scope.
    this.labels = [];

    // If enabled, skip leading hashbang line.
    if (this.pos === 0 && this.options.allowHashBang && this.input.slice(0, 2) === '#!') this.skipLineComment(2);
  }

  Parser.prototype.extend = function extend(name, f) {
    this[name] = f(this[name]);
  };

  Parser.prototype.loadPlugins = function loadPlugins(pluginConfigs) {
    for (var _name in pluginConfigs) {
      var plugin = plugins[_name];
      if (!plugin) throw new Error("Plugin '" + _name + "' not found");
      plugin(this, pluginConfigs[_name]);
    }
  };

  Parser.prototype.parse = function parse() {
    var node = this.options.program || this.startNode();
    this.nextToken();
    return this.parseTopLevel(node);
  };

  return Parser;
})();

exports.Parser = Parser;

},{"./identifier":2,"./options":8,"./tokentype":14,"./whitespace":16}],11:[function(_dereq_,module,exports){
"use strict";

var _tokentype = _dereq_("./tokentype");

var _state = _dereq_("./state");

var _whitespace = _dereq_("./whitespace");

var pp = _state.Parser.prototype;

// ### Statement parsing

// Parse a program. Initializes the parser, reads any number of
// statements, and wraps them in a Program node.  Optionally takes a
// `program` argument.  If present, the statements will be appended
// to its body instead of creating a new node.

pp.parseTopLevel = function (node) {
  var first = true;
  if (!node.body) node.body = [];
  while (this.type !== _tokentype.types.eof) {
    var stmt = this.parseStatement(true, true);
    node.body.push(stmt);
    if (first) {
      if (this.isUseStrict(stmt)) this.setStrict(true);
      first = false;
    }
  }
  this.next();
  if (this.options.ecmaVersion >= 6) {
    node.sourceType = this.options.sourceType;
  }
  return this.finishNode(node, "Program");
};

var loopLabel = { kind: "loop" },
    switchLabel = { kind: "switch" };

// Parse a single statement.
//
// If expecting a statement and finding a slash operator, parse a
// regular expression literal. This is to handle cases like
// `if (foo) /blah/.exec(foo)`, where looking at the previous token
// does not help.

pp.parseStatement = function (declaration, topLevel) {
  var starttype = this.type,
      node = this.startNode();

  // Most types of statements are recognized by the keyword they
  // start with. Many are trivial to parse, some require a bit of
  // complexity.

  switch (starttype) {
    case _tokentype.types._break:case _tokentype.types._continue:
      return this.parseBreakContinueStatement(node, starttype.keyword);
    case _tokentype.types._debugger:
      return this.parseDebuggerStatement(node);
    case _tokentype.types._do:
      return this.parseDoStatement(node);
    case _tokentype.types._for:
      return this.parseForStatement(node);
    case _tokentype.types._function:
      if (!declaration && this.options.ecmaVersion >= 6) this.unexpected();
      return this.parseFunctionStatement(node);
    case _tokentype.types._class:
      if (!declaration) this.unexpected();
      return this.parseClass(node, true);
    case _tokentype.types._if:
      return this.parseIfStatement(node);
    case _tokentype.types._return:
      return this.parseReturnStatement(node);
    case _tokentype.types._switch:
      return this.parseSwitchStatement(node);
    case _tokentype.types._throw:
      return this.parseThrowStatement(node);
    case _tokentype.types._try:
      return this.parseTryStatement(node);
    case _tokentype.types._let:case _tokentype.types._const:
      if (!declaration) this.unexpected(); // NOTE: falls through to _var
    case _tokentype.types._var:
      return this.parseVarStatement(node, starttype);
    case _tokentype.types._while:
      return this.parseWhileStatement(node);
    case _tokentype.types._with:
      return this.parseWithStatement(node);
    case _tokentype.types.braceL:
      return this.parseBlock();
    case _tokentype.types.semi:
      return this.parseEmptyStatement(node);
    case _tokentype.types._export:
    case _tokentype.types._import:
      if (!this.options.allowImportExportEverywhere) {
        if (!topLevel) this.raise(this.start, "'import' and 'export' may only appear at the top level");
        if (!this.inModule) this.raise(this.start, "'import' and 'export' may appear only with 'sourceType: module'");
      }
      return starttype === _tokentype.types._import ? this.parseImport(node) : this.parseExport(node);

    // If the statement does not start with a statement keyword or a
    // brace, it's an ExpressionStatement or LabeledStatement. We
    // simply start parsing an expression, and afterwards, if the
    // next token is a colon and the expression was a simple
    // Identifier node, we switch to interpreting it as a label.
    default:
      var maybeName = this.value,
          expr = this.parseExpression();
      if (starttype === _tokentype.types.name && expr.type === "Identifier" && this.eat(_tokentype.types.colon)) return this.parseLabeledStatement(node, maybeName, expr);else return this.parseExpressionStatement(node, expr);
  }
};

pp.parseBreakContinueStatement = function (node, keyword) {
  var isBreak = keyword == "break";
  this.next();
  if (this.eat(_tokentype.types.semi) || this.insertSemicolon()) node.label = null;else if (this.type !== _tokentype.types.name) this.unexpected();else {
    node.label = this.parseIdent();
    this.semicolon();
  }

  // Verify that there is an actual destination to break or
  // continue to.
  for (var i = 0; i < this.labels.length; ++i) {
    var lab = this.labels[i];
    if (node.label == null || lab.name === node.label.name) {
      if (lab.kind != null && (isBreak || lab.kind === "loop")) break;
      if (node.label && isBreak) break;
    }
  }
  if (i === this.labels.length) this.raise(node.start, "Unsyntactic " + keyword);
  return this.finishNode(node, isBreak ? "BreakStatement" : "ContinueStatement");
};

pp.parseDebuggerStatement = function (node) {
  this.next();
  this.semicolon();
  return this.finishNode(node, "DebuggerStatement");
};

pp.parseDoStatement = function (node) {
  this.next();
  this.labels.push(loopLabel);
  node.body = this.parseStatement(false);
  this.labels.pop();
  this.expect(_tokentype.types._while);
  node.test = this.parseParenExpression();
  if (this.options.ecmaVersion >= 6) this.eat(_tokentype.types.semi);else this.semicolon();
  return this.finishNode(node, "DoWhileStatement");
};

// Disambiguating between a `for` and a `for`/`in` or `for`/`of`
// loop is non-trivial. Basically, we have to parse the init `var`
// statement or expression, disallowing the `in` operator (see
// the second parameter to `parseExpression`), and then check
// whether the next token is `in` or `of`. When there is no init
// part (semicolon immediately after the opening parenthesis), it
// is a regular `for` loop.

pp.parseForStatement = function (node) {
  this.next();
  this.labels.push(loopLabel);
  this.expect(_tokentype.types.parenL);
  if (this.type === _tokentype.types.semi) return this.parseFor(node, null);
  if (this.type === _tokentype.types._var || this.type === _tokentype.types._let || this.type === _tokentype.types._const) {
    var _init = this.startNode(),
        varKind = this.type;
    this.next();
    this.parseVar(_init, true, varKind);
    this.finishNode(_init, "VariableDeclaration");
    if ((this.type === _tokentype.types._in || this.options.ecmaVersion >= 6 && this.isContextual("of")) && _init.declarations.length === 1 && !(varKind !== _tokentype.types._var && _init.declarations[0].init)) return this.parseForIn(node, _init);
    return this.parseFor(node, _init);
  }
  var refShorthandDefaultPos = { start: 0 };
  var init = this.parseExpression(true, refShorthandDefaultPos);
  if (this.type === _tokentype.types._in || this.options.ecmaVersion >= 6 && this.isContextual("of")) {
    this.toAssignable(init);
    this.checkLVal(init);
    return this.parseForIn(node, init);
  } else if (refShorthandDefaultPos.start) {
    this.unexpected(refShorthandDefaultPos.start);
  }
  return this.parseFor(node, init);
};

pp.parseFunctionStatement = function (node) {
  this.next();
  return this.parseFunction(node, true);
};

pp.parseIfStatement = function (node) {
  this.next();
  node.test = this.parseParenExpression();
  node.consequent = this.parseStatement(false);
  node.alternate = this.eat(_tokentype.types._else) ? this.parseStatement(false) : null;
  return this.finishNode(node, "IfStatement");
};

pp.parseReturnStatement = function (node) {
  if (!this.inFunction && !this.options.allowReturnOutsideFunction) this.raise(this.start, "'return' outside of function");
  this.next();

  // In `return` (and `break`/`continue`), the keywords with
  // optional arguments, we eagerly look for a semicolon or the
  // possibility to insert one.

  if (this.eat(_tokentype.types.semi) || this.insertSemicolon()) node.argument = null;else {
    node.argument = this.parseExpression();this.semicolon();
  }
  return this.finishNode(node, "ReturnStatement");
};

pp.parseSwitchStatement = function (node) {
  this.next();
  node.discriminant = this.parseParenExpression();
  node.cases = [];
  this.expect(_tokentype.types.braceL);
  this.labels.push(switchLabel);

  // Statements under must be grouped (by label) in SwitchCase
  // nodes. `cur` is used to keep the node that we are currently
  // adding statements to.

  for (var cur, sawDefault = false; this.type != _tokentype.types.braceR;) {
    if (this.type === _tokentype.types._case || this.type === _tokentype.types._default) {
      var isCase = this.type === _tokentype.types._case;
      if (cur) this.finishNode(cur, "SwitchCase");
      node.cases.push(cur = this.startNode());
      cur.consequent = [];
      this.next();
      if (isCase) {
        cur.test = this.parseExpression();
      } else {
        if (sawDefault) this.raise(this.lastTokStart, "Multiple default clauses");
        sawDefault = true;
        cur.test = null;
      }
      this.expect(_tokentype.types.colon);
    } else {
      if (!cur) this.unexpected();
      cur.consequent.push(this.parseStatement(true));
    }
  }
  if (cur) this.finishNode(cur, "SwitchCase");
  this.next(); // Closing brace
  this.labels.pop();
  return this.finishNode(node, "SwitchStatement");
};

pp.parseThrowStatement = function (node) {
  this.next();
  if (_whitespace.lineBreak.test(this.input.slice(this.lastTokEnd, this.start))) this.raise(this.lastTokEnd, "Illegal newline after throw");
  node.argument = this.parseExpression();
  this.semicolon();
  return this.finishNode(node, "ThrowStatement");
};

// Reused empty array added for node fields that are always empty.

var empty = [];

pp.parseTryStatement = function (node) {
  this.next();
  node.block = this.parseBlock();
  node.handler = null;
  if (this.type === _tokentype.types._catch) {
    var clause = this.startNode();
    this.next();
    this.expect(_tokentype.types.parenL);
    clause.param = this.parseBindingAtom();
    this.checkLVal(clause.param, true);
    this.expect(_tokentype.types.parenR);
    clause.guard = null;
    clause.body = this.parseBlock();
    node.handler = this.finishNode(clause, "CatchClause");
  }
  node.guardedHandlers = empty;
  node.finalizer = this.eat(_tokentype.types._finally) ? this.parseBlock() : null;
  if (!node.handler && !node.finalizer) this.raise(node.start, "Missing catch or finally clause");
  return this.finishNode(node, "TryStatement");
};

pp.parseVarStatement = function (node, kind) {
  this.next();
  this.parseVar(node, false, kind);
  this.semicolon();
  return this.finishNode(node, "VariableDeclaration");
};

pp.parseWhileStatement = function (node) {
  this.next();
  node.test = this.parseParenExpression();
  this.labels.push(loopLabel);
  node.body = this.parseStatement(false);
  this.labels.pop();
  return this.finishNode(node, "WhileStatement");
};

pp.parseWithStatement = function (node) {
  if (this.strict) this.raise(this.start, "'with' in strict mode");
  this.next();
  node.object = this.parseParenExpression();
  node.body = this.parseStatement(false);
  return this.finishNode(node, "WithStatement");
};

pp.parseEmptyStatement = function (node) {
  this.next();
  return this.finishNode(node, "EmptyStatement");
};

pp.parseLabeledStatement = function (node, maybeName, expr) {
  for (var i = 0; i < this.labels.length; ++i) {
    if (this.labels[i].name === maybeName) this.raise(expr.start, "Label '" + maybeName + "' is already declared");
  }var kind = this.type.isLoop ? "loop" : this.type === _tokentype.types._switch ? "switch" : null;
  for (var i = this.labels.length - 1; i >= 0; i--) {
    var label = this.labels[i];
    if (label.statementStart == node.start) {
      label.statementStart = this.start;
      label.kind = kind;
    } else break;
  }
  this.labels.push({ name: maybeName, kind: kind, statementStart: this.start });
  node.body = this.parseStatement(true);
  this.labels.pop();
  node.label = expr;
  return this.finishNode(node, "LabeledStatement");
};

pp.parseExpressionStatement = function (node, expr) {
  node.expression = expr;
  this.semicolon();
  return this.finishNode(node, "ExpressionStatement");
};

// Parse a semicolon-enclosed block of statements, handling `"use
// strict"` declarations when `allowStrict` is true (used for
// function bodies).

pp.parseBlock = function (allowStrict) {
  var node = this.startNode(),
      first = true,
      oldStrict = undefined;
  node.body = [];
  this.expect(_tokentype.types.braceL);
  while (!this.eat(_tokentype.types.braceR)) {
    var stmt = this.parseStatement(true);
    node.body.push(stmt);
    if (first && allowStrict && this.isUseStrict(stmt)) {
      oldStrict = this.strict;
      this.setStrict(this.strict = true);
    }
    first = false;
  }
  if (oldStrict === false) this.setStrict(false);
  return this.finishNode(node, "BlockStatement");
};

// Parse a regular `for` loop. The disambiguation code in
// `parseStatement` will already have parsed the init statement or
// expression.

pp.parseFor = function (node, init) {
  node.init = init;
  this.expect(_tokentype.types.semi);
  node.test = this.type === _tokentype.types.semi ? null : this.parseExpression();
  this.expect(_tokentype.types.semi);
  node.update = this.type === _tokentype.types.parenR ? null : this.parseExpression();
  this.expect(_tokentype.types.parenR);
  node.body = this.parseStatement(false);
  this.labels.pop();
  return this.finishNode(node, "ForStatement");
};

// Parse a `for`/`in` and `for`/`of` loop, which are almost
// same from parser's perspective.

pp.parseForIn = function (node, init) {
  var type = this.type === _tokentype.types._in ? "ForInStatement" : "ForOfStatement";
  this.next();
  node.left = init;
  node.right = this.parseExpression();
  this.expect(_tokentype.types.parenR);
  node.body = this.parseStatement(false);
  this.labels.pop();
  return this.finishNode(node, type);
};

// Parse a list of variable declarations.

pp.parseVar = function (node, isFor, kind) {
  node.declarations = [];
  node.kind = kind.keyword;
  for (;;) {
    var decl = this.startNode();
    this.parseVarId(decl);
    if (this.eat(_tokentype.types.eq)) {
      decl.init = this.parseMaybeAssign(isFor);
    } else if (kind === _tokentype.types._const && !(this.type === _tokentype.types._in || this.options.ecmaVersion >= 6 && this.isContextual("of"))) {
      this.unexpected();
    } else if (decl.id.type != "Identifier" && !(isFor && (this.type === _tokentype.types._in || this.isContextual("of")))) {
      this.raise(this.lastTokEnd, "Complex binding patterns require an initialization value");
    } else {
      decl.init = null;
    }
    node.declarations.push(this.finishNode(decl, "VariableDeclarator"));
    if (!this.eat(_tokentype.types.comma)) break;
  }
  return node;
};

pp.parseVarId = function (decl) {
  decl.id = this.parseBindingAtom();
  this.checkLVal(decl.id, true);
};

// Parse a function declaration or literal (depending on the
// `isStatement` parameter).

pp.parseFunction = function (node, isStatement, allowExpressionBody) {
  this.initFunction(node);
  if (this.options.ecmaVersion >= 6) node.generator = this.eat(_tokentype.types.star);
  if (isStatement || this.type === _tokentype.types.name) node.id = this.parseIdent();
  this.parseFunctionParams(node);
  this.parseFunctionBody(node, allowExpressionBody);
  return this.finishNode(node, isStatement ? "FunctionDeclaration" : "FunctionExpression");
};

pp.parseFunctionParams = function (node) {
  this.expect(_tokentype.types.parenL);
  node.params = this.parseBindingList(_tokentype.types.parenR, false, false);
};

// Parse a class declaration or literal (depending on the
// `isStatement` parameter).

pp.parseClass = function (node, isStatement) {
  this.next();
  this.parseClassId(node, isStatement);
  this.parseClassSuper(node);
  var classBody = this.startNode();
  var hadConstructor = false;
  classBody.body = [];
  this.expect(_tokentype.types.braceL);
  while (!this.eat(_tokentype.types.braceR)) {
    if (this.eat(_tokentype.types.semi)) continue;
    var method = this.startNode();
    var isGenerator = this.eat(_tokentype.types.star);
    var isMaybeStatic = this.type === _tokentype.types.name && this.value === "static";
    this.parsePropertyName(method);
    method["static"] = isMaybeStatic && this.type !== _tokentype.types.parenL;
    if (method["static"]) {
      if (isGenerator) this.unexpected();
      isGenerator = this.eat(_tokentype.types.star);
      this.parsePropertyName(method);
    }
    method.kind = "method";
    var isGetSet = false;
    if (!method.computed) {
      var key = method.key;

      if (!isGenerator && key.type === "Identifier" && this.type !== _tokentype.types.parenL && (key.name === "get" || key.name === "set")) {
        isGetSet = true;
        method.kind = key.name;
        key = this.parsePropertyName(method);
      }
      if (!method["static"] && (key.type === "Identifier" && key.name === "constructor" || key.type === "Literal" && key.value === "constructor")) {
        if (hadConstructor) this.raise(key.start, "Duplicate constructor in the same class");
        if (isGetSet) this.raise(key.start, "Constructor can't have get/set modifier");
        if (isGenerator) this.raise(key.start, "Constructor can't be a generator");
        method.kind = "constructor";
        hadConstructor = true;
      }
    }
    this.parseClassMethod(classBody, method, isGenerator);
    if (isGetSet) {
      var paramCount = method.kind === "get" ? 0 : 1;
      if (method.value.params.length !== paramCount) {
        var start = method.value.start;
        if (method.kind === "get") this.raise(start, "getter should have no params");else this.raise(start, "setter should have exactly one param");
      }
    }
  }
  node.body = this.finishNode(classBody, "ClassBody");
  return this.finishNode(node, isStatement ? "ClassDeclaration" : "ClassExpression");
};

pp.parseClassMethod = function (classBody, method, isGenerator) {
  method.value = this.parseMethod(isGenerator);
  classBody.body.push(this.finishNode(method, "MethodDefinition"));
};

pp.parseClassId = function (node, isStatement) {
  node.id = this.type === _tokentype.types.name ? this.parseIdent() : isStatement ? this.unexpected() : null;
};

pp.parseClassSuper = function (node) {
  node.superClass = this.eat(_tokentype.types._extends) ? this.parseExprSubscripts() : null;
};

// Parses module export declaration.

pp.parseExport = function (node) {
  this.next();
  // export * from '...'
  if (this.eat(_tokentype.types.star)) {
    this.expectContextual("from");
    node.source = this.type === _tokentype.types.string ? this.parseExprAtom() : this.unexpected();
    this.semicolon();
    return this.finishNode(node, "ExportAllDeclaration");
  }
  if (this.eat(_tokentype.types._default)) {
    // export default ...
    var expr = this.parseMaybeAssign();
    var needsSemi = true;
    if (expr.type == "FunctionExpression" || expr.type == "ClassExpression") {
      needsSemi = false;
      if (expr.id) {
        expr.type = expr.type == "FunctionExpression" ? "FunctionDeclaration" : "ClassDeclaration";
      }
    }
    node.declaration = expr;
    if (needsSemi) this.semicolon();
    return this.finishNode(node, "ExportDefaultDeclaration");
  }
  // export var|const|let|function|class ...
  if (this.shouldParseExportStatement()) {
    node.declaration = this.parseStatement(true);
    node.specifiers = [];
    node.source = null;
  } else {
    // export { x, y as z } [from '...']
    node.declaration = null;
    node.specifiers = this.parseExportSpecifiers();
    if (this.eatContextual("from")) {
      node.source = this.type === _tokentype.types.string ? this.parseExprAtom() : this.unexpected();
    } else {
      node.source = null;
    }
    this.semicolon();
  }
  return this.finishNode(node, "ExportNamedDeclaration");
};

pp.shouldParseExportStatement = function () {
  return this.type.keyword;
};

// Parses a comma-separated list of module exports.

pp.parseExportSpecifiers = function () {
  var nodes = [],
      first = true;
  // export { x, y as z } [from '...']
  this.expect(_tokentype.types.braceL);
  while (!this.eat(_tokentype.types.braceR)) {
    if (!first) {
      this.expect(_tokentype.types.comma);
      if (this.afterTrailingComma(_tokentype.types.braceR)) break;
    } else first = false;

    var node = this.startNode();
    node.local = this.parseIdent(this.type === _tokentype.types._default);
    node.exported = this.eatContextual("as") ? this.parseIdent(true) : node.local;
    nodes.push(this.finishNode(node, "ExportSpecifier"));
  }
  return nodes;
};

// Parses import declaration.

pp.parseImport = function (node) {
  this.next();
  // import '...'
  if (this.type === _tokentype.types.string) {
    node.specifiers = empty;
    node.source = this.parseExprAtom();
  } else {
    node.specifiers = this.parseImportSpecifiers();
    this.expectContextual("from");
    node.source = this.type === _tokentype.types.string ? this.parseExprAtom() : this.unexpected();
  }
  this.semicolon();
  return this.finishNode(node, "ImportDeclaration");
};

// Parses a comma-separated list of module imports.

pp.parseImportSpecifiers = function () {
  var nodes = [],
      first = true;
  if (this.type === _tokentype.types.name) {
    // import defaultObj, { x, y as z } from '...'
    var node = this.startNode();
    node.local = this.parseIdent();
    this.checkLVal(node.local, true);
    nodes.push(this.finishNode(node, "ImportDefaultSpecifier"));
    if (!this.eat(_tokentype.types.comma)) return nodes;
  }
  if (this.type === _tokentype.types.star) {
    var node = this.startNode();
    this.next();
    this.expectContextual("as");
    node.local = this.parseIdent();
    this.checkLVal(node.local, true);
    nodes.push(this.finishNode(node, "ImportNamespaceSpecifier"));
    return nodes;
  }
  this.expect(_tokentype.types.braceL);
  while (!this.eat(_tokentype.types.braceR)) {
    if (!first) {
      this.expect(_tokentype.types.comma);
      if (this.afterTrailingComma(_tokentype.types.braceR)) break;
    } else first = false;

    var node = this.startNode();
    node.imported = this.parseIdent(true);
    node.local = this.eatContextual("as") ? this.parseIdent() : node.imported;
    this.checkLVal(node.local, true);
    nodes.push(this.finishNode(node, "ImportSpecifier"));
  }
  return nodes;
};

},{"./state":10,"./tokentype":14,"./whitespace":16}],12:[function(_dereq_,module,exports){
// The algorithm used to determine whether a regexp can appear at a
// given point in the program is loosely based on sweet.js' approach.
// See https://github.com/mozilla/sweet.js/wiki/design

"use strict";

exports.__esModule = true;

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var _state = _dereq_("./state");

var _tokentype = _dereq_("./tokentype");

var _whitespace = _dereq_("./whitespace");

var TokContext = function TokContext(token, isExpr, preserveSpace, override) {
  _classCallCheck(this, TokContext);

  this.token = token;
  this.isExpr = !!isExpr;
  this.preserveSpace = !!preserveSpace;
  this.override = override;
};

exports.TokContext = TokContext;
var types = {
  b_stat: new TokContext("{", false),
  b_expr: new TokContext("{", true),
  b_tmpl: new TokContext("${", true),
  p_stat: new TokContext("(", false),
  p_expr: new TokContext("(", true),
  q_tmpl: new TokContext("`", true, true, function (p) {
    return p.readTmplToken();
  }),
  f_expr: new TokContext("function", true)
};

exports.types = types;
var pp = _state.Parser.prototype;

pp.initialContext = function () {
  return [types.b_stat];
};

pp.braceIsBlock = function (prevType) {
  if (prevType === _tokentype.types.colon) {
    var _parent = this.curContext();
    if (_parent === types.b_stat || _parent === types.b_expr) return !_parent.isExpr;
  }
  if (prevType === _tokentype.types._return) return _whitespace.lineBreak.test(this.input.slice(this.lastTokEnd, this.start));
  if (prevType === _tokentype.types._else || prevType === _tokentype.types.semi || prevType === _tokentype.types.eof || prevType === _tokentype.types.parenR) return true;
  if (prevType == _tokentype.types.braceL) return this.curContext() === types.b_stat;
  return !this.exprAllowed;
};

pp.updateContext = function (prevType) {
  var update = undefined,
      type = this.type;
  if (type.keyword && prevType == _tokentype.types.dot) this.exprAllowed = false;else if (update = type.updateContext) update.call(this, prevType);else this.exprAllowed = type.beforeExpr;
};

// Token-specific context update code

_tokentype.types.parenR.updateContext = _tokentype.types.braceR.updateContext = function () {
  if (this.context.length == 1) {
    this.exprAllowed = true;
    return;
  }
  var out = this.context.pop();
  if (out === types.b_stat && this.curContext() === types.f_expr) {
    this.context.pop();
    this.exprAllowed = false;
  } else if (out === types.b_tmpl) {
    this.exprAllowed = true;
  } else {
    this.exprAllowed = !out.isExpr;
  }
};

_tokentype.types.braceL.updateContext = function (prevType) {
  this.context.push(this.braceIsBlock(prevType) ? types.b_stat : types.b_expr);
  this.exprAllowed = true;
};

_tokentype.types.dollarBraceL.updateContext = function () {
  this.context.push(types.b_tmpl);
  this.exprAllowed = true;
};

_tokentype.types.parenL.updateContext = function (prevType) {
  var statementParens = prevType === _tokentype.types._if || prevType === _tokentype.types._for || prevType === _tokentype.types._with || prevType === _tokentype.types._while;
  this.context.push(statementParens ? types.p_stat : types.p_expr);
  this.exprAllowed = true;
};

_tokentype.types.incDec.updateContext = function () {
  // tokExprAllowed stays unchanged
};

_tokentype.types._function.updateContext = function () {
  if (this.curContext() !== types.b_stat) this.context.push(types.f_expr);
  this.exprAllowed = false;
};

_tokentype.types.backQuote.updateContext = function () {
  if (this.curContext() === types.q_tmpl) this.context.pop();else this.context.push(types.q_tmpl);
  this.exprAllowed = false;
};

},{"./state":10,"./tokentype":14,"./whitespace":16}],13:[function(_dereq_,module,exports){
"use strict";

exports.__esModule = true;

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var _identifier = _dereq_("./identifier");

var _tokentype = _dereq_("./tokentype");

var _state = _dereq_("./state");

var _locutil = _dereq_("./locutil");

var _whitespace = _dereq_("./whitespace");

// Object type used to represent tokens. Note that normally, tokens
// simply exist as properties on the parser object. This is only
// used for the onToken callback and the external tokenizer.

var Token = function Token(p) {
  _classCallCheck(this, Token);

  this.type = p.type;
  this.value = p.value;
  this.start = p.start;
  this.end = p.end;
  if (p.options.locations) this.loc = new _locutil.SourceLocation(p, p.startLoc, p.endLoc);
  if (p.options.ranges) this.range = [p.start, p.end];
}

// ## Tokenizer

;

exports.Token = Token;
var pp = _state.Parser.prototype;

// Are we running under Rhino?
var isRhino = typeof Packages == "object" && Object.prototype.toString.call(Packages) == "[object JavaPackage]";

// Move to the next token

pp.next = function () {
  if (this.options.onToken) this.options.onToken(new Token(this));

  this.lastTokEnd = this.end;
  this.lastTokStart = this.start;
  this.lastTokEndLoc = this.endLoc;
  this.lastTokStartLoc = this.startLoc;
  this.nextToken();
};

pp.getToken = function () {
  this.next();
  return new Token(this);
};

// If we're in an ES6 environment, make parsers iterable
if (typeof Symbol !== "undefined") pp[Symbol.iterator] = function () {
  var self = this;
  return { next: function next() {
      var token = self.getToken();
      return {
        done: token.type === _tokentype.types.eof,
        value: token
      };
    } };
};

// Toggle strict mode. Re-reads the next number or string to please
// pedantic tests (`"use strict"; 010;` should fail).

pp.setStrict = function (strict) {
  this.strict = strict;
  if (this.type !== _tokentype.types.num && this.type !== _tokentype.types.string) return;
  this.pos = this.start;
  if (this.options.locations) {
    while (this.pos < this.lineStart) {
      this.lineStart = this.input.lastIndexOf("\n", this.lineStart - 2) + 1;
      --this.curLine;
    }
  }
  this.nextToken();
};

pp.curContext = function () {
  return this.context[this.context.length - 1];
};

// Read a single token, updating the parser object's token-related
// properties.

pp.nextToken = function () {
  var curContext = this.curContext();
  if (!curContext || !curContext.preserveSpace) this.skipSpace();

  this.start = this.pos;
  if (this.options.locations) this.startLoc = this.curPosition();
  if (this.pos >= this.input.length) return this.finishToken(_tokentype.types.eof);

  if (curContext.override) return curContext.override(this);else this.readToken(this.fullCharCodeAtPos());
};

pp.readToken = function (code) {
  // Identifier or keyword. '\uXXXX' sequences are allowed in
  // identifiers, so '\' also dispatches to that.
  if (_identifier.isIdentifierStart(code, this.options.ecmaVersion >= 6) || code === 92 /* '\' */) return this.readWord();

  return this.getTokenFromCode(code);
};

pp.fullCharCodeAtPos = function () {
  var code = this.input.charCodeAt(this.pos);
  if (code <= 0xd7ff || code >= 0xe000) return code;
  var next = this.input.charCodeAt(this.pos + 1);
  return (code << 10) + next - 0x35fdc00;
};

pp.skipBlockComment = function () {
  var startLoc = this.options.onComment && this.curPosition();
  var start = this.pos,
      end = this.input.indexOf("*/", this.pos += 2);
  if (end === -1) this.raise(this.pos - 2, "Unterminated comment");
  this.pos = end + 2;
  if (this.options.locations) {
    _whitespace.lineBreakG.lastIndex = start;
    var match = undefined;
    while ((match = _whitespace.lineBreakG.exec(this.input)) && match.index < this.pos) {
      ++this.curLine;
      this.lineStart = match.index + match[0].length;
    }
  }
  if (this.options.onComment) this.options.onComment(true, this.input.slice(start + 2, end), start, this.pos, startLoc, this.curPosition());
};

pp.skipLineComment = function (startSkip) {
  var start = this.pos;
  var startLoc = this.options.onComment && this.curPosition();
  var ch = this.input.charCodeAt(this.pos += startSkip);
  while (this.pos < this.input.length && ch !== 10 && ch !== 13 && ch !== 8232 && ch !== 8233) {
    ++this.pos;
    ch = this.input.charCodeAt(this.pos);
  }
  if (this.options.onComment) this.options.onComment(false, this.input.slice(start + startSkip, this.pos), start, this.pos, startLoc, this.curPosition());
};

// Called at the start of the parse and after every token. Skips
// whitespace and comments, and.

pp.skipSpace = function () {
  loop: while (this.pos < this.input.length) {
    var ch = this.input.charCodeAt(this.pos);
    switch (ch) {
      case 32:case 160:
        // ' '
        ++this.pos;
        break;
      case 13:
        if (this.input.charCodeAt(this.pos + 1) === 10) {
          ++this.pos;
        }
      case 10:case 8232:case 8233:
        ++this.pos;
        if (this.options.locations) {
          ++this.curLine;
          this.lineStart = this.pos;
        }
        break;
      case 47:
        // '/'
        switch (this.input.charCodeAt(this.pos + 1)) {
          case 42:
            // '*'
            this.skipBlockComment();
            break;
          case 47:
            this.skipLineComment(2);
            break;
          default:
            break loop;
        }
        break;
      default:
        if (ch > 8 && ch < 14 || ch >= 5760 && _whitespace.nonASCIIwhitespace.test(String.fromCharCode(ch))) {
          ++this.pos;
        } else {
          break loop;
        }
    }
  }
};

// Called at the end of every token. Sets `end`, `val`, and
// maintains `context` and `exprAllowed`, and skips the space after
// the token, so that the next one's `start` will point at the
// right position.

pp.finishToken = function (type, val) {
  this.end = this.pos;
  if (this.options.locations) this.endLoc = this.curPosition();
  var prevType = this.type;
  this.type = type;
  this.value = val;

  this.updateContext(prevType);
};

// ### Token reading

// This is the function that is called to fetch the next token. It
// is somewhat obscure, because it works in character codes rather
// than characters, and because operator parsing has been inlined
// into it.
//
// All in the name of speed.
//
pp.readToken_dot = function () {
  var next = this.input.charCodeAt(this.pos + 1);
  if (next >= 48 && next <= 57) return this.readNumber(true);
  var next2 = this.input.charCodeAt(this.pos + 2);
  if (this.options.ecmaVersion >= 6 && next === 46 && next2 === 46) {
    // 46 = dot '.'
    this.pos += 3;
    return this.finishToken(_tokentype.types.ellipsis);
  } else {
    ++this.pos;
    return this.finishToken(_tokentype.types.dot);
  }
};

pp.readToken_slash = function () {
  // '/'
  var next = this.input.charCodeAt(this.pos + 1);
  if (this.exprAllowed) {
    ++this.pos;return this.readRegexp();
  }
  if (next === 61) return this.finishOp(_tokentype.types.assign, 2);
  return this.finishOp(_tokentype.types.slash, 1);
};

pp.readToken_mult_modulo = function (code) {
  // '%*'
  var next = this.input.charCodeAt(this.pos + 1);
  if (next === 61) return this.finishOp(_tokentype.types.assign, 2);
  return this.finishOp(code === 42 ? _tokentype.types.star : _tokentype.types.modulo, 1);
};

pp.readToken_pipe_amp = function (code) {
  // '|&'
  var next = this.input.charCodeAt(this.pos + 1);
  if (next === code) return this.finishOp(code === 124 ? _tokentype.types.logicalOR : _tokentype.types.logicalAND, 2);
  if (next === 61) return this.finishOp(_tokentype.types.assign, 2);
  return this.finishOp(code === 124 ? _tokentype.types.bitwiseOR : _tokentype.types.bitwiseAND, 1);
};

pp.readToken_caret = function () {
  // '^'
  var next = this.input.charCodeAt(this.pos + 1);
  if (next === 61) return this.finishOp(_tokentype.types.assign, 2);
  return this.finishOp(_tokentype.types.bitwiseXOR, 1);
};

pp.readToken_plus_min = function (code) {
  // '+-'
  var next = this.input.charCodeAt(this.pos + 1);
  if (next === code) {
    if (next == 45 && this.input.charCodeAt(this.pos + 2) == 62 && _whitespace.lineBreak.test(this.input.slice(this.lastTokEnd, this.pos))) {
      // A `-->` line comment
      this.skipLineComment(3);
      this.skipSpace();
      return this.nextToken();
    }
    return this.finishOp(_tokentype.types.incDec, 2);
  }
  if (next === 61) return this.finishOp(_tokentype.types.assign, 2);
  return this.finishOp(_tokentype.types.plusMin, 1);
};

pp.readToken_lt_gt = function (code) {
  // '<>'
  var next = this.input.charCodeAt(this.pos + 1);
  var size = 1;
  if (next === code) {
    size = code === 62 && this.input.charCodeAt(this.pos + 2) === 62 ? 3 : 2;
    if (this.input.charCodeAt(this.pos + size) === 61) return this.finishOp(_tokentype.types.assign, size + 1);
    return this.finishOp(_tokentype.types.bitShift, size);
  }
  if (next == 33 && code == 60 && this.input.charCodeAt(this.pos + 2) == 45 && this.input.charCodeAt(this.pos + 3) == 45) {
    if (this.inModule) this.unexpected();
    // `<!--`, an XML-style comment that should be interpreted as a line comment
    this.skipLineComment(4);
    this.skipSpace();
    return this.nextToken();
  }
  if (next === 61) size = this.input.charCodeAt(this.pos + 2) === 61 ? 3 : 2;
  return this.finishOp(_tokentype.types.relational, size);
};

pp.readToken_eq_excl = function (code) {
  // '=!'
  var next = this.input.charCodeAt(this.pos + 1);
  if (next === 61) return this.finishOp(_tokentype.types.equality, this.input.charCodeAt(this.pos + 2) === 61 ? 3 : 2);
  if (code === 61 && next === 62 && this.options.ecmaVersion >= 6) {
    // '=>'
    this.pos += 2;
    return this.finishToken(_tokentype.types.arrow);
  }
  return this.finishOp(code === 61 ? _tokentype.types.eq : _tokentype.types.prefix, 1);
};

pp.getTokenFromCode = function (code) {
  switch (code) {
    // The interpretation of a dot depends on whether it is followed
    // by a digit or another two dots.
    case 46:
      // '.'
      return this.readToken_dot();

    // Punctuation tokens.
    case 40:
      ++this.pos;return this.finishToken(_tokentype.types.parenL);
    case 41:
      ++this.pos;return this.finishToken(_tokentype.types.parenR);
    case 59:
      ++this.pos;return this.finishToken(_tokentype.types.semi);
    case 44:
      ++this.pos;return this.finishToken(_tokentype.types.comma);
    case 91:
      ++this.pos;return this.finishToken(_tokentype.types.bracketL);
    case 93:
      ++this.pos;return this.finishToken(_tokentype.types.bracketR);
    case 123:
      ++this.pos;return this.finishToken(_tokentype.types.braceL);
    case 125:
      ++this.pos;return this.finishToken(_tokentype.types.braceR);
    case 58:
      ++this.pos;return this.finishToken(_tokentype.types.colon);
    case 63:
      ++this.pos;return this.finishToken(_tokentype.types.question);

    case 96:
      // '`'
      if (this.options.ecmaVersion < 6) break;
      ++this.pos;
      return this.finishToken(_tokentype.types.backQuote);

    case 48:
      // '0'
      var next = this.input.charCodeAt(this.pos + 1);
      if (next === 120 || next === 88) return this.readRadixNumber(16); // '0x', '0X' - hex number
      if (this.options.ecmaVersion >= 6) {
        if (next === 111 || next === 79) return this.readRadixNumber(8); // '0o', '0O' - octal number
        if (next === 98 || next === 66) return this.readRadixNumber(2); // '0b', '0B' - binary number
      }
    // Anything else beginning with a digit is an integer, octal
    // number, or float.
    case 49:case 50:case 51:case 52:case 53:case 54:case 55:case 56:case 57:
      // 1-9
      return this.readNumber(false);

    // Quotes produce strings.
    case 34:case 39:
      // '"', "'"
      return this.readString(code);

    // Operators are parsed inline in tiny state machines. '=' (61) is
    // often referred to. `finishOp` simply skips the amount of
    // characters it is given as second argument, and returns a token
    // of the type given by its first argument.

    case 47:
      // '/'
      return this.readToken_slash();

    case 37:case 42:
      // '%*'
      return this.readToken_mult_modulo(code);

    case 124:case 38:
      // '|&'
      return this.readToken_pipe_amp(code);

    case 94:
      // '^'
      return this.readToken_caret();

    case 43:case 45:
      // '+-'
      return this.readToken_plus_min(code);

    case 60:case 62:
      // '<>'
      return this.readToken_lt_gt(code);

    case 61:case 33:
      // '=!'
      return this.readToken_eq_excl(code);

    case 126:
      // '~'
      return this.finishOp(_tokentype.types.prefix, 1);
  }

  this.raise(this.pos, "Unexpected character '" + codePointToString(code) + "'");
};

pp.finishOp = function (type, size) {
  var str = this.input.slice(this.pos, this.pos + size);
  this.pos += size;
  return this.finishToken(type, str);
};

// Parse a regular expression. Some context-awareness is necessary,
// since a '/' inside a '[]' set does not end the expression.

function tryCreateRegexp(src, flags, throwErrorAt) {
  try {
    return new RegExp(src, flags);
  } catch (e) {
    if (throwErrorAt !== undefined) {
      if (e instanceof SyntaxError) this.raise(throwErrorAt, "Error parsing regular expression: " + e.message);
      this.raise(e);
    }
  }
}

var regexpUnicodeSupport = !!tryCreateRegexp("￿", "u");

pp.readRegexp = function () {
  var _this = this;

  var escaped = undefined,
      inClass = undefined,
      start = this.pos;
  for (;;) {
    if (this.pos >= this.input.length) this.raise(start, "Unterminated regular expression");
    var ch = this.input.charAt(this.pos);
    if (_whitespace.lineBreak.test(ch)) this.raise(start, "Unterminated regular expression");
    if (!escaped) {
      if (ch === "[") inClass = true;else if (ch === "]" && inClass) inClass = false;else if (ch === "/" && !inClass) break;
      escaped = ch === "\\";
    } else escaped = false;
    ++this.pos;
  }
  var content = this.input.slice(start, this.pos);
  ++this.pos;
  // Need to use `readWord1` because '\uXXXX' sequences are allowed
  // here (don't ask).
  var mods = this.readWord1();
  var tmp = content;
  if (mods) {
    var validFlags = /^[gmsiy]*$/;
    if (this.options.ecmaVersion >= 6) validFlags = /^[gmsiyu]*$/;
    if (!validFlags.test(mods)) this.raise(start, "Invalid regular expression flag");
    if (mods.indexOf('u') >= 0 && !regexpUnicodeSupport) {
      // Replace each astral symbol and every Unicode escape sequence that
      // possibly represents an astral symbol or a paired surrogate with a
      // single ASCII symbol to avoid throwing on regular expressions that
      // are only valid in combination with the `/u` flag.
      // Note: replacing with the ASCII symbol `x` might cause false
      // negatives in unlikely scenarios. For example, `[\u{61}-b]` is a
      // perfectly valid pattern that is equivalent to `[a-b]`, but it would
      // be replaced by `[x-b]` which throws an error.
      tmp = tmp.replace(/\\u\{([0-9a-fA-F]+)\}/g, function (match, code, offset) {
        code = Number("0x" + code);
        if (code > 0x10FFFF) _this.raise(start + offset + 3, "Code point out of bounds");
        return "x";
      });
      tmp = tmp.replace(/\\u([a-fA-F0-9]{4})|[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "x");
    }
  }
  // Detect invalid regular expressions.
  var value = null;
  // Rhino's regular expression parser is flaky and throws uncatchable exceptions,
  // so don't do detection if we are running under Rhino
  if (!isRhino) {
    tryCreateRegexp(tmp, undefined, start);
    // Get a regular expression object for this pattern-flag pair, or `null` in
    // case the current environment doesn't support the flags it uses.
    value = tryCreateRegexp(content, mods);
  }
  return this.finishToken(_tokentype.types.regexp, { pattern: content, flags: mods, value: value });
};

// Read an integer in the given radix. Return null if zero digits
// were read, the integer value otherwise. When `len` is given, this
// will return `null` unless the integer has exactly `len` digits.

pp.readInt = function (radix, len) {
  var start = this.pos,
      total = 0;
  for (var i = 0, e = len == null ? Infinity : len; i < e; ++i) {
    var code = this.input.charCodeAt(this.pos),
        val = undefined;
    if (code >= 97) val = code - 97 + 10; // a
    else if (code >= 65) val = code - 65 + 10; // A
      else if (code >= 48 && code <= 57) val = code - 48; // 0-9
        else val = Infinity;
    if (val >= radix) break;
    ++this.pos;
    total = total * radix + val;
  }
  if (this.pos === start || len != null && this.pos - start !== len) return null;

  return total;
};

pp.readRadixNumber = function (radix) {
  this.pos += 2; // 0x
  var val = this.readInt(radix);
  if (val == null) this.raise(this.start + 2, "Expected number in radix " + radix);
  if (_identifier.isIdentifierStart(this.fullCharCodeAtPos())) this.raise(this.pos, "Identifier directly after number");
  return this.finishToken(_tokentype.types.num, val);
};

// Read an integer, octal integer, or floating-point number.

pp.readNumber = function (startsWithDot) {
  var start = this.pos,
      isFloat = false,
      octal = this.input.charCodeAt(this.pos) === 48;
  if (!startsWithDot && this.readInt(10) === null) this.raise(start, "Invalid number");
  var next = this.input.charCodeAt(this.pos);
  if (next === 46) {
    // '.'
    ++this.pos;
    this.readInt(10);
    isFloat = true;
    next = this.input.charCodeAt(this.pos);
  }
  if (next === 69 || next === 101) {
    // 'eE'
    next = this.input.charCodeAt(++this.pos);
    if (next === 43 || next === 45) ++this.pos; // '+-'
    if (this.readInt(10) === null) this.raise(start, "Invalid number");
    isFloat = true;
  }
  if (_identifier.isIdentifierStart(this.fullCharCodeAtPos())) this.raise(this.pos, "Identifier directly after number");

  var str = this.input.slice(start, this.pos),
      val = undefined;
  if (isFloat) val = parseFloat(str);else if (!octal || str.length === 1) val = parseInt(str, 10);else if (/[89]/.test(str) || this.strict) this.raise(start, "Invalid number");else val = parseInt(str, 8);
  return this.finishToken(_tokentype.types.num, val);
};

// Read a string value, interpreting backslash-escapes.

pp.readCodePoint = function () {
  var ch = this.input.charCodeAt(this.pos),
      code = undefined;

  if (ch === 123) {
    if (this.options.ecmaVersion < 6) this.unexpected();
    var codePos = ++this.pos;
    code = this.readHexChar(this.input.indexOf('}', this.pos) - this.pos);
    ++this.pos;
    if (code > 0x10FFFF) this.raise(codePos, "Code point out of bounds");
  } else {
    code = this.readHexChar(4);
  }
  return code;
};

function codePointToString(code) {
  // UTF-16 Decoding
  if (code <= 0xFFFF) return String.fromCharCode(code);
  code -= 0x10000;
  return String.fromCharCode((code >> 10) + 0xD800, (code & 1023) + 0xDC00);
}

pp.readString = function (quote) {
  var out = "",
      chunkStart = ++this.pos;
  for (;;) {
    if (this.pos >= this.input.length) this.raise(this.start, "Unterminated string constant");
    var ch = this.input.charCodeAt(this.pos);
    if (ch === quote) break;
    if (ch === 92) {
      // '\'
      out += this.input.slice(chunkStart, this.pos);
      out += this.readEscapedChar(false);
      chunkStart = this.pos;
    } else {
      if (_whitespace.isNewLine(ch)) this.raise(this.start, "Unterminated string constant");
      ++this.pos;
    }
  }
  out += this.input.slice(chunkStart, this.pos++);
  return this.finishToken(_tokentype.types.string, out);
};

// Reads template string tokens.

pp.readTmplToken = function () {
  var out = "",
      chunkStart = this.pos;
  for (;;) {
    if (this.pos >= this.input.length) this.raise(this.start, "Unterminated template");
    var ch = this.input.charCodeAt(this.pos);
    if (ch === 96 || ch === 36 && this.input.charCodeAt(this.pos + 1) === 123) {
      // '`', '${'
      if (this.pos === this.start && this.type === _tokentype.types.template) {
        if (ch === 36) {
          this.pos += 2;
          return this.finishToken(_tokentype.types.dollarBraceL);
        } else {
          ++this.pos;
          return this.finishToken(_tokentype.types.backQuote);
        }
      }
      out += this.input.slice(chunkStart, this.pos);
      return this.finishToken(_tokentype.types.template, out);
    }
    if (ch === 92) {
      // '\'
      out += this.input.slice(chunkStart, this.pos);
      out += this.readEscapedChar(true);
      chunkStart = this.pos;
    } else if (_whitespace.isNewLine(ch)) {
      out += this.input.slice(chunkStart, this.pos);
      ++this.pos;
      switch (ch) {
        case 13:
          if (this.input.charCodeAt(this.pos) === 10) ++this.pos;
        case 10:
          out += "\n";
          break;
        default:
          out += String.fromCharCode(ch);
          break;
      }
      if (this.options.locations) {
        ++this.curLine;
        this.lineStart = this.pos;
      }
      chunkStart = this.pos;
    } else {
      ++this.pos;
    }
  }
};

// Used to read escaped characters

pp.readEscapedChar = function (inTemplate) {
  var ch = this.input.charCodeAt(++this.pos);
  ++this.pos;
  switch (ch) {
    case 110:
      return "\n"; // 'n' -> '\n'
    case 114:
      return "\r"; // 'r' -> '\r'
    case 120:
      return String.fromCharCode(this.readHexChar(2)); // 'x'
    case 117:
      return codePointToString(this.readCodePoint()); // 'u'
    case 116:
      return "\t"; // 't' -> '\t'
    case 98:
      return "\b"; // 'b' -> '\b'
    case 118:
      return "\u000b"; // 'v' -> '\u000b'
    case 102:
      return "\f"; // 'f' -> '\f'
    case 13:
      if (this.input.charCodeAt(this.pos) === 10) ++this.pos; // '\r\n'
    case 10:
      // ' \n'
      if (this.options.locations) {
        this.lineStart = this.pos;++this.curLine;
      }
      return "";
    default:
      if (ch >= 48 && ch <= 55) {
        var octalStr = this.input.substr(this.pos - 1, 3).match(/^[0-7]+/)[0];
        var octal = parseInt(octalStr, 8);
        if (octal > 255) {
          octalStr = octalStr.slice(0, -1);
          octal = parseInt(octalStr, 8);
        }
        if (octal > 0 && (this.strict || inTemplate)) {
          this.raise(this.pos - 2, "Octal literal in strict mode");
        }
        this.pos += octalStr.length - 1;
        return String.fromCharCode(octal);
      }
      return String.fromCharCode(ch);
  }
};

// Used to read character escape sequences ('\x', '\u', '\U').

pp.readHexChar = function (len) {
  var codePos = this.pos;
  var n = this.readInt(16, len);
  if (n === null) this.raise(codePos, "Bad character escape sequence");
  return n;
};

// Read an identifier, and return it as a string. Sets `this.containsEsc`
// to whether the word contained a '\u' escape.
//
// Incrementally adds only escaped chars, adding other chunks as-is
// as a micro-optimization.

pp.readWord1 = function () {
  this.containsEsc = false;
  var word = "",
      first = true,
      chunkStart = this.pos;
  var astral = this.options.ecmaVersion >= 6;
  while (this.pos < this.input.length) {
    var ch = this.fullCharCodeAtPos();
    if (_identifier.isIdentifierChar(ch, astral)) {
      this.pos += ch <= 0xffff ? 1 : 2;
    } else if (ch === 92) {
      // "\"
      this.containsEsc = true;
      word += this.input.slice(chunkStart, this.pos);
      var escStart = this.pos;
      if (this.input.charCodeAt(++this.pos) != 117) // "u"
        this.raise(this.pos, "Expecting Unicode escape sequence \\uXXXX");
      ++this.pos;
      var esc = this.readCodePoint();
      if (!(first ? _identifier.isIdentifierStart : _identifier.isIdentifierChar)(esc, astral)) this.raise(escStart, "Invalid Unicode escape");
      word += codePointToString(esc);
      chunkStart = this.pos;
    } else {
      break;
    }
    first = false;
  }
  return word + this.input.slice(chunkStart, this.pos);
};

// Read an identifier or keyword token. Will check for reserved
// words when necessary.

pp.readWord = function () {
  var word = this.readWord1();
  var type = _tokentype.types.name;
  if ((this.options.ecmaVersion >= 6 || !this.containsEsc) && this.isKeyword(word)) type = _tokentype.keywords[word];
  return this.finishToken(type, word);
};

},{"./identifier":2,"./locutil":5,"./state":10,"./tokentype":14,"./whitespace":16}],14:[function(_dereq_,module,exports){
// ## Token types

// The assignment of fine-grained, information-carrying type objects
// allows the tokenizer to store the information it has about a
// token in a way that is very cheap for the parser to look up.

// All token type variables start with an underscore, to make them
// easy to recognize.

// The `beforeExpr` property is used to disambiguate between regular
// expressions and divisions. It is set on all token types that can
// be followed by an expression (thus, a slash after them would be a
// regular expression).
//
// `isLoop` marks a keyword as starting a loop, which is important
// to know when parsing a label, in order to allow or disallow
// continue jumps to that label.

"use strict";

exports.__esModule = true;

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var TokenType = function TokenType(label) {
  var conf = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];

  _classCallCheck(this, TokenType);

  this.label = label;
  this.keyword = conf.keyword;
  this.beforeExpr = !!conf.beforeExpr;
  this.startsExpr = !!conf.startsExpr;
  this.isLoop = !!conf.isLoop;
  this.isAssign = !!conf.isAssign;
  this.prefix = !!conf.prefix;
  this.postfix = !!conf.postfix;
  this.binop = conf.binop || null;
  this.updateContext = null;
};

exports.TokenType = TokenType;

function binop(name, prec) {
  return new TokenType(name, { beforeExpr: true, binop: prec });
}
var beforeExpr = { beforeExpr: true },
    startsExpr = { startsExpr: true };

var types = {
  num: new TokenType("num", startsExpr),
  regexp: new TokenType("regexp", startsExpr),
  string: new TokenType("string", startsExpr),
  name: new TokenType("name", startsExpr),
  eof: new TokenType("eof"),

  // Punctuation token types.
  bracketL: new TokenType("[", { beforeExpr: true, startsExpr: true }),
  bracketR: new TokenType("]"),
  braceL: new TokenType("{", { beforeExpr: true, startsExpr: true }),
  braceR: new TokenType("}"),
  parenL: new TokenType("(", { beforeExpr: true, startsExpr: true }),
  parenR: new TokenType(")"),
  comma: new TokenType(",", beforeExpr),
  semi: new TokenType(";", beforeExpr),
  colon: new TokenType(":", beforeExpr),
  dot: new TokenType("."),
  question: new TokenType("?", beforeExpr),
  arrow: new TokenType("=>", beforeExpr),
  template: new TokenType("template"),
  ellipsis: new TokenType("...", beforeExpr),
  backQuote: new TokenType("`", startsExpr),
  dollarBraceL: new TokenType("${", { beforeExpr: true, startsExpr: true }),

  // Operators. These carry several kinds of properties to help the
  // parser use them properly (the presence of these properties is
  // what categorizes them as operators).
  //
  // `binop`, when present, specifies that this operator is a binary
  // operator, and will refer to its precedence.
  //
  // `prefix` and `postfix` mark the operator as a prefix or postfix
  // unary operator.
  //
  // `isAssign` marks all of `=`, `+=`, `-=` etcetera, which act as
  // binary operators with a very low precedence, that should result
  // in AssignmentExpression nodes.

  eq: new TokenType("=", { beforeExpr: true, isAssign: true }),
  assign: new TokenType("_=", { beforeExpr: true, isAssign: true }),
  incDec: new TokenType("++/--", { prefix: true, postfix: true, startsExpr: true }),
  prefix: new TokenType("prefix", { beforeExpr: true, prefix: true, startsExpr: true }),
  logicalOR: binop("||", 1),
  logicalAND: binop("&&", 2),
  bitwiseOR: binop("|", 3),
  bitwiseXOR: binop("^", 4),
  bitwiseAND: binop("&", 5),
  equality: binop("==/!=", 6),
  relational: binop("</>", 7),
  bitShift: binop("<</>>", 8),
  plusMin: new TokenType("+/-", { beforeExpr: true, binop: 9, prefix: true, startsExpr: true }),
  modulo: binop("%", 10),
  star: binop("*", 10),
  slash: binop("/", 10)
};

exports.types = types;
// Map keyword names to token types.

var keywords = {};

exports.keywords = keywords;
// Succinct definitions of keyword token types
function kw(name) {
  var options = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];

  options.keyword = name;
  keywords[name] = types["_" + name] = new TokenType(name, options);
}

kw("break");
kw("case", beforeExpr);
kw("catch");
kw("continue");
kw("debugger");
kw("default", beforeExpr);
kw("do", { isLoop: true });
kw("else", beforeExpr);
kw("finally");
kw("for", { isLoop: true });
kw("function", startsExpr);
kw("if");
kw("return", beforeExpr);
kw("switch");
kw("throw", beforeExpr);
kw("try");
kw("var");
kw("let");
kw("const");
kw("while", { isLoop: true });
kw("with");
kw("new", { beforeExpr: true, startsExpr: true });
kw("this", startsExpr);
kw("super", startsExpr);
kw("class");
kw("extends", beforeExpr);
kw("export");
kw("import");
kw("yield", { beforeExpr: true, startsExpr: true });
kw("null", startsExpr);
kw("true", startsExpr);
kw("false", startsExpr);
kw("in", { beforeExpr: true, binop: 7 });
kw("instanceof", { beforeExpr: true, binop: 7 });
kw("typeof", { beforeExpr: true, prefix: true, startsExpr: true });
kw("void", { beforeExpr: true, prefix: true, startsExpr: true });
kw("delete", { beforeExpr: true, prefix: true, startsExpr: true });

},{}],15:[function(_dereq_,module,exports){
"use strict";

exports.__esModule = true;
exports.isArray = isArray;
exports.has = has;

function isArray(obj) {
  return Object.prototype.toString.call(obj) === "[object Array]";
}

// Checks if an object has a property.

function has(obj, propName) {
  return Object.prototype.hasOwnProperty.call(obj, propName);
}

},{}],16:[function(_dereq_,module,exports){
// Matches a whole line break (where CRLF is considered a single
// line break). Used to count lines.

"use strict";

exports.__esModule = true;
exports.isNewLine = isNewLine;
var lineBreak = /\r\n?|\n|\u2028|\u2029/;
exports.lineBreak = lineBreak;
var lineBreakG = new RegExp(lineBreak.source, "g");

exports.lineBreakG = lineBreakG;

function isNewLine(code) {
  return code === 10 || code === 13 || code === 0x2028 || code == 0x2029;
}

var nonASCIIwhitespace = /[\u1680\u180e\u2000-\u200a\u202f\u205f\u3000\ufeff]/;
exports.nonASCIIwhitespace = nonASCIIwhitespace;

},{}]},{},[3])(3)
});
}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{}],15:[function(require,module,exports){
(function (global){
(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}(g.acorn || (g.acorn = {})).loose = f()}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(_dereq_,module,exports){
(function (global){
"use strict";(function(f){if(typeof exports === "object" && typeof module !== "undefined"){module.exports = f();}else if(typeof define === "function" && define.amd){define([],f);}else {var g;if(typeof window !== "undefined"){g = window;}else if(typeof global !== "undefined"){g = global;}else if(typeof self !== "undefined"){g = self;}else {g = this;}g.acorn = f();}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof _dereq_ == "function" && _dereq_;if(!u && a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '" + o + "'");throw (f.code = "MODULE_NOT_FOUND",f);}var l=n[o] = {exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e);},l,l.exports,e,t,n,r);}return n[o].exports;}var i=typeof _dereq_ == "function" && _dereq_;for(var o=0;o < r.length;o++) s(r[o]);return s;})({1:[function(_dereq_,module,exports){ // A recursive descent parser operates by defining functions for all
// syntactic elements, and recursively calling those, each function
// advancing the input stream and returning an AST node. Precedence
// of constructs (for example, the fact that `!x[1]` means `!(x[1])`
// instead of `(!x)[1]` is handled by the fact that the parser
// function that parses unary prefix operators is called first, and
// in turn calls the function that parses `[]` subscripts — that
// way, it'll receive the node for `x[1]` already parsed, and wraps
// *that* in the unary operator node.
//
// Acorn uses an [operator precedence parser][opp] to handle binary
// operator precedence, because it is much more compact than using
// the technique outlined above, which uses different, nesting
// functions to specify precedence, for all of the ten binary
// precedence levels that JavaScript defines.
//
// [opp]: http://en.wikipedia.org/wiki/Operator-precedence_parser
"use strict";var _tokentype=_dereq_("./tokentype");var _state=_dereq_("./state");var _identifier=_dereq_("./identifier");var _util=_dereq_("./util");var pp=_state.Parser.prototype; // Check if property name clashes with already added.
// Object/class getters and setters are not allowed to clash —
// either with each other or with an init property — and in
// strict mode, init properties are also not allowed to be repeated.
pp.checkPropClash = function(prop,propHash){if(this.options.ecmaVersion >= 6 && (prop.computed || prop.method || prop.shorthand))return;var key=prop.key,name=undefined;switch(key.type){case "Identifier":name = key.name;break;case "Literal":name = String(key.value);break;default:return;}var kind=prop.kind;if(this.options.ecmaVersion >= 6){if(name === "__proto__" && kind === "init"){if(propHash.proto)this.raise(key.start,"Redefinition of __proto__ property");propHash.proto = true;}return;}var other=undefined;if(_util.has(propHash,name)){other = propHash[name];var isGetSet=kind !== "init";if((this.strict || isGetSet) && other[kind] || !(isGetSet ^ other.init))this.raise(key.start,"Redefinition of property");}else {other = propHash[name] = {init:false,get:false,set:false};}other[kind] = true;}; // ### Expression parsing
// These nest, from the most general expression type at the top to
// 'atomic', nondivisible expression types at the bottom. Most of
// the functions will simply let the function(s) below them parse,
// and, *if* the syntactic construct they handle is present, wrap
// the AST node that the inner parser gave them in another node.
// Parse a full expression. The optional arguments are used to
// forbid the `in` operator (in for loops initalization expressions)
// and provide reference for storing '=' operator inside shorthand
// property assignment in contexts where both object expression
// and object pattern might appear (so it's possible to raise
// delayed syntax error at correct position).
pp.parseExpression = function(noIn,refShorthandDefaultPos){var startPos=this.start,startLoc=this.startLoc;var expr=this.parseMaybeAssign(noIn,refShorthandDefaultPos);if(this.type === _tokentype.types.comma){var node=this.startNodeAt(startPos,startLoc);node.expressions = [expr];while(this.eat(_tokentype.types.comma)) node.expressions.push(this.parseMaybeAssign(noIn,refShorthandDefaultPos));return this.finishNode(node,"SequenceExpression");}return expr;}; // Parse an assignment expression. This includes applications of
// operators like `+=`.
pp.parseMaybeAssign = function(noIn,refShorthandDefaultPos,afterLeftParse){if(this.type == _tokentype.types._yield && this.inGenerator)return this.parseYield();var failOnShorthandAssign=undefined;if(!refShorthandDefaultPos){refShorthandDefaultPos = {start:0};failOnShorthandAssign = true;}else {failOnShorthandAssign = false;}var startPos=this.start,startLoc=this.startLoc;if(this.type == _tokentype.types.parenL || this.type == _tokentype.types.name)this.potentialArrowAt = this.start;var left=this.parseMaybeConditional(noIn,refShorthandDefaultPos);if(afterLeftParse)left = afterLeftParse.call(this,left,startPos,startLoc);if(this.type.isAssign){var node=this.startNodeAt(startPos,startLoc);node.operator = this.value;node.left = this.type === _tokentype.types.eq?this.toAssignable(left):left;refShorthandDefaultPos.start = 0; // reset because shorthand default was used correctly
this.checkLVal(left);this.next();node.right = this.parseMaybeAssign(noIn);return this.finishNode(node,"AssignmentExpression");}else if(failOnShorthandAssign && refShorthandDefaultPos.start){this.unexpected(refShorthandDefaultPos.start);}return left;}; // Parse a ternary conditional (`?:`) operator.
pp.parseMaybeConditional = function(noIn,refShorthandDefaultPos){var startPos=this.start,startLoc=this.startLoc;var expr=this.parseExprOps(noIn,refShorthandDefaultPos);if(refShorthandDefaultPos && refShorthandDefaultPos.start)return expr;if(this.eat(_tokentype.types.question)){var node=this.startNodeAt(startPos,startLoc);node.test = expr;node.consequent = this.parseMaybeAssign();this.expect(_tokentype.types.colon);node.alternate = this.parseMaybeAssign(noIn);return this.finishNode(node,"ConditionalExpression");}return expr;}; // Start the precedence parser.
pp.parseExprOps = function(noIn,refShorthandDefaultPos){var startPos=this.start,startLoc=this.startLoc;var expr=this.parseMaybeUnary(refShorthandDefaultPos);if(refShorthandDefaultPos && refShorthandDefaultPos.start)return expr;return this.parseExprOp(expr,startPos,startLoc,-1,noIn);}; // Parse binary operators with the operator precedence parsing
// algorithm. `left` is the left-hand side of the operator.
// `minPrec` provides context that allows the function to stop and
// defer further parser to one of its callers when it encounters an
// operator that has a lower precedence than the set it is parsing.
pp.parseExprOp = function(left,leftStartPos,leftStartLoc,minPrec,noIn){var prec=this.type.binop;if(prec != null && (!noIn || this.type !== _tokentype.types._in)){if(prec > minPrec){var node=this.startNodeAt(leftStartPos,leftStartLoc);node.left = left;node.operator = this.value;var op=this.type;this.next();var startPos=this.start,startLoc=this.startLoc;node.right = this.parseExprOp(this.parseMaybeUnary(),startPos,startLoc,prec,noIn);this.finishNode(node,op === _tokentype.types.logicalOR || op === _tokentype.types.logicalAND?"LogicalExpression":"BinaryExpression");return this.parseExprOp(node,leftStartPos,leftStartLoc,minPrec,noIn);}}return left;}; // Parse unary operators, both prefix and postfix.
pp.parseMaybeUnary = function(refShorthandDefaultPos){if(this.type.prefix){var node=this.startNode(),update=this.type === _tokentype.types.incDec;node.operator = this.value;node.prefix = true;this.next();node.argument = this.parseMaybeUnary();if(refShorthandDefaultPos && refShorthandDefaultPos.start)this.unexpected(refShorthandDefaultPos.start);if(update)this.checkLVal(node.argument);else if(this.strict && node.operator === "delete" && node.argument.type === "Identifier")this.raise(node.start,"Deleting local variable in strict mode");return this.finishNode(node,update?"UpdateExpression":"UnaryExpression");}var startPos=this.start,startLoc=this.startLoc;var expr=this.parseExprSubscripts(refShorthandDefaultPos);if(refShorthandDefaultPos && refShorthandDefaultPos.start)return expr;while(this.type.postfix && !this.canInsertSemicolon()) {var node=this.startNodeAt(startPos,startLoc);node.operator = this.value;node.prefix = false;node.argument = expr;this.checkLVal(expr);this.next();expr = this.finishNode(node,"UpdateExpression");}return expr;}; // Parse call, dot, and `[]`-subscript expressions.
pp.parseExprSubscripts = function(refShorthandDefaultPos){var startPos=this.start,startLoc=this.startLoc;var expr=this.parseExprAtom(refShorthandDefaultPos);if(refShorthandDefaultPos && refShorthandDefaultPos.start)return expr;return this.parseSubscripts(expr,startPos,startLoc);};pp.parseSubscripts = function(base,startPos,startLoc,noCalls){for(;;) {if(this.eat(_tokentype.types.dot)){var node=this.startNodeAt(startPos,startLoc);node.object = base;node.property = this.parseIdent(true);node.computed = false;base = this.finishNode(node,"MemberExpression");}else if(this.eat(_tokentype.types.bracketL)){var node=this.startNodeAt(startPos,startLoc);node.object = base;node.property = this.parseExpression();node.computed = true;this.expect(_tokentype.types.bracketR);base = this.finishNode(node,"MemberExpression");}else if(!noCalls && this.eat(_tokentype.types.parenL)){var node=this.startNodeAt(startPos,startLoc);node.callee = base;node.arguments = this.parseExprList(_tokentype.types.parenR,false);base = this.finishNode(node,"CallExpression");}else if(this.type === _tokentype.types.backQuote){var node=this.startNodeAt(startPos,startLoc);node.tag = base;node.quasi = this.parseTemplate();base = this.finishNode(node,"TaggedTemplateExpression");}else {return base;}}}; // Parse an atomic expression — either a single token that is an
// expression, an expression started by a keyword like `function` or
// `new`, or an expression wrapped in punctuation like `()`, `[]`,
// or `{}`.
pp.parseExprAtom = function(refShorthandDefaultPos){var node=undefined,canBeArrow=this.potentialArrowAt == this.start;switch(this.type){case _tokentype.types._super:if(!this.inFunction)this.raise(this.start,"'super' outside of function or class");case _tokentype.types._this:var type=this.type === _tokentype.types._this?"ThisExpression":"Super";node = this.startNode();this.next();return this.finishNode(node,type);case _tokentype.types._yield:if(this.inGenerator)this.unexpected();case _tokentype.types.name:var startPos=this.start,startLoc=this.startLoc;var id=this.parseIdent(this.type !== _tokentype.types.name);if(canBeArrow && !this.canInsertSemicolon() && this.eat(_tokentype.types.arrow))return this.parseArrowExpression(this.startNodeAt(startPos,startLoc),[id]);return id;case _tokentype.types.regexp:var value=this.value;node = this.parseLiteral(value.value);node.regex = {pattern:value.pattern,flags:value.flags};return node;case _tokentype.types.num:case _tokentype.types.string:return this.parseLiteral(this.value);case _tokentype.types._null:case _tokentype.types._true:case _tokentype.types._false:node = this.startNode();node.value = this.type === _tokentype.types._null?null:this.type === _tokentype.types._true;node.raw = this.type.keyword;this.next();return this.finishNode(node,"Literal");case _tokentype.types.parenL:return this.parseParenAndDistinguishExpression(canBeArrow);case _tokentype.types.bracketL:node = this.startNode();this.next(); // check whether this is array comprehension or regular array
if(this.options.ecmaVersion >= 7 && this.type === _tokentype.types._for){return this.parseComprehension(node,false);}node.elements = this.parseExprList(_tokentype.types.bracketR,true,true,refShorthandDefaultPos);return this.finishNode(node,"ArrayExpression");case _tokentype.types.braceL:return this.parseObj(false,refShorthandDefaultPos);case _tokentype.types._function:node = this.startNode();this.next();return this.parseFunction(node,false);case _tokentype.types._class:return this.parseClass(this.startNode(),false);case _tokentype.types._new:return this.parseNew();case _tokentype.types.backQuote:return this.parseTemplate();default:this.unexpected();}};pp.parseLiteral = function(value){var node=this.startNode();node.value = value;node.raw = this.input.slice(this.start,this.end);this.next();return this.finishNode(node,"Literal");};pp.parseParenExpression = function(){this.expect(_tokentype.types.parenL);var val=this.parseExpression();this.expect(_tokentype.types.parenR);return val;};pp.parseParenAndDistinguishExpression = function(canBeArrow){var startPos=this.start,startLoc=this.startLoc,val=undefined;if(this.options.ecmaVersion >= 6){this.next();if(this.options.ecmaVersion >= 7 && this.type === _tokentype.types._for){return this.parseComprehension(this.startNodeAt(startPos,startLoc),true);}var innerStartPos=this.start,innerStartLoc=this.startLoc;var exprList=[],first=true;var refShorthandDefaultPos={start:0},spreadStart=undefined,innerParenStart=undefined;while(this.type !== _tokentype.types.parenR) {first?first = false:this.expect(_tokentype.types.comma);if(this.type === _tokentype.types.ellipsis){spreadStart = this.start;exprList.push(this.parseParenItem(this.parseRest()));break;}else {if(this.type === _tokentype.types.parenL && !innerParenStart){innerParenStart = this.start;}exprList.push(this.parseMaybeAssign(false,refShorthandDefaultPos,this.parseParenItem));}}var innerEndPos=this.start,innerEndLoc=this.startLoc;this.expect(_tokentype.types.parenR);if(canBeArrow && !this.canInsertSemicolon() && this.eat(_tokentype.types.arrow)){if(innerParenStart)this.unexpected(innerParenStart);return this.parseParenArrowList(startPos,startLoc,exprList);}if(!exprList.length)this.unexpected(this.lastTokStart);if(spreadStart)this.unexpected(spreadStart);if(refShorthandDefaultPos.start)this.unexpected(refShorthandDefaultPos.start);if(exprList.length > 1){val = this.startNodeAt(innerStartPos,innerStartLoc);val.expressions = exprList;this.finishNodeAt(val,"SequenceExpression",innerEndPos,innerEndLoc);}else {val = exprList[0];}}else {val = this.parseParenExpression();}if(this.options.preserveParens){var par=this.startNodeAt(startPos,startLoc);par.expression = val;return this.finishNode(par,"ParenthesizedExpression");}else {return val;}};pp.parseParenItem = function(item){return item;};pp.parseParenArrowList = function(startPos,startLoc,exprList){return this.parseArrowExpression(this.startNodeAt(startPos,startLoc),exprList);}; // New's precedence is slightly tricky. It must allow its argument
// to be a `[]` or dot subscript expression, but not a call — at
// least, not without wrapping it in parentheses. Thus, it uses the
var empty=[];pp.parseNew = function(){var node=this.startNode();var meta=this.parseIdent(true);if(this.options.ecmaVersion >= 6 && this.eat(_tokentype.types.dot)){node.meta = meta;node.property = this.parseIdent(true);if(node.property.name !== "target")this.raise(node.property.start,"The only valid meta property for new is new.target");return this.finishNode(node,"MetaProperty");}var startPos=this.start,startLoc=this.startLoc;node.callee = this.parseSubscripts(this.parseExprAtom(),startPos,startLoc,true);if(this.eat(_tokentype.types.parenL))node.arguments = this.parseExprList(_tokentype.types.parenR,false);else node.arguments = empty;return this.finishNode(node,"NewExpression");}; // Parse template expression.
pp.parseTemplateElement = function(){var elem=this.startNode();elem.value = {raw:this.input.slice(this.start,this.end).replace(/\r\n?/g,'\n'),cooked:this.value};this.next();elem.tail = this.type === _tokentype.types.backQuote;return this.finishNode(elem,"TemplateElement");};pp.parseTemplate = function(){var node=this.startNode();this.next();node.expressions = [];var curElt=this.parseTemplateElement();node.quasis = [curElt];while(!curElt.tail) {this.expect(_tokentype.types.dollarBraceL);node.expressions.push(this.parseExpression());this.expect(_tokentype.types.braceR);node.quasis.push(curElt = this.parseTemplateElement());}this.next();return this.finishNode(node,"TemplateLiteral");}; // Parse an object literal or binding pattern.
pp.parseObj = function(isPattern,refShorthandDefaultPos){var node=this.startNode(),first=true,propHash={};node.properties = [];this.next();while(!this.eat(_tokentype.types.braceR)) {if(!first){this.expect(_tokentype.types.comma);if(this.afterTrailingComma(_tokentype.types.braceR))break;}else first = false;var prop=this.startNode(),isGenerator=undefined,startPos=undefined,startLoc=undefined;if(this.options.ecmaVersion >= 6){prop.method = false;prop.shorthand = false;if(isPattern || refShorthandDefaultPos){startPos = this.start;startLoc = this.startLoc;}if(!isPattern)isGenerator = this.eat(_tokentype.types.star);}this.parsePropertyName(prop);this.parsePropertyValue(prop,isPattern,isGenerator,startPos,startLoc,refShorthandDefaultPos);this.checkPropClash(prop,propHash);node.properties.push(this.finishNode(prop,"Property"));}return this.finishNode(node,isPattern?"ObjectPattern":"ObjectExpression");};pp.parsePropertyValue = function(prop,isPattern,isGenerator,startPos,startLoc,refShorthandDefaultPos){if(this.eat(_tokentype.types.colon)){prop.value = isPattern?this.parseMaybeDefault(this.start,this.startLoc):this.parseMaybeAssign(false,refShorthandDefaultPos);prop.kind = "init";}else if(this.options.ecmaVersion >= 6 && this.type === _tokentype.types.parenL){if(isPattern)this.unexpected();prop.kind = "init";prop.method = true;prop.value = this.parseMethod(isGenerator);}else if(this.options.ecmaVersion >= 5 && !prop.computed && prop.key.type === "Identifier" && (prop.key.name === "get" || prop.key.name === "set") && (this.type != _tokentype.types.comma && this.type != _tokentype.types.braceR)){if(isGenerator || isPattern)this.unexpected();prop.kind = prop.key.name;this.parsePropertyName(prop);prop.value = this.parseMethod(false);var paramCount=prop.kind === "get"?0:1;if(prop.value.params.length !== paramCount){var start=prop.value.start;if(prop.kind === "get")this.raise(start,"getter should have no params");else this.raise(start,"setter should have exactly one param");}}else if(this.options.ecmaVersion >= 6 && !prop.computed && prop.key.type === "Identifier"){prop.kind = "init";if(isPattern){if(this.isKeyword(prop.key.name) || this.strict && (_identifier.reservedWords.strictBind(prop.key.name) || _identifier.reservedWords.strict(prop.key.name)) || !this.options.allowReserved && this.isReservedWord(prop.key.name))this.raise(prop.key.start,"Binding " + prop.key.name);prop.value = this.parseMaybeDefault(startPos,startLoc,prop.key);}else if(this.type === _tokentype.types.eq && refShorthandDefaultPos){if(!refShorthandDefaultPos.start)refShorthandDefaultPos.start = this.start;prop.value = this.parseMaybeDefault(startPos,startLoc,prop.key);}else {prop.value = prop.key;}prop.shorthand = true;}else this.unexpected();};pp.parsePropertyName = function(prop){if(this.options.ecmaVersion >= 6){if(this.eat(_tokentype.types.bracketL)){prop.computed = true;prop.key = this.parseMaybeAssign();this.expect(_tokentype.types.bracketR);return prop.key;}else {prop.computed = false;}}return prop.key = this.type === _tokentype.types.num || this.type === _tokentype.types.string?this.parseExprAtom():this.parseIdent(true);}; // Initialize empty function node.
pp.initFunction = function(node){node.id = null;if(this.options.ecmaVersion >= 6){node.generator = false;node.expression = false;}}; // Parse object or class method.
pp.parseMethod = function(isGenerator){var node=this.startNode();this.initFunction(node);this.expect(_tokentype.types.parenL);node.params = this.parseBindingList(_tokentype.types.parenR,false,false);var allowExpressionBody=undefined;if(this.options.ecmaVersion >= 6){node.generator = isGenerator;}this.parseFunctionBody(node,false);return this.finishNode(node,"FunctionExpression");}; // Parse arrow function expression with given parameters.
pp.parseArrowExpression = function(node,params){this.initFunction(node);node.params = this.toAssignableList(params,true);this.parseFunctionBody(node,true);return this.finishNode(node,"ArrowFunctionExpression");}; // Parse function body and check parameters.
pp.parseFunctionBody = function(node,allowExpression){var isExpression=allowExpression && this.type !== _tokentype.types.braceL;if(isExpression){node.body = this.parseMaybeAssign();node.expression = true;}else { // Start a new scope with regard to labels and the `inFunction`
// flag (restore them to their old value afterwards).
var oldInFunc=this.inFunction,oldInGen=this.inGenerator,oldLabels=this.labels;this.inFunction = true;this.inGenerator = node.generator;this.labels = [];node.body = this.parseBlock(true);node.expression = false;this.inFunction = oldInFunc;this.inGenerator = oldInGen;this.labels = oldLabels;} // If this is a strict mode function, verify that argument names
// are not repeated, and it does not try to bind the words `eval`
// or `arguments`.
if(this.strict || !isExpression && node.body.body.length && this.isUseStrict(node.body.body[0])){var nameHash={},oldStrict=this.strict;this.strict = true;if(node.id)this.checkLVal(node.id,true);for(var i=0;i < node.params.length;i++) {this.checkLVal(node.params[i],true,nameHash);}this.strict = oldStrict;}}; // Parses a comma-separated list of expressions, and returns them as
// an array. `close` is the token type that ends the list, and
// `allowEmpty` can be turned on to allow subsequent commas with
// nothing in between them to be parsed as `null` (which is needed
// for array literals).
pp.parseExprList = function(close,allowTrailingComma,allowEmpty,refShorthandDefaultPos){var elts=[],first=true;while(!this.eat(close)) {if(!first){this.expect(_tokentype.types.comma);if(allowTrailingComma && this.afterTrailingComma(close))break;}else first = false;var elt=undefined;if(allowEmpty && this.type === _tokentype.types.comma)elt = null;else if(this.type === _tokentype.types.ellipsis)elt = this.parseSpread(refShorthandDefaultPos);else elt = this.parseMaybeAssign(false,refShorthandDefaultPos);elts.push(elt);}return elts;}; // Parse the next token as an identifier. If `liberal` is true (used
// when parsing properties), it will also convert keywords into
// identifiers.
pp.parseIdent = function(liberal){var node=this.startNode();if(liberal && this.options.allowReserved == "never")liberal = false;if(this.type === _tokentype.types.name){if(!liberal && (!this.options.allowReserved && this.isReservedWord(this.value) || this.strict && _identifier.reservedWords.strict(this.value) && (this.options.ecmaVersion >= 6 || this.input.slice(this.start,this.end).indexOf("\\") == -1)))this.raise(this.start,"The keyword '" + this.value + "' is reserved");node.name = this.value;}else if(liberal && this.type.keyword){node.name = this.type.keyword;}else {this.unexpected();}this.next();return this.finishNode(node,"Identifier");}; // Parses yield expression inside generator.
pp.parseYield = function(){var node=this.startNode();this.next();if(this.type == _tokentype.types.semi || this.canInsertSemicolon() || this.type != _tokentype.types.star && !this.type.startsExpr){node.delegate = false;node.argument = null;}else {node.delegate = this.eat(_tokentype.types.star);node.argument = this.parseMaybeAssign();}return this.finishNode(node,"YieldExpression");}; // Parses array and generator comprehensions.
pp.parseComprehension = function(node,isGenerator){node.blocks = [];while(this.type === _tokentype.types._for) {var block=this.startNode();this.next();this.expect(_tokentype.types.parenL);block.left = this.parseBindingAtom();this.checkLVal(block.left,true);this.expectContextual("of");block.right = this.parseExpression();this.expect(_tokentype.types.parenR);node.blocks.push(this.finishNode(block,"ComprehensionBlock"));}node.filter = this.eat(_tokentype.types._if)?this.parseParenExpression():null;node.body = this.parseExpression();this.expect(isGenerator?_tokentype.types.parenR:_tokentype.types.bracketR);node.generator = isGenerator;return this.finishNode(node,"ComprehensionExpression");};},{"./identifier":2,"./state":10,"./tokentype":14,"./util":15}],2:[function(_dereq_,module,exports){ // This is a trick taken from Esprima. It turns out that, on
// non-Chrome browsers, to check whether a string is in a set, a
// predicate containing a big ugly `switch` statement is faster than
// a regular expression, and on Chrome the two are about on par.
// This function uses `eval` (non-lexical) to produce such a
// predicate from a space-separated string of words.
//
// It starts by sorting the words by length.
"use strict";exports.__esModule = true;exports.isIdentifierStart = isIdentifierStart;exports.isIdentifierChar = isIdentifierChar;function makePredicate(words){words = words.split(" ");var f="",cats=[];out: for(var i=0;i < words.length;++i) {for(var j=0;j < cats.length;++j) {if(cats[j][0].length == words[i].length){cats[j].push(words[i]);continue out;}}cats.push([words[i]]);}function compareTo(arr){if(arr.length == 1)return f += "return str === " + JSON.stringify(arr[0]) + ";";f += "switch(str){";for(var i=0;i < arr.length;++i) {f += "case " + JSON.stringify(arr[i]) + ":";}f += "return true}return false;";} // When there are more than three length categories, an outer
// switch first dispatches on the lengths, to save on comparisons.
if(cats.length > 3){cats.sort(function(a,b){return b.length - a.length;});f += "switch(str.length){";for(var i=0;i < cats.length;++i) {var cat=cats[i];f += "case " + cat[0].length + ":";compareTo(cat);}f += "}"; // Otherwise, simply generate a flat `switch` statement.
}else {compareTo(words);}return new Function("str",f);} // Reserved word lists for various dialects of the language
var reservedWords={3:makePredicate("abstract boolean byte char class double enum export extends final float goto implements import int interface long native package private protected public short static super synchronized throws transient volatile"),5:makePredicate("class enum extends super const export import"),6:makePredicate("enum await"),strict:makePredicate("implements interface let package private protected public static yield"),strictBind:makePredicate("eval arguments")};exports.reservedWords = reservedWords; // And the keywords
var ecma5AndLessKeywords="break case catch continue debugger default do else finally for function if return switch throw try var while with null true false instanceof typeof void delete new in this";var keywords={5:makePredicate(ecma5AndLessKeywords),6:makePredicate(ecma5AndLessKeywords + " let const class extends export import yield super")};exports.keywords = keywords; // ## Character categories
// Big ugly regular expressions that match characters in the
// whitespace, identifier, and identifier-start categories. These
// are only applied when a character is found to actually have a
// code point above 128.
// Generated by `tools/generate-identifier-regex.js`.
var nonASCIIidentifierStartChars="ªµºÀ-ÖØ-öø-ˁˆ-ˑˠ-ˤˬˮͰ-ʹͶͷͺ-ͽͿΆΈ-ΊΌΎ-ΡΣ-ϵϷ-ҁҊ-ԯԱ-Ֆՙա-ևא-תװ-ײؠ-يٮٯٱ-ۓەۥۦۮۯۺ-ۼۿܐܒ-ܯݍ-ޥޱߊ-ߪߴߵߺࠀ-ࠕࠚࠤࠨࡀ-ࡘࢠ-ࢲऄ-हऽॐक़-ॡॱ-ঀঅ-ঌএঐও-নপ-রলশ-হঽৎড়ঢ়য়-ৡৰৱਅ-ਊਏਐਓ-ਨਪ-ਰਲਲ਼ਵਸ਼ਸਹਖ਼-ੜਫ਼ੲ-ੴઅ-ઍએ-ઑઓ-નપ-રલળવ-હઽૐૠૡଅ-ଌଏଐଓ-ନପ-ରଲଳଵ-ହଽଡ଼ଢ଼ୟ-ୡୱஃஅ-ஊஎ-ஐஒ-கஙசஜஞடணதந-பம-ஹௐఅ-ఌఎ-ఐఒ-నప-హఽౘౙౠౡಅ-ಌಎ-ಐಒ-ನಪ-ಳವ-ಹಽೞೠೡೱೲഅ-ഌഎ-ഐഒ-ഺഽൎൠൡൺ-ൿඅ-ඖක-නඳ-රලව-ෆก-ะาำเ-ๆກຂຄງຈຊຍດ-ທນ-ຟມ-ຣລວສຫອ-ະາຳຽເ-ໄໆໜ-ໟༀཀ-ཇཉ-ཬྈ-ྌက-ဪဿၐ-ၕၚ-ၝၡၥၦၮ-ၰၵ-ႁႎႠ-ჅჇჍა-ჺჼ-ቈቊ-ቍቐ-ቖቘቚ-ቝበ-ኈኊ-ኍነ-ኰኲ-ኵኸ-ኾዀዂ-ዅወ-ዖዘ-ጐጒ-ጕጘ-ፚᎀ-ᎏᎠ-Ᏼᐁ-ᙬᙯ-ᙿᚁ-ᚚᚠ-ᛪᛮ-ᛸᜀ-ᜌᜎ-ᜑᜠ-ᜱᝀ-ᝑᝠ-ᝬᝮ-ᝰក-ឳៗៜᠠ-ᡷᢀ-ᢨᢪᢰ-ᣵᤀ-ᤞᥐ-ᥭᥰ-ᥴᦀ-ᦫᧁ-ᧇᨀ-ᨖᨠ-ᩔᪧᬅ-ᬳᭅ-ᭋᮃ-ᮠᮮᮯᮺ-ᯥᰀ-ᰣᱍ-ᱏᱚ-ᱽᳩ-ᳬᳮ-ᳱᳵᳶᴀ-ᶿḀ-ἕἘ-Ἕἠ-ὅὈ-Ὅὐ-ὗὙὛὝὟ-ώᾀ-ᾴᾶ-ᾼιῂ-ῄῆ-ῌῐ-ΐῖ-Ίῠ-Ῥῲ-ῴῶ-ῼⁱⁿₐ-ₜℂℇℊ-ℓℕ℘-ℝℤΩℨK-ℹℼ-ℿⅅ-ⅉⅎⅠ-ↈⰀ-Ⱞⰰ-ⱞⱠ-ⳤⳫ-ⳮⳲⳳⴀ-ⴥⴧⴭⴰ-ⵧⵯⶀ-ⶖⶠ-ⶦⶨ-ⶮⶰ-ⶶⶸ-ⶾⷀ-ⷆⷈ-ⷎⷐ-ⷖⷘ-ⷞ々-〇〡-〩〱-〵〸-〼ぁ-ゖ゛-ゟァ-ヺー-ヿㄅ-ㄭㄱ-ㆎㆠ-ㆺㇰ-ㇿ㐀-䶵一-鿌ꀀ-ꒌꓐ-ꓽꔀ-ꘌꘐ-ꘟꘪꘫꙀ-ꙮꙿ-ꚝꚠ-ꛯꜗ-ꜟꜢ-ꞈꞋ-ꞎꞐ-ꞭꞰꞱꟷ-ꠁꠃ-ꠅꠇ-ꠊꠌ-ꠢꡀ-ꡳꢂ-ꢳꣲ-ꣷꣻꤊ-ꤥꤰ-ꥆꥠ-ꥼꦄ-ꦲꧏꧠ-ꧤꧦ-ꧯꧺ-ꧾꨀ-ꨨꩀ-ꩂꩄ-ꩋꩠ-ꩶꩺꩾ-ꪯꪱꪵꪶꪹ-ꪽꫀꫂꫛ-ꫝꫠ-ꫪꫲ-ꫴꬁ-ꬆꬉ-ꬎꬑ-ꬖꬠ-ꬦꬨ-ꬮꬰ-ꭚꭜ-ꭟꭤꭥꯀ-ꯢ가-힣ힰ-ퟆퟋ-ퟻ豈-舘並-龎ﬀ-ﬆﬓ-ﬗיִײַ-ﬨשׁ-זּטּ-לּמּנּסּףּפּצּ-ﮱﯓ-ﴽﵐ-ﶏﶒ-ﷇﷰ-ﷻﹰ-ﹴﹶ-ﻼＡ-Ｚａ-ｚｦ-ﾾￂ-ￇￊ-ￏￒ-ￗￚ-ￜ";var nonASCIIidentifierChars="‌‍·̀-ͯ·҃-֑҇-ׇֽֿׁׂׅׄؐ-ًؚ-٩ٰۖ-ۜ۟-۪ۤۧۨ-ۭ۰-۹ܑܰ-݊ަ-ް߀-߉߫-߳ࠖ-࠙ࠛ-ࠣࠥ-ࠧࠩ-࡙࠭-࡛ࣤ-ःऺ-़ा-ॏ॑-ॗॢॣ०-९ঁ-ঃ়া-ৄেৈো-্ৗৢৣ০-৯ਁ-ਃ਼ਾ-ੂੇੈੋ-੍ੑ੦-ੱੵઁ-ઃ઼ા-ૅે-ૉો-્ૢૣ૦-૯ଁ-ଃ଼ା-ୄେୈୋ-୍ୖୗୢୣ୦-୯ஂா-ூெ-ைொ-்ௗ௦-௯ఀ-ఃా-ౄె-ైొ-్ౕౖౢౣ౦-౯ಁ-ಃ಼ಾ-ೄೆ-ೈೊ-್ೕೖೢೣ೦-೯ഁ-ഃാ-ൄെ-ൈൊ-്ൗൢൣ൦-൯ංඃ්ා-ුූෘ-ෟ෦-෯ෲෳัิ-ฺ็-๎๐-๙ັິ-ູົຼ່-ໍ໐-໙༘༙༠-༩༹༵༷༾༿ཱ-྄྆྇ྍ-ྗྙ-ྼ࿆ါ-ှ၀-၉ၖ-ၙၞ-ၠၢ-ၤၧ-ၭၱ-ၴႂ-ႍႏ-ႝ፝-፟፩-፱ᜒ-᜔ᜲ-᜴ᝒᝓᝲᝳ឴-៓៝០-៩᠋-᠍᠐-᠙ᢩᤠ-ᤫᤰ-᤻᥆-᥏ᦰ-ᧀᧈᧉ᧐-᧚ᨗ-ᨛᩕ-ᩞ᩠-᩿᩼-᪉᪐-᪙᪰-᪽ᬀ-ᬄ᬴-᭄᭐-᭙᭫-᭳ᮀ-ᮂᮡ-ᮭ᮰-᮹᯦-᯳ᰤ-᰷᱀-᱉᱐-᱙᳐-᳔᳒-᳨᳭ᳲ-᳴᳸᳹᷀-᷵᷼-᷿‿⁀⁔⃐-⃥⃜⃡-⃰⳯-⵿⳱ⷠ-〪ⷿ-゙゚〯꘠-꘩꙯ꙴ-꙽ꚟ꛰꛱ꠂ꠆ꠋꠣ-ꠧꢀꢁꢴ-꣄꣐-꣙꣠-꣱꤀-꤉ꤦ-꤭ꥇ-꥓ꦀ-ꦃ꦳-꧀꧐-꧙ꧥ꧰-꧹ꨩ-ꨶꩃꩌꩍ꩐-꩙ꩻ-ꩽꪰꪲ-ꪴꪷꪸꪾ꪿꫁ꫫ-ꫯꫵ꫶ꯣ-ꯪ꯬꯭꯰-꯹ﬞ︀-️︠-︭︳︴﹍-﹏０-９＿";var nonASCIIidentifierStart=new RegExp("[" + nonASCIIidentifierStartChars + "]");var nonASCIIidentifier=new RegExp("[" + nonASCIIidentifierStartChars + nonASCIIidentifierChars + "]");nonASCIIidentifierStartChars = nonASCIIidentifierChars = null; // These are a run-length and offset encoded representation of the
// >0xffff code points that are a valid part of identifiers. The
// offset starts at 0x10000, and each pair of numbers represents an
// offset to the next range, and then a size of the range. They were
// generated by tools/generate-identifier-regex.js
var astralIdentifierStartCodes=[0,11,2,25,2,18,2,1,2,14,3,13,35,122,70,52,268,28,4,48,48,31,17,26,6,37,11,29,3,35,5,7,2,4,43,157,99,39,9,51,157,310,10,21,11,7,153,5,3,0,2,43,2,1,4,0,3,22,11,22,10,30,98,21,11,25,71,55,7,1,65,0,16,3,2,2,2,26,45,28,4,28,36,7,2,27,28,53,11,21,11,18,14,17,111,72,955,52,76,44,33,24,27,35,42,34,4,0,13,47,15,3,22,0,38,17,2,24,133,46,39,7,3,1,3,21,2,6,2,1,2,4,4,0,32,4,287,47,21,1,2,0,185,46,82,47,21,0,60,42,502,63,32,0,449,56,1288,920,104,110,2962,1070,13266,568,8,30,114,29,19,47,17,3,32,20,6,18,881,68,12,0,67,12,16481,1,3071,106,6,12,4,8,8,9,5991,84,2,70,2,1,3,0,3,1,3,3,2,11,2,0,2,6,2,64,2,3,3,7,2,6,2,27,2,3,2,4,2,0,4,6,2,339,3,24,2,24,2,30,2,24,2,30,2,24,2,30,2,24,2,30,2,24,2,7,4149,196,1340,3,2,26,2,1,2,0,3,0,2,9,2,3,2,0,2,0,7,0,5,0,2,0,2,0,2,2,2,1,2,0,3,0,2,0,2,0,2,0,2,0,2,1,2,0,3,3,2,6,2,3,2,3,2,0,2,9,2,16,6,2,2,4,2,16,4421,42710,42,4148,12,221,16355,541];var astralIdentifierCodes=[509,0,227,0,150,4,294,9,1368,2,2,1,6,3,41,2,5,0,166,1,1306,2,54,14,32,9,16,3,46,10,54,9,7,2,37,13,2,9,52,0,13,2,49,13,16,9,83,11,168,11,6,9,8,2,57,0,2,6,3,1,3,2,10,0,11,1,3,6,4,4,316,19,13,9,214,6,3,8,112,16,16,9,82,12,9,9,535,9,20855,9,135,4,60,6,26,9,1016,45,17,3,19723,1,5319,4,4,5,9,7,3,6,31,3,149,2,1418,49,4305,6,792618,239]; // This has a complexity linear to the value of the code. The
// assumption is that looking up astral identifier characters is
// rare.
function isInAstralSet(code,set){var pos=0x10000;for(var i=0;i < set.length;i += 2) {pos += set[i];if(pos > code)return false;pos += set[i + 1];if(pos >= code)return true;}} // Test whether a given character code starts an identifier.
function isIdentifierStart(code,astral){if(code < 65)return code === 36;if(code < 91)return true;if(code < 97)return code === 95;if(code < 123)return true;if(code <= 0xffff)return code >= 0xaa && nonASCIIidentifierStart.test(String.fromCharCode(code));if(astral === false)return false;return isInAstralSet(code,astralIdentifierStartCodes);} // Test whether a given character is part of an identifier.
function isIdentifierChar(code,astral){if(code < 48)return code === 36;if(code < 58)return true;if(code < 65)return false;if(code < 91)return true;if(code < 97)return code === 95;if(code < 123)return true;if(code <= 0xffff)return code >= 0xaa && nonASCIIidentifier.test(String.fromCharCode(code));if(astral === false)return false;return isInAstralSet(code,astralIdentifierStartCodes) || isInAstralSet(code,astralIdentifierCodes);}},{}],3:[function(_dereq_,module,exports){ // Acorn is a tiny, fast JavaScript parser written in JavaScript.
//
// Acorn was written by Marijn Haverbeke, Ingvar Stepanyan, and
// various contributors and released under an MIT license.
//
// Git repositories for Acorn are available at
//
//     http://marijnhaverbeke.nl/git/acorn
//     https://github.com/marijnh/acorn.git
//
// Please use the [github bug tracker][ghbt] to report issues.
//
// [ghbt]: https://github.com/marijnh/acorn/issues
//
// This file defines the main parser interface. The library also comes
// with a [error-tolerant parser][dammit] and an
// [abstract syntax tree walker][walk], defined in other files.
//
// [dammit]: acorn_loose.js
// [walk]: util/walk.js
"use strict";exports.__esModule = true;exports.parse = parse;exports.parseExpressionAt = parseExpressionAt;exports.tokenizer = tokenizer;var _state=_dereq_("./state");var _options=_dereq_("./options");_dereq_("./parseutil");_dereq_("./statement");_dereq_("./lval");_dereq_("./expression");_dereq_("./location");exports.Parser = _state.Parser;exports.plugins = _state.plugins;exports.defaultOptions = _options.defaultOptions;var _locutil=_dereq_("./locutil");exports.Position = _locutil.Position;exports.SourceLocation = _locutil.SourceLocation;exports.getLineInfo = _locutil.getLineInfo;var _node=_dereq_("./node");exports.Node = _node.Node;var _tokentype=_dereq_("./tokentype");exports.TokenType = _tokentype.TokenType;exports.tokTypes = _tokentype.types;var _tokencontext=_dereq_("./tokencontext");exports.TokContext = _tokencontext.TokContext;exports.tokContexts = _tokencontext.types;var _identifier=_dereq_("./identifier");exports.isIdentifierChar = _identifier.isIdentifierChar;exports.isIdentifierStart = _identifier.isIdentifierStart;var _tokenize=_dereq_("./tokenize");exports.Token = _tokenize.Token;var _whitespace=_dereq_("./whitespace");exports.isNewLine = _whitespace.isNewLine;exports.lineBreak = _whitespace.lineBreak;exports.lineBreakG = _whitespace.lineBreakG;var version="2.2.0";exports.version = version; // The main exported interface (under `self.acorn` when in the
// browser) is a `parse` function that takes a code string and
// returns an abstract syntax tree as specified by [Mozilla parser
// API][api].
//
// [api]: https://developer.mozilla.org/en-US/docs/SpiderMonkey/Parser_API
function parse(input,options){return new _state.Parser(options,input).parse();} // This function tries to parse a single expression at a given
// offset in a string. Useful for parsing mixed-language formats
// that embed JavaScript expressions.
function parseExpressionAt(input,pos,options){var p=new _state.Parser(options,input,pos);p.nextToken();return p.parseExpression();} // Acorn is organized as a tokenizer and a recursive-descent parser.
// The `tokenize` export provides an interface to the tokenizer.
function tokenizer(input,options){return new _state.Parser(options,input);}},{"./expression":1,"./identifier":2,"./location":4,"./locutil":5,"./lval":6,"./node":7,"./options":8,"./parseutil":9,"./state":10,"./statement":11,"./tokencontext":12,"./tokenize":13,"./tokentype":14,"./whitespace":16}],4:[function(_dereq_,module,exports){"use strict";var _state=_dereq_("./state");var _locutil=_dereq_("./locutil");var pp=_state.Parser.prototype; // This function is used to raise exceptions on parse errors. It
// takes an offset integer (into the current `input`) to indicate
// the location of the error, attaches the position to the end
// of the error message, and then raises a `SyntaxError` with that
// message.
pp.raise = function(pos,message){var loc=_locutil.getLineInfo(this.input,pos);message += " (" + loc.line + ":" + loc.column + ")";var err=new SyntaxError(message);err.pos = pos;err.loc = loc;err.raisedAt = this.pos;throw err;};pp.curPosition = function(){if(this.options.locations){return new _locutil.Position(this.curLine,this.pos - this.lineStart);}};},{"./locutil":5,"./state":10}],5:[function(_dereq_,module,exports){"use strict";exports.__esModule = true;exports.getLineInfo = getLineInfo;function _classCallCheck(instance,Constructor){if(!(instance instanceof Constructor)){throw new TypeError("Cannot call a class as a function");}}var _whitespace=_dereq_("./whitespace"); // These are used when `options.locations` is on, for the
// `startLoc` and `endLoc` properties.
var Position=(function(){function Position(line,col){_classCallCheck(this,Position);this.line = line;this.column = col;}Position.prototype.offset = function offset(n){return new Position(this.line,this.column + n);};return Position;})();exports.Position = Position;var SourceLocation=function SourceLocation(p,start,end){_classCallCheck(this,SourceLocation);this.start = start;this.end = end;if(p.sourceFile !== null)this.source = p.sourceFile;} // The `getLineInfo` function is mostly useful when the
// `locations` option is off (for performance reasons) and you
// want to find the line/column position for a given character
// offset. `input` should be the code string that the offset refers
// into.
;exports.SourceLocation = SourceLocation;function getLineInfo(input,offset){for(var line=1,cur=0;;) {_whitespace.lineBreakG.lastIndex = cur;var match=_whitespace.lineBreakG.exec(input);if(match && match.index < offset){++line;cur = match.index + match[0].length;}else {return new Position(line,offset - cur);}}}},{"./whitespace":16}],6:[function(_dereq_,module,exports){"use strict";var _tokentype=_dereq_("./tokentype");var _state=_dereq_("./state");var _identifier=_dereq_("./identifier");var _util=_dereq_("./util");var pp=_state.Parser.prototype; // Convert existing expression atom to assignable pattern
// if possible.
pp.toAssignable = function(node,isBinding){if(this.options.ecmaVersion >= 6 && node){switch(node.type){case "Identifier":case "ObjectPattern":case "ArrayPattern":case "AssignmentPattern":break;case "ObjectExpression":node.type = "ObjectPattern";for(var i=0;i < node.properties.length;i++) {var prop=node.properties[i];if(prop.kind !== "init")this.raise(prop.key.start,"Object pattern can't contain getter or setter");this.toAssignable(prop.value,isBinding);}break;case "ArrayExpression":node.type = "ArrayPattern";this.toAssignableList(node.elements,isBinding);break;case "AssignmentExpression":if(node.operator === "="){node.type = "AssignmentPattern";delete node.operator;}else {this.raise(node.left.end,"Only '=' operator can be used for specifying default value.");}break;case "ParenthesizedExpression":node.expression = this.toAssignable(node.expression,isBinding);break;case "MemberExpression":if(!isBinding)break;default:this.raise(node.start,"Assigning to rvalue");}}return node;}; // Convert list of expression atoms to binding list.
pp.toAssignableList = function(exprList,isBinding){var end=exprList.length;if(end){var last=exprList[end - 1];if(last && last.type == "RestElement"){--end;}else if(last && last.type == "SpreadElement"){last.type = "RestElement";var arg=last.argument;this.toAssignable(arg,isBinding);if(arg.type !== "Identifier" && arg.type !== "MemberExpression" && arg.type !== "ArrayPattern")this.unexpected(arg.start);--end;}}for(var i=0;i < end;i++) {var elt=exprList[i];if(elt)this.toAssignable(elt,isBinding);}return exprList;}; // Parses spread element.
pp.parseSpread = function(refShorthandDefaultPos){var node=this.startNode();this.next();node.argument = this.parseMaybeAssign(refShorthandDefaultPos);return this.finishNode(node,"SpreadElement");};pp.parseRest = function(){var node=this.startNode();this.next();node.argument = this.type === _tokentype.types.name || this.type === _tokentype.types.bracketL?this.parseBindingAtom():this.unexpected();return this.finishNode(node,"RestElement");}; // Parses lvalue (assignable) atom.
pp.parseBindingAtom = function(){if(this.options.ecmaVersion < 6)return this.parseIdent();switch(this.type){case _tokentype.types.name:return this.parseIdent();case _tokentype.types.bracketL:var node=this.startNode();this.next();node.elements = this.parseBindingList(_tokentype.types.bracketR,true,true);return this.finishNode(node,"ArrayPattern");case _tokentype.types.braceL:return this.parseObj(true);default:this.unexpected();}};pp.parseBindingList = function(close,allowEmpty,allowTrailingComma){var elts=[],first=true;while(!this.eat(close)) {if(first)first = false;else this.expect(_tokentype.types.comma);if(allowEmpty && this.type === _tokentype.types.comma){elts.push(null);}else if(allowTrailingComma && this.afterTrailingComma(close)){break;}else if(this.type === _tokentype.types.ellipsis){var rest=this.parseRest();this.parseBindingListItem(rest);elts.push(rest);this.expect(close);break;}else {var elem=this.parseMaybeDefault(this.start,this.startLoc);this.parseBindingListItem(elem);elts.push(elem);}}return elts;};pp.parseBindingListItem = function(param){return param;}; // Parses assignment pattern around given atom if possible.
pp.parseMaybeDefault = function(startPos,startLoc,left){left = left || this.parseBindingAtom();if(!this.eat(_tokentype.types.eq))return left;var node=this.startNodeAt(startPos,startLoc);node.left = left;node.right = this.parseMaybeAssign();return this.finishNode(node,"AssignmentPattern");}; // Verify that a node is an lval — something that can be assigned
// to.
pp.checkLVal = function(expr,isBinding,checkClashes){switch(expr.type){case "Identifier":if(this.strict && (_identifier.reservedWords.strictBind(expr.name) || _identifier.reservedWords.strict(expr.name)))this.raise(expr.start,(isBinding?"Binding ":"Assigning to ") + expr.name + " in strict mode");if(checkClashes){if(_util.has(checkClashes,expr.name))this.raise(expr.start,"Argument name clash in strict mode");checkClashes[expr.name] = true;}break;case "MemberExpression":if(isBinding)this.raise(expr.start,(isBinding?"Binding":"Assigning to") + " member expression");break;case "ObjectPattern":for(var i=0;i < expr.properties.length;i++) {this.checkLVal(expr.properties[i].value,isBinding,checkClashes);}break;case "ArrayPattern":for(var i=0;i < expr.elements.length;i++) {var elem=expr.elements[i];if(elem)this.checkLVal(elem,isBinding,checkClashes);}break;case "AssignmentPattern":this.checkLVal(expr.left,isBinding,checkClashes);break;case "RestElement":this.checkLVal(expr.argument,isBinding,checkClashes);break;case "ParenthesizedExpression":this.checkLVal(expr.expression,isBinding,checkClashes);break;default:this.raise(expr.start,(isBinding?"Binding":"Assigning to") + " rvalue");}};},{"./identifier":2,"./state":10,"./tokentype":14,"./util":15}],7:[function(_dereq_,module,exports){"use strict";exports.__esModule = true;function _classCallCheck(instance,Constructor){if(!(instance instanceof Constructor)){throw new TypeError("Cannot call a class as a function");}}var _state=_dereq_("./state");var _locutil=_dereq_("./locutil");var Node=function Node(parser,pos,loc){_classCallCheck(this,Node);this.type = "";this.start = pos;this.end = 0;if(parser.options.locations)this.loc = new _locutil.SourceLocation(parser,loc);if(parser.options.directSourceFile)this.sourceFile = parser.options.directSourceFile;if(parser.options.ranges)this.range = [pos,0];} // Start an AST node, attaching a start offset.
;exports.Node = Node;var pp=_state.Parser.prototype;pp.startNode = function(){return new Node(this,this.start,this.startLoc);};pp.startNodeAt = function(pos,loc){return new Node(this,pos,loc);}; // Finish an AST node, adding `type` and `end` properties.
function finishNodeAt(node,type,pos,loc){node.type = type;node.end = pos;if(this.options.locations)node.loc.end = loc;if(this.options.ranges)node.range[1] = pos;return node;}pp.finishNode = function(node,type){return finishNodeAt.call(this,node,type,this.lastTokEnd,this.lastTokEndLoc);}; // Finish node at given position
pp.finishNodeAt = function(node,type,pos,loc){return finishNodeAt.call(this,node,type,pos,loc);};},{"./locutil":5,"./state":10}],8:[function(_dereq_,module,exports){"use strict";exports.__esModule = true;exports.getOptions = getOptions;var _util=_dereq_("./util");var _locutil=_dereq_("./locutil"); // A second optional argument can be given to further configure
// the parser process. These options are recognized:
var defaultOptions={ // `ecmaVersion` indicates the ECMAScript version to parse. Must
// be either 3, or 5, or 6. This influences support for strict
// mode, the set of reserved words, support for getters and
// setters and other features.
ecmaVersion:5, // Source type ("script" or "module") for different semantics
sourceType:"script", // `onInsertedSemicolon` can be a callback that will be called
// when a semicolon is automatically inserted. It will be passed
// th position of the comma as an offset, and if `locations` is
// enabled, it is given the location as a `{line, column}` object
// as second argument.
onInsertedSemicolon:null, // `onTrailingComma` is similar to `onInsertedSemicolon`, but for
// trailing commas.
onTrailingComma:null, // By default, reserved words are not enforced. Disable
// `allowReserved` to enforce them. When this option has the
// value "never", reserved words and keywords can also not be
// used as property names.
allowReserved:true, // When enabled, a return at the top level is not considered an
// error.
allowReturnOutsideFunction:false, // When enabled, import/export statements are not constrained to
// appearing at the top of the program.
allowImportExportEverywhere:false, // When enabled, hashbang directive in the beginning of file
// is allowed and treated as a line comment.
allowHashBang:false, // When `locations` is on, `loc` properties holding objects with
// `start` and `end` properties in `{line, column}` form (with
// line being 1-based and column 0-based) will be attached to the
// nodes.
locations:false, // A function can be passed as `onToken` option, which will
// cause Acorn to call that function with object in the same
// format as tokenize() returns. Note that you are not
// allowed to call the parser from the callback—that will
// corrupt its internal state.
onToken:null, // A function can be passed as `onComment` option, which will
// cause Acorn to call that function with `(block, text, start,
// end)` parameters whenever a comment is skipped. `block` is a
// boolean indicating whether this is a block (`/* */`) comment,
// `text` is the content of the comment, and `start` and `end` are
// character offsets that denote the start and end of the comment.
// When the `locations` option is on, two more parameters are
// passed, the full `{line, column}` locations of the start and
// end of the comments. Note that you are not allowed to call the
// parser from the callback—that will corrupt its internal state.
onComment:null, // Nodes have their start and end characters offsets recorded in
// `start` and `end` properties (directly on the node, rather than
// the `loc` object, which holds line/column data. To also add a
// [semi-standardized][range] `range` property holding a `[start,
// end]` array with the same numbers, set the `ranges` option to
// `true`.
//
// [range]: https://bugzilla.mozilla.org/show_bug.cgi?id=745678
ranges:false, // It is possible to parse multiple files into a single AST by
// passing the tree produced by parsing the first file as
// `program` option in subsequent parses. This will add the
// toplevel forms of the parsed file to the `Program` (top) node
// of an existing parse tree.
program:null, // When `locations` is on, you can pass this to record the source
// file in every node's `loc` object.
sourceFile:null, // This value, if given, is stored in every node, whether
// `locations` is on or off.
directSourceFile:null, // When enabled, parenthesized expressions are represented by
// (non-standard) ParenthesizedExpression nodes
preserveParens:false,plugins:{}};exports.defaultOptions = defaultOptions; // Interpret and default an options object
function getOptions(opts){var options={};for(var opt in defaultOptions) {options[opt] = opts && _util.has(opts,opt)?opts[opt]:defaultOptions[opt];}if(_util.isArray(options.onToken)){(function(){var tokens=options.onToken;options.onToken = function(token){return tokens.push(token);};})();}if(_util.isArray(options.onComment))options.onComment = pushComment(options,options.onComment);return options;}function pushComment(options,array){return function(block,text,start,end,startLoc,endLoc){var comment={type:block?'Block':'Line',value:text,start:start,end:end};if(options.locations)comment.loc = new _locutil.SourceLocation(this,startLoc,endLoc);if(options.ranges)comment.range = [start,end];array.push(comment);};}},{"./locutil":5,"./util":15}],9:[function(_dereq_,module,exports){"use strict";var _tokentype=_dereq_("./tokentype");var _state=_dereq_("./state");var _whitespace=_dereq_("./whitespace");var pp=_state.Parser.prototype; // ## Parser utilities
// Test whether a statement node is the string literal `"use strict"`.
pp.isUseStrict = function(stmt){return this.options.ecmaVersion >= 5 && stmt.type === "ExpressionStatement" && stmt.expression.type === "Literal" && stmt.expression.raw.slice(1,-1) === "use strict";}; // Predicate that tests whether the next token is of the given
// type, and if yes, consumes it as a side effect.
pp.eat = function(type){if(this.type === type){this.next();return true;}else {return false;}}; // Tests whether parsed token is a contextual keyword.
pp.isContextual = function(name){return this.type === _tokentype.types.name && this.value === name;}; // Consumes contextual keyword if possible.
pp.eatContextual = function(name){return this.value === name && this.eat(_tokentype.types.name);}; // Asserts that following token is given contextual keyword.
pp.expectContextual = function(name){if(!this.eatContextual(name))this.unexpected();}; // Test whether a semicolon can be inserted at the current position.
pp.canInsertSemicolon = function(){return this.type === _tokentype.types.eof || this.type === _tokentype.types.braceR || _whitespace.lineBreak.test(this.input.slice(this.lastTokEnd,this.start));};pp.insertSemicolon = function(){if(this.canInsertSemicolon()){if(this.options.onInsertedSemicolon)this.options.onInsertedSemicolon(this.lastTokEnd,this.lastTokEndLoc);return true;}}; // Consume a semicolon, or, failing that, see if we are allowed to
// pretend that there is a semicolon at this position.
pp.semicolon = function(){if(!this.eat(_tokentype.types.semi) && !this.insertSemicolon())this.unexpected();};pp.afterTrailingComma = function(tokType){if(this.type == tokType){if(this.options.onTrailingComma)this.options.onTrailingComma(this.lastTokStart,this.lastTokStartLoc);this.next();return true;}}; // Expect a token of a given type. If found, consume it, otherwise,
// raise an unexpected token error.
pp.expect = function(type){this.eat(type) || this.unexpected();}; // Raise an unexpected token error.
pp.unexpected = function(pos){this.raise(pos != null?pos:this.start,"Unexpected token");};},{"./state":10,"./tokentype":14,"./whitespace":16}],10:[function(_dereq_,module,exports){"use strict";exports.__esModule = true;function _classCallCheck(instance,Constructor){if(!(instance instanceof Constructor)){throw new TypeError("Cannot call a class as a function");}}var _identifier=_dereq_("./identifier");var _tokentype=_dereq_("./tokentype");var _whitespace=_dereq_("./whitespace");var _options=_dereq_("./options"); // Registered plugins
var plugins={};exports.plugins = plugins;var Parser=(function(){function Parser(options,input,startPos){_classCallCheck(this,Parser);this.options = _options.getOptions(options);this.sourceFile = this.options.sourceFile;this.isKeyword = _identifier.keywords[this.options.ecmaVersion >= 6?6:5];this.isReservedWord = _identifier.reservedWords[this.options.ecmaVersion];this.input = String(input); // Used to signal to callers of `readWord1` whether the word
// contained any escape sequences. This is needed because words with
// escape sequences must not be interpreted as keywords.
this.containsEsc = false; // Load plugins
this.loadPlugins(this.options.plugins); // Set up token state
// The current position of the tokenizer in the input.
if(startPos){this.pos = startPos;this.lineStart = Math.max(0,this.input.lastIndexOf("\n",startPos));this.curLine = this.input.slice(0,this.lineStart).split(_whitespace.lineBreak).length;}else {this.pos = this.lineStart = 0;this.curLine = 1;} // Properties of the current token:
// Its type
this.type = _tokentype.types.eof; // For tokens that include more information than their type, the value
this.value = null; // Its start and end offset
this.start = this.end = this.pos; // And, if locations are used, the {line, column} object
// corresponding to those offsets
this.startLoc = this.endLoc = this.curPosition(); // Position information for the previous token
this.lastTokEndLoc = this.lastTokStartLoc = null;this.lastTokStart = this.lastTokEnd = this.pos; // The context stack is used to superficially track syntactic
// context to predict whether a regular expression is allowed in a
// given position.
this.context = this.initialContext();this.exprAllowed = true; // Figure out if it's a module code.
this.strict = this.inModule = this.options.sourceType === "module"; // Used to signify the start of a potential arrow function
this.potentialArrowAt = -1; // Flags to track whether we are in a function, a generator.
this.inFunction = this.inGenerator = false; // Labels in scope.
this.labels = []; // If enabled, skip leading hashbang line.
if(this.pos === 0 && this.options.allowHashBang && this.input.slice(0,2) === '#!')this.skipLineComment(2);}Parser.prototype.extend = function extend(name,f){this[name] = f(this[name]);};Parser.prototype.loadPlugins = function loadPlugins(pluginConfigs){for(var _name in pluginConfigs) {var plugin=plugins[_name];if(!plugin)throw new Error("Plugin '" + _name + "' not found");plugin(this,pluginConfigs[_name]);}};Parser.prototype.parse = function parse(){var node=this.options.program || this.startNode();this.nextToken();return this.parseTopLevel(node);};return Parser;})();exports.Parser = Parser;},{"./identifier":2,"./options":8,"./tokentype":14,"./whitespace":16}],11:[function(_dereq_,module,exports){"use strict";var _tokentype=_dereq_("./tokentype");var _state=_dereq_("./state");var _whitespace=_dereq_("./whitespace");var pp=_state.Parser.prototype; // ### Statement parsing
// Parse a program. Initializes the parser, reads any number of
// statements, and wraps them in a Program node.  Optionally takes a
// `program` argument.  If present, the statements will be appended
// to its body instead of creating a new node.
pp.parseTopLevel = function(node){var first=true;if(!node.body)node.body = [];while(this.type !== _tokentype.types.eof) {var stmt=this.parseStatement(true,true);node.body.push(stmt);if(first){if(this.isUseStrict(stmt))this.setStrict(true);first = false;}}this.next();if(this.options.ecmaVersion >= 6){node.sourceType = this.options.sourceType;}return this.finishNode(node,"Program");};var loopLabel={kind:"loop"},switchLabel={kind:"switch"}; // Parse a single statement.
//
// If expecting a statement and finding a slash operator, parse a
// regular expression literal. This is to handle cases like
// `if (foo) /blah/.exec(foo)`, where looking at the previous token
// does not help.
pp.parseStatement = function(declaration,topLevel){var starttype=this.type,node=this.startNode(); // Most types of statements are recognized by the keyword they
// start with. Many are trivial to parse, some require a bit of
// complexity.
switch(starttype){case _tokentype.types._break:case _tokentype.types._continue:return this.parseBreakContinueStatement(node,starttype.keyword);case _tokentype.types._debugger:return this.parseDebuggerStatement(node);case _tokentype.types._do:return this.parseDoStatement(node);case _tokentype.types._for:return this.parseForStatement(node);case _tokentype.types._function:if(!declaration && this.options.ecmaVersion >= 6)this.unexpected();return this.parseFunctionStatement(node);case _tokentype.types._class:if(!declaration)this.unexpected();return this.parseClass(node,true);case _tokentype.types._if:return this.parseIfStatement(node);case _tokentype.types._return:return this.parseReturnStatement(node);case _tokentype.types._switch:return this.parseSwitchStatement(node);case _tokentype.types._throw:return this.parseThrowStatement(node);case _tokentype.types._try:return this.parseTryStatement(node);case _tokentype.types._let:case _tokentype.types._const:if(!declaration)this.unexpected(); // NOTE: falls through to _var
case _tokentype.types._var:return this.parseVarStatement(node,starttype);case _tokentype.types._while:return this.parseWhileStatement(node);case _tokentype.types._with:return this.parseWithStatement(node);case _tokentype.types.braceL:return this.parseBlock();case _tokentype.types.semi:return this.parseEmptyStatement(node);case _tokentype.types._export:case _tokentype.types._import:if(!this.options.allowImportExportEverywhere){if(!topLevel)this.raise(this.start,"'import' and 'export' may only appear at the top level");if(!this.inModule)this.raise(this.start,"'import' and 'export' may appear only with 'sourceType: module'");}return starttype === _tokentype.types._import?this.parseImport(node):this.parseExport(node); // If the statement does not start with a statement keyword or a
// brace, it's an ExpressionStatement or LabeledStatement. We
// simply start parsing an expression, and afterwards, if the
// next token is a colon and the expression was a simple
// Identifier node, we switch to interpreting it as a label.
default:var maybeName=this.value,expr=this.parseExpression();if(starttype === _tokentype.types.name && expr.type === "Identifier" && this.eat(_tokentype.types.colon))return this.parseLabeledStatement(node,maybeName,expr);else return this.parseExpressionStatement(node,expr);}};pp.parseBreakContinueStatement = function(node,keyword){var isBreak=keyword == "break";this.next();if(this.eat(_tokentype.types.semi) || this.insertSemicolon())node.label = null;else if(this.type !== _tokentype.types.name)this.unexpected();else {node.label = this.parseIdent();this.semicolon();} // Verify that there is an actual destination to break or
// continue to.
for(var i=0;i < this.labels.length;++i) {var lab=this.labels[i];if(node.label == null || lab.name === node.label.name){if(lab.kind != null && (isBreak || lab.kind === "loop"))break;if(node.label && isBreak)break;}}if(i === this.labels.length)this.raise(node.start,"Unsyntactic " + keyword);return this.finishNode(node,isBreak?"BreakStatement":"ContinueStatement");};pp.parseDebuggerStatement = function(node){this.next();this.semicolon();return this.finishNode(node,"DebuggerStatement");};pp.parseDoStatement = function(node){this.next();this.labels.push(loopLabel);node.body = this.parseStatement(false);this.labels.pop();this.expect(_tokentype.types._while);node.test = this.parseParenExpression();if(this.options.ecmaVersion >= 6)this.eat(_tokentype.types.semi);else this.semicolon();return this.finishNode(node,"DoWhileStatement");}; // Disambiguating between a `for` and a `for`/`in` or `for`/`of`
// loop is non-trivial. Basically, we have to parse the init `var`
// statement or expression, disallowing the `in` operator (see
// the second parameter to `parseExpression`), and then check
// whether the next token is `in` or `of`. When there is no init
// part (semicolon immediately after the opening parenthesis), it
// is a regular `for` loop.
pp.parseForStatement = function(node){this.next();this.labels.push(loopLabel);this.expect(_tokentype.types.parenL);if(this.type === _tokentype.types.semi)return this.parseFor(node,null);if(this.type === _tokentype.types._var || this.type === _tokentype.types._let || this.type === _tokentype.types._const){var _init=this.startNode(),varKind=this.type;this.next();this.parseVar(_init,true,varKind);this.finishNode(_init,"VariableDeclaration");if((this.type === _tokentype.types._in || this.options.ecmaVersion >= 6 && this.isContextual("of")) && _init.declarations.length === 1 && !(varKind !== _tokentype.types._var && _init.declarations[0].init))return this.parseForIn(node,_init);return this.parseFor(node,_init);}var refShorthandDefaultPos={start:0};var init=this.parseExpression(true,refShorthandDefaultPos);if(this.type === _tokentype.types._in || this.options.ecmaVersion >= 6 && this.isContextual("of")){this.toAssignable(init);this.checkLVal(init);return this.parseForIn(node,init);}else if(refShorthandDefaultPos.start){this.unexpected(refShorthandDefaultPos.start);}return this.parseFor(node,init);};pp.parseFunctionStatement = function(node){this.next();return this.parseFunction(node,true);};pp.parseIfStatement = function(node){this.next();node.test = this.parseParenExpression();node.consequent = this.parseStatement(false);node.alternate = this.eat(_tokentype.types._else)?this.parseStatement(false):null;return this.finishNode(node,"IfStatement");};pp.parseReturnStatement = function(node){if(!this.inFunction && !this.options.allowReturnOutsideFunction)this.raise(this.start,"'return' outside of function");this.next(); // In `return` (and `break`/`continue`), the keywords with
// optional arguments, we eagerly look for a semicolon or the
// possibility to insert one.
if(this.eat(_tokentype.types.semi) || this.insertSemicolon())node.argument = null;else {node.argument = this.parseExpression();this.semicolon();}return this.finishNode(node,"ReturnStatement");};pp.parseSwitchStatement = function(node){this.next();node.discriminant = this.parseParenExpression();node.cases = [];this.expect(_tokentype.types.braceL);this.labels.push(switchLabel); // Statements under must be grouped (by label) in SwitchCase
// nodes. `cur` is used to keep the node that we are currently
// adding statements to.
for(var cur,sawDefault=false;this.type != _tokentype.types.braceR;) {if(this.type === _tokentype.types._case || this.type === _tokentype.types._default){var isCase=this.type === _tokentype.types._case;if(cur)this.finishNode(cur,"SwitchCase");node.cases.push(cur = this.startNode());cur.consequent = [];this.next();if(isCase){cur.test = this.parseExpression();}else {if(sawDefault)this.raise(this.lastTokStart,"Multiple default clauses");sawDefault = true;cur.test = null;}this.expect(_tokentype.types.colon);}else {if(!cur)this.unexpected();cur.consequent.push(this.parseStatement(true));}}if(cur)this.finishNode(cur,"SwitchCase");this.next(); // Closing brace
this.labels.pop();return this.finishNode(node,"SwitchStatement");};pp.parseThrowStatement = function(node){this.next();if(_whitespace.lineBreak.test(this.input.slice(this.lastTokEnd,this.start)))this.raise(this.lastTokEnd,"Illegal newline after throw");node.argument = this.parseExpression();this.semicolon();return this.finishNode(node,"ThrowStatement");}; // Reused empty array added for node fields that are always empty.
var empty=[];pp.parseTryStatement = function(node){this.next();node.block = this.parseBlock();node.handler = null;if(this.type === _tokentype.types._catch){var clause=this.startNode();this.next();this.expect(_tokentype.types.parenL);clause.param = this.parseBindingAtom();this.checkLVal(clause.param,true);this.expect(_tokentype.types.parenR);clause.guard = null;clause.body = this.parseBlock();node.handler = this.finishNode(clause,"CatchClause");}node.guardedHandlers = empty;node.finalizer = this.eat(_tokentype.types._finally)?this.parseBlock():null;if(!node.handler && !node.finalizer)this.raise(node.start,"Missing catch or finally clause");return this.finishNode(node,"TryStatement");};pp.parseVarStatement = function(node,kind){this.next();this.parseVar(node,false,kind);this.semicolon();return this.finishNode(node,"VariableDeclaration");};pp.parseWhileStatement = function(node){this.next();node.test = this.parseParenExpression();this.labels.push(loopLabel);node.body = this.parseStatement(false);this.labels.pop();return this.finishNode(node,"WhileStatement");};pp.parseWithStatement = function(node){if(this.strict)this.raise(this.start,"'with' in strict mode");this.next();node.object = this.parseParenExpression();node.body = this.parseStatement(false);return this.finishNode(node,"WithStatement");};pp.parseEmptyStatement = function(node){this.next();return this.finishNode(node,"EmptyStatement");};pp.parseLabeledStatement = function(node,maybeName,expr){for(var i=0;i < this.labels.length;++i) {if(this.labels[i].name === maybeName)this.raise(expr.start,"Label '" + maybeName + "' is already declared");}var kind=this.type.isLoop?"loop":this.type === _tokentype.types._switch?"switch":null;for(var i=this.labels.length - 1;i >= 0;i--) {var label=this.labels[i];if(label.statementStart == node.start){label.statementStart = this.start;label.kind = kind;}else break;}this.labels.push({name:maybeName,kind:kind,statementStart:this.start});node.body = this.parseStatement(true);this.labels.pop();node.label = expr;return this.finishNode(node,"LabeledStatement");};pp.parseExpressionStatement = function(node,expr){node.expression = expr;this.semicolon();return this.finishNode(node,"ExpressionStatement");}; // Parse a semicolon-enclosed block of statements, handling `"use
// strict"` declarations when `allowStrict` is true (used for
// function bodies).
pp.parseBlock = function(allowStrict){var node=this.startNode(),first=true,oldStrict=undefined;node.body = [];this.expect(_tokentype.types.braceL);while(!this.eat(_tokentype.types.braceR)) {var stmt=this.parseStatement(true);node.body.push(stmt);if(first && allowStrict && this.isUseStrict(stmt)){oldStrict = this.strict;this.setStrict(this.strict = true);}first = false;}if(oldStrict === false)this.setStrict(false);return this.finishNode(node,"BlockStatement");}; // Parse a regular `for` loop. The disambiguation code in
// `parseStatement` will already have parsed the init statement or
// expression.
pp.parseFor = function(node,init){node.init = init;this.expect(_tokentype.types.semi);node.test = this.type === _tokentype.types.semi?null:this.parseExpression();this.expect(_tokentype.types.semi);node.update = this.type === _tokentype.types.parenR?null:this.parseExpression();this.expect(_tokentype.types.parenR);node.body = this.parseStatement(false);this.labels.pop();return this.finishNode(node,"ForStatement");}; // Parse a `for`/`in` and `for`/`of` loop, which are almost
// same from parser's perspective.
pp.parseForIn = function(node,init){var type=this.type === _tokentype.types._in?"ForInStatement":"ForOfStatement";this.next();node.left = init;node.right = this.parseExpression();this.expect(_tokentype.types.parenR);node.body = this.parseStatement(false);this.labels.pop();return this.finishNode(node,type);}; // Parse a list of variable declarations.
pp.parseVar = function(node,isFor,kind){node.declarations = [];node.kind = kind.keyword;for(;;) {var decl=this.startNode();this.parseVarId(decl);if(this.eat(_tokentype.types.eq)){decl.init = this.parseMaybeAssign(isFor);}else if(kind === _tokentype.types._const && !(this.type === _tokentype.types._in || this.options.ecmaVersion >= 6 && this.isContextual("of"))){this.unexpected();}else if(decl.id.type != "Identifier" && !(isFor && (this.type === _tokentype.types._in || this.isContextual("of")))){this.raise(this.lastTokEnd,"Complex binding patterns require an initialization value");}else {decl.init = null;}node.declarations.push(this.finishNode(decl,"VariableDeclarator"));if(!this.eat(_tokentype.types.comma))break;}return node;};pp.parseVarId = function(decl){decl.id = this.parseBindingAtom();this.checkLVal(decl.id,true);}; // Parse a function declaration or literal (depending on the
// `isStatement` parameter).
pp.parseFunction = function(node,isStatement,allowExpressionBody){this.initFunction(node);if(this.options.ecmaVersion >= 6)node.generator = this.eat(_tokentype.types.star);if(isStatement || this.type === _tokentype.types.name)node.id = this.parseIdent();this.parseFunctionParams(node);this.parseFunctionBody(node,allowExpressionBody);return this.finishNode(node,isStatement?"FunctionDeclaration":"FunctionExpression");};pp.parseFunctionParams = function(node){this.expect(_tokentype.types.parenL);node.params = this.parseBindingList(_tokentype.types.parenR,false,false);}; // Parse a class declaration or literal (depending on the
// `isStatement` parameter).
pp.parseClass = function(node,isStatement){this.next();this.parseClassId(node,isStatement);this.parseClassSuper(node);var classBody=this.startNode();var hadConstructor=false;classBody.body = [];this.expect(_tokentype.types.braceL);while(!this.eat(_tokentype.types.braceR)) {if(this.eat(_tokentype.types.semi))continue;var method=this.startNode();var isGenerator=this.eat(_tokentype.types.star);var isMaybeStatic=this.type === _tokentype.types.name && this.value === "static";this.parsePropertyName(method);method["static"] = isMaybeStatic && this.type !== _tokentype.types.parenL;if(method["static"]){if(isGenerator)this.unexpected();isGenerator = this.eat(_tokentype.types.star);this.parsePropertyName(method);}method.kind = "method";var isGetSet=false;if(!method.computed){var key=method.key;if(!isGenerator && key.type === "Identifier" && this.type !== _tokentype.types.parenL && (key.name === "get" || key.name === "set")){isGetSet = true;method.kind = key.name;key = this.parsePropertyName(method);}if(!method["static"] && (key.type === "Identifier" && key.name === "constructor" || key.type === "Literal" && key.value === "constructor")){if(hadConstructor)this.raise(key.start,"Duplicate constructor in the same class");if(isGetSet)this.raise(key.start,"Constructor can't have get/set modifier");if(isGenerator)this.raise(key.start,"Constructor can't be a generator");method.kind = "constructor";hadConstructor = true;}}this.parseClassMethod(classBody,method,isGenerator);if(isGetSet){var paramCount=method.kind === "get"?0:1;if(method.value.params.length !== paramCount){var start=method.value.start;if(method.kind === "get")this.raise(start,"getter should have no params");else this.raise(start,"setter should have exactly one param");}}}node.body = this.finishNode(classBody,"ClassBody");return this.finishNode(node,isStatement?"ClassDeclaration":"ClassExpression");};pp.parseClassMethod = function(classBody,method,isGenerator){method.value = this.parseMethod(isGenerator);classBody.body.push(this.finishNode(method,"MethodDefinition"));};pp.parseClassId = function(node,isStatement){node.id = this.type === _tokentype.types.name?this.parseIdent():isStatement?this.unexpected():null;};pp.parseClassSuper = function(node){node.superClass = this.eat(_tokentype.types._extends)?this.parseExprSubscripts():null;}; // Parses module export declaration.
pp.parseExport = function(node){this.next(); // export * from '...'
if(this.eat(_tokentype.types.star)){this.expectContextual("from");node.source = this.type === _tokentype.types.string?this.parseExprAtom():this.unexpected();this.semicolon();return this.finishNode(node,"ExportAllDeclaration");}if(this.eat(_tokentype.types._default)){ // export default ...
var expr=this.parseMaybeAssign();var needsSemi=true;if(expr.type == "FunctionExpression" || expr.type == "ClassExpression"){needsSemi = false;if(expr.id){expr.type = expr.type == "FunctionExpression"?"FunctionDeclaration":"ClassDeclaration";}}node.declaration = expr;if(needsSemi)this.semicolon();return this.finishNode(node,"ExportDefaultDeclaration");} // export var|const|let|function|class ...
if(this.shouldParseExportStatement()){node.declaration = this.parseStatement(true);node.specifiers = [];node.source = null;}else { // export { x, y as z } [from '...']
node.declaration = null;node.specifiers = this.parseExportSpecifiers();if(this.eatContextual("from")){node.source = this.type === _tokentype.types.string?this.parseExprAtom():this.unexpected();}else {node.source = null;}this.semicolon();}return this.finishNode(node,"ExportNamedDeclaration");};pp.shouldParseExportStatement = function(){return this.type.keyword;}; // Parses a comma-separated list of module exports.
pp.parseExportSpecifiers = function(){var nodes=[],first=true; // export { x, y as z } [from '...']
this.expect(_tokentype.types.braceL);while(!this.eat(_tokentype.types.braceR)) {if(!first){this.expect(_tokentype.types.comma);if(this.afterTrailingComma(_tokentype.types.braceR))break;}else first = false;var node=this.startNode();node.local = this.parseIdent(this.type === _tokentype.types._default);node.exported = this.eatContextual("as")?this.parseIdent(true):node.local;nodes.push(this.finishNode(node,"ExportSpecifier"));}return nodes;}; // Parses import declaration.
pp.parseImport = function(node){this.next(); // import '...'
if(this.type === _tokentype.types.string){node.specifiers = empty;node.source = this.parseExprAtom();}else {node.specifiers = this.parseImportSpecifiers();this.expectContextual("from");node.source = this.type === _tokentype.types.string?this.parseExprAtom():this.unexpected();}this.semicolon();return this.finishNode(node,"ImportDeclaration");}; // Parses a comma-separated list of module imports.
pp.parseImportSpecifiers = function(){var nodes=[],first=true;if(this.type === _tokentype.types.name){ // import defaultObj, { x, y as z } from '...'
var node=this.startNode();node.local = this.parseIdent();this.checkLVal(node.local,true);nodes.push(this.finishNode(node,"ImportDefaultSpecifier"));if(!this.eat(_tokentype.types.comma))return nodes;}if(this.type === _tokentype.types.star){var node=this.startNode();this.next();this.expectContextual("as");node.local = this.parseIdent();this.checkLVal(node.local,true);nodes.push(this.finishNode(node,"ImportNamespaceSpecifier"));return nodes;}this.expect(_tokentype.types.braceL);while(!this.eat(_tokentype.types.braceR)) {if(!first){this.expect(_tokentype.types.comma);if(this.afterTrailingComma(_tokentype.types.braceR))break;}else first = false;var node=this.startNode();node.imported = this.parseIdent(true);node.local = this.eatContextual("as")?this.parseIdent():node.imported;this.checkLVal(node.local,true);nodes.push(this.finishNode(node,"ImportSpecifier"));}return nodes;};},{"./state":10,"./tokentype":14,"./whitespace":16}],12:[function(_dereq_,module,exports){ // The algorithm used to determine whether a regexp can appear at a
// given point in the program is loosely based on sweet.js' approach.
// See https://github.com/mozilla/sweet.js/wiki/design
"use strict";exports.__esModule = true;function _classCallCheck(instance,Constructor){if(!(instance instanceof Constructor)){throw new TypeError("Cannot call a class as a function");}}var _state=_dereq_("./state");var _tokentype=_dereq_("./tokentype");var _whitespace=_dereq_("./whitespace");var TokContext=function TokContext(token,isExpr,preserveSpace,override){_classCallCheck(this,TokContext);this.token = token;this.isExpr = !!isExpr;this.preserveSpace = !!preserveSpace;this.override = override;};exports.TokContext = TokContext;var types={b_stat:new TokContext("{",false),b_expr:new TokContext("{",true),b_tmpl:new TokContext("${",true),p_stat:new TokContext("(",false),p_expr:new TokContext("(",true),q_tmpl:new TokContext("`",true,true,function(p){return p.readTmplToken();}),f_expr:new TokContext("function",true)};exports.types = types;var pp=_state.Parser.prototype;pp.initialContext = function(){return [types.b_stat];};pp.braceIsBlock = function(prevType){if(prevType === _tokentype.types.colon){var _parent=this.curContext();if(_parent === types.b_stat || _parent === types.b_expr)return !_parent.isExpr;}if(prevType === _tokentype.types._return)return _whitespace.lineBreak.test(this.input.slice(this.lastTokEnd,this.start));if(prevType === _tokentype.types._else || prevType === _tokentype.types.semi || prevType === _tokentype.types.eof || prevType === _tokentype.types.parenR)return true;if(prevType == _tokentype.types.braceL)return this.curContext() === types.b_stat;return !this.exprAllowed;};pp.updateContext = function(prevType){var update=undefined,type=this.type;if(type.keyword && prevType == _tokentype.types.dot)this.exprAllowed = false;else if(update = type.updateContext)update.call(this,prevType);else this.exprAllowed = type.beforeExpr;}; // Token-specific context update code
_tokentype.types.parenR.updateContext = _tokentype.types.braceR.updateContext = function(){if(this.context.length == 1){this.exprAllowed = true;return;}var out=this.context.pop();if(out === types.b_stat && this.curContext() === types.f_expr){this.context.pop();this.exprAllowed = false;}else if(out === types.b_tmpl){this.exprAllowed = true;}else {this.exprAllowed = !out.isExpr;}};_tokentype.types.braceL.updateContext = function(prevType){this.context.push(this.braceIsBlock(prevType)?types.b_stat:types.b_expr);this.exprAllowed = true;};_tokentype.types.dollarBraceL.updateContext = function(){this.context.push(types.b_tmpl);this.exprAllowed = true;};_tokentype.types.parenL.updateContext = function(prevType){var statementParens=prevType === _tokentype.types._if || prevType === _tokentype.types._for || prevType === _tokentype.types._with || prevType === _tokentype.types._while;this.context.push(statementParens?types.p_stat:types.p_expr);this.exprAllowed = true;};_tokentype.types.incDec.updateContext = function(){ // tokExprAllowed stays unchanged
};_tokentype.types._function.updateContext = function(){if(this.curContext() !== types.b_stat)this.context.push(types.f_expr);this.exprAllowed = false;};_tokentype.types.backQuote.updateContext = function(){if(this.curContext() === types.q_tmpl)this.context.pop();else this.context.push(types.q_tmpl);this.exprAllowed = false;};},{"./state":10,"./tokentype":14,"./whitespace":16}],13:[function(_dereq_,module,exports){"use strict";exports.__esModule = true;function _classCallCheck(instance,Constructor){if(!(instance instanceof Constructor)){throw new TypeError("Cannot call a class as a function");}}var _identifier=_dereq_("./identifier");var _tokentype=_dereq_("./tokentype");var _state=_dereq_("./state");var _locutil=_dereq_("./locutil");var _whitespace=_dereq_("./whitespace"); // Object type used to represent tokens. Note that normally, tokens
// simply exist as properties on the parser object. This is only
// used for the onToken callback and the external tokenizer.
var Token=function Token(p){_classCallCheck(this,Token);this.type = p.type;this.value = p.value;this.start = p.start;this.end = p.end;if(p.options.locations)this.loc = new _locutil.SourceLocation(p,p.startLoc,p.endLoc);if(p.options.ranges)this.range = [p.start,p.end];} // ## Tokenizer
;exports.Token = Token;var pp=_state.Parser.prototype; // Are we running under Rhino?
var isRhino=typeof Packages == "object" && Object.prototype.toString.call(Packages) == "[object JavaPackage]"; // Move to the next token
pp.next = function(){if(this.options.onToken)this.options.onToken(new Token(this));this.lastTokEnd = this.end;this.lastTokStart = this.start;this.lastTokEndLoc = this.endLoc;this.lastTokStartLoc = this.startLoc;this.nextToken();};pp.getToken = function(){this.next();return new Token(this);}; // If we're in an ES6 environment, make parsers iterable
if(typeof Symbol !== "undefined")pp[Symbol.iterator] = function(){var self=this;return {next:function next(){var token=self.getToken();return {done:token.type === _tokentype.types.eof,value:token};}};}; // Toggle strict mode. Re-reads the next number or string to please
// pedantic tests (`"use strict"; 010;` should fail).
pp.setStrict = function(strict){this.strict = strict;if(this.type !== _tokentype.types.num && this.type !== _tokentype.types.string)return;this.pos = this.start;if(this.options.locations){while(this.pos < this.lineStart) {this.lineStart = this.input.lastIndexOf("\n",this.lineStart - 2) + 1;--this.curLine;}}this.nextToken();};pp.curContext = function(){return this.context[this.context.length - 1];}; // Read a single token, updating the parser object's token-related
// properties.
pp.nextToken = function(){var curContext=this.curContext();if(!curContext || !curContext.preserveSpace)this.skipSpace();this.start = this.pos;if(this.options.locations)this.startLoc = this.curPosition();if(this.pos >= this.input.length)return this.finishToken(_tokentype.types.eof);if(curContext.override)return curContext.override(this);else this.readToken(this.fullCharCodeAtPos());};pp.readToken = function(code){ // Identifier or keyword. '\uXXXX' sequences are allowed in
// identifiers, so '\' also dispatches to that.
if(_identifier.isIdentifierStart(code,this.options.ecmaVersion >= 6) || code === 92 /* '\' */)return this.readWord();return this.getTokenFromCode(code);};pp.fullCharCodeAtPos = function(){var code=this.input.charCodeAt(this.pos);if(code <= 0xd7ff || code >= 0xe000)return code;var next=this.input.charCodeAt(this.pos + 1);return (code << 10) + next - 0x35fdc00;};pp.skipBlockComment = function(){var startLoc=this.options.onComment && this.curPosition();var start=this.pos,end=this.input.indexOf("*/",this.pos += 2);if(end === -1)this.raise(this.pos - 2,"Unterminated comment");this.pos = end + 2;if(this.options.locations){_whitespace.lineBreakG.lastIndex = start;var match=undefined;while((match = _whitespace.lineBreakG.exec(this.input)) && match.index < this.pos) {++this.curLine;this.lineStart = match.index + match[0].length;}}if(this.options.onComment)this.options.onComment(true,this.input.slice(start + 2,end),start,this.pos,startLoc,this.curPosition());};pp.skipLineComment = function(startSkip){var start=this.pos;var startLoc=this.options.onComment && this.curPosition();var ch=this.input.charCodeAt(this.pos += startSkip);while(this.pos < this.input.length && ch !== 10 && ch !== 13 && ch !== 8232 && ch !== 8233) {++this.pos;ch = this.input.charCodeAt(this.pos);}if(this.options.onComment)this.options.onComment(false,this.input.slice(start + startSkip,this.pos),start,this.pos,startLoc,this.curPosition());}; // Called at the start of the parse and after every token. Skips
// whitespace and comments, and.
pp.skipSpace = function(){loop: while(this.pos < this.input.length) {var ch=this.input.charCodeAt(this.pos);switch(ch){case 32:case 160: // ' '
++this.pos;break;case 13:if(this.input.charCodeAt(this.pos + 1) === 10){++this.pos;}case 10:case 8232:case 8233:++this.pos;if(this.options.locations){++this.curLine;this.lineStart = this.pos;}break;case 47: // '/'
switch(this.input.charCodeAt(this.pos + 1)){case 42: // '*'
this.skipBlockComment();break;case 47:this.skipLineComment(2);break;default:break loop;}break;default:if(ch > 8 && ch < 14 || ch >= 5760 && _whitespace.nonASCIIwhitespace.test(String.fromCharCode(ch))){++this.pos;}else {break loop;}}}}; // Called at the end of every token. Sets `end`, `val`, and
// maintains `context` and `exprAllowed`, and skips the space after
// the token, so that the next one's `start` will point at the
// right position.
pp.finishToken = function(type,val){this.end = this.pos;if(this.options.locations)this.endLoc = this.curPosition();var prevType=this.type;this.type = type;this.value = val;this.updateContext(prevType);}; // ### Token reading
// This is the function that is called to fetch the next token. It
// is somewhat obscure, because it works in character codes rather
// than characters, and because operator parsing has been inlined
// into it.
//
// All in the name of speed.
//
pp.readToken_dot = function(){var next=this.input.charCodeAt(this.pos + 1);if(next >= 48 && next <= 57)return this.readNumber(true);var next2=this.input.charCodeAt(this.pos + 2);if(this.options.ecmaVersion >= 6 && next === 46 && next2 === 46){ // 46 = dot '.'
this.pos += 3;return this.finishToken(_tokentype.types.ellipsis);}else {++this.pos;return this.finishToken(_tokentype.types.dot);}};pp.readToken_slash = function(){ // '/'
var next=this.input.charCodeAt(this.pos + 1);if(this.exprAllowed){++this.pos;return this.readRegexp();}if(next === 61)return this.finishOp(_tokentype.types.assign,2);return this.finishOp(_tokentype.types.slash,1);};pp.readToken_mult_modulo = function(code){ // '%*'
var next=this.input.charCodeAt(this.pos + 1);if(next === 61)return this.finishOp(_tokentype.types.assign,2);return this.finishOp(code === 42?_tokentype.types.star:_tokentype.types.modulo,1);};pp.readToken_pipe_amp = function(code){ // '|&'
var next=this.input.charCodeAt(this.pos + 1);if(next === code)return this.finishOp(code === 124?_tokentype.types.logicalOR:_tokentype.types.logicalAND,2);if(next === 61)return this.finishOp(_tokentype.types.assign,2);return this.finishOp(code === 124?_tokentype.types.bitwiseOR:_tokentype.types.bitwiseAND,1);};pp.readToken_caret = function(){ // '^'
var next=this.input.charCodeAt(this.pos + 1);if(next === 61)return this.finishOp(_tokentype.types.assign,2);return this.finishOp(_tokentype.types.bitwiseXOR,1);};pp.readToken_plus_min = function(code){ // '+-'
var next=this.input.charCodeAt(this.pos + 1);if(next === code){if(next == 45 && this.input.charCodeAt(this.pos + 2) == 62 && _whitespace.lineBreak.test(this.input.slice(this.lastTokEnd,this.pos))){ // A `-->` line comment
this.skipLineComment(3);this.skipSpace();return this.nextToken();}return this.finishOp(_tokentype.types.incDec,2);}if(next === 61)return this.finishOp(_tokentype.types.assign,2);return this.finishOp(_tokentype.types.plusMin,1);};pp.readToken_lt_gt = function(code){ // '<>'
var next=this.input.charCodeAt(this.pos + 1);var size=1;if(next === code){size = code === 62 && this.input.charCodeAt(this.pos + 2) === 62?3:2;if(this.input.charCodeAt(this.pos + size) === 61)return this.finishOp(_tokentype.types.assign,size + 1);return this.finishOp(_tokentype.types.bitShift,size);}if(next == 33 && code == 60 && this.input.charCodeAt(this.pos + 2) == 45 && this.input.charCodeAt(this.pos + 3) == 45){if(this.inModule)this.unexpected(); // `<!--`, an XML-style comment that should be interpreted as a line comment
this.skipLineComment(4);this.skipSpace();return this.nextToken();}if(next === 61)size = this.input.charCodeAt(this.pos + 2) === 61?3:2;return this.finishOp(_tokentype.types.relational,size);};pp.readToken_eq_excl = function(code){ // '=!'
var next=this.input.charCodeAt(this.pos + 1);if(next === 61)return this.finishOp(_tokentype.types.equality,this.input.charCodeAt(this.pos + 2) === 61?3:2);if(code === 61 && next === 62 && this.options.ecmaVersion >= 6){ // '=>'
this.pos += 2;return this.finishToken(_tokentype.types.arrow);}return this.finishOp(code === 61?_tokentype.types.eq:_tokentype.types.prefix,1);};pp.getTokenFromCode = function(code){switch(code){ // The interpretation of a dot depends on whether it is followed
// by a digit or another two dots.
case 46: // '.'
return this.readToken_dot(); // Punctuation tokens.
case 40:++this.pos;return this.finishToken(_tokentype.types.parenL);case 41:++this.pos;return this.finishToken(_tokentype.types.parenR);case 59:++this.pos;return this.finishToken(_tokentype.types.semi);case 44:++this.pos;return this.finishToken(_tokentype.types.comma);case 91:++this.pos;return this.finishToken(_tokentype.types.bracketL);case 93:++this.pos;return this.finishToken(_tokentype.types.bracketR);case 123:++this.pos;return this.finishToken(_tokentype.types.braceL);case 125:++this.pos;return this.finishToken(_tokentype.types.braceR);case 58:++this.pos;return this.finishToken(_tokentype.types.colon);case 63:++this.pos;return this.finishToken(_tokentype.types.question);case 96: // '`'
if(this.options.ecmaVersion < 6)break;++this.pos;return this.finishToken(_tokentype.types.backQuote);case 48: // '0'
var next=this.input.charCodeAt(this.pos + 1);if(next === 120 || next === 88)return this.readRadixNumber(16); // '0x', '0X' - hex number
if(this.options.ecmaVersion >= 6){if(next === 111 || next === 79)return this.readRadixNumber(8); // '0o', '0O' - octal number
if(next === 98 || next === 66)return this.readRadixNumber(2); // '0b', '0B' - binary number
} // Anything else beginning with a digit is an integer, octal
// number, or float.
case 49:case 50:case 51:case 52:case 53:case 54:case 55:case 56:case 57: // 1-9
return this.readNumber(false); // Quotes produce strings.
case 34:case 39: // '"', "'"
return this.readString(code); // Operators are parsed inline in tiny state machines. '=' (61) is
// often referred to. `finishOp` simply skips the amount of
// characters it is given as second argument, and returns a token
// of the type given by its first argument.
case 47: // '/'
return this.readToken_slash();case 37:case 42: // '%*'
return this.readToken_mult_modulo(code);case 124:case 38: // '|&'
return this.readToken_pipe_amp(code);case 94: // '^'
return this.readToken_caret();case 43:case 45: // '+-'
return this.readToken_plus_min(code);case 60:case 62: // '<>'
return this.readToken_lt_gt(code);case 61:case 33: // '=!'
return this.readToken_eq_excl(code);case 126: // '~'
return this.finishOp(_tokentype.types.prefix,1);}this.raise(this.pos,"Unexpected character '" + codePointToString(code) + "'");};pp.finishOp = function(type,size){var str=this.input.slice(this.pos,this.pos + size);this.pos += size;return this.finishToken(type,str);}; // Parse a regular expression. Some context-awareness is necessary,
// since a '/' inside a '[]' set does not end the expression.
function tryCreateRegexp(src,flags,throwErrorAt){try{return new RegExp(src,flags);}catch(e) {if(throwErrorAt !== undefined){if(e instanceof SyntaxError)this.raise(throwErrorAt,"Error parsing regular expression: " + e.message);this.raise(e);}}}var regexpUnicodeSupport=!!tryCreateRegexp("￿","u");pp.readRegexp = function(){var _this=this;var escaped=undefined,inClass=undefined,start=this.pos;for(;;) {if(this.pos >= this.input.length)this.raise(start,"Unterminated regular expression");var ch=this.input.charAt(this.pos);if(_whitespace.lineBreak.test(ch))this.raise(start,"Unterminated regular expression");if(!escaped){if(ch === "[")inClass = true;else if(ch === "]" && inClass)inClass = false;else if(ch === "/" && !inClass)break;escaped = ch === "\\";}else escaped = false;++this.pos;}var content=this.input.slice(start,this.pos);++this.pos; // Need to use `readWord1` because '\uXXXX' sequences are allowed
// here (don't ask).
var mods=this.readWord1();var tmp=content;if(mods){var validFlags=/^[gmsiy]*$/;if(this.options.ecmaVersion >= 6)validFlags = /^[gmsiyu]*$/;if(!validFlags.test(mods))this.raise(start,"Invalid regular expression flag");if(mods.indexOf('u') >= 0 && !regexpUnicodeSupport){ // Replace each astral symbol and every Unicode escape sequence that
// possibly represents an astral symbol or a paired surrogate with a
// single ASCII symbol to avoid throwing on regular expressions that
// are only valid in combination with the `/u` flag.
// Note: replacing with the ASCII symbol `x` might cause false
// negatives in unlikely scenarios. For example, `[\u{61}-b]` is a
// perfectly valid pattern that is equivalent to `[a-b]`, but it would
// be replaced by `[x-b]` which throws an error.
tmp = tmp.replace(/\\u\{([0-9a-fA-F]+)\}/g,function(match,code,offset){code = Number("0x" + code);if(code > 0x10FFFF)_this.raise(start + offset + 3,"Code point out of bounds");return "x";});tmp = tmp.replace(/\\u([a-fA-F0-9]{4})|[\uD800-\uDBFF][\uDC00-\uDFFF]/g,"x");}} // Detect invalid regular expressions.
var value=null; // Rhino's regular expression parser is flaky and throws uncatchable exceptions,
// so don't do detection if we are running under Rhino
if(!isRhino){tryCreateRegexp(tmp,undefined,start); // Get a regular expression object for this pattern-flag pair, or `null` in
// case the current environment doesn't support the flags it uses.
value = tryCreateRegexp(content,mods);}return this.finishToken(_tokentype.types.regexp,{pattern:content,flags:mods,value:value});}; // Read an integer in the given radix. Return null if zero digits
// were read, the integer value otherwise. When `len` is given, this
// will return `null` unless the integer has exactly `len` digits.
pp.readInt = function(radix,len){var start=this.pos,total=0;for(var i=0,e=len == null?Infinity:len;i < e;++i) {var code=this.input.charCodeAt(this.pos),val=undefined;if(code >= 97)val = code - 97 + 10; // a
else if(code >= 65)val = code - 65 + 10; // A
else if(code >= 48 && code <= 57)val = code - 48; // 0-9
else val = Infinity;if(val >= radix)break;++this.pos;total = total * radix + val;}if(this.pos === start || len != null && this.pos - start !== len)return null;return total;};pp.readRadixNumber = function(radix){this.pos += 2; // 0x
var val=this.readInt(radix);if(val == null)this.raise(this.start + 2,"Expected number in radix " + radix);if(_identifier.isIdentifierStart(this.fullCharCodeAtPos()))this.raise(this.pos,"Identifier directly after number");return this.finishToken(_tokentype.types.num,val);}; // Read an integer, octal integer, or floating-point number.
pp.readNumber = function(startsWithDot){var start=this.pos,isFloat=false,octal=this.input.charCodeAt(this.pos) === 48;if(!startsWithDot && this.readInt(10) === null)this.raise(start,"Invalid number");var next=this.input.charCodeAt(this.pos);if(next === 46){ // '.'
++this.pos;this.readInt(10);isFloat = true;next = this.input.charCodeAt(this.pos);}if(next === 69 || next === 101){ // 'eE'
next = this.input.charCodeAt(++this.pos);if(next === 43 || next === 45)++this.pos; // '+-'
if(this.readInt(10) === null)this.raise(start,"Invalid number");isFloat = true;}if(_identifier.isIdentifierStart(this.fullCharCodeAtPos()))this.raise(this.pos,"Identifier directly after number");var str=this.input.slice(start,this.pos),val=undefined;if(isFloat)val = parseFloat(str);else if(!octal || str.length === 1)val = parseInt(str,10);else if(/[89]/.test(str) || this.strict)this.raise(start,"Invalid number");else val = parseInt(str,8);return this.finishToken(_tokentype.types.num,val);}; // Read a string value, interpreting backslash-escapes.
pp.readCodePoint = function(){var ch=this.input.charCodeAt(this.pos),code=undefined;if(ch === 123){if(this.options.ecmaVersion < 6)this.unexpected();var codePos=++this.pos;code = this.readHexChar(this.input.indexOf('}',this.pos) - this.pos);++this.pos;if(code > 0x10FFFF)this.raise(codePos,"Code point out of bounds");}else {code = this.readHexChar(4);}return code;};function codePointToString(code){ // UTF-16 Decoding
if(code <= 0xFFFF)return String.fromCharCode(code);code -= 0x10000;return String.fromCharCode((code >> 10) + 0xD800,(code & 1023) + 0xDC00);}pp.readString = function(quote){var out="",chunkStart=++this.pos;for(;;) {if(this.pos >= this.input.length)this.raise(this.start,"Unterminated string constant");var ch=this.input.charCodeAt(this.pos);if(ch === quote)break;if(ch === 92){ // '\'
out += this.input.slice(chunkStart,this.pos);out += this.readEscapedChar(false);chunkStart = this.pos;}else {if(_whitespace.isNewLine(ch))this.raise(this.start,"Unterminated string constant");++this.pos;}}out += this.input.slice(chunkStart,this.pos++);return this.finishToken(_tokentype.types.string,out);}; // Reads template string tokens.
pp.readTmplToken = function(){var out="",chunkStart=this.pos;for(;;) {if(this.pos >= this.input.length)this.raise(this.start,"Unterminated template");var ch=this.input.charCodeAt(this.pos);if(ch === 96 || ch === 36 && this.input.charCodeAt(this.pos + 1) === 123){ // '`', '${'
if(this.pos === this.start && this.type === _tokentype.types.template){if(ch === 36){this.pos += 2;return this.finishToken(_tokentype.types.dollarBraceL);}else {++this.pos;return this.finishToken(_tokentype.types.backQuote);}}out += this.input.slice(chunkStart,this.pos);return this.finishToken(_tokentype.types.template,out);}if(ch === 92){ // '\'
out += this.input.slice(chunkStart,this.pos);out += this.readEscapedChar(true);chunkStart = this.pos;}else if(_whitespace.isNewLine(ch)){out += this.input.slice(chunkStart,this.pos);++this.pos;switch(ch){case 13:if(this.input.charCodeAt(this.pos) === 10)++this.pos;case 10:out += "\n";break;default:out += String.fromCharCode(ch);break;}if(this.options.locations){++this.curLine;this.lineStart = this.pos;}chunkStart = this.pos;}else {++this.pos;}}}; // Used to read escaped characters
pp.readEscapedChar = function(inTemplate){var ch=this.input.charCodeAt(++this.pos);++this.pos;switch(ch){case 110:return "\n"; // 'n' -> '\n'
case 114:return "\r"; // 'r' -> '\r'
case 120:return String.fromCharCode(this.readHexChar(2)); // 'x'
case 117:return codePointToString(this.readCodePoint()); // 'u'
case 116:return "\t"; // 't' -> '\t'
case 98:return "\b"; // 'b' -> '\b'
case 118:return "\u000b"; // 'v' -> '\u000b'
case 102:return "\f"; // 'f' -> '\f'
case 13:if(this.input.charCodeAt(this.pos) === 10)++this.pos; // '\r\n'
case 10: // ' \n'
if(this.options.locations){this.lineStart = this.pos;++this.curLine;}return "";default:if(ch >= 48 && ch <= 55){var octalStr=this.input.substr(this.pos - 1,3).match(/^[0-7]+/)[0];var octal=parseInt(octalStr,8);if(octal > 255){octalStr = octalStr.slice(0,-1);octal = parseInt(octalStr,8);}if(octal > 0 && (this.strict || inTemplate)){this.raise(this.pos - 2,"Octal literal in strict mode");}this.pos += octalStr.length - 1;return String.fromCharCode(octal);}return String.fromCharCode(ch);}}; // Used to read character escape sequences ('\x', '\u', '\U').
pp.readHexChar = function(len){var codePos=this.pos;var n=this.readInt(16,len);if(n === null)this.raise(codePos,"Bad character escape sequence");return n;}; // Read an identifier, and return it as a string. Sets `this.containsEsc`
// to whether the word contained a '\u' escape.
//
// Incrementally adds only escaped chars, adding other chunks as-is
// as a micro-optimization.
pp.readWord1 = function(){this.containsEsc = false;var word="",first=true,chunkStart=this.pos;var astral=this.options.ecmaVersion >= 6;while(this.pos < this.input.length) {var ch=this.fullCharCodeAtPos();if(_identifier.isIdentifierChar(ch,astral)){this.pos += ch <= 0xffff?1:2;}else if(ch === 92){ // "\"
this.containsEsc = true;word += this.input.slice(chunkStart,this.pos);var escStart=this.pos;if(this.input.charCodeAt(++this.pos) != 117) // "u"
this.raise(this.pos,"Expecting Unicode escape sequence \\uXXXX");++this.pos;var esc=this.readCodePoint();if(!(first?_identifier.isIdentifierStart:_identifier.isIdentifierChar)(esc,astral))this.raise(escStart,"Invalid Unicode escape");word += codePointToString(esc);chunkStart = this.pos;}else {break;}first = false;}return word + this.input.slice(chunkStart,this.pos);}; // Read an identifier or keyword token. Will check for reserved
// words when necessary.
pp.readWord = function(){var word=this.readWord1();var type=_tokentype.types.name;if((this.options.ecmaVersion >= 6 || !this.containsEsc) && this.isKeyword(word))type = _tokentype.keywords[word];return this.finishToken(type,word);};},{"./identifier":2,"./locutil":5,"./state":10,"./tokentype":14,"./whitespace":16}],14:[function(_dereq_,module,exports){ // ## Token types
// The assignment of fine-grained, information-carrying type objects
// allows the tokenizer to store the information it has about a
// token in a way that is very cheap for the parser to look up.
// All token type variables start with an underscore, to make them
// easy to recognize.
// The `beforeExpr` property is used to disambiguate between regular
// expressions and divisions. It is set on all token types that can
// be followed by an expression (thus, a slash after them would be a
// regular expression).
//
// `isLoop` marks a keyword as starting a loop, which is important
// to know when parsing a label, in order to allow or disallow
// continue jumps to that label.
"use strict";exports.__esModule = true;function _classCallCheck(instance,Constructor){if(!(instance instanceof Constructor)){throw new TypeError("Cannot call a class as a function");}}var TokenType=function TokenType(label){var conf=arguments.length <= 1 || arguments[1] === undefined?{}:arguments[1];_classCallCheck(this,TokenType);this.label = label;this.keyword = conf.keyword;this.beforeExpr = !!conf.beforeExpr;this.startsExpr = !!conf.startsExpr;this.isLoop = !!conf.isLoop;this.isAssign = !!conf.isAssign;this.prefix = !!conf.prefix;this.postfix = !!conf.postfix;this.binop = conf.binop || null;this.updateContext = null;};exports.TokenType = TokenType;function binop(name,prec){return new TokenType(name,{beforeExpr:true,binop:prec});}var beforeExpr={beforeExpr:true},startsExpr={startsExpr:true};var types={num:new TokenType("num",startsExpr),regexp:new TokenType("regexp",startsExpr),string:new TokenType("string",startsExpr),name:new TokenType("name",startsExpr),eof:new TokenType("eof"), // Punctuation token types.
bracketL:new TokenType("[",{beforeExpr:true,startsExpr:true}),bracketR:new TokenType("]"),braceL:new TokenType("{",{beforeExpr:true,startsExpr:true}),braceR:new TokenType("}"),parenL:new TokenType("(",{beforeExpr:true,startsExpr:true}),parenR:new TokenType(")"),comma:new TokenType(",",beforeExpr),semi:new TokenType(";",beforeExpr),colon:new TokenType(":",beforeExpr),dot:new TokenType("."),question:new TokenType("?",beforeExpr),arrow:new TokenType("=>",beforeExpr),template:new TokenType("template"),ellipsis:new TokenType("...",beforeExpr),backQuote:new TokenType("`",startsExpr),dollarBraceL:new TokenType("${",{beforeExpr:true,startsExpr:true}), // Operators. These carry several kinds of properties to help the
// parser use them properly (the presence of these properties is
// what categorizes them as operators).
//
// `binop`, when present, specifies that this operator is a binary
// operator, and will refer to its precedence.
//
// `prefix` and `postfix` mark the operator as a prefix or postfix
// unary operator.
//
// `isAssign` marks all of `=`, `+=`, `-=` etcetera, which act as
// binary operators with a very low precedence, that should result
// in AssignmentExpression nodes.
eq:new TokenType("=",{beforeExpr:true,isAssign:true}),assign:new TokenType("_=",{beforeExpr:true,isAssign:true}),incDec:new TokenType("++/--",{prefix:true,postfix:true,startsExpr:true}),prefix:new TokenType("prefix",{beforeExpr:true,prefix:true,startsExpr:true}),logicalOR:binop("||",1),logicalAND:binop("&&",2),bitwiseOR:binop("|",3),bitwiseXOR:binop("^",4),bitwiseAND:binop("&",5),equality:binop("==/!=",6),relational:binop("</>",7),bitShift:binop("<</>>",8),plusMin:new TokenType("+/-",{beforeExpr:true,binop:9,prefix:true,startsExpr:true}),modulo:binop("%",10),star:binop("*",10),slash:binop("/",10)};exports.types = types; // Map keyword names to token types.
var keywords={};exports.keywords = keywords; // Succinct definitions of keyword token types
function kw(name){var options=arguments.length <= 1 || arguments[1] === undefined?{}:arguments[1];options.keyword = name;keywords[name] = types["_" + name] = new TokenType(name,options);}kw("break");kw("case",beforeExpr);kw("catch");kw("continue");kw("debugger");kw("default",beforeExpr);kw("do",{isLoop:true});kw("else",beforeExpr);kw("finally");kw("for",{isLoop:true});kw("function",startsExpr);kw("if");kw("return",beforeExpr);kw("switch");kw("throw",beforeExpr);kw("try");kw("var");kw("let");kw("const");kw("while",{isLoop:true});kw("with");kw("new",{beforeExpr:true,startsExpr:true});kw("this",startsExpr);kw("super",startsExpr);kw("class");kw("extends",beforeExpr);kw("export");kw("import");kw("yield",{beforeExpr:true,startsExpr:true});kw("null",startsExpr);kw("true",startsExpr);kw("false",startsExpr);kw("in",{beforeExpr:true,binop:7});kw("instanceof",{beforeExpr:true,binop:7});kw("typeof",{beforeExpr:true,prefix:true,startsExpr:true});kw("void",{beforeExpr:true,prefix:true,startsExpr:true});kw("delete",{beforeExpr:true,prefix:true,startsExpr:true});},{}],15:[function(_dereq_,module,exports){"use strict";exports.__esModule = true;exports.isArray = isArray;exports.has = has;function isArray(obj){return Object.prototype.toString.call(obj) === "[object Array]";} // Checks if an object has a property.
function has(obj,propName){return Object.prototype.hasOwnProperty.call(obj,propName);}},{}],16:[function(_dereq_,module,exports){ // Matches a whole line break (where CRLF is considered a single
// line break). Used to count lines.
"use strict";exports.__esModule = true;exports.isNewLine = isNewLine;var lineBreak=/\r\n?|\n|\u2028|\u2029/;exports.lineBreak = lineBreak;var lineBreakG=new RegExp(lineBreak.source,"g");exports.lineBreakG = lineBreakG;function isNewLine(code){return code === 10 || code === 13 || code === 0x2028 || code == 0x2029;}var nonASCIIwhitespace=/[\u1680\u180e\u2000-\u200a\u202f\u205f\u3000\ufeff]/;exports.nonASCIIwhitespace = nonASCIIwhitespace;},{}]},{},[3])(3);});

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],2:[function(_dereq_,module,exports){
"use strict";

module.exports = typeof acorn != 'undefined' ? acorn : _dereq_("acorn");

},{"acorn":1}],3:[function(_dereq_,module,exports){
"use strict";

var _state = _dereq_("./state");

var _parseutil = _dereq_("./parseutil");

var _ = _dereq_("..");

var lp = _state.LooseParser.prototype;

lp.checkLVal = function (expr, binding) {
  if (!expr) return expr;
  switch (expr.type) {
    case "Identifier":
      return expr;

    case "MemberExpression":
      return binding ? this.dummyIdent() : expr;

    case "ParenthesizedExpression":
      expr.expression = this.checkLVal(expr.expression, binding);
      return expr;

    // FIXME recursively check contents
    case "ObjectPattern":
    case "ArrayPattern":
    case "RestElement":
    case "AssignmentPattern":
      if (this.options.ecmaVersion >= 6) return expr;

    default:
      return this.dummyIdent();
  }
};

lp.parseExpression = function (noIn) {
  var start = this.storeCurrentPos();
  var expr = this.parseMaybeAssign(noIn);
  if (this.tok.type === _.tokTypes.comma) {
    var node = this.startNodeAt(start);
    node.expressions = [expr];
    while (this.eat(_.tokTypes.comma)) node.expressions.push(this.parseMaybeAssign(noIn));
    return this.finishNode(node, "SequenceExpression");
  }
  return expr;
};

lp.parseParenExpression = function () {
  this.pushCx();
  this.expect(_.tokTypes.parenL);
  var val = this.parseExpression();
  this.popCx();
  this.expect(_.tokTypes.parenR);
  return val;
};

lp.parseMaybeAssign = function (noIn) {
  var start = this.storeCurrentPos();
  var left = this.parseMaybeConditional(noIn);
  if (this.tok.type.isAssign) {
    var node = this.startNodeAt(start);
    node.operator = this.tok.value;
    node.left = this.tok.type === _.tokTypes.eq ? this.toAssignable(left) : this.checkLVal(left);
    this.next();
    node.right = this.parseMaybeAssign(noIn);
    return this.finishNode(node, "AssignmentExpression");
  }
  return left;
};

lp.parseMaybeConditional = function (noIn) {
  var start = this.storeCurrentPos();
  var expr = this.parseExprOps(noIn);
  if (this.eat(_.tokTypes.question)) {
    var node = this.startNodeAt(start);
    node.test = expr;
    node.consequent = this.parseMaybeAssign();
    node.alternate = this.expect(_.tokTypes.colon) ? this.parseMaybeAssign(noIn) : this.dummyIdent();
    return this.finishNode(node, "ConditionalExpression");
  }
  return expr;
};

lp.parseExprOps = function (noIn) {
  var start = this.storeCurrentPos();
  var indent = this.curIndent,
      line = this.curLineStart;
  return this.parseExprOp(this.parseMaybeUnary(noIn), start, -1, noIn, indent, line);
};

lp.parseExprOp = function (left, start, minPrec, noIn, indent, line) {
  if (this.curLineStart != line && this.curIndent < indent && this.tokenStartsLine()) return left;
  var prec = this.tok.type.binop;
  if (prec != null && (!noIn || this.tok.type !== _.tokTypes._in)) {
    if (prec > minPrec) {
      var node = this.startNodeAt(start);
      node.left = left;
      node.operator = this.tok.value;
      this.next();
      if (this.curLineStart != line && this.curIndent < indent && this.tokenStartsLine()) {
        node.right = this.dummyIdent();
      } else {
        var rightStart = this.storeCurrentPos();
        node.right = this.parseExprOp(this.parseMaybeUnary(noIn), rightStart, prec, noIn, indent, line);
      }
      this.finishNode(node, /&&|\|\|/.test(node.operator) ? "LogicalExpression" : "BinaryExpression");
      return this.parseExprOp(node, start, minPrec, noIn, indent, line);
    }
  }
  return left;
};

lp.parseMaybeUnary = function (noIn) {
  if (this.tok.type.prefix) {
    var node = this.startNode(),
        update = this.tok.type === _.tokTypes.incDec;
    node.operator = this.tok.value;
    node.prefix = true;
    this.next();
    node.argument = this.parseMaybeUnary(noIn);
    if (update) node.argument = this.checkLVal(node.argument);
    return this.finishNode(node, update ? "UpdateExpression" : "UnaryExpression");
  } else if (this.tok.type === _.tokTypes.ellipsis) {
    var node = this.startNode();
    this.next();
    node.argument = this.parseMaybeUnary(noIn);
    return this.finishNode(node, "SpreadElement");
  }
  var start = this.storeCurrentPos();
  var expr = this.parseExprSubscripts();
  while (this.tok.type.postfix && !this.canInsertSemicolon()) {
    var node = this.startNodeAt(start);
    node.operator = this.tok.value;
    node.prefix = false;
    node.argument = this.checkLVal(expr);
    this.next();
    expr = this.finishNode(node, "UpdateExpression");
  }
  return expr;
};

lp.parseExprSubscripts = function () {
  var start = this.storeCurrentPos();
  return this.parseSubscripts(this.parseExprAtom(), start, false, this.curIndent, this.curLineStart);
};

lp.parseSubscripts = function (base, start, noCalls, startIndent, line) {
  for (;;) {
    if (this.curLineStart != line && this.curIndent <= startIndent && this.tokenStartsLine()) {
      if (this.tok.type == _.tokTypes.dot && this.curIndent == startIndent) --startIndent;else return base;
    }

    if (this.eat(_.tokTypes.dot)) {
      var node = this.startNodeAt(start);
      node.object = base;
      if (this.curLineStart != line && this.curIndent <= startIndent && this.tokenStartsLine()) node.property = this.dummyIdent();else node.property = this.parsePropertyAccessor() || this.dummyIdent();
      node.computed = false;
      base = this.finishNode(node, "MemberExpression");
    } else if (this.tok.type == _.tokTypes.bracketL) {
      this.pushCx();
      this.next();
      var node = this.startNodeAt(start);
      node.object = base;
      node.property = this.parseExpression();
      node.computed = true;
      this.popCx();
      this.expect(_.tokTypes.bracketR);
      base = this.finishNode(node, "MemberExpression");
    } else if (!noCalls && this.tok.type == _.tokTypes.parenL) {
      var node = this.startNodeAt(start);
      node.callee = base;
      node.arguments = this.parseExprList(_.tokTypes.parenR);
      base = this.finishNode(node, "CallExpression");
    } else if (this.tok.type == _.tokTypes.backQuote) {
      var node = this.startNodeAt(start);
      node.tag = base;
      node.quasi = this.parseTemplate();
      base = this.finishNode(node, "TaggedTemplateExpression");
    } else {
      return base;
    }
  }
};

lp.parseExprAtom = function () {
  var node = undefined;
  switch (this.tok.type) {
    case _.tokTypes._this:
    case _.tokTypes._super:
      var type = this.tok.type === _.tokTypes._this ? "ThisExpression" : "Super";
      node = this.startNode();
      this.next();
      return this.finishNode(node, type);

    case _.tokTypes.name:
      var start = this.storeCurrentPos();
      var id = this.parseIdent();
      return this.eat(_.tokTypes.arrow) ? this.parseArrowExpression(this.startNodeAt(start), [id]) : id;

    case _.tokTypes.regexp:
      node = this.startNode();
      var val = this.tok.value;
      node.regex = { pattern: val.pattern, flags: val.flags };
      node.value = val.value;
      node.raw = this.input.slice(this.tok.start, this.tok.end);
      this.next();
      return this.finishNode(node, "Literal");

    case _.tokTypes.num:case _.tokTypes.string:
      node = this.startNode();
      node.value = this.tok.value;
      node.raw = this.input.slice(this.tok.start, this.tok.end);
      this.next();
      return this.finishNode(node, "Literal");

    case _.tokTypes._null:case _.tokTypes._true:case _.tokTypes._false:
      node = this.startNode();
      node.value = this.tok.type === _.tokTypes._null ? null : this.tok.type === _.tokTypes._true;
      node.raw = this.tok.type.keyword;
      this.next();
      return this.finishNode(node, "Literal");

    case _.tokTypes.parenL:
      var parenStart = this.storeCurrentPos();
      this.next();
      var inner = this.parseExpression();
      this.expect(_.tokTypes.parenR);
      if (this.eat(_.tokTypes.arrow)) {
        return this.parseArrowExpression(this.startNodeAt(parenStart), inner.expressions || (_parseutil.isDummy(inner) ? [] : [inner]));
      }
      if (this.options.preserveParens) {
        var par = this.startNodeAt(parenStart);
        par.expression = inner;
        inner = this.finishNode(par, "ParenthesizedExpression");
      }
      return inner;

    case _.tokTypes.bracketL:
      node = this.startNode();
      node.elements = this.parseExprList(_.tokTypes.bracketR, true);
      return this.finishNode(node, "ArrayExpression");

    case _.tokTypes.braceL:
      return this.parseObj();

    case _.tokTypes._class:
      return this.parseClass();

    case _.tokTypes._function:
      node = this.startNode();
      this.next();
      return this.parseFunction(node, false);

    case _.tokTypes._new:
      return this.parseNew();

    case _.tokTypes._yield:
      node = this.startNode();
      this.next();
      if (this.semicolon() || this.canInsertSemicolon() || this.tok.type != _.tokTypes.star && !this.tok.type.startsExpr) {
        node.delegate = false;
        node.argument = null;
      } else {
        node.delegate = this.eat(_.tokTypes.star);
        node.argument = this.parseMaybeAssign();
      }
      return this.finishNode(node, "YieldExpression");

    case _.tokTypes.backQuote:
      return this.parseTemplate();

    default:
      return this.dummyIdent();
  }
};

lp.parseNew = function () {
  var node = this.startNode(),
      startIndent = this.curIndent,
      line = this.curLineStart;
  var meta = this.parseIdent(true);
  if (this.options.ecmaVersion >= 6 && this.eat(_.tokTypes.dot)) {
    node.meta = meta;
    node.property = this.parseIdent(true);
    return this.finishNode(node, "MetaProperty");
  }
  var start = this.storeCurrentPos();
  node.callee = this.parseSubscripts(this.parseExprAtom(), start, true, startIndent, line);
  if (this.tok.type == _.tokTypes.parenL) {
    node.arguments = this.parseExprList(_.tokTypes.parenR);
  } else {
    node.arguments = [];
  }
  return this.finishNode(node, "NewExpression");
};

lp.parseTemplateElement = function () {
  var elem = this.startNode();
  elem.value = {
    raw: this.input.slice(this.tok.start, this.tok.end).replace(/\r\n?/g, '\n'),
    cooked: this.tok.value
  };
  this.next();
  elem.tail = this.tok.type === _.tokTypes.backQuote;
  return this.finishNode(elem, "TemplateElement");
};

lp.parseTemplate = function () {
  var node = this.startNode();
  this.next();
  node.expressions = [];
  var curElt = this.parseTemplateElement();
  node.quasis = [curElt];
  while (!curElt.tail) {
    this.next();
    node.expressions.push(this.parseExpression());
    if (this.expect(_.tokTypes.braceR)) {
      curElt = this.parseTemplateElement();
    } else {
      curElt = this.startNode();
      curElt.value = { cooked: '', raw: '' };
      curElt.tail = true;
    }
    node.quasis.push(curElt);
  }
  this.expect(_.tokTypes.backQuote);
  return this.finishNode(node, "TemplateLiteral");
};

lp.parseObj = function () {
  var node = this.startNode();
  node.properties = [];
  this.pushCx();
  var indent = this.curIndent + 1,
      line = this.curLineStart;
  this.eat(_.tokTypes.braceL);
  if (this.curIndent + 1 < indent) {
    indent = this.curIndent;line = this.curLineStart;
  }
  while (!this.closes(_.tokTypes.braceR, indent, line)) {
    var prop = this.startNode(),
        isGenerator = undefined,
        start = undefined;
    if (this.options.ecmaVersion >= 6) {
      start = this.storeCurrentPos();
      prop.method = false;
      prop.shorthand = false;
      isGenerator = this.eat(_.tokTypes.star);
    }
    this.parsePropertyName(prop);
    if (_parseutil.isDummy(prop.key)) {
      if (_parseutil.isDummy(this.parseMaybeAssign())) this.next();this.eat(_.tokTypes.comma);continue;
    }
    if (this.eat(_.tokTypes.colon)) {
      prop.kind = "init";
      prop.value = this.parseMaybeAssign();
    } else if (this.options.ecmaVersion >= 6 && (this.tok.type === _.tokTypes.parenL || this.tok.type === _.tokTypes.braceL)) {
      prop.kind = "init";
      prop.method = true;
      prop.value = this.parseMethod(isGenerator);
    } else if (this.options.ecmaVersion >= 5 && prop.key.type === "Identifier" && !prop.computed && (prop.key.name === "get" || prop.key.name === "set") && (this.tok.type != _.tokTypes.comma && this.tok.type != _.tokTypes.braceR)) {
      prop.kind = prop.key.name;
      this.parsePropertyName(prop);
      prop.value = this.parseMethod(false);
    } else {
      prop.kind = "init";
      if (this.options.ecmaVersion >= 6) {
        if (this.eat(_.tokTypes.eq)) {
          var assign = this.startNodeAt(start);
          assign.operator = "=";
          assign.left = prop.key;
          assign.right = this.parseMaybeAssign();
          prop.value = this.finishNode(assign, "AssignmentExpression");
        } else {
          prop.value = prop.key;
        }
      } else {
        prop.value = this.dummyIdent();
      }
      prop.shorthand = true;
    }
    node.properties.push(this.finishNode(prop, "Property"));
    this.eat(_.tokTypes.comma);
  }
  this.popCx();
  if (!this.eat(_.tokTypes.braceR)) {
    // If there is no closing brace, make the node span to the start
    // of the next token (this is useful for Tern)
    this.last.end = this.tok.start;
    if (this.options.locations) this.last.loc.end = this.tok.loc.start;
  }
  return this.finishNode(node, "ObjectExpression");
};

lp.parsePropertyName = function (prop) {
  if (this.options.ecmaVersion >= 6) {
    if (this.eat(_.tokTypes.bracketL)) {
      prop.computed = true;
      prop.key = this.parseExpression();
      this.expect(_.tokTypes.bracketR);
      return;
    } else {
      prop.computed = false;
    }
  }
  var key = this.tok.type === _.tokTypes.num || this.tok.type === _.tokTypes.string ? this.parseExprAtom() : this.parseIdent();
  prop.key = key || this.dummyIdent();
};

lp.parsePropertyAccessor = function () {
  if (this.tok.type === _.tokTypes.name || this.tok.type.keyword) return this.parseIdent();
};

lp.parseIdent = function () {
  var name = this.tok.type === _.tokTypes.name ? this.tok.value : this.tok.type.keyword;
  if (!name) return this.dummyIdent();
  var node = this.startNode();
  this.next();
  node.name = name;
  return this.finishNode(node, "Identifier");
};

lp.initFunction = function (node) {
  node.id = null;
  node.params = [];
  if (this.options.ecmaVersion >= 6) {
    node.generator = false;
    node.expression = false;
  }
};

// Convert existing expression atom to assignable pattern
// if possible.

lp.toAssignable = function (node, binding) {
  if (this.options.ecmaVersion >= 6 && node) {
    switch (node.type) {
      case "ObjectExpression":
        node.type = "ObjectPattern";
        var props = node.properties;
        for (var i = 0; i < props.length; i++) {
          this.toAssignable(props[i].value, binding);
        }break;

      case "ArrayExpression":
        node.type = "ArrayPattern";
        this.toAssignableList(node.elements, binding);
        break;

      case "SpreadElement":
        node.type = "RestElement";
        node.argument = this.toAssignable(node.argument, binding);
        break;

      case "AssignmentExpression":
        node.type = "AssignmentPattern";
        delete node.operator;
        break;
    }
  }
  return this.checkLVal(node, binding);
};

lp.toAssignableList = function (exprList, binding) {
  for (var i = 0; i < exprList.length; i++) {
    exprList[i] = this.toAssignable(exprList[i], binding);
  }return exprList;
};

lp.parseFunctionParams = function (params) {
  params = this.parseExprList(_.tokTypes.parenR);
  return this.toAssignableList(params, true);
};

lp.parseMethod = function (isGenerator) {
  var node = this.startNode();
  this.initFunction(node);
  node.params = this.parseFunctionParams();
  node.generator = isGenerator || false;
  node.expression = this.options.ecmaVersion >= 6 && this.tok.type !== _.tokTypes.braceL;
  node.body = node.expression ? this.parseMaybeAssign() : this.parseBlock();
  return this.finishNode(node, "FunctionExpression");
};

lp.parseArrowExpression = function (node, params) {
  this.initFunction(node);
  node.params = this.toAssignableList(params, true);
  node.expression = this.tok.type !== _.tokTypes.braceL;
  node.body = node.expression ? this.parseMaybeAssign() : this.parseBlock();
  return this.finishNode(node, "ArrowFunctionExpression");
};

lp.parseExprList = function (close, allowEmpty) {
  this.pushCx();
  var indent = this.curIndent,
      line = this.curLineStart,
      elts = [];
  this.next(); // Opening bracket
  while (!this.closes(close, indent + 1, line)) {
    if (this.eat(_.tokTypes.comma)) {
      elts.push(allowEmpty ? null : this.dummyIdent());
      continue;
    }
    var elt = this.parseMaybeAssign();
    if (_parseutil.isDummy(elt)) {
      if (this.closes(close, indent, line)) break;
      this.next();
    } else {
      elts.push(elt);
    }
    this.eat(_.tokTypes.comma);
  }
  this.popCx();
  if (!this.eat(close)) {
    // If there is no closing brace, make the node span to the start
    // of the next token (this is useful for Tern)
    this.last.end = this.tok.start;
    if (this.options.locations) this.last.loc.end = this.tok.loc.start;
  }
  return elts;
};

},{"..":2,"./parseutil":5,"./state":6}],4:[function(_dereq_,module,exports){
// Acorn: Loose parser
//
// This module provides an alternative parser (`parse_dammit`) that
// exposes that same interface as `parse`, but will try to parse
// anything as JavaScript, repairing syntax error the best it can.
// There are circumstances in which it will raise an error and give
// up, but they are very rare. The resulting AST will be a mostly
// valid JavaScript AST (as per the [Mozilla parser API][api], except
// that:
//
// - Return outside functions is allowed
//
// - Label consistency (no conflicts, break only to existing labels)
//   is not enforced.
//
// - Bogus Identifier nodes with a name of `"✖"` are inserted whenever
//   the parser got too confused to return anything meaningful.
//
// [api]: https://developer.mozilla.org/en-US/docs/SpiderMonkey/Parser_API
//
// The expected use for this is to *first* try `acorn.parse`, and only
// if that fails switch to `parse_dammit`. The loose parser might
// parse badly indented code incorrectly, so **don't** use it as
// your default parser.
//
// Quite a lot of acorn.js is duplicated here. The alternative was to
// add a *lot* of extra cruft to that file, making it less readable
// and slower. Copying and editing the code allowed me to make
// invasive changes and simplifications without creating a complicated
// tangle.

"use strict";

exports.__esModule = true;
exports.parse_dammit = parse_dammit;

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj["default"] = obj; return newObj; } }

var _ = _dereq_("..");

var acorn = _interopRequireWildcard(_);

var _state = _dereq_("./state");

_dereq_("./tokenize");

_dereq_("./statement");

_dereq_("./expression");

exports.LooseParser = _state.LooseParser;

acorn.defaultOptions.tabSize = 4;

function parse_dammit(input, options) {
  var p = new _state.LooseParser(input, options);
  p.next();
  return p.parseTopLevel();
}

acorn.parse_dammit = parse_dammit;
acorn.LooseParser = _state.LooseParser;

},{"..":2,"./expression":3,"./state":6,"./statement":7,"./tokenize":8}],5:[function(_dereq_,module,exports){
"use strict";

exports.__esModule = true;
exports.isDummy = isDummy;

function isDummy(node) {
  return node.name == "✖";
}

},{}],6:[function(_dereq_,module,exports){
"use strict";

exports.__esModule = true;

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var _ = _dereq_("..");

var LooseParser = (function () {
  function LooseParser(input, options) {
    _classCallCheck(this, LooseParser);

    this.toks = _.tokenizer(input, options);
    this.options = this.toks.options;
    this.input = this.toks.input;
    this.tok = this.last = { type: _.tokTypes.eof, start: 0, end: 0 };
    if (this.options.locations) {
      var here = this.toks.curPosition();
      this.tok.loc = new _.SourceLocation(this.toks, here, here);
    }
    this.ahead = []; // Tokens ahead
    this.context = []; // Indentation contexted
    this.curIndent = 0;
    this.curLineStart = 0;
    this.nextLineStart = this.lineEnd(this.curLineStart) + 1;
  }

  LooseParser.prototype.startNode = function startNode() {
    return new _.Node(this.toks, this.tok.start, this.options.locations ? this.tok.loc.start : null);
  };

  LooseParser.prototype.storeCurrentPos = function storeCurrentPos() {
    return this.options.locations ? [this.tok.start, this.tok.loc.start] : this.tok.start;
  };

  LooseParser.prototype.startNodeAt = function startNodeAt(pos) {
    if (this.options.locations) {
      return new _.Node(this.toks, pos[0], pos[1]);
    } else {
      return new _.Node(this.toks, pos);
    }
  };

  LooseParser.prototype.finishNode = function finishNode(node, type) {
    node.type = type;
    node.end = this.last.end;
    if (this.options.locations) node.loc.end = this.last.loc.end;
    if (this.options.ranges) node.range[1] = this.last.end;
    return node;
  };

  LooseParser.prototype.dummyIdent = function dummyIdent() {
    var dummy = this.startNode();
    dummy.name = "✖";
    return this.finishNode(dummy, "Identifier");
  };

  LooseParser.prototype.eat = function eat(type) {
    if (this.tok.type === type) {
      this.next();
      return true;
    } else {
      return false;
    }
  };

  LooseParser.prototype.isContextual = function isContextual(name) {
    return this.tok.type === _.tokTypes.name && this.tok.value === name;
  };

  LooseParser.prototype.eatContextual = function eatContextual(name) {
    return this.tok.value === name && this.eat(_.tokTypes.name);
  };

  LooseParser.prototype.canInsertSemicolon = function canInsertSemicolon() {
    return this.tok.type === _.tokTypes.eof || this.tok.type === _.tokTypes.braceR || _.lineBreak.test(this.input.slice(this.last.end, this.tok.start));
  };

  LooseParser.prototype.semicolon = function semicolon() {
    return this.eat(_.tokTypes.semi);
  };

  LooseParser.prototype.expect = function expect(type) {
    if (this.eat(type)) return true;
    for (var i = 1; i <= 2; i++) {
      if (this.lookAhead(i).type == type) {
        for (var j = 0; j < i; j++) {
          this.next();
        }return true;
      }
    }
  };

  LooseParser.prototype.pushCx = function pushCx() {
    this.context.push(this.curIndent);
  };

  LooseParser.prototype.popCx = function popCx() {
    this.curIndent = this.context.pop();
  };

  LooseParser.prototype.lineEnd = function lineEnd(pos) {
    while (pos < this.input.length && !_.isNewLine(this.input.charCodeAt(pos))) ++pos;
    return pos;
  };

  LooseParser.prototype.indentationAfter = function indentationAfter(pos) {
    for (var count = 0;; ++pos) {
      var ch = this.input.charCodeAt(pos);
      if (ch === 32) ++count;else if (ch === 9) count += this.options.tabSize;else return count;
    }
  };

  LooseParser.prototype.closes = function closes(closeTok, indent, line, blockHeuristic) {
    if (this.tok.type === closeTok || this.tok.type === _.tokTypes.eof) return true;
    return line != this.curLineStart && this.curIndent < indent && this.tokenStartsLine() && (!blockHeuristic || this.nextLineStart >= this.input.length || this.indentationAfter(this.nextLineStart) < indent);
  };

  LooseParser.prototype.tokenStartsLine = function tokenStartsLine() {
    for (var p = this.tok.start - 1; p >= this.curLineStart; --p) {
      var ch = this.input.charCodeAt(p);
      if (ch !== 9 && ch !== 32) return false;
    }
    return true;
  };

  return LooseParser;
})();

exports.LooseParser = LooseParser;

},{"..":2}],7:[function(_dereq_,module,exports){
"use strict";

var _state = _dereq_("./state");

var _parseutil = _dereq_("./parseutil");

var _ = _dereq_("..");

var lp = _state.LooseParser.prototype;

lp.parseTopLevel = function () {
  var node = this.startNodeAt(this.options.locations ? [0, _.getLineInfo(this.input, 0)] : 0);
  node.body = [];
  while (this.tok.type !== _.tokTypes.eof) node.body.push(this.parseStatement());
  this.last = this.tok;
  if (this.options.ecmaVersion >= 6) {
    node.sourceType = this.options.sourceType;
  }
  return this.finishNode(node, "Program");
};

lp.parseStatement = function () {
  var starttype = this.tok.type,
      node = this.startNode();

  switch (starttype) {
    case _.tokTypes._break:case _.tokTypes._continue:
      this.next();
      var isBreak = starttype === _.tokTypes._break;
      if (this.semicolon() || this.canInsertSemicolon()) {
        node.label = null;
      } else {
        node.label = this.tok.type === _.tokTypes.name ? this.parseIdent() : null;
        this.semicolon();
      }
      return this.finishNode(node, isBreak ? "BreakStatement" : "ContinueStatement");

    case _.tokTypes._debugger:
      this.next();
      this.semicolon();
      return this.finishNode(node, "DebuggerStatement");

    case _.tokTypes._do:
      this.next();
      node.body = this.parseStatement();
      node.test = this.eat(_.tokTypes._while) ? this.parseParenExpression() : this.dummyIdent();
      this.semicolon();
      return this.finishNode(node, "DoWhileStatement");

    case _.tokTypes._for:
      this.next();
      this.pushCx();
      this.expect(_.tokTypes.parenL);
      if (this.tok.type === _.tokTypes.semi) return this.parseFor(node, null);
      if (this.tok.type === _.tokTypes._var || this.tok.type === _.tokTypes._let || this.tok.type === _.tokTypes._const) {
        var _init = this.parseVar(true);
        if (_init.declarations.length === 1 && (this.tok.type === _.tokTypes._in || this.isContextual("of"))) {
          return this.parseForIn(node, _init);
        }
        return this.parseFor(node, _init);
      }
      var init = this.parseExpression(true);
      if (this.tok.type === _.tokTypes._in || this.isContextual("of")) return this.parseForIn(node, this.toAssignable(init));
      return this.parseFor(node, init);

    case _.tokTypes._function:
      this.next();
      return this.parseFunction(node, true);

    case _.tokTypes._if:
      this.next();
      node.test = this.parseParenExpression();
      node.consequent = this.parseStatement();
      node.alternate = this.eat(_.tokTypes._else) ? this.parseStatement() : null;
      return this.finishNode(node, "IfStatement");

    case _.tokTypes._return:
      this.next();
      if (this.eat(_.tokTypes.semi) || this.canInsertSemicolon()) node.argument = null;else {
        node.argument = this.parseExpression();this.semicolon();
      }
      return this.finishNode(node, "ReturnStatement");

    case _.tokTypes._switch:
      var blockIndent = this.curIndent,
          line = this.curLineStart;
      this.next();
      node.discriminant = this.parseParenExpression();
      node.cases = [];
      this.pushCx();
      this.expect(_.tokTypes.braceL);

      var cur = undefined;
      while (!this.closes(_.tokTypes.braceR, blockIndent, line, true)) {
        if (this.tok.type === _.tokTypes._case || this.tok.type === _.tokTypes._default) {
          var isCase = this.tok.type === _.tokTypes._case;
          if (cur) this.finishNode(cur, "SwitchCase");
          node.cases.push(cur = this.startNode());
          cur.consequent = [];
          this.next();
          if (isCase) cur.test = this.parseExpression();else cur.test = null;
          this.expect(_.tokTypes.colon);
        } else {
          if (!cur) {
            node.cases.push(cur = this.startNode());
            cur.consequent = [];
            cur.test = null;
          }
          cur.consequent.push(this.parseStatement());
        }
      }
      if (cur) this.finishNode(cur, "SwitchCase");
      this.popCx();
      this.eat(_.tokTypes.braceR);
      return this.finishNode(node, "SwitchStatement");

    case _.tokTypes._throw:
      this.next();
      node.argument = this.parseExpression();
      this.semicolon();
      return this.finishNode(node, "ThrowStatement");

    case _.tokTypes._try:
      this.next();
      node.block = this.parseBlock();
      node.handler = null;
      if (this.tok.type === _.tokTypes._catch) {
        var clause = this.startNode();
        this.next();
        this.expect(_.tokTypes.parenL);
        clause.param = this.toAssignable(this.parseExprAtom(), true);
        this.expect(_.tokTypes.parenR);
        clause.guard = null;
        clause.body = this.parseBlock();
        node.handler = this.finishNode(clause, "CatchClause");
      }
      node.finalizer = this.eat(_.tokTypes._finally) ? this.parseBlock() : null;
      if (!node.handler && !node.finalizer) return node.block;
      return this.finishNode(node, "TryStatement");

    case _.tokTypes._var:
    case _.tokTypes._let:
    case _.tokTypes._const:
      return this.parseVar();

    case _.tokTypes._while:
      this.next();
      node.test = this.parseParenExpression();
      node.body = this.parseStatement();
      return this.finishNode(node, "WhileStatement");

    case _.tokTypes._with:
      this.next();
      node.object = this.parseParenExpression();
      node.body = this.parseStatement();
      return this.finishNode(node, "WithStatement");

    case _.tokTypes.braceL:
      return this.parseBlock();

    case _.tokTypes.semi:
      this.next();
      return this.finishNode(node, "EmptyStatement");

    case _.tokTypes._class:
      return this.parseClass(true);

    case _.tokTypes._import:
      return this.parseImport();

    case _.tokTypes._export:
      return this.parseExport();

    default:
      var expr = this.parseExpression();
      if (_parseutil.isDummy(expr)) {
        this.next();
        if (this.tok.type === _.tokTypes.eof) return this.finishNode(node, "EmptyStatement");
        return this.parseStatement();
      } else if (starttype === _.tokTypes.name && expr.type === "Identifier" && this.eat(_.tokTypes.colon)) {
        node.body = this.parseStatement();
        node.label = expr;
        return this.finishNode(node, "LabeledStatement");
      } else {
        node.expression = expr;
        this.semicolon();
        return this.finishNode(node, "ExpressionStatement");
      }
  }
};

lp.parseBlock = function () {
  var node = this.startNode();
  this.pushCx();
  this.expect(_.tokTypes.braceL);
  var blockIndent = this.curIndent,
      line = this.curLineStart;
  node.body = [];
  while (!this.closes(_.tokTypes.braceR, blockIndent, line, true)) node.body.push(this.parseStatement());
  this.popCx();
  this.eat(_.tokTypes.braceR);
  return this.finishNode(node, "BlockStatement");
};

lp.parseFor = function (node, init) {
  node.init = init;
  node.test = node.update = null;
  if (this.eat(_.tokTypes.semi) && this.tok.type !== _.tokTypes.semi) node.test = this.parseExpression();
  if (this.eat(_.tokTypes.semi) && this.tok.type !== _.tokTypes.parenR) node.update = this.parseExpression();
  this.popCx();
  this.expect(_.tokTypes.parenR);
  node.body = this.parseStatement();
  return this.finishNode(node, "ForStatement");
};

lp.parseForIn = function (node, init) {
  var type = this.tok.type === _.tokTypes._in ? "ForInStatement" : "ForOfStatement";
  this.next();
  node.left = init;
  node.right = this.parseExpression();
  this.popCx();
  this.expect(_.tokTypes.parenR);
  node.body = this.parseStatement();
  return this.finishNode(node, type);
};

lp.parseVar = function (noIn) {
  var node = this.startNode();
  node.kind = this.tok.type.keyword;
  this.next();
  node.declarations = [];
  do {
    var decl = this.startNode();
    decl.id = this.options.ecmaVersion >= 6 ? this.toAssignable(this.parseExprAtom(), true) : this.parseIdent();
    decl.init = this.eat(_.tokTypes.eq) ? this.parseMaybeAssign(noIn) : null;
    node.declarations.push(this.finishNode(decl, "VariableDeclarator"));
  } while (this.eat(_.tokTypes.comma));
  if (!node.declarations.length) {
    var decl = this.startNode();
    decl.id = this.dummyIdent();
    node.declarations.push(this.finishNode(decl, "VariableDeclarator"));
  }
  if (!noIn) this.semicolon();
  return this.finishNode(node, "VariableDeclaration");
};

lp.parseClass = function (isStatement) {
  var node = this.startNode();
  this.next();
  if (this.tok.type === _.tokTypes.name) node.id = this.parseIdent();else if (isStatement) node.id = this.dummyIdent();else node.id = null;
  node.superClass = this.eat(_.tokTypes._extends) ? this.parseExpression() : null;
  node.body = this.startNode();
  node.body.body = [];
  this.pushCx();
  var indent = this.curIndent + 1,
      line = this.curLineStart;
  this.eat(_.tokTypes.braceL);
  if (this.curIndent + 1 < indent) {
    indent = this.curIndent;line = this.curLineStart;
  }
  while (!this.closes(_.tokTypes.braceR, indent, line)) {
    if (this.semicolon()) continue;
    var method = this.startNode(),
        isGenerator = undefined;
    if (this.options.ecmaVersion >= 6) {
      method["static"] = false;
      isGenerator = this.eat(_.tokTypes.star);
    }
    this.parsePropertyName(method);
    if (_parseutil.isDummy(method.key)) {
      if (_parseutil.isDummy(this.parseMaybeAssign())) this.next();this.eat(_.tokTypes.comma);continue;
    }
    if (method.key.type === "Identifier" && !method.computed && method.key.name === "static" && (this.tok.type != _.tokTypes.parenL && this.tok.type != _.tokTypes.braceL)) {
      method["static"] = true;
      isGenerator = this.eat(_.tokTypes.star);
      this.parsePropertyName(method);
    } else {
      method["static"] = false;
    }
    if (this.options.ecmaVersion >= 5 && method.key.type === "Identifier" && !method.computed && (method.key.name === "get" || method.key.name === "set") && this.tok.type !== _.tokTypes.parenL && this.tok.type !== _.tokTypes.braceL) {
      method.kind = method.key.name;
      this.parsePropertyName(method);
      method.value = this.parseMethod(false);
    } else {
      if (!method.computed && !method["static"] && !isGenerator && (method.key.type === "Identifier" && method.key.name === "constructor" || method.key.type === "Literal" && method.key.value === "constructor")) {
        method.kind = "constructor";
      } else {
        method.kind = "method";
      }
      method.value = this.parseMethod(isGenerator);
    }
    node.body.body.push(this.finishNode(method, "MethodDefinition"));
  }
  this.popCx();
  if (!this.eat(_.tokTypes.braceR)) {
    // If there is no closing brace, make the node span to the start
    // of the next token (this is useful for Tern)
    this.last.end = this.tok.start;
    if (this.options.locations) this.last.loc.end = this.tok.loc.start;
  }
  this.semicolon();
  this.finishNode(node.body, "ClassBody");
  return this.finishNode(node, isStatement ? "ClassDeclaration" : "ClassExpression");
};

lp.parseFunction = function (node, isStatement) {
  this.initFunction(node);
  if (this.options.ecmaVersion >= 6) {
    node.generator = this.eat(_.tokTypes.star);
  }
  if (this.tok.type === _.tokTypes.name) node.id = this.parseIdent();else if (isStatement) node.id = this.dummyIdent();
  node.params = this.parseFunctionParams();
  node.body = this.parseBlock();
  return this.finishNode(node, isStatement ? "FunctionDeclaration" : "FunctionExpression");
};

lp.parseExport = function () {
  var node = this.startNode();
  this.next();
  if (this.eat(_.tokTypes.star)) {
    node.source = this.eatContextual("from") ? this.parseExprAtom() : null;
    return this.finishNode(node, "ExportAllDeclaration");
  }
  if (this.eat(_.tokTypes._default)) {
    var expr = this.parseMaybeAssign();
    if (expr.id) {
      switch (expr.type) {
        case "FunctionExpression":
          expr.type = "FunctionDeclaration";break;
        case "ClassExpression":
          expr.type = "ClassDeclaration";break;
      }
    }
    node.declaration = expr;
    this.semicolon();
    return this.finishNode(node, "ExportDefaultDeclaration");
  }
  if (this.tok.type.keyword) {
    node.declaration = this.parseStatement();
    node.specifiers = [];
    node.source = null;
  } else {
    node.declaration = null;
    node.specifiers = this.parseExportSpecifierList();
    node.source = this.eatContextual("from") ? this.parseExprAtom() : null;
    this.semicolon();
  }
  return this.finishNode(node, "ExportNamedDeclaration");
};

lp.parseImport = function () {
  var node = this.startNode();
  this.next();
  if (this.tok.type === _.tokTypes.string) {
    node.specifiers = [];
    node.source = this.parseExprAtom();
    node.kind = '';
  } else {
    var elt = undefined;
    if (this.tok.type === _.tokTypes.name && this.tok.value !== "from") {
      elt = this.startNode();
      elt.local = this.parseIdent();
      this.finishNode(elt, "ImportDefaultSpecifier");
      this.eat(_.tokTypes.comma);
    }
    node.specifiers = this.parseImportSpecifierList();
    node.source = this.eatContextual("from") ? this.parseExprAtom() : null;
    if (elt) node.specifiers.unshift(elt);
  }
  this.semicolon();
  return this.finishNode(node, "ImportDeclaration");
};

lp.parseImportSpecifierList = function () {
  var elts = [];
  if (this.tok.type === _.tokTypes.star) {
    var elt = this.startNode();
    this.next();
    if (this.eatContextual("as")) elt.local = this.parseIdent();
    elts.push(this.finishNode(elt, "ImportNamespaceSpecifier"));
  } else {
    var indent = this.curIndent,
        line = this.curLineStart,
        continuedLine = this.nextLineStart;
    this.pushCx();
    this.eat(_.tokTypes.braceL);
    if (this.curLineStart > continuedLine) continuedLine = this.curLineStart;
    while (!this.closes(_.tokTypes.braceR, indent + (this.curLineStart <= continuedLine ? 1 : 0), line)) {
      var elt = this.startNode();
      if (this.eat(_.tokTypes.star)) {
        if (this.eatContextual("as")) elt.local = this.parseIdent();
        this.finishNode(elt, "ImportNamespaceSpecifier");
      } else {
        if (this.isContextual("from")) break;
        elt.imported = this.parseIdent();
        if (_parseutil.isDummy(elt.imported)) break;
        elt.local = this.eatContextual("as") ? this.parseIdent() : elt.imported;
        this.finishNode(elt, "ImportSpecifier");
      }
      elts.push(elt);
      this.eat(_.tokTypes.comma);
    }
    this.eat(_.tokTypes.braceR);
    this.popCx();
  }
  return elts;
};

lp.parseExportSpecifierList = function () {
  var elts = [];
  var indent = this.curIndent,
      line = this.curLineStart,
      continuedLine = this.nextLineStart;
  this.pushCx();
  this.eat(_.tokTypes.braceL);
  if (this.curLineStart > continuedLine) continuedLine = this.curLineStart;
  while (!this.closes(_.tokTypes.braceR, indent + (this.curLineStart <= continuedLine ? 1 : 0), line)) {
    if (this.isContextual("from")) break;
    var elt = this.startNode();
    elt.local = this.parseIdent();
    if (_parseutil.isDummy(elt.local)) break;
    elt.exported = this.eatContextual("as") ? this.parseIdent() : elt.local;
    this.finishNode(elt, "ExportSpecifier");
    elts.push(elt);
    this.eat(_.tokTypes.comma);
  }
  this.eat(_.tokTypes.braceR);
  this.popCx();
  return elts;
};

},{"..":2,"./parseutil":5,"./state":6}],8:[function(_dereq_,module,exports){
"use strict";

var _ = _dereq_("..");

var _state = _dereq_("./state");

var lp = _state.LooseParser.prototype;

function isSpace(ch) {
  return ch < 14 && ch > 8 || ch === 32 || ch === 160 || _.isNewLine(ch);
}

lp.next = function () {
  this.last = this.tok;
  if (this.ahead.length) this.tok = this.ahead.shift();else this.tok = this.readToken();

  if (this.tok.start >= this.nextLineStart) {
    while (this.tok.start >= this.nextLineStart) {
      this.curLineStart = this.nextLineStart;
      this.nextLineStart = this.lineEnd(this.curLineStart) + 1;
    }
    this.curIndent = this.indentationAfter(this.curLineStart);
  }
};

lp.readToken = function () {
  for (;;) {
    try {
      this.toks.next();
      if (this.toks.type === _.tokTypes.dot && this.input.substr(this.toks.end, 1) === "." && this.options.ecmaVersion >= 6) {
        this.toks.end++;
        this.toks.type = _.tokTypes.ellipsis;
      }
      return new _.Token(this.toks);
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;

      // Try to skip some text, based on the error message, and then continue
      var msg = e.message,
          pos = e.raisedAt,
          replace = true;
      if (/unterminated/i.test(msg)) {
        pos = this.lineEnd(e.pos + 1);
        if (/string/.test(msg)) {
          replace = { start: e.pos, end: pos, type: _.tokTypes.string, value: this.input.slice(e.pos + 1, pos) };
        } else if (/regular expr/i.test(msg)) {
          var re = this.input.slice(e.pos, pos);
          try {
            re = new RegExp(re);
          } catch (e) {}
          replace = { start: e.pos, end: pos, type: _.tokTypes.regexp, value: re };
        } else if (/template/.test(msg)) {
          replace = { start: e.pos, end: pos,
            type: _.tokTypes.template,
            value: this.input.slice(e.pos, pos) };
        } else {
          replace = false;
        }
      } else if (/invalid (unicode|regexp|number)|expecting unicode|octal literal|is reserved|directly after number|expected number in radix/i.test(msg)) {
        while (pos < this.input.length && !isSpace(this.input.charCodeAt(pos))) ++pos;
      } else if (/character escape|expected hexadecimal/i.test(msg)) {
        while (pos < this.input.length) {
          var ch = this.input.charCodeAt(pos++);
          if (ch === 34 || ch === 39 || _.isNewLine(ch)) break;
        }
      } else if (/unexpected character/i.test(msg)) {
        pos++;
        replace = false;
      } else if (/regular expression/i.test(msg)) {
        replace = true;
      } else {
        throw e;
      }
      this.resetTo(pos);
      if (replace === true) replace = { start: pos, end: pos, type: _.tokTypes.name, value: "✖" };
      if (replace) {
        if (this.options.locations) replace.loc = new _.SourceLocation(this.toks, _.getLineInfo(this.input, replace.start), _.getLineInfo(this.input, replace.end));
        return replace;
      }
    }
  }
};

lp.resetTo = function (pos) {
  this.toks.pos = pos;
  var ch = this.input.charAt(pos - 1);
  this.toks.exprAllowed = !ch || /[\[\{\(,;:?\/*=+\-~!|&%^<>]/.test(ch) || /[enwfd]/.test(ch) && /\b(keywords|case|else|return|throw|new|in|(instance|type)of|delete|void)$/.test(this.input.slice(pos - 10, pos));

  if (this.options.locations) {
    this.toks.curLine = 1;
    this.toks.lineStart = _.lineBreakG.lastIndex = 0;
    var match = undefined;
    while ((match = _.lineBreakG.exec(this.input)) && match.index < pos) {
      ++this.toks.curLine;
      this.toks.lineStart = match.index + match[0].length;
    }
  }
};

lp.lookAhead = function (n) {
  while (n > this.ahead.length) this.ahead.push(this.readToken());
  return this.ahead[n - 1];
};

},{"..":2,"./state":6}]},{},[4])(4)
});
}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{}],16:[function(require,module,exports){
(function (global){
(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}(g.acorn || (g.acorn = {})).walk = f()}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(_dereq_,module,exports){
// AST walker module for Mozilla Parser API compatible trees

// A simple walk is one where you simply specify callbacks to be
// called on specific nodes. The last two arguments are optional. A
// simple use would be
//
//     walk.simple(myTree, {
//         Expression: function(node) { ... }
//     });
//
// to do something with all expressions. All Parser API node types
// can be used to identify node types, as well as Expression,
// Statement, and ScopeBody, which denote categories of nodes.
//
// The base argument can be used to pass a custom (recursive)
// walker, and state can be used to give this walked an initial
// state.

"use strict";

exports.__esModule = true;
exports.simple = simple;
exports.ancestor = ancestor;
exports.recursive = recursive;
exports.findNodeAt = findNodeAt;
exports.findNodeAround = findNodeAround;
exports.findNodeAfter = findNodeAfter;
exports.findNodeBefore = findNodeBefore;
exports.make = make;

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

function simple(node, visitors, base, state, override) {
  if (!base) base = exports.base;(function c(node, st, override) {
    var type = override || node.type,
        found = visitors[type];
    base[type](node, st, c);
    if (found) found(node, st);
  })(node, state, override);
}

// An ancestor walk builds up an array of ancestor nodes (including
// the current node) and passes them to the callback as the state parameter.

function ancestor(node, visitors, base, state) {
  if (!base) base = exports.base;
  if (!state) state = [];(function c(node, st, override) {
    var type = override || node.type,
        found = visitors[type];
    if (node != st[st.length - 1]) {
      st = st.slice();
      st.push(node);
    }
    base[type](node, st, c);
    if (found) found(node, st);
  })(node, state);
}

// A recursive walk is one where your functions override the default
// walkers. They can modify and replace the state parameter that's
// threaded through the walk, and can opt how and whether to walk
// their child nodes (by calling their third argument on these
// nodes).

function recursive(node, state, funcs, base, override) {
  var visitor = funcs ? exports.make(funcs, base) : base;(function c(node, st, override) {
    visitor[override || node.type](node, st, c);
  })(node, state, override);
}

function makeTest(test) {
  if (typeof test == "string") return function (type) {
    return type == test;
  };else if (!test) return function () {
    return true;
  };else return test;
}

var Found = function Found(node, state) {
  _classCallCheck(this, Found);

  this.node = node;this.state = state;
}

// Find a node with a given start, end, and type (all are optional,
// null can be used as wildcard). Returns a {node, state} object, or
// undefined when it doesn't find a matching node.
;

function findNodeAt(node, start, end, test, base, state) {
  test = makeTest(test);
  if (!base) base = exports.base;
  try {
    ;(function c(node, st, override) {
      var type = override || node.type;
      if ((start == null || node.start <= start) && (end == null || node.end >= end)) base[type](node, st, c);
      if (test(type, node) && (start == null || node.start == start) && (end == null || node.end == end)) throw new Found(node, st);
    })(node, state);
  } catch (e) {
    if (e instanceof Found) return e;
    throw e;
  }
}

// Find the innermost node of a given type that contains the given
// position. Interface similar to findNodeAt.

function findNodeAround(node, pos, test, base, state) {
  test = makeTest(test);
  if (!base) base = exports.base;
  try {
    ;(function c(node, st, override) {
      var type = override || node.type;
      if (node.start > pos || node.end < pos) return;
      base[type](node, st, c);
      if (test(type, node)) throw new Found(node, st);
    })(node, state);
  } catch (e) {
    if (e instanceof Found) return e;
    throw e;
  }
}

// Find the outermost matching node after a given position.

function findNodeAfter(node, pos, test, base, state) {
  test = makeTest(test);
  if (!base) base = exports.base;
  try {
    ;(function c(node, st, override) {
      if (node.end < pos) return;
      var type = override || node.type;
      if (node.start >= pos && test(type, node)) throw new Found(node, st);
      base[type](node, st, c);
    })(node, state);
  } catch (e) {
    if (e instanceof Found) return e;
    throw e;
  }
}

// Find the outermost matching node before a given position.

function findNodeBefore(node, pos, test, base, state) {
  test = makeTest(test);
  if (!base) base = exports.base;
  var max = undefined;(function c(node, st, override) {
    if (node.start > pos) return;
    var type = override || node.type;
    if (node.end <= pos && (!max || max.node.end < node.end) && test(type, node)) max = new Found(node, st);
    base[type](node, st, c);
  })(node, state);
  return max;
}

// Used to create a custom walker. Will fill in all missing node
// type properties with the defaults.

function make(funcs, base) {
  if (!base) base = exports.base;
  var visitor = {};
  for (var type in base) visitor[type] = base[type];
  for (var type in funcs) visitor[type] = funcs[type];
  return visitor;
}

function skipThrough(node, st, c) {
  c(node, st);
}
function ignore(_node, _st, _c) {}

// Node walkers.

var base = {};

exports.base = base;
base.Program = base.BlockStatement = function (node, st, c) {
  for (var i = 0; i < node.body.length; ++i) {
    c(node.body[i], st, "Statement");
  }
};
base.Statement = skipThrough;
base.EmptyStatement = ignore;
base.ExpressionStatement = base.ParenthesizedExpression = function (node, st, c) {
  return c(node.expression, st, "Expression");
};
base.IfStatement = function (node, st, c) {
  c(node.test, st, "Expression");
  c(node.consequent, st, "Statement");
  if (node.alternate) c(node.alternate, st, "Statement");
};
base.LabeledStatement = function (node, st, c) {
  return c(node.body, st, "Statement");
};
base.BreakStatement = base.ContinueStatement = ignore;
base.WithStatement = function (node, st, c) {
  c(node.object, st, "Expression");
  c(node.body, st, "Statement");
};
base.SwitchStatement = function (node, st, c) {
  c(node.discriminant, st, "Expression");
  for (var i = 0; i < node.cases.length; ++i) {
    var cs = node.cases[i];
    if (cs.test) c(cs.test, st, "Expression");
    for (var j = 0; j < cs.consequent.length; ++j) {
      c(cs.consequent[j], st, "Statement");
    }
  }
};
base.ReturnStatement = base.YieldExpression = function (node, st, c) {
  if (node.argument) c(node.argument, st, "Expression");
};
base.ThrowStatement = base.SpreadElement = function (node, st, c) {
  return c(node.argument, st, "Expression");
};
base.TryStatement = function (node, st, c) {
  c(node.block, st, "Statement");
  if (node.handler) {
    c(node.handler.param, st, "Pattern");
    c(node.handler.body, st, "ScopeBody");
  }
  if (node.finalizer) c(node.finalizer, st, "Statement");
};
base.WhileStatement = base.DoWhileStatement = function (node, st, c) {
  c(node.test, st, "Expression");
  c(node.body, st, "Statement");
};
base.ForStatement = function (node, st, c) {
  if (node.init) c(node.init, st, "ForInit");
  if (node.test) c(node.test, st, "Expression");
  if (node.update) c(node.update, st, "Expression");
  c(node.body, st, "Statement");
};
base.ForInStatement = base.ForOfStatement = function (node, st, c) {
  c(node.left, st, "ForInit");
  c(node.right, st, "Expression");
  c(node.body, st, "Statement");
};
base.ForInit = function (node, st, c) {
  if (node.type == "VariableDeclaration") c(node, st);else c(node, st, "Expression");
};
base.DebuggerStatement = ignore;

base.FunctionDeclaration = function (node, st, c) {
  return c(node, st, "Function");
};
base.VariableDeclaration = function (node, st, c) {
  for (var i = 0; i < node.declarations.length; ++i) {
    var decl = node.declarations[i];
    c(decl.id, st, "Pattern");
    if (decl.init) c(decl.init, st, "Expression");
  }
};

base.Function = function (node, st, c) {
  for (var i = 0; i < node.params.length; i++) {
    c(node.params[i], st, "Pattern");
  }c(node.body, st, node.expression ? "ScopeExpression" : "ScopeBody");
};
// FIXME drop these node types in next major version
// (They are awkward, and in ES6 every block can be a scope.)
base.ScopeBody = function (node, st, c) {
  return c(node, st, "Statement");
};
base.ScopeExpression = function (node, st, c) {
  return c(node, st, "Expression");
};

base.Pattern = function (node, st, c) {
  if (node.type == "Identifier") c(node, st, "VariablePattern");else if (node.type == "MemberExpression") c(node, st, "MemberPattern");else c(node, st);
};
base.VariablePattern = ignore;
base.MemberPattern = skipThrough;
base.RestElement = function (node, st, c) {
  return c(node.argument, st, "Pattern");
};
base.ArrayPattern = function (node, st, c) {
  for (var i = 0; i < node.elements.length; ++i) {
    var elt = node.elements[i];
    if (elt) c(elt, st, "Pattern");
  }
};
base.ObjectPattern = function (node, st, c) {
  for (var i = 0; i < node.properties.length; ++i) {
    c(node.properties[i].value, st, "Pattern");
  }
};

base.Expression = skipThrough;
base.ThisExpression = base.Super = base.MetaProperty = ignore;
base.ArrayExpression = function (node, st, c) {
  for (var i = 0; i < node.elements.length; ++i) {
    var elt = node.elements[i];
    if (elt) c(elt, st, "Expression");
  }
};
base.ObjectExpression = function (node, st, c) {
  for (var i = 0; i < node.properties.length; ++i) {
    c(node.properties[i], st);
  }
};
base.FunctionExpression = base.ArrowFunctionExpression = base.FunctionDeclaration;
base.SequenceExpression = base.TemplateLiteral = function (node, st, c) {
  for (var i = 0; i < node.expressions.length; ++i) {
    c(node.expressions[i], st, "Expression");
  }
};
base.UnaryExpression = base.UpdateExpression = function (node, st, c) {
  c(node.argument, st, "Expression");
};
base.BinaryExpression = base.LogicalExpression = function (node, st, c) {
  c(node.left, st, "Expression");
  c(node.right, st, "Expression");
};
base.AssignmentExpression = base.AssignmentPattern = function (node, st, c) {
  c(node.left, st, "Pattern");
  c(node.right, st, "Expression");
};
base.ConditionalExpression = function (node, st, c) {
  c(node.test, st, "Expression");
  c(node.consequent, st, "Expression");
  c(node.alternate, st, "Expression");
};
base.NewExpression = base.CallExpression = function (node, st, c) {
  c(node.callee, st, "Expression");
  if (node.arguments) for (var i = 0; i < node.arguments.length; ++i) {
    c(node.arguments[i], st, "Expression");
  }
};
base.MemberExpression = function (node, st, c) {
  c(node.object, st, "Expression");
  if (node.computed) c(node.property, st, "Expression");
};
base.ExportNamedDeclaration = base.ExportDefaultDeclaration = function (node, st, c) {
  if (node.declaration) c(node.declaration, st);
};
base.ImportDeclaration = function (node, st, c) {
  for (var i = 0; i < node.specifiers.length; i++) {
    c(node.specifiers[i], st);
  }
};
base.ImportSpecifier = base.ImportDefaultSpecifier = base.ImportNamespaceSpecifier = base.Identifier = base.Literal = ignore;

base.TaggedTemplateExpression = function (node, st, c) {
  c(node.tag, st, "Expression");
  c(node.quasi, st);
};
base.ClassDeclaration = base.ClassExpression = function (node, st, c) {
  return c(node, st, "Class");
};
base.Class = function (node, st, c) {
  if (node.id) c(node.id, st, "Pattern");
  if (node.superClass) c(node.superClass, st, "Expression");
  for (var i = 0; i < node.body.body.length; i++) {
    c(node.body.body[i], st);
  }
};
base.MethodDefinition = base.Property = function (node, st, c) {
  if (node.computed) c(node.key, st, "Expression");
  c(node.value, st, "Expression");
};
base.ComprehensionExpression = function (node, st, c) {
  for (var i = 0; i < node.blocks.length; i++) {
    c(node.blocks[i].right, st, "Expression");
  }c(node.body, st, "Expression");
};

},{}]},{},[1])(1)
});
}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{}],17:[function(require,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],18:[function(require,module,exports){
// shim for using process in browser

var process = module.exports = {};
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = setTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            currentQueue[queueIndex].run();
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    clearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        setTimeout(drainQueue, 0);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

// TODO(shtylman)
process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],19:[function(require,module,exports){
module.exports = function isBuffer(arg) {
  return arg && typeof arg === 'object'
    && typeof arg.copy === 'function'
    && typeof arg.fill === 'function'
    && typeof arg.readUInt8 === 'function';
}
},{}],20:[function(require,module,exports){
(function (process,global){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var formatRegExp = /%[sdj%]/g;
exports.format = function(f) {
  if (!isString(f)) {
    var objects = [];
    for (var i = 0; i < arguments.length; i++) {
      objects.push(inspect(arguments[i]));
    }
    return objects.join(' ');
  }

  var i = 1;
  var args = arguments;
  var len = args.length;
  var str = String(f).replace(formatRegExp, function(x) {
    if (x === '%%') return '%';
    if (i >= len) return x;
    switch (x) {
      case '%s': return String(args[i++]);
      case '%d': return Number(args[i++]);
      case '%j':
        try {
          return JSON.stringify(args[i++]);
        } catch (_) {
          return '[Circular]';
        }
      default:
        return x;
    }
  });
  for (var x = args[i]; i < len; x = args[++i]) {
    if (isNull(x) || !isObject(x)) {
      str += ' ' + x;
    } else {
      str += ' ' + inspect(x);
    }
  }
  return str;
};


// Mark that a method should not be used.
// Returns a modified function which warns once by default.
// If --no-deprecation is set, then it is a no-op.
exports.deprecate = function(fn, msg) {
  // Allow for deprecating things in the process of starting up.
  if (isUndefined(global.process)) {
    return function() {
      return exports.deprecate(fn, msg).apply(this, arguments);
    };
  }

  if (process.noDeprecation === true) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (process.throwDeprecation) {
        throw new Error(msg);
      } else if (process.traceDeprecation) {
        console.trace(msg);
      } else {
        console.error(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
};


var debugs = {};
var debugEnviron;
exports.debuglog = function(set) {
  if (isUndefined(debugEnviron))
    debugEnviron = process.env.NODE_DEBUG || '';
  set = set.toUpperCase();
  if (!debugs[set]) {
    if (new RegExp('\\b' + set + '\\b', 'i').test(debugEnviron)) {
      var pid = process.pid;
      debugs[set] = function() {
        var msg = exports.format.apply(exports, arguments);
        console.error('%s %d: %s', set, pid, msg);
      };
    } else {
      debugs[set] = function() {};
    }
  }
  return debugs[set];
};


/**
 * Echos the value of a value. Trys to print the value out
 * in the best way possible given the different types.
 *
 * @param {Object} obj The object to print out.
 * @param {Object} opts Optional options object that alters the output.
 */
/* legacy: obj, showHidden, depth, colors*/
function inspect(obj, opts) {
  // default options
  var ctx = {
    seen: [],
    stylize: stylizeNoColor
  };
  // legacy...
  if (arguments.length >= 3) ctx.depth = arguments[2];
  if (arguments.length >= 4) ctx.colors = arguments[3];
  if (isBoolean(opts)) {
    // legacy...
    ctx.showHidden = opts;
  } else if (opts) {
    // got an "options" object
    exports._extend(ctx, opts);
  }
  // set default options
  if (isUndefined(ctx.showHidden)) ctx.showHidden = false;
  if (isUndefined(ctx.depth)) ctx.depth = 2;
  if (isUndefined(ctx.colors)) ctx.colors = false;
  if (isUndefined(ctx.customInspect)) ctx.customInspect = true;
  if (ctx.colors) ctx.stylize = stylizeWithColor;
  return formatValue(ctx, obj, ctx.depth);
}
exports.inspect = inspect;


// http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
inspect.colors = {
  'bold' : [1, 22],
  'italic' : [3, 23],
  'underline' : [4, 24],
  'inverse' : [7, 27],
  'white' : [37, 39],
  'grey' : [90, 39],
  'black' : [30, 39],
  'blue' : [34, 39],
  'cyan' : [36, 39],
  'green' : [32, 39],
  'magenta' : [35, 39],
  'red' : [31, 39],
  'yellow' : [33, 39]
};

// Don't use 'blue' not visible on cmd.exe
inspect.styles = {
  'special': 'cyan',
  'number': 'yellow',
  'boolean': 'yellow',
  'undefined': 'grey',
  'null': 'bold',
  'string': 'green',
  'date': 'magenta',
  // "name": intentionally not styling
  'regexp': 'red'
};


function stylizeWithColor(str, styleType) {
  var style = inspect.styles[styleType];

  if (style) {
    return '\u001b[' + inspect.colors[style][0] + 'm' + str +
           '\u001b[' + inspect.colors[style][1] + 'm';
  } else {
    return str;
  }
}


function stylizeNoColor(str, styleType) {
  return str;
}


function arrayToHash(array) {
  var hash = {};

  array.forEach(function(val, idx) {
    hash[val] = true;
  });

  return hash;
}


function formatValue(ctx, value, recurseTimes) {
  // Provide a hook for user-specified inspect functions.
  // Check that value is an object with an inspect function on it
  if (ctx.customInspect &&
      value &&
      isFunction(value.inspect) &&
      // Filter out the util module, it's inspect function is special
      value.inspect !== exports.inspect &&
      // Also filter out any prototype objects using the circular check.
      !(value.constructor && value.constructor.prototype === value)) {
    var ret = value.inspect(recurseTimes, ctx);
    if (!isString(ret)) {
      ret = formatValue(ctx, ret, recurseTimes);
    }
    return ret;
  }

  // Primitive types cannot have properties
  var primitive = formatPrimitive(ctx, value);
  if (primitive) {
    return primitive;
  }

  // Look up the keys of the object.
  var keys = Object.keys(value);
  var visibleKeys = arrayToHash(keys);

  if (ctx.showHidden) {
    keys = Object.getOwnPropertyNames(value);
  }

  // IE doesn't make error fields non-enumerable
  // http://msdn.microsoft.com/en-us/library/ie/dww52sbt(v=vs.94).aspx
  if (isError(value)
      && (keys.indexOf('message') >= 0 || keys.indexOf('description') >= 0)) {
    return formatError(value);
  }

  // Some type of object without properties can be shortcutted.
  if (keys.length === 0) {
    if (isFunction(value)) {
      var name = value.name ? ': ' + value.name : '';
      return ctx.stylize('[Function' + name + ']', 'special');
    }
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    }
    if (isDate(value)) {
      return ctx.stylize(Date.prototype.toString.call(value), 'date');
    }
    if (isError(value)) {
      return formatError(value);
    }
  }

  var base = '', array = false, braces = ['{', '}'];

  // Make Array say that they are Array
  if (isArray(value)) {
    array = true;
    braces = ['[', ']'];
  }

  // Make functions say that they are functions
  if (isFunction(value)) {
    var n = value.name ? ': ' + value.name : '';
    base = ' [Function' + n + ']';
  }

  // Make RegExps say that they are RegExps
  if (isRegExp(value)) {
    base = ' ' + RegExp.prototype.toString.call(value);
  }

  // Make dates with properties first say the date
  if (isDate(value)) {
    base = ' ' + Date.prototype.toUTCString.call(value);
  }

  // Make error with message first say the error
  if (isError(value)) {
    base = ' ' + formatError(value);
  }

  if (keys.length === 0 && (!array || value.length == 0)) {
    return braces[0] + base + braces[1];
  }

  if (recurseTimes < 0) {
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    } else {
      return ctx.stylize('[Object]', 'special');
    }
  }

  ctx.seen.push(value);

  var output;
  if (array) {
    output = formatArray(ctx, value, recurseTimes, visibleKeys, keys);
  } else {
    output = keys.map(function(key) {
      return formatProperty(ctx, value, recurseTimes, visibleKeys, key, array);
    });
  }

  ctx.seen.pop();

  return reduceToSingleString(output, base, braces);
}


function formatPrimitive(ctx, value) {
  if (isUndefined(value))
    return ctx.stylize('undefined', 'undefined');
  if (isString(value)) {
    var simple = '\'' + JSON.stringify(value).replace(/^"|"$/g, '')
                                             .replace(/'/g, "\\'")
                                             .replace(/\\"/g, '"') + '\'';
    return ctx.stylize(simple, 'string');
  }
  if (isNumber(value))
    return ctx.stylize('' + value, 'number');
  if (isBoolean(value))
    return ctx.stylize('' + value, 'boolean');
  // For some reason typeof null is "object", so special case here.
  if (isNull(value))
    return ctx.stylize('null', 'null');
}


function formatError(value) {
  return '[' + Error.prototype.toString.call(value) + ']';
}


function formatArray(ctx, value, recurseTimes, visibleKeys, keys) {
  var output = [];
  for (var i = 0, l = value.length; i < l; ++i) {
    if (hasOwnProperty(value, String(i))) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          String(i), true));
    } else {
      output.push('');
    }
  }
  keys.forEach(function(key) {
    if (!key.match(/^\d+$/)) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          key, true));
    }
  });
  return output;
}


function formatProperty(ctx, value, recurseTimes, visibleKeys, key, array) {
  var name, str, desc;
  desc = Object.getOwnPropertyDescriptor(value, key) || { value: value[key] };
  if (desc.get) {
    if (desc.set) {
      str = ctx.stylize('[Getter/Setter]', 'special');
    } else {
      str = ctx.stylize('[Getter]', 'special');
    }
  } else {
    if (desc.set) {
      str = ctx.stylize('[Setter]', 'special');
    }
  }
  if (!hasOwnProperty(visibleKeys, key)) {
    name = '[' + key + ']';
  }
  if (!str) {
    if (ctx.seen.indexOf(desc.value) < 0) {
      if (isNull(recurseTimes)) {
        str = formatValue(ctx, desc.value, null);
      } else {
        str = formatValue(ctx, desc.value, recurseTimes - 1);
      }
      if (str.indexOf('\n') > -1) {
        if (array) {
          str = str.split('\n').map(function(line) {
            return '  ' + line;
          }).join('\n').substr(2);
        } else {
          str = '\n' + str.split('\n').map(function(line) {
            return '   ' + line;
          }).join('\n');
        }
      }
    } else {
      str = ctx.stylize('[Circular]', 'special');
    }
  }
  if (isUndefined(name)) {
    if (array && key.match(/^\d+$/)) {
      return str;
    }
    name = JSON.stringify('' + key);
    if (name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)) {
      name = name.substr(1, name.length - 2);
      name = ctx.stylize(name, 'name');
    } else {
      name = name.replace(/'/g, "\\'")
                 .replace(/\\"/g, '"')
                 .replace(/(^"|"$)/g, "'");
      name = ctx.stylize(name, 'string');
    }
  }

  return name + ': ' + str;
}


function reduceToSingleString(output, base, braces) {
  var numLinesEst = 0;
  var length = output.reduce(function(prev, cur) {
    numLinesEst++;
    if (cur.indexOf('\n') >= 0) numLinesEst++;
    return prev + cur.replace(/\u001b\[\d\d?m/g, '').length + 1;
  }, 0);

  if (length > 60) {
    return braces[0] +
           (base === '' ? '' : base + '\n ') +
           ' ' +
           output.join(',\n  ') +
           ' ' +
           braces[1];
  }

  return braces[0] + base + ' ' + output.join(', ') + ' ' + braces[1];
}


// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.
function isArray(ar) {
  return Array.isArray(ar);
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return isObject(re) && objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return isObject(d) && objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return isObject(e) &&
      (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = require('./support/isBuffer');

function objectToString(o) {
  return Object.prototype.toString.call(o);
}


function pad(n) {
  return n < 10 ? '0' + n.toString(10) : n.toString(10);
}


var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'];

// 26 Feb 16:19:34
function timestamp() {
  var d = new Date();
  var time = [pad(d.getHours()),
              pad(d.getMinutes()),
              pad(d.getSeconds())].join(':');
  return [d.getDate(), months[d.getMonth()], time].join(' ');
}


// log is just a thin wrapper to console.log that prepends a timestamp
exports.log = function() {
  console.log('%s - %s', timestamp(), exports.format.apply(exports, arguments));
};


/**
 * Inherit the prototype methods from one constructor into another.
 *
 * The Function.prototype.inherits from lang.js rewritten as a standalone
 * function (not on Function.prototype). NOTE: If this file is to be loaded
 * during bootstrapping this function needs to be rewritten using some native
 * functions as prototype setup using normal JavaScript does not work as
 * expected during bootstrapping (see mirror.js in r114903).
 *
 * @param {function} ctor Constructor function which needs to inherit the
 *     prototype.
 * @param {function} superCtor Constructor function to inherit prototype from.
 */
exports.inherits = require('inherits');

exports._extend = function(origin, add) {
  // Don't do anything if add isn't an object
  if (!add || !isObject(add)) return origin;

  var keys = Object.keys(add);
  var i = keys.length;
  while (i--) {
    origin[keys[i]] = add[keys[i]];
  }
  return origin;
};

function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"./support/isBuffer":19,"_process":18,"inherits":17}]},{},[8])(8)
});
//# sourceMappingURL=data:application/json;charset:utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCIvaG9tZS9zd2tpbS9XZWJzdG9ybVByb2plY3RzL3lhdGVybi9saWIvYXV4LmpzIiwiL2hvbWUvc3draW0vV2Vic3Rvcm1Qcm9qZWN0cy95YXRlcm4vbGliL2NvbnN0cmFpbnQvY0dlbi5qcyIsIi9ob21lL3N3a2ltL1dlYnN0b3JtUHJvamVjdHMveWF0ZXJuL2xpYi9jb25zdHJhaW50L2NvbnN0cmFpbnRzLmpzIiwiL2hvbWUvc3draW0vV2Vic3Rvcm1Qcm9qZWN0cy95YXRlcm4vbGliL2RvbWFpbnMvY29udGV4dC5qcyIsIi9ob21lL3N3a2ltL1dlYnN0b3JtUHJvamVjdHMveWF0ZXJuL2xpYi9kb21haW5zL3N0YXR1cy5qcyIsIi9ob21lL3N3a2ltL1dlYnN0b3JtUHJvamVjdHMveWF0ZXJuL2xpYi9kb21haW5zL3R5cGVzLmpzIiwiL2hvbWUvc3draW0vV2Vic3Rvcm1Qcm9qZWN0cy95YXRlcm4vbGliL2dldFR5cGVEYXRhLmpzIiwiL2hvbWUvc3draW0vV2Vic3Rvcm1Qcm9qZWN0cy95YXRlcm4vbGliL2luZmVyLmpzIiwiL2hvbWUvc3draW0vV2Vic3Rvcm1Qcm9qZWN0cy95YXRlcm4vbGliL3JldE9jY3VyLmpzIiwiL2hvbWUvc3draW0vV2Vic3Rvcm1Qcm9qZWN0cy95YXRlcm4vbGliL3RoaXNPY2N1ci5qcyIsIi9ob21lL3N3a2ltL1dlYnN0b3JtUHJvamVjdHMveWF0ZXJuL2xpYi91dGlsL215V2Fsa2VyLmpzIiwiL2hvbWUvc3draW0vV2Vic3Rvcm1Qcm9qZWN0cy95YXRlcm4vbGliL3ZhckJsb2NrLmpzIiwiL2hvbWUvc3draW0vV2Vic3Rvcm1Qcm9qZWN0cy95YXRlcm4vbGliL3ZhcnJlZnMuanMiLCJub2RlX21vZHVsZXMvYWNvcm4vZGlzdC9hY29ybi5qcyIsIm5vZGVfbW9kdWxlcy9hY29ybi9kaXN0L2Fjb3JuX2xvb3NlLmpzIiwibm9kZV9tb2R1bGVzL2Fjb3JuL2Rpc3Qvd2Fsay5qcyIsIm5vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9pbmhlcml0cy9pbmhlcml0c19icm93c2VyLmpzIiwibm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3Byb2Nlc3MvYnJvd3Nlci5qcyIsIm5vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy91dGlsL3N1cHBvcnQvaXNCdWZmZXJCcm93c2VyLmpzIiwibm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3V0aWwvdXRpbC5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7O0FDQUEsSUFBSSxJQUFJLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDOztBQUUzQixTQUFTLFdBQVcsQ0FBQyxHQUFHLEVBQUUsUUFBUSxFQUFFO0FBQ2hDLFFBQUksUUFBUSxHQUFHLEVBQUUsQ0FBQzs7QUFFbEIsUUFBSSxHQUFHLEdBQUcsUUFBUSxLQUFLLFNBQVMsR0FBRyxDQUFDLEdBQUcsUUFBUSxDQUFDOztBQUVoRCxhQUFTLFFBQVEsQ0FBQyxJQUFJLEVBQUU7QUFDcEIsWUFBSSxDQUFDLFFBQVEsQ0FBQyxHQUFHLEdBQUcsQ0FBQztBQUNyQixnQkFBUSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUNwQixXQUFHLEVBQUUsQ0FBQztLQUNUOzs7QUFHRCxhQUFTLGlCQUFpQixDQUFDLElBQUksRUFBRTtBQUM3QixZQUFJLElBQUksSUFBSSxJQUFJLENBQUMsY0FBYyxDQUFDLE1BQU0sQ0FBQyxFQUFFO0FBQ3JDLG9CQUFRLENBQUMsSUFBSSxDQUFDLENBQUM7U0FDbEI7QUFDRCxZQUFJLElBQUksSUFBSSxPQUFPLElBQUksS0FBSyxRQUFRLEVBQUU7QUFDbEMsaUJBQUssSUFBSSxDQUFDLElBQUksSUFBSSxFQUFFO0FBQ2hCLGlDQUFpQixDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO2FB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QTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7OztBQ2p2R0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7QUN6dERBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDalhBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDMUZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDTEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt2YXIgZj1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpO3Rocm93IGYuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixmfXZhciBsPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChsLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGwsbC5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkiLCJ2YXIgdXRpbCA9IHJlcXVpcmUoJ3V0aWwnKTtcblxuZnVuY3Rpb24gZ2V0Tm9kZUxpc3QoYXN0LCBzdGFydE51bSkge1xuICAgIHZhciBub2RlTGlzdCA9IFtdO1xuXG4gICAgdmFyIG51bSA9IHN0YXJ0TnVtID09PSB1bmRlZmluZWQgPyAwIDogc3RhcnROdW07XG5cbiAgICBmdW5jdGlvbiBhc3NpZ25JZChub2RlKSB7XG4gICAgICAgIG5vZGVbJ0BsYWJlbCddID0gbnVtO1xuICAgICAgICBub2RlTGlzdC5wdXNoKG5vZGUpO1xuICAgICAgICBudW0rKztcbiAgICB9XG5cbiAgICAvLyBMYWJlbCBldmVyeSBBU1Qgbm9kZSB3aXRoIHByb3BlcnR5ICd0eXBlJ1xuICAgIGZ1bmN0aW9uIGxhYmVsTm9kZVdpdGhUeXBlKG5vZGUpIHtcbiAgICAgICAgaWYgKG5vZGUgJiYgbm9kZS5oYXNPd25Qcm9wZXJ0eSgndHlwZScpKSB7XG4gICAgICAgICAgICBhc3NpZ25JZChub2RlKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAobm9kZSAmJiB0eXBlb2Ygbm9kZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIGZvciAodmFyIHAgaW4gbm9kZSkge1xuICAgICAgICAgICAgICAgIGxhYmVsTm9kZVdpdGhUeXBlKG5vZGVbcF0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgbGFiZWxOb2RlV2l0aFR5cGUoYXN0KTtcblxuICAgIHJldHVybiBub2RlTGlzdDtcbn1cblxuZnVuY3Rpb24gc2hvd1VuZm9sZGVkKG9iaikge1xuICAgIGNvbnNvbGUubG9nKHV0aWwuaW5zcGVjdChvYmosIHtkZXB0aDogbnVsbH0pKTtcbn1cblxuZXhwb3J0cy5nZXROb2RlTGlzdCA9IGdldE5vZGVMaXN0O1xuZXhwb3J0cy5zaG93VW5mb2xkZWQgPSBzaG93VW5mb2xkZWQ7XG4iLCIndXNlIHN0cmljdCc7XG5cbmNvbnN0IHR5cGVzID0gcmVxdWlyZSgnLi4vZG9tYWlucy90eXBlcycpO1xuY29uc3Qgd2FsayA9IHJlcXVpcmUoJ2Fjb3JuL2Rpc3Qvd2FsaycpO1xuY29uc3Qgc3RhdHVzID0gcmVxdWlyZSgnLi4vZG9tYWlucy9zdGF0dXMnKTtcbmNvbnN0IGNzdHIgPSByZXF1aXJlKCcuL2NvbnN0cmFpbnRzJyk7XG5cbi8vIGFyZ3VtZW50cyBhcmUgXCIgb2xkU3RhdHVzICgsIG5hbWUsIHZhbCkqIFwiXG5mdW5jdGlvbiBjaGFuZ2VkU3RhdHVzKG9sZFN0YXR1cykge1xuICAgIGNvbnN0IG5ld1N0YXR1cyA9IG5ldyBzdGF0dXMuU3RhdHVzO1xuICAgIGZvciAobGV0IGkgPSAxOyBpIDwgYXJndW1lbnRzLmxlbmd0aDsgaSA9IGkgKyAyKVxuICAgICAgICBuZXdTdGF0dXNbYXJndW1lbnRzW2ldXSA9IGFyZ3VtZW50c1tpKzFdO1xuXG4gICAgZm9yIChsZXQgcCBpbiBvbGRTdGF0dXMpIHtcbiAgICAgICAgaWYgKG5ld1N0YXR1c1twXSA9PT0gdW5kZWZpbmVkKVxuICAgICAgICAgICAgbmV3U3RhdHVzW3BdID0gb2xkU3RhdHVzW3BdO1xuICAgIH1cbiAgICByZXR1cm4gbmV3U3RhdHVzO1xufVxuXG4vLyByZXR1cm5zIFthY2Nlc3MgdHlwZSwgcHJvcCB2YWx1ZV1cbmZ1bmN0aW9uIHByb3BBY2Nlc3Mobm9kZSkge1xuICAgIGNvbnN0IHByb3AgPSBub2RlLnByb3BlcnR5O1xuICAgIGlmICghbm9kZS5jb21wdXRlZCkge1xuICAgICAgICByZXR1cm4gWydkb3RBY2Nlc3MnLCBwcm9wLm5hbWVdO1xuICAgIH1cbiAgICBpZiAocHJvcC50eXBlID09PSAnTGl0ZXJhbCcpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBwcm9wLnZhbHVlID09PSAnc3RyaW5nJylcbiAgICAgICAgICAgIHJldHVybiBbJ3N0cmluZ0xpdGVyYWwnLCBwcm9wLnZhbHVlXTtcbiAgICAgICAgaWYgKHR5cGVvZiBwcm9wLnZhbHVlID09PSAnbnVtYmVyJylcbiAgICAgICAgICAgIC8vIGNvbnZlcnQgbnVtYmVyIHRvIHN0cmluZ1xuICAgICAgICAgICAgcmV0dXJuIFsnbnVtYmVyTGl0ZXJhbCcsIHByb3AudmFsdWUgKyAnJ107XG4gICAgfVxuICAgIHJldHVybiBbXCJjb21wdXRlZFwiLCBudWxsXTtcbn1cblxuZnVuY3Rpb24gdW5vcFJlc3VsdFR5cGUob3ApIHtcbiAgICBzd2l0Y2ggKG9wKSB7XG4gICAgICAgIGNhc2UgJysnOiBjYXNlICctJzogY2FzZSAnfic6XG4gICAgICAgICAgICByZXR1cm4gdHlwZXMuUHJpbU51bWJlcjtcbiAgICAgICAgY2FzZSAnISc6XG4gICAgICAgICAgICByZXR1cm4gdHlwZXMuUHJpbUJvb2xlYW47XG4gICAgICAgIGNhc2UgJ3R5cGVvZic6XG4gICAgICAgICAgICByZXR1cm4gdHlwZXMuUHJpbVN0cmluZztcbiAgICAgICAgY2FzZSAndm9pZCc6IGNhc2UgJ2RlbGV0ZSc6XG4gICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGJpbm9wSXNCb29sZWFuKG9wKSB7XG4gICAgc3dpdGNoIChvcCkge1xuICAgICAgICBjYXNlICc9PSc6IGNhc2UgJyE9JzogY2FzZSAnPT09JzogY2FzZSAnIT09JzpcbiAgICAgICAgY2FzZSAnPCc6IGNhc2UgJz4nOiBjYXNlICc+PSc6IGNhc2UgJzw9JzpcbiAgICAgICAgY2FzZSAnaW4nOiBjYXNlICdpbnN0YW5jZW9mJzpcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG59XG5cbi8vIFRvIHByZXZlbnQgcmVjdXJzaW9uLFxuLy8gd2UgcmVtZW1iZXIgdGhlIHN0YXR1cyB1c2VkIGluIGFkZENvbnN0cmFpbnRzXG5jb25zdCB2aXNpdGVkU3RhdHVzID0gW107XG5jb25zdCBjb25zdHJhaW50cyA9IFtdO1xuZnVuY3Rpb24gY2xlYXJDb25zdHJhaW50cygpIHtcbiAgICB2aXNpdGVkU3RhdHVzLmxlbmd0aCA9IDA7XG4gICAgY29uc3RyYWludHMubGVuZ3RoID0gMDtcbn1cblxubGV0IHJ0Q1g7XG5mdW5jdGlvbiBhZGRDb25zdHJhaW50cyhhc3QsIGluaXRTdGF0dXMsIG5ld1J0Q1gpIHtcblxuICAgIC8vIHNldCBydENYXG4gICAgcnRDWCA9IG5ld1J0Q1ggfHwgcnRDWDtcbiAgICBjb25zdCDEiCA9IHJ0Q1guxIg7XG5cbiAgICAvLyBDaGVjayB3aGV0aGVyIHdlIGhhdmUgcHJvY2Vzc2VkICdpbml0U3RhdHVzJyBiZWZvcmVcbiAgICBmb3IgKGxldCBpPTA7IGkgPCB2aXNpdGVkU3RhdHVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGlmIChpbml0U3RhdHVzLmVxdWFscyh2aXNpdGVkU3RhdHVzW2ldKSkge1xuICAgICAgICAgICAgIC8vIElmIHNvLCBkbyBub3RoaW5nXG4gICAgICAgICAgICAgLy8gc2lnbmlmeWluZyB3ZSBkaWRuJ3QgYWRkIGNvbnN0cmFpbnRzXG4gICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgfVxuICAgIH1cbiAgICAvLyBJZiB0aGUgaW5pdFN0YXR1cyBpcyBuZXcsIHB1c2ggaXQuXG4gICAgLy8gV2UgZG8gbm90IHJlY29yZCBhc3Qgc2luY2UgYXN0IG5vZGUgZGVwZW5kcyBvbiB0aGUgc3RhdHVzXG4gICAgdmlzaXRlZFN0YXR1cy5wdXNoKGluaXRTdGF0dXMpO1xuXG4gICAgZnVuY3Rpb24gcmVhZE1lbWJlcihub2RlLCBjdXJTdGF0dXMsIGMpIHtcbiAgICAgICAgY29uc3QgcmV0ID0gxIguZ2V0KG5vZGUsIGN1clN0YXR1cy5kZWx0YSk7XG4gICAgICAgIGNvbnN0IG9iakFWYWwgPSBjKG5vZGUub2JqZWN0LCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgIGlmIChub2RlLnByb3BlcnR5LnR5cGUgIT09ICdJZGVudGlmaWVyJykge1xuICAgICAgICAgICAgLy8gcmV0dXJuIGZyb20gcHJvcGVydHkgaXMgaWdub3JlZFxuICAgICAgICAgICAgYyhub2RlLnByb3BlcnR5LCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgWywgcHJvcE5hbWVdID0gcHJvcEFjY2Vzcyhub2RlKTtcblxuICAgICAgICBjb25zdHJhaW50cy5wdXNoKHtPQko6IG9iakFWYWwsXG4gICAgICAgICAgICBQUk9QOiBwcm9wTmFtZSxcbiAgICAgICAgICAgIFJFQURfVE86IHJldH0pO1xuICAgICAgICBvYmpBVmFsLnByb3BhZ2F0ZShuZXcgY3N0ci5SZWFkUHJvcChwcm9wTmFtZSwgcmV0KSk7XG5cbiAgICAgICAgLy8gcmV0dXJucyBBVmFsIGZvciByZWNlaXZlciBhbmQgcmVhZCBtZW1iZXJcbiAgICAgICAgcmV0dXJuIFtvYmpBVmFsLCByZXRdO1xuICAgIH1cblxuICAgIC8vIGNvbnN0cmFpbnQgZ2VuZXJhdGluZyB3YWxrZXIgZm9yIGV4cHJlc3Npb25zXG4gICAgY29uc3QgY29uc3RyYWludEdlbmVyYXRvciA9IHdhbGsubWFrZSh7XG5cbiAgICAgICAgSWRlbnRpZmllcjogZnVuY3Rpb24gKG5vZGUsIGN1clN0YXR1cywgYykge1xuICAgICAgICAgICAgY29uc3QgYXYgPSBjdXJTdGF0dXMuc2MuZ2V0QVZhbE9mKG5vZGUubmFtZSk7XG4gICAgICAgICAgICAvLyB1c2UgYXZhbCBpbiB0aGUgc2NvcGVcbiAgICAgICAgICAgIMSILnNldChub2RlLCBjdXJTdGF0dXMuZGVsdGEsIGF2KTtcbiAgICAgICAgICAgIHJldHVybiBhdjtcbiAgICAgICAgfSxcblxuICAgICAgICBUaGlzRXhwcmVzc2lvbjogZnVuY3Rpb24gKG5vZGUsIGN1clN0YXR1cywgYykge1xuICAgICAgICAgICAgY29uc3QgYXYgPSBjdXJTdGF0dXMuc2VsZjtcbiAgICAgICAgICAgIC8vIHVzZSBhdmFsIGZvciAndGhpcydcbiAgICAgICAgICAgIMSILnNldChub2RlLCBjdXJTdGF0dXMuZGVsdGEsIGF2KTtcbiAgICAgICAgICAgIHJldHVybiBhdjtcbiAgICAgICAgfSxcblxuICAgICAgICBMaXRlcmFsOiBmdW5jdGlvbiAobm9kZSwgY3VyU3RhdHVzLCBjKSB7XG4gICAgICAgICAgICBjb25zdCByZXMgPSDEiC5nZXQobm9kZSwgY3VyU3RhdHVzLmRlbHRhKTtcbiAgICAgICAgICAgIGlmIChub2RlLnJlZ2V4KSB7XG4gICAgICAgICAgICAgICAgLy8gbm90IGltcGxlbWVudGVkIHlldFxuICAgICAgICAgICAgICAgIC8vIHRocm93IG5ldyBFcnJvcigncmVnZXggbGl0ZXJhbCBpcyBub3QgaW1wbGVtZW50ZWQgeWV0Jyk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlcztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHN3aXRjaCAodHlwZW9mIG5vZGUudmFsdWUpIHtcbiAgICAgICAgICAgIGNhc2UgJ251bWJlcic6XG4gICAgICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7VFlQRTogdHlwZXMuUHJpbU51bWJlcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBJTkNMX1NFVDogcmVzfSk7XG4gICAgICAgICAgICAgICAgcmVzLmFkZFR5cGUodHlwZXMuUHJpbU51bWJlcik7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICBjYXNlICdzdHJpbmcnOlxuICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLnB1c2goe1RZUEU6IHR5cGVzLlByaW1TdHJpbmcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgSU5DTF9TRVQ6IHJlc30pO1xuICAgICAgICAgICAgICAgIHJlcy5hZGRUeXBlKHR5cGVzLlByaW1TdHJpbmcpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgY2FzZSAnYm9vbGVhbic6XG4gICAgICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7VFlQRTogdHlwZXMuUHJpbUJvb2xlYW4sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgSU5DTF9TRVQ6IHJlc30pO1xuICAgICAgICAgICAgICAgIHJlcy5hZGRUeXBlKHR5cGVzLlByaW1Cb29sZWFuKTtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIGNhc2UgJ29iamVjdCc6XG4gICAgICAgICAgICAgICAgLy8gSSBndWVzczogTGl0ZXJhbCAmJiBvYmplY3QgPT0+IG5vZGUudmFsdWUgPT0gbnVsbFxuICAgICAgICAgICAgICAgIC8vIG51bGwgaXMgaWdub3JlZCwgc28gbm90aGluZyB0byBhZGRcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIGNhc2UgJ2Z1bmN0aW9uJzpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0kgZ3Vlc3MgZnVuY3Rpb24gaXMgaW1wb3NzaWJsZSBoZXJlLicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHJlcztcbiAgICAgICAgfSxcblxuICAgICAgICBBc3NpZ25tZW50RXhwcmVzc2lvbjogZnVuY3Rpb24gKG5vZGUsIGN1clN0YXR1cywgYykge1xuICAgICAgICAgICAgY29uc3QgcmhzQVZhbCA9IGMobm9kZS5yaWdodCwgY3VyU3RhdHVzLCB1bmRlZmluZWQpO1xuICAgICAgICAgICAgaWYgKG5vZGUubGVmdC50eXBlID09PSAnSWRlbnRpZmllcicpIHtcbiAgICAgICAgICAgICAgICAvLyBMSFMgaXMgYSBzaW1wbGUgdmFyaWFibGUuXG4gICAgICAgICAgICAgICAgY29uc3QgdmFyTmFtZSA9IG5vZGUubGVmdC5uYW1lO1xuICAgICAgICAgICAgICAgIGNvbnN0IGxoc0FWYWwgPSBjdXJTdGF0dXMuc2MuZ2V0QVZhbE9mKHZhck5hbWUpO1xuICAgICAgICAgICAgICAgIC8vIGxocyBpcyBub3QgdmlzaXRlZC4gTmVlZCB0byBoYW5kbGUgaGVyZS5cbiAgICAgICAgICAgICAgICAvLyBVc2UgYXZhbCBmb3VuZCBpbiB0aGUgc2NvcGUgZm9yIGxoc1xuICAgICAgICAgICAgICAgIMSILnNldChub2RlLmxlZnQsIGN1clN0YXR1cy5kZWx0YSwgbGhzQVZhbCk7XG5cbiAgICAgICAgICAgICAgICBpZiAobm9kZS5vcGVyYXRvciA9PT0gJz0nKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIHNpbXBsZSBhc3NpZ25tZW50XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLnB1c2goe1xuICAgICAgICAgICAgICAgICAgICAgICAgRlJPTTogcmhzQVZhbCxcbiAgICAgICAgICAgICAgICAgICAgICAgIFRPOiBsaHNBVmFsXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICByaHNBVmFsLnByb3BhZ2F0ZShsaHNBVmFsKTtcbiAgICAgICAgICAgICAgICAgICAgLy8gbm9kZSdzIEFWYWwgZnJvbSBSSFNcbiAgICAgICAgICAgICAgICAgICAgxIguc2V0KG5vZGUsIGN1clN0YXR1cy5kZWx0YSwgcmhzQVZhbCk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiByaHNBVmFsO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAvLyB1cGRhdGluZyBhc3NpZ25tZW50XG4gICAgICAgICAgICAgICAgY29uc3QgcmVzQVZhbCA9IMSILmdldChub2RlLCBjdXJTdGF0dXMuZGVsdGEpO1xuICAgICAgICAgICAgICAgIGlmIChub2RlLm9wZXJhdG9yID09PSAnKz0nKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGNvbmNhdGVuYXRpbmcgdXBkYXRlXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLnB1c2goe1xuICAgICAgICAgICAgICAgICAgICAgICAgQUREX09QUkQxOiBsaHNBVmFsLFxuICAgICAgICAgICAgICAgICAgICAgICAgQUREX09QUkQyOiByaHNBVmFsLFxuICAgICAgICAgICAgICAgICAgICAgICAgUkVTVUxUOiByZXNBVmFsXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICBsaHNBVmFsLnByb3BhZ2F0ZShuZXcgY3N0ci5Jc0FkZGVkKHJoc0FWYWwsIHJlc0FWYWwpKTtcbiAgICAgICAgICAgICAgICAgICAgcmhzQVZhbC5wcm9wYWdhdGUobmV3IGNzdHIuSXNBZGRlZChsaHNBVmFsLCByZXNBVmFsKSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gYXJpdGhtZXRpYyB1cGRhdGVcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7XG4gICAgICAgICAgICAgICAgICAgICAgICBUWVBFOnR5cGVzLlByaW1OdW1iZXIsXG4gICAgICAgICAgICAgICAgICAgICAgICBJTkNMX1NFVDogcmVzQVZhbFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgcmVzQVZhbC5hZGRUeXBlKHR5cGVzLlByaW1OdW1iZXIpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzQVZhbDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAobm9kZS5sZWZ0LnR5cGUgPT09ICdNZW1iZXJFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgICAgIGNvbnN0IG9iakFWYWwgPSBjKG5vZGUubGVmdC5vYmplY3QsIGN1clN0YXR1cywgdW5kZWZpbmVkKTtcbiAgICAgICAgICAgICAgICBjb25zdCBbYWNjVHlwZSwgcHJvcE5hbWVdID0gcHJvcEFjY2Vzcyhub2RlLmxlZnQpO1xuICAgICAgICAgICAgICAgIGlmIChub2RlLm9wZXJhdG9yID09PSAnPScpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gYXNzaWdubWVudCB0byBtZW1iZXJcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7XG4gICAgICAgICAgICAgICAgICAgICAgICBPQko6IG9iakFWYWwsXG4gICAgICAgICAgICAgICAgICAgICAgICBQUk9QOiBwcm9wTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIFdSSVRFX1dJVEg6IHJoc0FWYWxcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIG9iakFWYWwucHJvcGFnYXRlKG5ldyBjc3RyLldyaXRlUHJvcChwcm9wTmFtZSwgcmhzQVZhbCkpO1xuICAgICAgICAgICAgICAgICAgICAvLyBpZiBwcm9wZXJ0eSBpcyBudW1iZXIgbGl0ZXJhbCwgYWxzbyB3cml0ZSB0byAndW5rbm93bidcbiAgICAgICAgICAgICAgICAgICAgaWYgKGFjY1R5cGUgPT09ICdudW1iZXJMaXRlcmFsJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgb2JqQVZhbC5wcm9wYWdhdGUobmV3IGNzdHIuV3JpdGVQcm9wKG51bGwsIHJoc0FWYWwpKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAvLyBub2RlJ3MgQVZhbCBmcm9tIFJIU1xuICAgICAgICAgICAgICAgICAgICDEiC5zZXQobm9kZSwgY3VyU3RhdHVzLmRlbHRhLCByaHNBVmFsKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJoc0FWYWw7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIC8vIHVwZGF0aW5nIGFzc2lnbm1lbnRcbiAgICAgICAgICAgICAgICBjb25zdCByZXNBVmFsID0gxIguZ2V0KG5vZGUsIGN1clN0YXR1cy5kZWx0YSk7XG4gICAgICAgICAgICAgICAgY29uc3QgWywgcmV0QVZhbF0gPSByZWFkTWVtYmVyKG5vZGUubGVmdCwgY3VyU3RhdHVzLCBjKTtcbiAgICAgICAgICAgICAgICBpZiAobm9kZS5vcGVyYXRvciA9PT0gJys9Jykge1xuICAgICAgICAgICAgICAgICAgICAvLyBjb25jYXRlbmF0aW5nIHVwZGF0ZVxuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5wdXNoKHtcbiAgICAgICAgICAgICAgICAgICAgICAgIEFERF9PUFJEMTogcmV0QVZhbCxcbiAgICAgICAgICAgICAgICAgICAgICAgIEFERF9PUFJEMjogcmhzQVZhbCxcbiAgICAgICAgICAgICAgICAgICAgICAgIFJFU1VMVDogcmVzQVZhbFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgcmV0QVZhbC5wcm9wYWdhdGUobmV3IGNzdHIuSXNBZGRlZChyaHNBVmFsLCByZXNBVmFsKSk7XG4gICAgICAgICAgICAgICAgICAgIHJoc0FWYWwucHJvcGFnYXRlKG5ldyBjc3RyLklzQWRkZWQocmV0QVZhbCwgcmVzQVZhbCkpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGFyaXRobWV0aWMgdXBkYXRlXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLnB1c2goe1xuICAgICAgICAgICAgICAgICAgICAgICAgVFlQRTogdHlwZXMuUHJpbU51bWJlcixcbiAgICAgICAgICAgICAgICAgICAgICAgIElOQ0xfU0VUOiByZXNBVmFsXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICByZXNBVmFsLmFkZFR5cGUodHlwZXMuUHJpbU51bWJlcik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiByZXNBVmFsO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmluZm8oJ0Fzc2lnbm1lbnQgdXNpbmcgcGF0dGVybiBpcyBub3QgaW1wbGVtZW50ZWQnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBWYXJpYWJsZURlY2xhcmF0aW9uOiBmdW5jdGlvbiAobm9kZSwgY3VyU3RhdHVzLCBjKSB7XG4gICAgICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IG5vZGUuZGVjbGFyYXRpb25zLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgZGVjbCA9IG5vZGUuZGVjbGFyYXRpb25zW2ldO1xuICAgICAgICAgICAgICAgIGNvbnN0IGxoc0FWYWwgPSBjdXJTdGF0dXMuc2MuZ2V0QVZhbE9mKGRlY2wuaWQubmFtZSk7XG4gICAgICAgICAgICAgICAgLy8gZGVjbGFyZWQgdmFyIG5vZGUgaXMgJ2lkJ1xuICAgICAgICAgICAgICAgIMSILnNldChkZWNsLmlkLCBjdXJTdGF0dXMuZGVsdGEsIGxoc0FWYWwpO1xuICAgICAgICAgICAgICAgIGlmIChkZWNsLmluaXQpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcmhzQVZhbCA9IGMoZGVjbC5pbml0LCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgICAgICAgICAgICAgIMSILnNldChkZWNsLmluaXQsIGN1clN0YXR1cy5kZWx0YSwgcmhzQVZhbCk7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLnB1c2goe0ZST006IHJoc0FWYWwsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFRPOiBsaHNBVmFsfSk7XG4gICAgICAgICAgICAgICAgICAgIHJoc0FWYWwucHJvcGFnYXRlKGxoc0FWYWwpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBMb2dpY2FsRXhwcmVzc2lvbjogZnVuY3Rpb24gKG5vZGUsIGN1clN0YXR1cywgYykge1xuICAgICAgICAgICAgY29uc3QgcmVzID0gxIguZ2V0KG5vZGUsIGN1clN0YXR1cy5kZWx0YSk7XG4gICAgICAgICAgICBjb25zdCBsZWZ0ID0gYyhub2RlLmxlZnQsIGN1clN0YXR1cywgdW5kZWZpbmVkKTtcbiAgICAgICAgICAgIGNvbnN0IHJpZ2h0ID0gYyhub2RlLnJpZ2h0LCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgICAgICBjb25zdHJhaW50cy5wdXNoKHtGUk9NOiBsZWZ0LCBUTzogcmVzfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAge0ZST006IHJpZ2h0LCBUTzogcmVzfSk7XG4gICAgICAgICAgICBsZWZ0LnByb3BhZ2F0ZShyZXMpO1xuICAgICAgICAgICAgcmlnaHQucHJvcGFnYXRlKHJlcyk7XG4gICAgICAgICAgICByZXR1cm4gcmVzO1xuICAgICAgICB9LFxuXG4gICAgICAgIENvbmRpdGlvbmFsRXhwcmVzc2lvbjogZnVuY3Rpb24gKG5vZGUsIGN1clN0YXR1cywgYykge1xuICAgICAgICAgICAgY29uc3QgcmVzID0gxIguZ2V0KG5vZGUsIGN1clN0YXR1cy5kZWx0YSk7XG4gICAgICAgICAgICBjKG5vZGUudGVzdCwgY3VyU3RhdHVzLCB1bmRlZmluZWQpO1xuICAgICAgICAgICAgY29uc3QgY29ucyA9IGMobm9kZS5jb25zZXF1ZW50LCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgICAgICBjb25zdCBhbHQgPSBjKG5vZGUuYWx0ZXJuYXRlLCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgICAgICBjb25zdHJhaW50cy5wdXNoKHtGUk9NOiBjb25zLCBUTzogcmVzfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAge0ZST006IGFsdCwgVE86IHJlc30pO1xuICAgICAgICAgICAgY29ucy5wcm9wYWdhdGUocmVzKTtcbiAgICAgICAgICAgIGFsdC5wcm9wYWdhdGUocmVzKTtcbiAgICAgICAgICAgIHJldHVybiByZXM7XG4gICAgICAgIH0sXG5cbiAgICAgICAgTmV3RXhwcmVzc2lvbjogZnVuY3Rpb24gKG5vZGUsIGN1clN0YXR1cywgYykge1xuICAgICAgICAgICAgY29uc3QgcmV0ID0gxIguZ2V0KG5vZGUsIGN1clN0YXR1cy5kZWx0YSk7XG4gICAgICAgICAgICBjb25zdCBjYWxsZWUgPSBjKG5vZGUuY2FsbGVlLCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgICAgICBjb25zdCBhcmdzID0gW107XG4gICAgICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IG5vZGUuYXJndW1lbnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICAgICAgYXJncy5wdXNoKGMobm9kZS5hcmd1bWVudHNbaV0sIGN1clN0YXR1cywgdW5kZWZpbmVkKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBuZXdEZWx0YSA9IGN1clN0YXR1cy5kZWx0YS5hcHBlbmRPbmUobm9kZVsnQGxhYmVsJ10pO1xuICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7Q09OU1RSVUNUT1I6IGNhbGxlZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIEFSR1M6IGFyZ3MsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBSRVQ6IHJldCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIEVYQzogY3VyU3RhdHVzLmV4YyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIERFTFRBOiBuZXdEZWx0YX0pO1xuICAgICAgICAgICAgY2FsbGVlLnByb3BhZ2F0ZShcbiAgICAgICAgICAgICAgICBuZXcgY3N0ci5Jc0N0b3IoXG4gICAgICAgICAgICAgICAgICAgIGFyZ3MsXG4gICAgICAgICAgICAgICAgICAgIHJldCxcbiAgICAgICAgICAgICAgICAgICAgY3VyU3RhdHVzLmV4YyxcbiAgICAgICAgICAgICAgICAgICAgbmV3RGVsdGEpKTtcbiAgICAgICAgICAgIHJldHVybiByZXQ7XG4gICAgICAgIH0sXG5cbiAgICAgICAgQXJyYXlFeHByZXNzaW9uOiBmdW5jdGlvbiAobm9kZSwgY3VyU3RhdHVzLCBjKSB7XG4gICAgICAgICAgICBjb25zdCByZXQgPSDEiC5nZXQobm9kZSwgY3VyU3RhdHVzLmRlbHRhKTtcbiAgICAgICAgICAgIC8vIE5PVEUgcHJvdG90eXBlIG9iamVjdCBpcyBub3QgcmVjb3JkZWQgaW4gxIhcbiAgICAgICAgICAgIGNvbnN0IGFyclR5cGUgPSBuZXcgdHlwZXMuQXJyVHlwZShuZXcgdHlwZXMuQVZhbChydENYLnByb3Rvcy5BcnJheSkpO1xuICAgICAgICAgICAgLy8gYWRkIGxlbmd0aCBwcm9wZXJ0eVxuICAgICAgICAgICAgYXJyVHlwZS5nZXRQcm9wKCdsZW5ndGgnKS5hZGRUeXBlKHR5cGVzLlByaW1OdW1iZXIpO1xuXG4gICAgICAgICAgICBjb25zdHJhaW50cy5wdXNoKHtUWVBFOiBhcnJUeXBlLCBJTkNMX1NFVDogcmV0fSk7XG4gICAgICAgICAgICByZXQuYWRkVHlwZShhcnJUeXBlKTtcblxuICAgICAgICAgICAgLy8gYWRkIGFycmF5IGVsZW1lbnRzXG4gICAgICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IG5vZGUuZWxlbWVudHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgICAgICBjb25zdCBlbHRBVmFsID0gYyhub2RlLmVsZW1lbnRzW2ldLCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG5cbiAgICAgICAgICAgICAgICBjb25zdCBwcm9wID0gaSArICcnO1xuICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLnB1c2goe09CSjogcmV0LCBQUk9QOiBwcm9wLCBBVkFMOiBlbHRBVmFsfSk7XG4gICAgICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7T0JKOiByZXQsIFBST1A6IG51bGwsIEFWQUw6IGVsdEFWYWx9KTtcbiAgICAgICAgICAgICAgICByZXQucHJvcGFnYXRlKG5ldyBjc3RyLldyaXRlUHJvcChwcm9wLCBlbHRBVmFsKSk7XG4gICAgICAgICAgICAgICAgcmV0LnByb3BhZ2F0ZShuZXcgY3N0ci5Xcml0ZVByb3AobnVsbCwgZWx0QVZhbCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHJldDtcbiAgICAgICAgfSxcblxuICAgICAgICBPYmplY3RFeHByZXNzaW9uOiBmdW5jdGlvbiAobm9kZSwgY3VyU3RhdHVzLCBjKSB7XG4gICAgICAgICAgICBjb25zdCByZXQgPSDEiC5nZXQobm9kZSwgY3VyU3RhdHVzLmRlbHRhKTtcbiAgICAgICAgICAgIC8vIE5PVEUgcHJvdG90eXBlIG9iamVjdCBpcyBub3QgcmVjb3JkZWQgaW4gxIhcbiAgICAgICAgICAgIGNvbnN0IG9ialR5cGUgPSBuZXcgdHlwZXMuT2JqVHlwZShuZXcgdHlwZXMuQVZhbChydENYLnByb3Rvcy5PYmplY3QpKTtcbiAgICAgICAgICAgIGNvbnN0cmFpbnRzLnB1c2goe1RZUEU6IG9ialR5cGUsIElOQ0xfU0VUOiByZXR9KTtcbiAgICAgICAgICAgIHJldC5hZGRUeXBlKG9ialR5cGUpO1xuXG4gICAgICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IG5vZGUucHJvcGVydGllcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgICAgIGNvbnN0IHByb3BQYWlyID0gbm9kZS5wcm9wZXJ0aWVzW2ldO1xuICAgICAgICAgICAgICAgIGNvbnN0IHByb3BLZXkgPSBwcm9wUGFpci5rZXk7XG4gICAgICAgICAgICAgICAgbGV0IG5hbWU7XG4gICAgICAgICAgICAgICAgY29uc3QgcHJvcEV4cHIgPSBwcm9wUGFpci52YWx1ZTtcblxuICAgICAgICAgICAgICAgIGNvbnN0IGZsZEFWYWwgPSBjKHByb3BFeHByLCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG5cbiAgICAgICAgICAgICAgICBpZiAocHJvcEtleS50eXBlID09PSAnSWRlbnRpZmllcicpIHtcbiAgICAgICAgICAgICAgICAgICAgbmFtZSA9IHByb3BLZXkubmFtZTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiBwcm9wS2V5LnZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICBuYW1lID0gcHJvcEtleS52YWx1ZTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiBwcm9wS2V5LnZhbHVlID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgICAgICAgICAvLyBjb252ZXJ0IG51bWJlciB0byBzdHJpbmdcbiAgICAgICAgICAgICAgICAgICAgbmFtZSA9IHByb3BLZXkudmFsdWUgKyAnJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7T0JKOiByZXQsIFBST1A6IG5hbWUsIEFWQUw6IGZsZEFWYWx9KTtcbiAgICAgICAgICAgICAgICByZXQucHJvcGFnYXRlKG5ldyBjc3RyLldyaXRlUHJvcChuYW1lLCBmbGRBVmFsKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gcmV0O1xuICAgICAgICB9LFxuXG4gICAgICAgIEZ1bmN0aW9uRXhwcmVzc2lvbjogZnVuY3Rpb24gKG5vZGUsIGN1clN0YXR1cywgYykge1xuICAgICAgICAgICAgaWYgKCFub2RlLmZuSW5zdGFuY2VzKSB7XG4gICAgICAgICAgICAgICAgbm9kZS5mbkluc3RhbmNlcyA9IFtdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbGV0IGZuSW5zdGFuY2UgPSBudWxsO1xuICAgICAgICAgICAgbm9kZS5mbkluc3RhbmNlcy5mb3JFYWNoKGZ1bmN0aW9uIChmblR5cGUpIHtcbiAgICAgICAgICAgICAgICBpZiAoZm5UeXBlLnNjID09PSBjdXJTdGF0dXMuc2MpIHtcbiAgICAgICAgICAgICAgICAgICAgZm5JbnN0YW5jZSA9IGZuVHlwZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGlmICghZm5JbnN0YW5jZSkge1xuICAgICAgICAgICAgICAgIC8vIE5PVEUgcHJvdG90eXBlIG9iamVjdCBpcyBub3QgcmVjb3JkZWQgaW4gxIhcbiAgICAgICAgICAgICAgICBmbkluc3RhbmNlXG4gICAgICAgICAgICAgICAgICAgID0gbmV3IHR5cGVzLkZuVHlwZShuZXcgdHlwZXMuQVZhbChydENYLnByb3Rvcy5GdW5jdGlvbiksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAnW2Fub255bW91cyBmdW5jdGlvbl0nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9kZS5ib2R5WydAYmxvY2snXS5nZXRQYXJhbVZhck5hbWVzKCksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjdXJTdGF0dXMuc2MsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBub2RlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcnRDWC5wcm90b3MuT2JqZWN0KTtcbiAgICAgICAgICAgICAgICBub2RlLmZuSW5zdGFuY2VzLnB1c2goZm5JbnN0YW5jZSk7XG4gICAgICAgICAgICAgICAgLy8gTk9URSBwcm90b3R5cGUgb2JqZWN0IGlzIG5vdCByZWNvcmRlZCBpbiDEiFxuICAgICAgICAgICAgICAgIGNvbnN0IHByb3RvdHlwZU9iamVjdCA9XG4gICAgICAgICAgICAgICAgICAgIG5ldyB0eXBlcy5PYmpUeXBlKG5ldyB0eXBlcy5BVmFsKHJ0Q1gucHJvdG9zLk9iamVjdCksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICc/LnByb3RvdHlwZScpO1xuICAgICAgICAgICAgICAgIC8vIEZvciAucHJvdG90eXBlXG4gICAgICAgICAgICAgICAgY29uc3QgcHJvdG90eXBlUHJvcCA9IGZuSW5zdGFuY2UuZ2V0UHJvcCgncHJvdG90eXBlJyk7XG4gICAgICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7VFlQRTogcHJvdG90eXBlT2JqZWN0LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIElOQ0xfU0VUOiBwcm90b3R5cGVQcm9wfSk7XG4gICAgICAgICAgICAgICAgcHJvdG90eXBlUHJvcC5hZGRUeXBlKHByb3RvdHlwZU9iamVjdCk7XG4gICAgICAgICAgICAgICAgLy8gRm9yIC5wcm90b3R5cGUuY29uc3RydWN0b3JcbiAgICAgICAgICAgICAgICBjb25zdCBjb25zdHJ1Y3RvclByb3AgPSBwcm90b3R5cGVPYmplY3QuZ2V0UHJvcCgnY29uc3RydWN0b3InKTtcbiAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5wdXNoKHtUWVBFOiBmbkluc3RhbmNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIElOQ0xfU0VUOiBjb25zdHJ1Y3RvclByb3B9KTtcbiAgICAgICAgICAgICAgICBjb25zdHJ1Y3RvclByb3AuYWRkVHlwZShmbkluc3RhbmNlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHJldCA9IMSILmdldChub2RlLCBjdXJTdGF0dXMuZGVsdGEpO1xuICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7VFlQRTogZm5JbnN0YW5jZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIElOQ0xfU0VUOiByZXR9KTtcbiAgICAgICAgICAgIHJldC5hZGRUeXBlKGZuSW5zdGFuY2UpO1xuICAgICAgICAgICAgcmV0dXJuIHJldDtcbiAgICAgICAgfSxcblxuICAgICAgICBGdW5jdGlvbkRlY2xhcmF0aW9uOiBmdW5jdGlvbiAobm9kZSwgY3VyU3RhdHVzLCBjKSB7XG4gICAgICAgICAgICAvLyBEcm9wIGluaXRpYWwgY2F0Y2ggc2NvcGVzXG4gICAgICAgICAgICBjb25zdCBzYzAgPSBjdXJTdGF0dXMuc2MucmVtb3ZlSW5pdGlhbENhdGNoQmxvY2tzKCk7XG4gICAgICAgICAgICBpZiAoIW5vZGUuZm5JbnN0YW5jZXMpIHtcbiAgICAgICAgICAgICAgICBub2RlLmZuSW5zdGFuY2VzID0gW107XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBsZXQgZm5JbnN0YW5jZSA9IG51bGw7XG4gICAgICAgICAgICBub2RlLmZuSW5zdGFuY2VzLmZvckVhY2goZnVuY3Rpb24gKGZuVHlwZSkge1xuICAgICAgICAgICAgICAgIGlmIChmblR5cGUuc2MgPT09IHNjMCkge1xuICAgICAgICAgICAgICAgICAgICBmbkluc3RhbmNlID0gZm5UeXBlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgaWYgKCFmbkluc3RhbmNlKSB7XG4gICAgICAgICAgICAgICAgLy8gTk9URSBwcm90b3R5cGUgb2JqZWN0IGlzIG5vdCByZWNvcmRlZCBpbiDEiFxuICAgICAgICAgICAgICAgIGZuSW5zdGFuY2VcbiAgICAgICAgICAgICAgICAgICAgPSBuZXcgdHlwZXMuRm5UeXBlKG5ldyB0eXBlcy5BVmFsKHJ0Q1gucHJvdG9zLkZ1bmN0aW9uKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5vZGUuaWQubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5vZGUuYm9keVsnQGJsb2NrJ10uZ2V0UGFyYW1WYXJOYW1lcygpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2MwLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9kZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJ0Q1gucHJvdG9zLk9iamVjdCk7XG4gICAgICAgICAgICAgICAgbm9kZS5mbkluc3RhbmNlcy5wdXNoKGZuSW5zdGFuY2UpO1xuICAgICAgICAgICAgICAgIC8vIGZvciBlYWNoIGZuSW5zdGFuY2UsIGFzc2lnbiBvbmUgcHJvdG90eXBlIG9iamVjdFxuICAgICAgICAgICAgICAgIC8vIE5PVEUgcHJvdG90eXBlIG9iamVjdCBpcyBub3QgcmVjb3JkZWQgaW4gxIhcbiAgICAgICAgICAgICAgICBjb25zdCBwcm90b3R5cGVPYmplY3QgPVxuICAgICAgICAgICAgICAgICAgICBuZXcgdHlwZXMuT2JqVHlwZShuZXcgdHlwZXMuQVZhbChydENYLnByb3Rvcy5PYmplY3QpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBub2RlLmlkLm5hbWUgKyAnLnByb3RvdHlwZScpO1xuICAgICAgICAgICAgICAgIC8vIEZvciAucHJvdG90eXBlXG4gICAgICAgICAgICAgICAgY29uc3QgcHJvdG90eXBlUHJvcCA9IGZuSW5zdGFuY2UuZ2V0UHJvcCgncHJvdG90eXBlJyk7XG4gICAgICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7VFlQRTogcHJvdG90eXBlT2JqZWN0LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIElOQ0xfU0VUOiBwcm90b3R5cGVQcm9wfSk7XG4gICAgICAgICAgICAgICAgcHJvdG90eXBlUHJvcC5hZGRUeXBlKHByb3RvdHlwZU9iamVjdCk7XG4gICAgICAgICAgICAgICAgLy8gRm9yIC5wcm90b3R5cGUuY29uc3RydWN0b3JcbiAgICAgICAgICAgICAgICBjb25zdCBjb25zdHJ1Y3RvclByb3AgPSBwcm90b3R5cGVPYmplY3QuZ2V0UHJvcCgnY29uc3RydWN0b3InKTtcbiAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5wdXNoKHtUWVBFOiBmbkluc3RhbmNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIElOQ0xfU0VUOiBjb25zdHJ1Y3RvclByb3B9KTtcbiAgICAgICAgICAgICAgICBjb25zdHJ1Y3RvclByb3AuYWRkVHlwZShmbkluc3RhbmNlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGxoc0FWYWwgPSBzYzAuZ2V0QVZhbE9mKG5vZGUuaWQubmFtZSk7XG4gICAgICAgICAgICBjb25zdHJhaW50cy5wdXNoKHtUWVBFOiBmbkluc3RhbmNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgSU5DTF9TRVQ6IGxoc0FWYWx9KTtcbiAgICAgICAgICAgIGxoc0FWYWwuYWRkVHlwZShmbkluc3RhbmNlKTtcbiAgICAgICAgICAgIC8vIG5vdGhpbmcgdG8gcmV0dXJuXG4gICAgICAgICAgICByZXR1cm4gdHlwZXMuQVZhbE51bGw7XG4gICAgICAgIH0sXG5cbiAgICAgICAgU2VxdWVuY2VFeHByZXNzaW9uOiBmdW5jdGlvbiAobm9kZSwgY3VyU3RhdHVzLCBjKSB7XG4gICAgICAgICAgICBjb25zdCBsYXN0SW5kZXggPSBub2RlLmV4cHJlc3Npb25zLmxlbmd0aCAtIDE7XG4gICAgICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGxhc3RJbmRleDsgaSsrKSB7XG4gICAgICAgICAgICAgICAgYyhub2RlLmV4cHJlc3Npb25zW2ldLCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBsYXN0QVZhbCA9IGMobm9kZS5leHByZXNzaW9uc1tsYXN0SW5kZXhdLCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgICAgICDEiC5zZXQobm9kZSwgY3VyU3RhdHVzLmRlbHRhLCBsYXN0QVZhbCk7XG4gICAgICAgICAgICByZXR1cm4gbGFzdEFWYWw7XG4gICAgICAgIH0sXG5cbiAgICAgICAgVW5hcnlFeHByZXNzaW9uOiBmdW5jdGlvbiAobm9kZSwgY3VyU3RhdHVzLCBjKSB7XG4gICAgICAgICAgICBjKG5vZGUuYXJndW1lbnQsIGN1clN0YXR1cywgdW5kZWZpbmVkKTtcbiAgICAgICAgICAgIGNvbnN0IHJlcyA9IMSILmdldChub2RlLCBjdXJTdGF0dXMuZGVsdGEpO1xuICAgICAgICAgICAgY29uc3QgdHlwZSA9IHVub3BSZXN1bHRUeXBlKG5vZGUub3BlcmF0b3IpO1xuICAgICAgICAgICAgaWYgKHR5cGUpIHtcbiAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5wdXNoKHtUWVBFOiB0eXBlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIElOQ0xfU0VUOiByZXN9KTtcbiAgICAgICAgICAgICAgICByZXMuYWRkVHlwZSh0eXBlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiByZXM7XG4gICAgICAgIH0sXG5cbiAgICAgICAgVXBkYXRlRXhwcmVzc2lvbjogZnVuY3Rpb24gKG5vZGUsIGN1clN0YXR1cywgYykge1xuICAgICAgICAgICAgYyhub2RlLmFyZ3VtZW50LCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgICAgICBjb25zdCByZXMgPSDEiC5nZXQobm9kZSwgY3VyU3RhdHVzLmRlbHRhKTtcbiAgICAgICAgICAgIGNvbnN0cmFpbnRzLnB1c2goe1RZUEU6IHR5cGVzLlByaW1OdW1iZXIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBJTkNMX1NFVDogcmVzfSk7XG4gICAgICAgICAgICByZXMuYWRkVHlwZSh0eXBlcy5QcmltTnVtYmVyKTtcbiAgICAgICAgICAgIC8vIFdlIGlnbm9yZSB0aGUgZWZmZWN0IG9mIHVwZGF0aW5nIHRvIG51bWJlciB0eXBlXG4gICAgICAgICAgICByZXR1cm4gcmVzO1xuICAgICAgICB9LFxuXG4gICAgICAgIEJpbmFyeUV4cHJlc3Npb246IGZ1bmN0aW9uIChub2RlLCBjdXJTdGF0dXMsIGMpIHtcbiAgICAgICAgICAgIGNvbnN0IGxPcHJkID0gYyhub2RlLmxlZnQsIGN1clN0YXR1cywgdW5kZWZpbmVkKTtcbiAgICAgICAgICAgIGNvbnN0IHJPcHJkID0gYyhub2RlLnJpZ2h0LCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgICAgICBjb25zdCByZXMgPSDEiC5nZXQobm9kZSwgY3VyU3RhdHVzLmRlbHRhKTtcblxuICAgICAgICAgICAgaWYgKG5vZGUub3BlcmF0b3IgPT0gJysnKSB7XG4gICAgICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7QUREX09QUkQxOiBsT3ByZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBBRERfT1BSRDI6IHJPcHJkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFJFU1VMVDogcmVzIH0pO1xuICAgICAgICAgICAgICAgIGxPcHJkLnByb3BhZ2F0ZShuZXcgY3N0ci5Jc0FkZGVkKHJPcHJkLCByZXMpKTtcbiAgICAgICAgICAgICAgICByT3ByZC5wcm9wYWdhdGUobmV3IGNzdHIuSXNBZGRlZChsT3ByZCwgcmVzKSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGlmIChiaW5vcElzQm9vbGVhbihub2RlLm9wZXJhdG9yKSkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5wdXNoKHtUWVBFOiB0eXBlcy5QcmltQm9vbGVhbixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgSU5DTF9TRVQ6IHJlc30pO1xuICAgICAgICAgICAgICAgICAgICByZXMuYWRkVHlwZSh0eXBlcy5QcmltQm9vbGVhbik7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7VFlQRTogdHlwZXMuUHJpbU51bWJlcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgSU5DTF9TRVQ6IHJlc30pO1xuICAgICAgICAgICAgICAgICAgICByZXMuYWRkVHlwZSh0eXBlcy5QcmltTnVtYmVyKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gcmVzO1xuICAgICAgICB9LFxuXG4gICAgICAgIFRyeVN0YXRlbWVudDogZnVuY3Rpb24gKG5vZGUsIGN1clN0YXR1cywgYykge1xuICAgICAgICAgICAgLy8gY29uc3RydWN0IHNjb3BlIGNoYWluIGZvciBjYXRjaCBibG9ja1xuICAgICAgICAgICAgY29uc3QgY2F0Y2hCbG9ja1NDID1cbiAgICAgICAgICAgICAgICBub2RlLmhhbmRsZXIuYm9keVsnQGJsb2NrJ11cbiAgICAgICAgICAgICAgICAuZ2V0U2NvcGVJbnN0YW5jZShjdXJTdGF0dXMuc2MsIGN1clN0YXR1cy5kZWx0YSk7XG4gICAgICAgICAgICAvLyBnZXQgdGhlIEFWYWwgZm9yIGV4Y2VwdGlvbiBwYXJhbWV0ZXJcbiAgICAgICAgICAgIGNvbnN0IGV4Y0FWYWwgPSBjYXRjaEJsb2NrU0MuZ2V0QVZhbE9mKG5vZGUuaGFuZGxlci5wYXJhbS5uYW1lKTtcblxuICAgICAgICAgICAgLy8gZm9yIHRyeSBibG9ja1xuICAgICAgICAgICAgY29uc3QgdHJ5U3RhdHVzID0gY2hhbmdlZFN0YXR1cyhjdXJTdGF0dXMsICdleGMnLCBleGNBVmFsKTtcbiAgICAgICAgICAgIGMobm9kZS5ibG9jaywgdHJ5U3RhdHVzLCB1bmRlZmluZWQpO1xuXG4gICAgICAgICAgICAvLyBmb3IgY2F0Y2ggYmxvY2tcbiAgICAgICAgICAgIGNvbnN0IGNhdGNoU3RhdHVzID0gY2hhbmdlZFN0YXR1cyhjdXJTdGF0dXMsICdzYycsIGNhdGNoQmxvY2tTQyk7XG4gICAgICAgICAgICBjKG5vZGUuaGFuZGxlci5ib2R5LCBjYXRjaFN0YXR1cywgdW5kZWZpbmVkKTtcblxuICAgICAgICAgICAgLy8gZm9yIGZpbmFsbHkgYmxvY2tcbiAgICAgICAgICAgIGlmIChub2RlLmZpbmFsaXplciAhPT0gbnVsbClcbiAgICAgICAgICAgICAgICBjKG5vZGUuZmluYWxpemVyLCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgVGhyb3dTdGF0ZW1lbnQ6IGZ1bmN0aW9uIChub2RlLCBjdXJTdGF0dXMsIGMpIHtcbiAgICAgICAgICAgIGNvbnN0IHRociA9IGMobm9kZS5hcmd1bWVudCwgY3VyU3RhdHVzLCB1bmRlZmluZWQpO1xuICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7RlJPTTogdGhyLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgVE86IGN1clN0YXR1cy5leGN9KTtcbiAgICAgICAgICAgIHRoci5wcm9wYWdhdGUoY3VyU3RhdHVzLmV4Yyk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgQ2FsbEV4cHJlc3Npb246IGZ1bmN0aW9uIChub2RlLCBjdXJTdGF0dXMsIGMpIHtcbiAgICAgICAgICAgIGNvbnN0IHJlc0FWYWwgPSDEiC5nZXQobm9kZSwgY3VyU3RhdHVzLmRlbHRhKTtcbiAgICAgICAgICAgIGNvbnN0IGFyZ0FWYWxzID0gW107XG5cbiAgICAgICAgICAgIC8vIGdldCBBVmFscyBmb3IgZWFjaCBhcmd1bWVudHNcbiAgICAgICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgbm9kZS5hcmd1bWVudHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgICAgICBhcmdBVmFscy5wdXNoKFxuICAgICAgICAgICAgICAgICAgICBjKG5vZGUuYXJndW1lbnRzW2ldLCBjdXJTdGF0dXMsIHVuZGVmaW5lZCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLy8gYXBwZW5kIGN1cnJlbnQgY2FsbCBzaXRlIHRvIHRoZSBjb250ZXh0XG4gICAgICAgICAgICBjb25zdCBuZXdEZWx0YSA9IGN1clN0YXR1cy5kZWx0YS5hcHBlbmRPbmUobm9kZVsnQGxhYmVsJ10pO1xuXG4gICAgICAgICAgICBpZiAobm9kZS5jYWxsZWUudHlwZSA9PT0gJ01lbWJlckV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICAgICAgLy8gbWV0aG9kIGNhbGxcbiAgICAgICAgICAgICAgICAvLyB2YXIgcmVjdiA9IGMobm9kZS5jYWxsZWUub2JqZWN0LCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgICAgICAgICAgLy8gdmFyIG1ldGhvZE5hbWUgPSBpbW1lZFByb3Aobm9kZS5jYWxsZWUpO1xuICAgICAgICAgICAgICAgIC8vIGNvbnN0cmFpbnRzLnB1c2goe1xuICAgICAgICAgICAgICAgIC8vICAgUkVDVjogcmVjdixcbiAgICAgICAgICAgICAgICAvLyAgIFBST1BOQU1FOiBtZXRob2ROYW1lLFxuICAgICAgICAgICAgICAgIC8vICAgUEFSQU1TOiBhcmdBVmFscyxcbiAgICAgICAgICAgICAgICAvLyAgIFJFVDogcmVzQVZhbCxcbiAgICAgICAgICAgICAgICAvLyAgIEVYQzogY3VyU3RhdHVzLmV4YyxcbiAgICAgICAgICAgICAgICAvLyAgIERFTFRBOiBuZXdEZWx0YVxuICAgICAgICAgICAgICAgIC8vIH0pO1xuICAgICAgICAgICAgICAgIGNvbnN0IFtyZWN2QVZhbCwgcmV0QVZhbF0gPSByZWFkTWVtYmVyKG5vZGUuY2FsbGVlLCBjdXJTdGF0dXMsIGMpO1xuICAgICAgICAgICAgICAgIHJldEFWYWwucHJvcGFnYXRlKFxuICAgICAgICAgICAgICAgICAgICBuZXcgY3N0ci5Jc0NhbGxlZShcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlY3ZBVmFsLFxuICAgICAgICAgICAgICAgICAgICAgICAgYXJnQVZhbHMsXG4gICAgICAgICAgICAgICAgICAgICAgICByZXNBVmFsLFxuICAgICAgICAgICAgICAgICAgICAgICAgY3VyU3RhdHVzLmV4YyxcbiAgICAgICAgICAgICAgICAgICAgICAgIG5ld0RlbHRhKSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIG5vcm1hbCBmdW5jdGlvbiBjYWxsXG4gICAgICAgICAgICAgICAgY29uc3QgY2FsbGVlQVZhbCA9IGMobm9kZS5jYWxsZWUsIGN1clN0YXR1cywgdW5kZWZpbmVkKTtcbiAgICAgICAgICAgICAgICAvLyBjYWxsZWXsnZggcmV0dXJu7J2EIGNhbGwgZXhwcmVzc2lvbuycvOuhnFxuICAgICAgICAgICAgICAgIC8vIGNhbGxlZeydmCBleGNlcHRpb27snYQg7Zi47LacIOy4oeydmCBleGNlcHRpb27sl5Ag7KCE64us7ZW07JW8XG4gICAgICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7XG4gICAgICAgICAgICAgICAgICAgIENBTExFRTogY2FsbGVlQVZhbCxcbiAgICAgICAgICAgICAgICAgICAgU0VMRjogcnRDWC5nbG9iYWxPYmplY3QsXG4gICAgICAgICAgICAgICAgICAgIFBBUkFNUzogYXJnQVZhbHMsXG4gICAgICAgICAgICAgICAgICAgIFJFVDogcmVzQVZhbCxcbiAgICAgICAgICAgICAgICAgICAgRVhDOiBjdXJTdGF0dXMuZXhjLFxuICAgICAgICAgICAgICAgICAgICBERUxUQTogbmV3RGVsdGFcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICBjYWxsZWVBVmFsLnByb3BhZ2F0ZShcbiAgICAgICAgICAgICAgICAgICAgbmV3IGNzdHIuSXNDYWxsZWUoXG4gICAgICAgICAgICAgICAgICAgICAgICBuZXcgdHlwZXMuQVZhbChydENYLmdsb2JhbE9iamVjdCksXG4gICAgICAgICAgICAgICAgICAgICAgICBhcmdBVmFscyxcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlc0FWYWwsXG4gICAgICAgICAgICAgICAgICAgICAgICBjdXJTdGF0dXMuZXhjLFxuICAgICAgICAgICAgICAgICAgICAgICAgbmV3RGVsdGEpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiByZXNBVmFsO1xuICAgICAgICB9LFxuXG4gICAgICAgIE1lbWJlckV4cHJlc3Npb246IGZ1bmN0aW9uIChub2RlLCBjdXJTdGF0dXMsIGMpIHtcbiAgICAgICAgICAgIGNvbnN0IFssIHJldEFWYWxdID0gcmVhZE1lbWJlcihub2RlLCBjdXJTdGF0dXMsIGMpO1xuICAgICAgICAgICAgcmV0dXJuIHJldEFWYWw7XG4gICAgICAgIH0sXG5cbiAgICAgICAgUmV0dXJuU3RhdGVtZW50OiBmdW5jdGlvbiAobm9kZSwgY3VyU3RhdHVzLCBjKSB7XG4gICAgICAgICAgICBpZiAoIW5vZGUuYXJndW1lbnQpIHJldHVybjtcbiAgICAgICAgICAgIGNvbnN0IHJldCA9IGMobm9kZS5hcmd1bWVudCwgY3VyU3RhdHVzLCB1bmRlZmluZWQpO1xuICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7RlJPTTogcmV0LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgVE86IGN1clN0YXR1cy5yZXR9KTtcbiAgICAgICAgICAgIHJldC5wcm9wYWdhdGUoY3VyU3RhdHVzLnJldCk7XG4gICAgICAgIH1cbiAgICB9KTtcblxuICAgIHJlY3Vyc2l2ZVdpdGhSZXR1cm4oYXN0LCBpbml0U3RhdHVzLCBjb25zdHJhaW50R2VuZXJhdG9yKTtcblxuICAgIC8vIFdlIGFjdHVhbGx5IGFkZGVkIGNvbnN0cmFpbnRzXG4gICAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIHJlY3Vyc2l2ZVdpdGhSZXR1cm4obm9kZSwgc3RhdGUsIHZpc2l0b3IpIHtcbiAgICBmdW5jdGlvbiBjKG5vZGUsIHN0LCBvdmVycmlkZSkge1xuICAgICAgICByZXR1cm4gdmlzaXRvcltvdmVycmlkZSB8fCBub2RlLnR5cGVdKG5vZGUsIHN0LCBjKTtcbiAgICB9XG4gICAgcmV0dXJuIGMobm9kZSwgc3RhdGUpO1xufVxuXG5leHBvcnRzLmNvbnN0cmFpbnRzID0gY29uc3RyYWludHM7XG5leHBvcnRzLmFkZENvbnN0cmFpbnRzID0gYWRkQ29uc3RyYWludHM7XG5leHBvcnRzLmNsZWFyQ29uc3RyYWludHMgPSBjbGVhckNvbnN0cmFpbnRzO1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG5jb25zdCB0eXBlcyA9IHJlcXVpcmUoJy4uL2RvbWFpbnMvdHlwZXMnKTtcbmNvbnN0IHN0YXR1cyA9IHJlcXVpcmUoJy4uL2RvbWFpbnMvc3RhdHVzJyk7XG5jb25zdCBjR2VuID0gcmVxdWlyZSgnLi9jR2VuJyk7XG5cbmZ1bmN0aW9uIENTVFIoKSB7fVxuQ1NUUi5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKG51bGwpO1xuQ1NUUi5wcm90b3R5cGUuZXF1YWxzID0gZnVuY3Rpb24gKG90aGVyKSB7XG4gICAgcmV0dXJuIHRoaXMgPT09IG90aGVyO1xufTtcblxuZnVuY3Rpb24gUmVhZFByb3AocHJvcCwgdG8pIHtcbiAgICB0aGlzLnByb3AgPSBwcm9wO1xuICAgIHRoaXMudG8gPSB0bztcbn1cblJlYWRQcm9wLnByb3RvdHlwZSA9IE9iamVjdC5jcmVhdGUoQ1NUUi5wcm90b3R5cGUpO1xuUmVhZFByb3AucHJvdG90eXBlLmFkZFR5cGUgPSBmdW5jdGlvbiAob2JqKSB7XG4gICAgaWYgKCEob2JqIGluc3RhbmNlb2YgKHR5cGVzLk9ialR5cGUpKSkgcmV0dXJuO1xuICAgIC8vIHdoZW4gb2JqIGlzIE9ialR5cGUsXG4gICAgY29uc3Qgb3duUHJvcCA9IG9iai5nZXRQcm9wKHRoaXMucHJvcCwgdHJ1ZSk7XG4gICAgaWYgKG93blByb3ApIHtcbiAgICAgICAgLy8gd2hlbiB0aGUgb2JqZWN0IGhhcyB0aGUgcHJvcCxcbiAgICAgICAgb3duUHJvcC5wcm9wYWdhdGUodGhpcy50byk7XG4gICAgfSBlbHNlIGlmIChvYmouZ2V0UHJvcCgnX19wcm90b19fJywgdHJ1ZSkpIHtcbiAgICAgICAgLy8gdXNlIHByb3RvdHlwZSBjaGFpblxuICAgICAgICBvYmouZ2V0UHJvcCgnX19wcm90b19fJylcbiAgICAgICAgICAucHJvcGFnYXRlKG5ldyBSZWFkUHJvcCh0aGlzLnByb3AsIHRoaXMudG8pKTtcbiAgICB9XG59O1xuUmVhZFByb3AucHJvdG90eXBlLmVxdWFscyA9IGZ1bmN0aW9uIChvdGhlcikge1xuICAgIGlmICghKG90aGVyIGluc3RhbmNlb2YgUmVhZFByb3ApKSByZXR1cm4gZmFsc2U7XG4gICAgcmV0dXJuIHRoaXMucHJvcCA9PT0gb3RoZXIucHJvcFxuICAgICAgICAmJiB0aGlzLnRvLmVxdWFscyhvdGhlci50byk7XG59O1xuXG5mdW5jdGlvbiBXcml0ZVByb3AocHJvcCwgZnJvbSkge1xuICAgIHRoaXMucHJvcCA9IHByb3A7XG4gICAgdGhpcy5mcm9tID0gZnJvbTtcbn1cbldyaXRlUHJvcC5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKENTVFIucHJvdG90eXBlKTtcbldyaXRlUHJvcC5wcm90b3R5cGUuYWRkVHlwZSA9IGZ1bmN0aW9uIChvYmopIHtcbiAgICBpZiAoIShvYmogaW5zdGFuY2VvZiAodHlwZXMuT2JqVHlwZSkpKSByZXR1cm47XG4gICAgY29uc3Qgb3duUHJvcCA9IG9iai5nZXRQcm9wKHRoaXMucHJvcCk7XG4gICAgdGhpcy5mcm9tLnByb3BhZ2F0ZShvd25Qcm9wKTtcbn07XG5cbmZ1bmN0aW9uIElzQWRkZWQob3RoZXIsIHRhcmdldCkge1xuICAgIHRoaXMub3RoZXIgPSBvdGhlcjtcbiAgICB0aGlzLnRhcmdldCA9IHRhcmdldDtcbn1cbklzQWRkZWQucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShDU1RSLnByb3RvdHlwZSk7XG5Jc0FkZGVkLnByb3RvdHlwZS5hZGRUeXBlID0gZnVuY3Rpb24gKHR5cGUpIHtcbiAgICBpZiAoKHR5cGUgPT09IHR5cGVzLlByaW1OdW1iZXIgXG4gICAgICAgICB8fCB0eXBlID09PSB0eXBlcy5QcmltQm9vbGVhbilcbiAgICAgJiYgKHRoaXMub3RoZXIuaGFzVHlwZSh0eXBlcy5QcmltTnVtYmVyKSBcbiAgICAgICAgIHx8IHRoaXMub3RoZXIuaGFzVHlwZSh0eXBlcy5QcmltQm9vbGVhbikpKSB7XG4gICAgICAgIHRoaXMudGFyZ2V0LmFkZFR5cGUodHlwZXMuUHJpbU51bWJlcik7XG4gICAgfVxuICAgIGlmICh0eXBlID09PSB0eXBlcy5QcmltU3RyaW5nXG4gICAgICYmICF0aGlzLm90aGVyLmlzRW1wdHkoKSkge1xuICAgICAgICAgdGhpcy50YXJnZXQuYWRkVHlwZSh0eXBlcy5QcmltU3RyaW5nKTtcbiAgICB9XG59O1xuXG5mdW5jdGlvbiBJc0NhbGxlZShzZWxmLCBhcmdzLCByZXQsIGV4YywgZGVsdGEpIHtcbiAgICB0aGlzLnNlbGYgPSBzZWxmO1xuICAgIHRoaXMuYXJncyA9IGFyZ3M7XG4gICAgdGhpcy5yZXQgPSByZXQ7XG4gICAgdGhpcy5leGMgPSBleGM7XG4gICAgdGhpcy5kZWx0YSA9IGRlbHRhO1xufVxuSXNDYWxsZWUucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShDU1RSLnByb3RvdHlwZSk7XG5Jc0NhbGxlZS5wcm90b3R5cGUuYWRkVHlwZSA9IGZ1bmN0aW9uIChmKSB7XG4gICAgaWYgKCEoZiBpbnN0YW5jZW9mICh0eXBlcy5GblR5cGUpKSkgcmV0dXJuO1xuICAgIGNvbnN0IGZ1bkVudiA9IGYuZ2V0RnVuRW52KHRoaXMuZGVsdGEpO1xuICAgIGNvbnN0IG5ld1NDID0gZi5vcmlnaW5Ob2RlLmJvZHlbJ0BibG9jayddLmdldFNjb3BlSW5zdGFuY2UoZi5zYywgdGhpcy5kZWx0YSk7XG4gICAgY29uc3QgZnVuU3RhdHVzXG4gICAgICAgID0gbmV3IHN0YXR1cy5TdGF0dXMoZnVuRW52WzBdLCBmdW5FbnZbMV0sIGZ1bkVudlsyXSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5kZWx0YSwgbmV3U0MpO1xuICAgIC8vIHBhc3MgdGhpcyBvYmplY3RcbiAgICB0aGlzLnNlbGYucHJvcGFnYXRlKGZ1bkVudlswXSk7XG5cbiAgICBjb25zdCBtaW5MZW4gPSBNYXRoLm1pbih0aGlzLmFyZ3MubGVuZ3RoLCBmLnBhcmFtTmFtZXMubGVuZ3RoKTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IG1pbkxlbjsgaSsrKSB7XG4gICAgICAgIHRoaXMuYXJnc1tpXS5wcm9wYWdhdGUobmV3U0MuZ2V0QVZhbE9mKGYucGFyYW1OYW1lc1tpXSkpO1xuICAgIH1cblxuICAgIC8vIGZvciBhcmd1bWVudHMgb2JqZWN0XG4gICAgaWYgKGYub3JpZ2luTm9kZS5ib2R5WydAYmxvY2snXS51c2VBcmd1bWVudHNPYmplY3QpIHtcbiAgICAgICAgY29uc3QgYXJnT2JqID0gZi5nZXRBcmd1bWVudHNPYmplY3QodGhpcy5kZWx0YSk7XG4gICAgICAgIG5ld1NDLmdldEFWYWxPZignYXJndW1lbnRzJykuYWRkVHlwZShhcmdPYmopO1xuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IHRoaXMuYXJncy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgdGhpcy5hcmdzW2ldLnByb3BhZ2F0ZShhcmdPYmouZ2V0UHJvcChpICsgJycpKTtcbiAgICAgICAgICAgIHRoaXMuYXJnc1tpXS5wcm9wYWdhdGUoYXJnT2JqLmdldFByb3AobnVsbCkpO1xuICAgICAgICB9XG4gICAgICAgIGFyZ09iai5nZXRQcm9wKCdjYWxsZWUnKS5hZGRUeXBlKGYpO1xuICAgICAgICBhcmdPYmouZ2V0UHJvcCgnbGVuZ3RoJykuYWRkVHlwZSh0eXBlcy5QcmltTnVtYmVyKTtcbiAgICB9XG5cbiAgICAvLyBjb25zdHJhaW50IGdlbmVyYXRpb24gZm9yIHRoZSBmdW5jdGlvbiBib2R5XG4gICAgY0dlbi5hZGRDb25zdHJhaW50cyhmLm9yaWdpbk5vZGUuYm9keSwgZnVuU3RhdHVzKTtcblxuICAgIC8vIGdldCByZXR1cm4gXG4gICAgZnVuRW52WzFdLnByb3BhZ2F0ZSh0aGlzLnJldCk7XG4gICAgLy8gZ2V0IGV4Y2VwdGlvblxuICAgIGZ1bkVudlsyXS5wcm9wYWdhdGUodGhpcy5leGMpO1xufTtcblxuZnVuY3Rpb24gSXNDdG9yKGFyZ3MsIHJldCwgZXhjLCBkZWx0YSkge1xuICAgIHRoaXMuYXJncyA9IGFyZ3M7XG4gICAgdGhpcy5yZXQgPSByZXQ7XG4gICAgdGhpcy5leGMgPSBleGM7XG4gICAgdGhpcy5kZWx0YSA9IGRlbHRhO1xufVxuSXNDdG9yLnByb3RvdHlwZSA9IE9iamVjdC5jcmVhdGUoQ1NUUi5wcm90b3R5cGUpO1xuSXNDdG9yLnByb3RvdHlwZS5hZGRUeXBlID0gZnVuY3Rpb24gKGYpIHtcbiAgICBpZiAoIShmIGluc3RhbmNlb2YgKHR5cGVzLkZuVHlwZSkpKSByZXR1cm47XG4gICAgY29uc3QgZnVuRW52ID0gZi5nZXRGdW5FbnYodGhpcy5kZWx0YSk7XG4gICAgY29uc3QgbmV3U0MgPSBmLm9yaWdpbk5vZGUuYm9keVsnQGJsb2NrJ10uZ2V0U2NvcGVJbnN0YW5jZShmLnNjLCB0aGlzLmRlbHRhKTtcbiAgICBjb25zdCBmdW5TdGF0dXNcbiAgICAgICAgPSBuZXcgc3RhdHVzLlN0YXR1cyhmdW5FbnZbMF0sIG5ldyBJZk9ialR5cGUoZnVuRW52WzFdKSwgZnVuRW52WzJdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuZGVsdGEsIG5ld1NDKTtcbiAgICAvLyBwYXNzIHRoaXMgb2JqZWN0XG4gICAgY29uc3QgbmV3T2JqID0gZi5nZXRJbnN0YW5jZSgpO1xuICAgIGZ1bkVudlswXS5hZGRUeXBlKG5ld09iaik7XG5cbiAgICBjb25zdCBtaW5MZW4gPSBNYXRoLm1pbih0aGlzLmFyZ3MubGVuZ3RoLCBmLnBhcmFtTmFtZXMubGVuZ3RoKTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IG1pbkxlbjsgaSsrKSB7XG4gICAgICAgIHRoaXMuYXJnc1tpXS5wcm9wYWdhdGUobmV3U0MuZ2V0QVZhbE9mKGYucGFyYW1OYW1lc1tpXSkpO1xuICAgIH1cblxuICAgIC8vIGZvciBhcmd1bWVudHMgb2JqZWN0XG4gICAgaWYgKGYub3JpZ2luTm9kZS5ib2R5WydAYmxvY2snXS51c2VBcmd1bWVudHNPYmplY3QpIHtcbiAgICAgICAgY29uc3QgYXJnT2JqID0gZi5nZXRBcmd1bWVudHNPYmplY3QodGhpcy5kZWx0YSk7XG4gICAgICAgIG5ld1NDLmdldEFWYWxPZignYXJndW1lbnRzJykuYWRkVHlwZShhcmdPYmopO1xuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IHRoaXMuYXJncy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgdGhpcy5hcmdzW2ldLnByb3BhZ2F0ZShhcmdPYmouZ2V0UHJvcChpICsgJycpKTtcbiAgICAgICAgICAgIHRoaXMuYXJnc1tpXS5wcm9wYWdhdGUoYXJnT2JqLmdldFByb3AobnVsbCkpO1xuICAgICAgICB9XG4gICAgICAgIGFyZ09iai5nZXRQcm9wKCdjYWxsZWUnKS5hZGRUeXBlKGYpO1xuICAgICAgICBhcmdPYmouZ2V0UHJvcCgnbGVuZ3RoJykuYWRkVHlwZSh0eXBlcy5QcmltTnVtYmVyKTtcbiAgICB9XG5cbiAgICAvLyBjb25zdHJhaW50IGdlbmVyYXRpb24gZm9yIHRoZSBmdW5jdGlvbiBib2R5XG4gICAgY0dlbi5hZGRDb25zdHJhaW50cyhmLm9yaWdpbk5vZGUuYm9keSwgZnVuU3RhdHVzKTtcblxuICAgIC8vIGJ5IGV4cGxpY2l0IHJldHVybiwgb25seSBPYmpUeXBlIGFyZSBwcm9wYWdhdGVkXG4gICAgZnVuRW52WzFdLnByb3BhZ2F0ZSh0aGlzLnJldCk7XG4gICAgLy8gcmV0dXJuIG5ldyBvYmplY3RcbiAgICB0aGlzLnJldC5hZGRUeXBlKG5ld09iaik7XG4gICAgLy8gZ2V0IGV4Y2VwdGlvblxuICAgIGZ1bkVudlsyXS5wcm9wYWdhdGUodGhpcy5leGMpO1xufTtcblxuLy8gaWdub3JlIG5vbiBvYmplY3QgdHlwZXNcbmZ1bmN0aW9uIElmT2JqVHlwZShhdmFsKSB7XG4gICAgdGhpcy5hdmFsID0gYXZhbDtcbn1cbklmT2JqVHlwZS5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKENTVFIucHJvdG90eXBlKTtcbklmT2JqVHlwZS5wcm90b3R5cGUuYWRkVHlwZSA9IGZ1bmN0aW9uICh0eXBlKSB7XG4gICAgaWYgKCEodHlwZSBpbnN0YW5jZW9mIHR5cGVzLk9ialR5cGUpKSByZXR1cm47XG4gICAgdGhpcy5hdmFsLmFkZFR5cGUodHlwZSk7XG59O1xuXG5leHBvcnRzLlJlYWRQcm9wID0gUmVhZFByb3A7XG5leHBvcnRzLldyaXRlUHJvcCA9IFdyaXRlUHJvcDtcbmV4cG9ydHMuSXNBZGRlZCA9IElzQWRkZWQ7XG5leHBvcnRzLklzQ2FsbGVlID0gSXNDYWxsZWU7XG5leHBvcnRzLklzQ3RvciA9IElzQ3RvcjtcbiIsIi8vIENvbnRleHQgZm9yIGstQ0ZBIGFuYWx5c2lzXG4vL1xuLy8gQXNzdW1lIGEgY29udGV4dCBpcyBhbiBhcnJheSBvZiBudW1iZXJzLlxuLy8gQSBudW1iZXIgaW4gc3VjaCBsaXN0IGRlbm90ZXMgYSBjYWxsIHNpdGUsIHRoYXQgaXMgQGxhYmVsIG9mIGEgQ2FsbEV4cHJlc3Npb24uXG4vLyBXZSBrZWVwIHRoZSBtb3N0IHJlY2VudCAnaycgY2FsbHNpdGVzLlxuLy8gRXF1YWxpdHkgb24gY29udGV4dHMgc2hvdWxkIGxvb2sgaW50byB0aGUgbnVtYmVycy5cblxudmFyIGNhbGxTaXRlQ29udGV4dFBhcmFtZXRlciA9IHtcbiAgICAvLyBtYXhpbXVtIGxlbmd0aCBvZiBjb250ZXh0XG4gICAgbWF4RGVwdGhLOiAwLFxuICAgIC8vIGZ1bmN0aW9uIGxpc3QgZm9yIHNlbnNpdGl2ZSBhbmFseXNpc1xuICAgIHNlbnNGdW5jczoge31cbn07XG5cbmZ1bmN0aW9uIENhbGxTaXRlQ29udGV4dChjc0xpc3QpIHtcbiAgICBpZiAoY3NMaXN0KSB0aGlzLmNzTGlzdCA9IGNzTGlzdDtcbiAgICBlbHNlIHRoaXMuY3NMaXN0ID0gW107XG59XG5cbkNhbGxTaXRlQ29udGV4dC5wcm90b3R5cGUuZXF1YWxzID0gZnVuY3Rpb24gKG90aGVyKSB7XG4gICAgaWYgKHRoaXMuY3NMaXN0Lmxlbmd0aCAhPSBvdGhlci5jc0xpc3QubGVuZ3RoKSByZXR1cm4gZmFsc2U7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCB0aGlzLmNzTGlzdC5sZW5ndGg7IGkrKykge1xuICAgICAgICBpZiAodGhpcy5jc0xpc3RbaV0gIT09IG90aGVyLmNzTGlzdFtpXSkgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbn07XG5cbkNhbGxTaXRlQ29udGV4dC5wcm90b3R5cGUuYXBwZW5kT25lID0gZnVuY3Rpb24gKGNhbGxTaXRlKSB7XG4gICAgLy8gdXNlIGNvbmNhdCB0byBjcmVhdGUgYSBuZXcgYXJyYXlcbiAgICAvLyBvbGRlc3Qgb25lIGNvbWVzIGZpcnN0XG4gICAgdmFyIGFwcGVuZGVkID0gdGhpcy5jc0xpc3QuY29uY2F0KGNhbGxTaXRlKTtcbiAgICBpZiAoYXBwZW5kZWQubGVuZ3RoID4gY2FsbFNpdGVDb250ZXh0UGFyYW1ldGVyLm1heERlcHRoSykge1xuICAgICAgICBhcHBlbmRlZC5zaGlmdCgpO1xuICAgIH1cbiAgICByZXR1cm4gbmV3IENhbGxTaXRlQ29udGV4dChhcHBlbmRlZCk7XG59O1xuXG5DYWxsU2l0ZUNvbnRleHQucHJvdG90eXBlLnRvU3RyaW5nID0gZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0aGlzLmNzTGlzdC50b1N0cmluZygpO1xufTtcblxuZXhwb3J0cy5jYWxsU2l0ZUNvbnRleHRQYXJhbWV0ZXIgPSBjYWxsU2l0ZUNvbnRleHRQYXJhbWV0ZXI7XG5leHBvcnRzLkNhbGxTaXRlQ29udGV4dCA9IENhbGxTaXRlQ29udGV4dDsiLCIvLyBTdGF0dXM6XG4vLyB7IHNlbGYgIDogQVZhbCxcbi8vICAgcmV0ICAgOiBBVmFsLFxuLy8gICBleGMgICA6IEFWYWwsXG4vLyAgIGRlbHRhIDogQ29udGV4dCxcbi8vICAgc2MgICAgOiBTY29wZUNoYWluIH1cblxuZnVuY3Rpb24gU3RhdHVzKHNlbGYsIHJldCwgZXhjLCBkZWx0YSwgc2MpIHtcbiAgICB0aGlzLnNlbGYgPSBzZWxmO1xuICAgIHRoaXMucmV0ID0gcmV0O1xuICAgIHRoaXMuZXhjID0gZXhjO1xuICAgIHRoaXMuZGVsdGEgPSBkZWx0YTtcbiAgICB0aGlzLnNjID0gc2M7XG59XG5cblN0YXR1cy5wcm90b3R5cGUuZXF1YWxzID0gZnVuY3Rpb24gKG90aGVyKSB7XG4gICAgcmV0dXJuIHRoaXMuc2VsZiA9PT0gb3RoZXIuc2VsZiAmJlxuICAgICAgICB0aGlzLnJldCA9PT0gb3RoZXIucmV0ICYmXG4gICAgICAgIHRoaXMuZXhjID09PSBvdGhlci5leGMgJiZcbiAgICAgICAgdGhpcy5kZWx0YS5lcXVhbHMob3RoZXIuZGVsdGEpICYmXG4gICAgICAgIHRoaXMuc2MgPT09IG90aGVyLnNjO1xufTtcblxuZXhwb3J0cy5TdGF0dXMgPSBTdGF0dXM7IiwiJ3VzZSBzdHJpY3QnO1xuXG4vLyBmb3IgREVCVUdcbnZhciBjb3VudCA9IDA7XG4vKipcbiAqIHRoZSBhYnN0cmFjdCB2YWx1ZSBmb3IgYSBjb25jcmV0ZSB2YWx1ZVxuICogd2hpY2ggaXMgYSBzZXQgb2YgdHlwZXMuXG4gKiBAY29uc3RydWN0b3JcbiAqIEBwYXJhbSB7VHlwZX0gdHlwZSAtIGdpdmUgYSB0eXBlIHRvIG1ha2UgQVZhbCB3aXRoIGEgc2luZ2xlIHR5cGVcbiAqL1xuZnVuY3Rpb24gQVZhbCh0eXBlKSB7XG4gICAgLy8gdHlwZTogY29udGFpbmVkIHR5cGVzXG4gICAgLy8gV2UgYXNzdW1lIHR5cGVzIGFyZSBkaXN0aW5ndWlzaGFibGUgYnkgJz09PSdcbiAgICBpZiAodHlwZSkgdGhpcy50eXBlcyA9IG5ldyBTZXQoW3R5cGVdKTtcbiAgICBlbHNlIHRoaXMudHlwZXMgPSBuZXcgU2V0KCk7XG4gICAgLy8gZm9yd2FyZHM6IHByb3BhZ2F0aW9uIHRhcmdldHNcbiAgICAvLyBXZSBhc3N1bWUgdGFyZ2V0cyBhcmUgZGlzdGluZ3Vpc2hhYmxlIGJ5ICdlcXVhbHMnIG1ldGhvZFxuICAgIHRoaXMuZm9yd2FyZHMgPSBuZXcgU2V0KCk7XG4gICAgLy8gZm9yIERFQlVHXG4gICAgdGhpcy5faWQgPSBjb3VudCsrO1xufVxuLyoqIENoZWNrIHdoZXRoZXIgaXQgaGFzIGFueSB0eXBlXG4gKiBAcmV0dXJucyB7Ym9vbGVhbn1cbiAqL1xuQVZhbC5wcm90b3R5cGUuaXNFbXB0eSA9IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gdGhpcy50eXBlcy5zaXplID09PSAwO1xufTtcblxuLyoqXG4gKiBAcmV0dXJucyB7W1R5cGVdfVxuICovXG5BVmFsLnByb3RvdHlwZS5nZXRUeXBlcyA9IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gdGhpcy50eXBlcztcbn07XG5cbi8qKlxuICogQHJldHVybnMge2Jvb2xlYW59XG4gKi9cbkFWYWwucHJvdG90eXBlLmhhc1R5cGUgPSBmdW5jdGlvbiAodHlwZSkge1xuICAgIHJldHVybiB0aGlzLnR5cGVzLmhhcyh0eXBlKTtcbn07XG5cbi8qKlxuICogQWRkIGEgdHlwZS5cbiAqIEBwYXJhbSB7VHlwZX0gdHlwZVxuICovXG5BVmFsLnByb3RvdHlwZS5hZGRUeXBlID0gZnVuY3Rpb24gKHR5cGUpIHtcbiAgICBpZiAodGhpcy50eXBlcy5oYXModHlwZSkpIHJldHVybjtcbiAgICAvLyBnaXZlbiB0eXBlIGlzIG5ld1xuICAgIHRoaXMudHlwZXMuYWRkKHR5cGUpO1xuICAgIC8vIHNlbmQgdG8gcHJvcGFnYXRpb24gdGFyZ2F0c1xuICAgIHRoaXMuZm9yd2FyZHMuZm9yRWFjaChmdW5jdGlvbiAoZndkKSB7XG4gICAgICAgIGZ3ZC5hZGRUeXBlKHR5cGUpO1xuICAgIH0pO1xufTtcbi8qKlxuICogQHBhcmFtIHtBVmFsfSB0YXJnZXRcbiAqL1xuQVZhbC5wcm90b3R5cGUucHJvcGFnYXRlID0gZnVuY3Rpb24gKHRhcmdldCkge1xuICAgIGlmICghdGhpcy5hZGRGb3J3YXJkKHRhcmdldCkpIHJldHVybjtcbiAgICAvLyB0YXJnZXQgaXMgbmV3bHkgYWRkZWRcbiAgICAvLyBzZW5kIHR5cGVzIHRvIHRoZSBuZXcgdGFyZ2V0XG4gICAgdGhpcy50eXBlcy5mb3JFYWNoKGZ1bmN0aW9uICh0eXBlKSB7XG4gICAgICAgIHRhcmdldC5hZGRUeXBlKHR5cGUpO1xuICAgIH0pO1xufTtcblxuQVZhbC5wcm90b3R5cGUuYWRkRm9yd2FyZCA9IGZ1bmN0aW9uIChmd2QpIHtcbiAgICBmb3IgKGxldCBvbGRGd2Qgb2YgdGhpcy5mb3J3YXJkcykge1xuICAgICAgICBpZiAoZndkLmVxdWFscyhvbGRGd2QpKSByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHRoaXMuZm9yd2FyZHMuYWRkKGZ3ZCk7XG4gICAgcmV0dXJuIHRydWU7XG59O1xuXG5BVmFsLnByb3RvdHlwZS5lcXVhbHMgPSBmdW5jdGlvbiAob3RoZXIpIHtcbiAgICAvLyBzaW1wbGUgcmVmZXJlbmNlIGNvbXBhcmlzb25cbiAgICByZXR1cm4gdGhpcyA9PT0gb3RoZXI7XG59O1xuXG4vKipcbiAqIFRPRE86IGNoZWNrIHdoZXRoZXIgd2UgcmVhbGx5IG5lZWQgdGhpcyBtZXRob2QuXG4gKiBAcGFyYW0ge3N0cmluZ30gcHJvcFxuICogQHJldHVybnMge0FWYWx9XG4gKi9cbkFWYWwucHJvdG90eXBlLmdldFByb3AgPSBmdW5jdGlvbiAocHJvcCkge1xuICAgIGlmIChwcm9wID09PSAn4pyWJykge1xuICAgICAgICAvLyDinJYgaXMgdGhlIGJvZ3VzIHByb3BlcnR5IG5hbWUgYWRkZWQgZm9yIGVycm9yIHJlY292ZXJ5LlxuICAgICAgICByZXR1cm4gQVZhbE51bGw7XG4gICAgfVxuICAgIGlmICh0aGlzLnByb3BzLmhhcyhwcm9wKSkge1xuICAgICAgICByZXR1cm4gdGhpcy5wcm9wcy5nZXQocHJvcCk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuIEFWYWxOdWxsO1xuICAgIH1cbn07XG5cbi8qKlxuICogdGhlIHN1cGVyIGNsYXNzIG9mIGFsbCB0eXBlc1xuICogZWFjaCB0eXBlIHNob3VsZCBiZSBkaXN0aW5ndWlzaGFibGUgYnkgJz09PScgb3BlcmF0aW9uLlxuICogQGNvbnN0cnVjdG9yXG4gKi9cbmZ1bmN0aW9uIFR5cGUobmFtZSkge1xuICAgIHRoaXMubmFtZSA9IG5hbWU7XG59XG5UeXBlLnByb3RvdHlwZSA9IE9iamVjdC5jcmVhdGUobnVsbCk7XG5UeXBlLnByb3RvdHlwZS5nZXROYW1lID0gZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0aGlzLm5hbWU7XG59O1xuXG4vKipcbiAqIDEuIG9iamVjdCB0eXBlc1xuICogQHBhcmFtIHtBVmFsfSBwcm90byAtIEFWYWwgb2YgY29uc3RydWN0b3IncyBwcm90b3R5cGVcbiAqIEBwYXJhbSB7c3RyaW5nfSBuYW1lIC0gZ3Vlc3NlZCBuYW1lXG4gKi9cbmZ1bmN0aW9uIE9ialR5cGUocHJvdG8sIG5hbWUpIHtcbiAgICB0aGlzLm5hbWUgPSBuYW1lO1xuICAgIHRoaXMucHJvcHMgPSBuZXcgTWFwKCk7XG5cbiAgICAvLyBzaGFyZSBwcm90byB3aXRoIF9fcHJvdG9fX1xuICAgIHRoaXMuc2V0UHJvcCgnX19wcm90b19fJywgcHJvdG8pO1xufVxuT2JqVHlwZS5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKFR5cGUucHJvdG90eXBlKTtcbi8qKlxuICogQHBhcmFtIHtzdHJpbmd8bnVsbH0gcHJvcCAtIG51bGwgZm9yIGNvbXB1dGVkIHByb3BzXG4gKiBAcGFyYW0ge2Jvb2xlYW59IHJlYWRPbmx5IC0gaWYgZmFsc2UsIGNyZWF0ZSBBVmFsIGZvciBwcm9wIGlmIG5lY2Vzc2FyeVxuICogQHJldHVybnMge0FWYWx9IEFWYWwgb2YgdGhlIHByb3BlcnR5XG4gKi9cbk9ialR5cGUucHJvdG90eXBlLmdldFByb3AgPSBmdW5jdGlvbiAocHJvcCwgcmVhZE9ubHkpIHtcbiAgICBpZiAocHJvcCA9PT0gJ+KclicpIHtcbiAgICAgICAgLy8g4pyWIGlzIHRoZSBib2d1cyBwcm9wZXJ0eSBuYW1lIGFkZGVkIGR1cmluZyBwYXJzaW5nIGVycm9yIHJlY292ZXJ5LlxuICAgICAgICByZXR1cm4gQVZhbE51bGw7XG4gICAgfVxuICAgIGlmICh0aGlzLnByb3BzLmhhcyhwcm9wKSkge1xuICAgICAgICByZXR1cm4gdGhpcy5wcm9wcy5nZXQocHJvcCk7XG4gICAgfSBlbHNlIGlmIChyZWFkT25seSkge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9IGVsc2Uge1xuICAgICAgICB2YXIgbmV3UHJvcEFWYWwgPSBuZXcgQVZhbDtcbiAgICAgICAgdGhpcy5wcm9wcy5zZXQocHJvcCwgbmV3UHJvcEFWYWwpO1xuICAgICAgICByZXR1cm4gbmV3UHJvcEFWYWw7XG4gICAgfVxufTtcbi8qKlxuICogV2UgdXNlIHRoaXMgZnVuY3Rpb24gdG8gc2hhcmUgLnByb3RvdHlwZSB3aXRoIGluc3RhbmNlcyBfX3Byb3RvX19cbiAqIEl0IGlzIHBvc3NpYmxlIHRvIHVzZSB0aGlzIGZ1bmN0aW9uIHRvIG1lcmdlIEFWYWxzIHRvIG9wdGltaXplIHRoZSBhbmFseXplci5cbiAqIEBwYXJhbSB7c3RyaW5nfG51bGx9IHByb3AgLSBudWxsIGZvciBjb21wdXRlZCBwcm9wc1xuICogQHBhcmFtIHtBVmFsfSBhdmFsXG4gKi9cbk9ialR5cGUucHJvdG90eXBlLnNldFByb3AgPSBmdW5jdGlvbiAocHJvcCwgYXZhbCkge1xuICAgIGlmIChwcm9wID09PSAn4pyWJykge1xuICAgICAgICAvLyDinJYgaXMgdGhlIGJvZ3VzIHByb3BlcnR5IG5hbWUgYWRkZWQgZHVyaW5nIHBhcnNpbmcgZXJyb3IgcmVjb3ZlcnkuXG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5wcm9wcy5zZXQocHJvcCwgYXZhbCk7XG59O1xuLyoqXG4gKiBUT0RPOiBDaGVjayB0aGlzIGZ1bmN0aW9uJ3MgbmVjZXNzaXR5XG4gKiBAcGFyYW0ge3N0cmluZ30gcHJvcFxuICogQHJldHVybnMge2Jvb2xlYW59XG4gKi9cbk9ialR5cGUucHJvdG90eXBlLmhhc1Byb3AgPSBmdW5jdGlvbiAocHJvcCkge1xuICAgIGlmIChwcm9wID09PSAn4pyWJykgcmV0dXJuIGZhbHNlO1xuICAgIHJldHVybiB0aGlzLnByb3BzLmhhcyhwcm9wKTtcbn07XG4vKipcbiAqIFRPRE86IENoZWNrIHRoaXMgZnVuY3Rpb24ncyBuZWNlc3NpdHlcbiAqIEBwYXJhbSB7VHlwZX0gdHlwZVxuICogQHBhcmFtIHtzdHJpbmd9IHByb3BcbiAqL1xuT2JqVHlwZS5wcm90b3R5cGUuYWRkVHlwZVRvUHJvcCA9IGZ1bmN0aW9uICh0eXBlLCBwcm9wKSB7XG4gICAgaWYgKHByb3AgPT09ICfinJYnKSByZXR1cm47XG4gICAgaWYgKCF0aGlzLnByb3BzLmhhcyhwcm9wKSkge1xuICAgICAgICB0aGlzLnByb3BzLnNldChwcm9wLCBuZXcgQVZhbCk7XG4gICAgfVxuICAgIGlmICh0aGlzLnByb3BzLmdldChwcm9wKS5oYXNUeXBlKHR5cGUpKSByZXR1cm47XG4gICAgdGhpcy5wcm9wcy5nZXQocHJvcCkuYWRkVHlwZSh0eXBlKTtcbn07XG4vKipcbiAqIFRPRE86IENoZWNrIHRoaXMgZnVuY3Rpb24ncyBuZWNlc3NpdHlcbiAqIEBwYXJhbSB7QVZhbH0gYXZhbFxuICogQHBhcmFtIHtzdHJpbmd9IHByb3BcbiAqL1xuT2JqVHlwZS5wcm90b3R5cGUuam9pbkFWYWxUb1Byb3AgPSBmdW5jdGlvbiAoYXZhbCwgcHJvcCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBhdmFsLmdldFR5cGVzKCkuZm9yRWFjaChmdW5jdGlvbiAodHlwZSkge1xuICAgICAgICBzZWxmLmFkZFR5cGVUb1Byb3AodHlwZSwgcHJvcCk7XG4gICAgfSk7XG59O1xuXG4vLyBtYWtlIGFuIE9iaiBmcm9tIHRoZSBnbG9iYWwgc2NvcGVcbmZ1bmN0aW9uIG1rT2JqRnJvbUdsb2JhbFNjb3BlKGdTY29wZSkge1xuICAgIHZhciBnT2JqID0gbmV3IE9ialR5cGUoQVZhbE51bGwsICcqZ2xvYmFsIHNjb3BlKicpO1xuICAgIGdPYmoucHJvcHMgPSBnU2NvcGUudmFyTWFwO1xuICAgIC8vIE92ZXJyaWRlIGdldFByb3AgbWV0aG9kIGZvciBnbG9iYWwgb2JqZWN0XG4gICAgLy8gV2UgaWdub3JlICdyZWFkT25seScgcGFyYW1ldGVyIHRvIGFsd2F5cyByZXR1cm4gaXRzIG93biBwcm9wIEFWYWwgXG4gICAgZ09iai5nZXRQcm9wID0gZnVuY3Rpb24gKHByb3ApIHtcbiAgICAgICAgcmV0dXJuIE9ialR5cGUucHJvdG90eXBlLmdldFByb3AuY2FsbCh0aGlzLCBwcm9wKTtcbiAgICB9O1xuICAgIHJldHVybiBnT2JqO1xufVxuXG4vKipcbiAqIDIuIHByaW1pdGl2ZSB0eXBlc1xuICogQGNvbnN0cnVjdG9yXG4gKiBAcGFyYW0ge3N0cmluZ30gbmFtZVxuICovXG5mdW5jdGlvbiBQcmltVHlwZShuYW1lKSB7XG4gICAgdGhpcy5uYW1lID0gbmFtZTtcbn1cblByaW1UeXBlLnByb3RvdHlwZSA9IE9iamVjdC5jcmVhdGUoVHlwZS5wcm90b3R5cGUpO1xuXG4vKipcbiAqIDMuIGZ1bmN0aW9uIHR5cGVzXG4gKiB0aGUgbmFtZSBpcyB1c2VkIGZvciB0aGUgdHlwZSBvZiB0aGUgaW5zdGFuY2VzIGZyb20gdGhlIGZ1bmN0aW9uXG4gKiBAY29uc3RydWN0b3JcbiAqIEBwYXJhbSB7QVZhbH0gZm5fcHJvdG8gLSBBVmFsIGZvciBjb25zdHJ1Y3RvcidzIC5wcm90b3R5cGVcbiAqIEBwYXJhbSB7c3RyaW5nfSBuYW1lIC0gZ3Vlc3NlZCBuYW1lXG4gKiBAcGFyYW0ge1tzdHJpbmddfSBhcmdOYW1lcyAtIGxpc3Qgb2YgcGFyYW1ldGVyIG5hbWVzXG4gKiBAcGFyYW0ge1Njb3BlfSBzYyAtIGZ1bmN0aW9ucyBzY29wZSBjaGFpbiwgb3IgY2xvc3VyZVxuICogQHBhcmFtIHtub2RlfSBvcmlnaW5Ob2RlIC0gQVNUIG5vZGUgZm9yIHRoZSBmdW5jdGlvblxuICogQHBhcmFtIHtUeXBlfSBhcmdQcm90byAtIHByb3RvdHlwZSBmb3IgYXJndW1lbnRzIG9iamVjdFxuICovXG5mdW5jdGlvbiBGblR5cGUoZm5fcHJvdG8sIG5hbWUsIGFyZ05hbWVzLCBzYywgb3JpZ2luTm9kZSwgYXJnUHJvdG8pIHtcbiAgICBPYmpUeXBlLmNhbGwodGhpcywgZm5fcHJvdG8sIG5hbWUpO1xuICAgIHRoaXMucGFyYW1OYW1lcyA9IGFyZ05hbWVzO1xuICAgIHRoaXMuc2MgPSBzYztcbiAgICB0aGlzLm9yaWdpbk5vZGUgPSBvcmlnaW5Ob2RlO1xuICAgIHRoaXMuYXJnUHJvdG8gPSBhcmdQcm90bztcbiAgICAvLyBmdW5FbnYgOiBDYWxsQ29udGV4dCAtPiBbc2VsZiwgcmV0LCBleGNdXG4gICAgdGhpcy5mdW5FbnYgPSBuZXcgTWFwO1xufVxuRm5UeXBlLnByb3RvdHlwZSA9IE9iamVjdC5jcmVhdGUoT2JqVHlwZS5wcm90b3R5cGUpO1xuXG4vKipcbiAqIGNvbnN0cnVjdCBTdGF0dXMgZm9yIGZ1bmN0aW9uXG4gKiBAcGFyYW0ge0NhbGxDb250ZXh0fSBkZWx0YSAtIGNhbGwgY29udGV4dFxuICogQHJldHVybnMge1tBVmFsLCBBVmFsLCBBVmFsXX0gLSBmb3Igc2VsZiwgcmV0dXJuIGFuZCBleGNlcHRpb24gQVZhbHNcbiAqL1xuRm5UeXBlLnByb3RvdHlwZS5nZXRGdW5FbnYgPSBmdW5jdGlvbiAoZGVsdGEpIHtcbiAgICBpZiAodGhpcy5mdW5FbnYuaGFzKGRlbHRhKSkge1xuICAgICAgICByZXR1cm4gdGhpcy5mdW5FbnYuZ2V0KGRlbHRhKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICB2YXIgdHJpcGxlID0gW25ldyBBVmFsLCBuZXcgQVZhbCwgbmV3IEFWYWxdO1xuICAgICAgICB0aGlzLmZ1bkVudi5zZXQoZGVsdGEsIHRyaXBsZSk7XG4gICAgICAgIHJldHVybiB0cmlwbGU7XG4gICAgfVxufTtcblxuRm5UeXBlLnByb3RvdHlwZS5nZXRBcmd1bWVudHNPYmplY3QgPSBmdW5jdGlvbiAoZGVsdGEpIHtcbiAgICB0aGlzLmFyZ09iak1hcCA9IHRoaXMuYXJnT2JqTWFwIHx8IG5ldyBNYXA7XG4gICAgaWYgKHRoaXMuYXJnT2JqTWFwLmhhcyhkZWx0YSkpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuYXJnT2JqTWFwLmdldChkZWx0YSk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgdmFyIGFyZ09iaiA9IG5ldyBPYmpUeXBlKG5ldyBBVmFsKHRoaXMuYXJnUHJvdG8pLCAnKmFyZ3VtZW50cyBvYmplY3QqJyk7XG4gICAgICAgIHRoaXMuYXJnT2JqTWFwLnNldChkZWx0YSwgYXJnT2JqKTtcbiAgICAgICAgcmV0dXJuIGFyZ09iajtcbiAgICB9XG59O1xuXG4vKipcbiAqIGdldCBPYmplY3QgbWFkZSBieSB0aGUgZnVuY3Rpb25cbiAqIFRPRE86IHVzZSBhZGRpdGlvbmFsIGluZm9ybWF0aW9uIHRvIGNyZWF0ZSBtdWx0aXBsZSBpbnN0YW5jZXNcbiAqIEByZXR1cm5zIHtPYmpUeXBlfVxuICovXG5GblR5cGUucHJvdG90eXBlLmdldEluc3RhbmNlID0gZnVuY3Rpb24gKCkge1xuICAgIC8vIG9iakluc3RhbmNlIGlzIHRoZSBvYmplY3QgbWFkZSBieSB0aGUgZnVuY3Rpb2FublxuICAgIGlmICh0aGlzLm9iakluc3RhbmNlKSByZXR1cm4gdGhpcy5vYmpJbnN0YW5jZTtcbiAgICAvLyB3ZSB1bmlmeSBjb25zdHJ1Y3RvcidzIC5wcm90b3R5cGUgYW5kIGluc3RhbmNlJ3MgX19wcm90b19fXG4gICAgdGhpcy5vYmpJbnN0YW5jZSA9IG5ldyBPYmpUeXBlKHRoaXMuZ2V0UHJvcCgncHJvdG90eXBlJykpO1xuICAgIHJldHVybiB0aGlzLm9iakluc3RhbmNlO1xufTtcblxuLyoqIFxuICogNC4gYXJyYXkgdHlwZXNcbiAqIEBjb25zdHJ1Y3RvclxuICovXG5mdW5jdGlvbiBBcnJUeXBlKGFycl9wcm90bykge1xuICAgIE9ialR5cGUuY2FsbCh0aGlzLCBhcnJfcHJvdG8sICdBcnJheScpO1xufVxuQXJyVHlwZS5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKE9ialR5cGUucHJvdG90eXBlKTtcblxuLy8gTWFrZSBwcmltaXRpdmUgdHlwZXNcbnZhciBQcmltTnVtYmVyID0gbmV3IFByaW1UeXBlKCdudW1iZXInKTtcbnZhciBQcmltU3RyaW5nID0gbmV3IFByaW1UeXBlKCdzdHJpbmcnKTtcbnZhciBQcmltQm9vbGVhbiA9IG5ldyBQcmltVHlwZSgnYm9vbGVhbicpO1xuXG4vLyBBYnNOdWxsIHJlcHJlc2VudHMgYWxsIGVtcHR5IGFic3RyYWN0IHZhbHVlcy5cbnZhciBBVmFsTnVsbCA9IG5ldyBBVmFsKCk7XG4vLyBZb3Ugc2hvdWxkIG5vdCBhZGQgYW55IHByb3BlcnRpZXMgdG8gaXQuXG5BVmFsTnVsbC5wcm9wcyA9IG51bGw7XG4vLyBBZGRpbmcgdHlwZXMgYXJlIGlnbm9yZWQuXG5BVmFsTnVsbC5hZGRUeXBlID0gZnVuY3Rpb24gKCkge307XG5cbmNsYXNzIEFic0NhY2hlIHtcbiAgICBjb25zdHJ1Y3RvcigpIHtcbiAgICAgICAgdGhpcy5tYXAgPSBuZXcgTWFwKCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGlmIG9uZSBleGlzdHMsIGlmIG5vdCBjcmVhdGUgb25lXG4gICAgICogQHBhcmFtIGxvY1xuICAgICAqIEBwYXJhbSBjdHhcbiAgICAgKiBAcmV0dXJucyB7Kn1cbiAgICAgKi9cbiAgICBnZXQobG9jLCBjdHgpIHtcbiAgICAgICAgaWYgKCF0aGlzLm1hcC5oYXMobG9jKSkge1xuICAgICAgICAgICAgLy8gY3JlYXRlIGlubmVyIG1hcFxuICAgICAgICAgICAgdGhpcy5tYXAuc2V0KGxvYywgbmV3IE1hcCgpKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBtYXBMb2MgPSB0aGlzLm1hcC5nZXQobG9jKTtcbiAgICAgICAgaWYgKCFtYXBMb2MuaGFzKGN0eCkpIHtcbiAgICAgICAgICAgIGNvbnN0IGF2ID0gbmV3IEFWYWwoKTtcbiAgICAgICAgICAgIG1hcExvYy5zZXQoY3R4LCBhdik7XG4gICAgICAgICAgICByZXR1cm4gYXY7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByZXR1cm4gbWFwTG9jLmdldChjdHgpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogVG8gdXNlIGF2IG1hZGUgYnkgb3RoZXJzIChlLmcuIHNjb3BlKVxuICAgICAqIEBwYXJhbSBsb2NcbiAgICAgKiBAcGFyYW0gY3R4XG4gICAgICogQHBhcmFtIGF2XG4gICAgICovXG4gICAgc2V0KGxvYywgY3R4LCBhdikge1xuICAgICAgICBpZiAoIXRoaXMubWFwLmhhcyhsb2MpKSB7XG4gICAgICAgICAgICAvLyBjcmVhdGUgaW5uZXIgbWFwXG4gICAgICAgICAgICB0aGlzLm1hcC5zZXQobG9jLCBuZXcgTWFwKCkpO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMubWFwLmdldChsb2MpLnNldChjdHgsIGF2KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDaGVjayB3aGV0aGVyIGl0IGhhcyBvbmUgZm9yIGxvYyBhbmQgY3R4XG4gICAgICogQHBhcmFtIGxvY1xuICAgICAqIEBwYXJhbSBjdHhcbiAgICAgKiBAcmV0dXJucyB7Ym9vbGVhbn1cbiAgICAgKi9cbiAgICBoYXMobG9jLCBjdHgpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMubWFwLmhhcyhsb2MpICYmIHRoaXMubWFwLmdldChsb2MpLmhhcyhjdHgpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBhbGwgdGhlIHR5cGVzIG9mIHRoZSBsb2NcbiAgICAgKiBAcGFyYW0gbG9jXG4gICAgICogQHJldHVybnMgW1R5cGVdXG4gICAgICovXG4gICAgZ2V0VHlwZU9mTG9jKGxvYykge1xuICAgICAgICBpZiAoIXRoaXMubWFwLmhhcyhsb2MpKSB7XG4gICAgICAgICAgICAvLyBubyB0eXBlIGlzIGF2YWlsYWJsZVxuICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgdHBzID0gW107XG4gICAgICAgIGZvciAodmFyIGF2IG9mIHRoaXMubWFwLmdldChsb2MpLnZhbHVlcygpKSB7XG4gICAgICAgICAgICBmb3IgKHZhciB0cCBvZiBhdi5nZXRUeXBlcygpKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRwcy5pbmRleE9mKHRwKSA9PT0gLTEpIHtcbiAgICAgICAgICAgICAgICAgICAgdHBzLnB1c2godHApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdHBzO1xuICAgIH1cbn1cblxuLy8gZXhwb3J0XG5leHBvcnRzLlR5cGUgPSBUeXBlO1xuZXhwb3J0cy5PYmpUeXBlID0gT2JqVHlwZTtcbmV4cG9ydHMuRm5UeXBlID0gRm5UeXBlO1xuZXhwb3J0cy5BcnJUeXBlID0gQXJyVHlwZTtcbmV4cG9ydHMuUHJpbU51bWJlciA9IFByaW1OdW1iZXI7XG5leHBvcnRzLlByaW1TdHJpbmcgPSBQcmltU3RyaW5nO1xuZXhwb3J0cy5QcmltQm9vbGVhbiA9IFByaW1Cb29sZWFuO1xuZXhwb3J0cy5ta09iakZyb21HbG9iYWxTY29wZSA9IG1rT2JqRnJvbUdsb2JhbFNjb3BlO1xuXG5leHBvcnRzLkFWYWwgPSBBVmFsO1xuZXhwb3J0cy5BVmFsTnVsbCA9IEFWYWxOdWxsO1xuXG5leHBvcnRzLkFic0NhY2hlID0gQWJzQ2FjaGU7XG4iLCJjb25zdCBteVdhbGtlciA9IHJlcXVpcmUoJy4vdXRpbC9teVdhbGtlcicpO1xuXG5mdW5jdGlvbiBnZXRUeXBlRGF0YShhc3QsIMSILCBzdGFydCwgZW5kKSB7XG4gICAgJ3VzZSBzdHJpY3QnO1xuICAgIGNvbnN0IG5vZGUgPSBteVdhbGtlci5maW5kU3Vycm91bmRpbmdOb2RlKGFzdCwgc3RhcnQsIGVuZCk7XG4gICAgY29uc3Qgbm9kZVR5cGVzID0gxIguZ2V0VHlwZU9mTG9jKG5vZGUpO1xuICAgIGxldCBoYXNUeXBlO1xuICAgIGxldCB0eXBlU3RyaW5nID0gJyc7XG4gICAgaWYgKCFub2RlVHlwZXMpIHtcbiAgICAgICAgaGFzVHlwZSA9IGZhbHNlO1xuICAgICAgICB0eXBlU3RyaW5nID0gJ05vIGV4cHJlc3Npb24gYXQgdGhlIGdpdmVuIHJhbmdlJztcbiAgICB9IGVsc2Uge1xuICAgICAgICBoYXNUeXBlID0gdHJ1ZTtcbiAgICAgICAgdHlwZVN0cmluZyA9ICcnO1xuICAgICAgICBub2RlVHlwZXMuZm9yRWFjaChmdW5jdGlvbiAodHAsIGkpIHtcbiAgICAgICAgICAgIHR5cGVTdHJpbmcgKz0gdHAuZ2V0TmFtZSgpO1xuICAgICAgICAgICAgaWYgKGkgIT09IG5vZGVUeXBlcy5sZW5ndGggLSAxKSB7XG4gICAgICAgICAgICAgICAgdHlwZVN0cmluZyArPSAnLCAnO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgICAgaGFzVHlwZTogaGFzVHlwZSxcbiAgICAgICAgdHlwZVN0cmluZzogdHlwZVN0cmluZyxcbiAgICAgICAgbm9kZVN0YXJ0OiBub2RlLnN0YXJ0LFxuICAgICAgICBub2RlRW5kOiBub2RlLmVuZFxuICAgIH07XG59XG5cbmV4cG9ydHMuZ2V0VHlwZURhdGEgPSBnZXRUeXBlRGF0YTsiLCIvLyBpbXBvcnQgbmVjZXNzYXJ5IGxpYnJhcmllc1xuY29uc3QgYWNvcm4gPSByZXF1aXJlKCdhY29ybi9kaXN0L2Fjb3JuJyk7XG5jb25zdCBhY29ybl9sb29zZSA9IHJlcXVpcmUoJ2Fjb3JuL2Rpc3QvYWNvcm5fbG9vc2UnKTtcbmNvbnN0IGF1eCA9IHJlcXVpcmUoJy4vYXV4Jyk7XG5jb25zdCB0eXBlcyA9IHJlcXVpcmUoJy4vZG9tYWlucy90eXBlcycpO1xuY29uc3QgY29udGV4dCA9IHJlcXVpcmUoJy4vZG9tYWlucy9jb250ZXh0Jyk7XG5jb25zdCBzdGF0dXMgPSByZXF1aXJlKCcuL2RvbWFpbnMvc3RhdHVzJyk7XG5jb25zdCB2YXJCbG9jayA9IHJlcXVpcmUoJy4vdmFyQmxvY2snKTtcbmNvbnN0IGNHZW4gPSByZXF1aXJlKCcuL2NvbnN0cmFpbnQvY0dlbicpO1xuY29uc3QgdmFyUmVmcyA9IHJlcXVpcmUoJy4vdmFycmVmcycpO1xuY29uc3QgcmV0T2NjdXIgPSByZXF1aXJlKCcuL3JldE9jY3VyJyk7XG5jb25zdCB0aGlzT2NjdXIgPSByZXF1aXJlKCcuL3RoaXNPY2N1cicpO1xuY29uc3QgbXlXYWxrZXIgPSByZXF1aXJlKCcuL3V0aWwvbXlXYWxrZXInKTtcbmNvbnN0IGdldFR5cGVEYXRhID0gcmVxdWlyZSgnLi9nZXRUeXBlRGF0YScpO1xuXG5mdW5jdGlvbiBhbmFseXplKGlucHV0LCByZXRBbGwpIHtcbiAgICAvLyB0aGUgU2NvcGUgb2JqZWN0IGZvciBnbG9iYWwgc2NvcGVcbiAgICAvLyBzY29wZS5TY29wZS5nbG9iYWxTY29wZSA9IG5ldyBzY29wZS5TY29wZShudWxsKTtcblxuICAgIC8vIHBhcnNpbmcgaW5wdXQgcHJvZ3JhbVxuICAgIHZhciBhc3Q7XG4gICAgY29uc3QgYWNvcm5PcHRpb25zID0ge2VjbWFWZXJzaW9uOiA2fTtcbiAgICB0cnkge1xuICAgICAgICBhc3QgPSBhY29ybi5wYXJzZShpbnB1dCwgYWNvcm5PcHRpb25zKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGFzdCA9IGFjb3JuX2xvb3NlLnBhcnNlX2RhbW1pdChpbnB1dCwgYWNvcm5PcHRpb25zKTtcbiAgICB9XG5cbiAgICB2YXIgbm9kZUFycmF5SW5kZXhlZEJ5TGlzdCA9IGF1eC5nZXROb2RlTGlzdChhc3QpO1xuXG4gICAgLy8gU2hvdyBBU1QgYmVmb3JlIHNjb3BlIHJlc29sdXRpb25cbiAgICAvLyBhdXguc2hvd1VuZm9sZGVkKGFzdCk7XG5cbiAgICB2YXJCbG9jay5hbm5vdGF0ZUJsb2NrSW5mbyhhc3QpO1xuICAgIHZhciBnQmxvY2sgPSBhc3RbJ0BibG9jayddO1xuICAgIHZhciBpbml0aWFsQ29udGV4dCA9IG5ldyBjb250ZXh0LkNhbGxTaXRlQ29udGV4dDtcbiAgICB2YXIgZ1Njb3BlID0gZ0Jsb2NrLmdldFNjb3BlSW5zdGFuY2UobnVsbCwgaW5pdGlhbENvbnRleHQpO1xuICAgIHZhciBnT2JqZWN0ID0gdHlwZXMubWtPYmpGcm9tR2xvYmFsU2NvcGUoZ1Njb3BlKTtcbiAgICB2YXIgaW5pdFN0YXR1cyA9IG5ldyBzdGF0dXMuU3RhdHVzKFxuICAgICAgICBnT2JqZWN0LFxuICAgICAgICB0eXBlcy5BVmFsTnVsbCxcbiAgICAgICAgdHlwZXMuQVZhbE51bGwsXG4gICAgICAgIGluaXRpYWxDb250ZXh0LFxuICAgICAgICBnU2NvcGUpO1xuICAgIC8vIHRoZSBwcm90b3R5cGUgb2JqZWN0IG9mIE9iamVjdFxuICAgIHZhciBPYmpQcm90byA9IG5ldyB0eXBlcy5PYmpUeXBlKG51bGwsICdPYmplY3QucHJvdG90eXBlJyk7XG4gICAgdmFyIHJ0Q1ggPSB7XG4gICAgICAgIGdsb2JhbE9iamVjdDogZ09iamVjdCxcbiAgICAgICAgLy8gdGVtcG9yYWxcbiAgICAgICAgcHJvdG9zOiB7XG4gICAgICAgICAgICBPYmplY3Q6IE9ialByb3RvLFxuICAgICAgICAgICAgRnVuY3Rpb246IG5ldyB0eXBlcy5PYmpUeXBlKG5ldyB0eXBlcy5BVmFsKE9ialByb3RvKSwgJ0Z1bmN0aW9uLnByb3RvdHlwZScpLFxuICAgICAgICAgICAgQXJyYXk6IG5ldyB0eXBlcy5PYmpUeXBlKG5ldyB0eXBlcy5BVmFsKE9ialByb3RvKSwgJ0FycmF5LnByb3RvdHlwZScpLFxuICAgICAgICAgICAgUmVnRXhwOiBuZXcgdHlwZXMuT2JqVHlwZShuZXcgdHlwZXMuQVZhbChPYmpQcm90byksICdSZWdFeHAucHJvdG90eXBlJyksXG4gICAgICAgICAgICBTdHJpbmc6IG5ldyB0eXBlcy5PYmpUeXBlKG5ldyB0eXBlcy5BVmFsKE9ialByb3RvKSwgJ1N0cmluZy5wcm90b3R5cGUnKSxcbiAgICAgICAgICAgIE51bWJlcjogbmV3IHR5cGVzLk9ialR5cGUobmV3IHR5cGVzLkFWYWwoT2JqUHJvdG8pLCAnTnVtYmVyLnByb3RvdHlwZScpLFxuICAgICAgICAgICAgQm9vbGVhbjogbmV3IHR5cGVzLk9ialR5cGUobmV3IHR5cGVzLkFWYWwoT2JqUHJvdG8pLCAnQm9vbGVhbi5wcm90b3R5cGUnKVxuICAgICAgICB9LFxuICAgICAgICDEiDogbmV3IHR5cGVzLkFic0NhY2hlKClcbiAgICB9O1xuICAgIGNHZW4uYWRkQ29uc3RyYWludHMoYXN0LCBpbml0U3RhdHVzLCBydENYKTtcbiAgICB2YXIgY29uc3RyYWludHMgPSBjR2VuLmNvbnN0cmFpbnRzO1xuICAgIC8vYXV4LnNob3dVbmZvbGRlZChnQmxvY2tBbmRBbm5vdGF0ZWRBU1QuYXN0KTtcbiAgICAvLyBhdXguc2hvd1VuZm9sZGVkKGNvbnN0cmFpbnRzKTtcbiAgICAvLyBhdXguc2hvd1VuZm9sZGVkKGdCbG9jayk7XG4gICAgLy8gY29uc29sZS5sb2codXRpbC5pbnNwZWN0KGdCbG9jaywge2RlcHRoOiAxMH0pKTtcbiAgICBpZiAocmV0QWxsKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBnT2JqZWN0OiBnT2JqZWN0LFxuICAgICAgICAgICAgQVNUOiBhc3QsXG4gICAgICAgICAgICBnQmxvY2s6IGdCbG9jayxcbiAgICAgICAgICAgIGdTY29wZTogZ1Njb3BlLFxuICAgICAgICAgICAgxIg6IHJ0Q1guxIhcbiAgICAgICAgfTtcbiAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm4gZ09iamVjdDtcbiAgICB9XG59XG5cbmV4cG9ydHMuYW5hbHl6ZSA9IGFuYWx5emU7XG5leHBvcnRzLmZpbmRJZGVudGlmaWVyQXQgPSBteVdhbGtlci5maW5kSWRlbnRpZmllckF0O1xuZXhwb3J0cy5maW5kVmFyUmVmc0F0ID0gdmFyUmVmcy5maW5kVmFyUmVmc0F0O1xuZXhwb3J0cy5vbkZ1bmN0aW9uT3JSZXR1cm5LZXl3b3JkID0gcmV0T2NjdXIub25GdW5jdGlvbk9yUmV0dXJuS2V5d29yZDtcbmV4cG9ydHMuZmluZFJldHVyblN0YXRlbWVudHMgPSByZXRPY2N1ci5maW5kUmV0dXJuU3RhdGVtZW50cztcbmV4cG9ydHMub25UaGlzS2V5d29yZCA9IHRoaXNPY2N1ci5vblRoaXNLZXl3b3JkO1xuZXhwb3J0cy5maW5kVGhpc0V4cHJlc3Npb25zID0gdGhpc09jY3VyLmZpbmRUaGlzRXhwcmVzc2lvbnM7XG5leHBvcnRzLmZpbmRTdXJyb3VuZGluZ05vZGUgPSBteVdhbGtlci5maW5kU3Vycm91bmRpbmdOb2RlO1xuZXhwb3J0cy5nZXRUeXBlRGF0YSA9IGdldFR5cGVEYXRhLmdldFR5cGVEYXRhO1xuIiwiY29uc3Qgd2FsayA9IHJlcXVpcmUoJ2Fjb3JuL2Rpc3Qvd2FsaycpO1xuY29uc3QgbXlXYWxrZXIgPSByZXF1aXJlKCcuL3V0aWwvbXlXYWxrZXInKTtcblxuLyoqXG4gKiBDaGVjayB3aGV0aGVyIGdpdmVuIHBvcyBpcyBvbiBhIGZ1bmN0aW9uIGtleXdvcmRcbiAqIEBwYXJhbSBhc3QgLSBBU1Qgb2YgYSBwcm9ncmFtXG4gKiBAcGFyYW0gcG9zIC0gaW5kZXggcG9zaXRpb25cbiAqIEByZXR1cm5zIHsqfSAtIGZ1bmN0aW9uIG5vZGUgb3IgbnVsbFxuICovXG5mdW5jdGlvbiBvbkZ1bmN0aW9uT3JSZXR1cm5LZXl3b3JkKGFzdCwgcG9zKSB7XG4gICAgXCJ1c2Ugc3RyaWN0XCI7XG5cbiAgICAvLyBmaW5kIGZ1bmN0aW9uIG5vZGVcbiAgICAvLyBzdCBpcyB0aGUgZW5jbG9zaW5nIGZ1bmN0aW9uXG4gICAgY29uc3Qgd2Fsa2VyID0gbXlXYWxrZXIud3JhcFdhbGtlcih3YWxrLmJhc2UsXG4gICAgICAgIC8vIHByZVxuICAgICAgICAobm9kZSwgc3QpID0+IHtcbiAgICAgICAgICAgIGlmIChub2RlLnN0YXJ0ID4gcG9zIHx8IG5vZGUuZW5kIDwgcG9zKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBvbiBhIGZ1bmN0aW9uIGtleXdvcmQsIDggaXMgdGhlIGxlbmd0aCBvZiAnZnVuY3Rpb24nXG4gICAgICAgICAgICAvLyBvciBvbiByZXR1cm4ga2V5d29yZCwgNiBpcyB0aGUgbGVuZ3RoIG9mICdyZXR1cm4nXG4gICAgICAgICAgICBpZiAoKChub2RlLnR5cGUgPT09ICdGdW5jdGlvbkRlY2xhcmF0aW9uJyB8fCBub2RlLnR5cGUgPT09ICdGdW5jdGlvbkV4cHJlc3Npb24nKVxuICAgICAgICAgICAgICAgICYmIChub2RlLnN0YXJ0IDw9IHBvcyAmJiBwb3MgPD0gbm9kZS5zdGFydCArIDgpKVxuICAgICAgICAgICAgICAgIHx8XG4gICAgICAgICAgICAgICAgKG5vZGUudHlwZSA9PT0gJ1JldHVyblN0YXRlbWVudCdcbiAgICAgICAgICAgICAgICAmJiAobm9kZS5zdGFydCA8PSBwb3MgJiYgcG9zIDw9IG5vZGUuc3RhcnQgKyA2KSkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBzdDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuICAgICAgICAvLyBwb3N0XG4gICAgICAgIHVuZGVmaW5lZCxcbiAgICAgICAgLy8gc3RDaGFuZ2VcbiAgICAgICAgKG5vZGUsIHN0KSA9PiB7XG4gICAgICAgICAgICBpZiAobm9kZS50eXBlID09PSAnRnVuY3Rpb25EZWNsYXJhdGlvbidcbiAgICAgICAgICAgICAgICB8fCBub2RlLnR5cGUgPT09ICdGdW5jdGlvbkV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG5vZGU7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJldHVybiBzdDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICB0cnkge1xuICAgICAgICB3YWxrLnJlY3Vyc2l2ZShhc3QsIHVuZGVmaW5lZCwgd2Fsa2VyKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGlmIChlICYmIGUudHlwZSAmJlxuICAgICAgICAgICAgKGUudHlwZSA9PT0gJ0Z1bmN0aW9uRXhwcmVzc2lvbidcbiAgICAgICAgICAgIHx8IGUudHlwZSA9PT0gJ0Z1bmN0aW9uRGVjbGFyYXRpb24nKSkge1xuICAgICAgICAgICAgcmV0dXJuIGU7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aHJvdyBlO1xuICAgICAgICB9XG4gICAgfVxuICAgIC8vIGlkZW50aWZpZXIgbm90IGZvdW5kXG4gICAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICogR2l2ZW4gYSBmdW5jdGlvbiBub2RlLCBmaW5kIGl0cyByZXR1cm4gbm9kZXNcbiAqXG4gKiBAcGFyYW0gZk5vZGUgLSBBU1Qgbm9kZSBvZiBhIGZ1bmN0aW9uLCBwb3NzaWJseSB3aXRoIG5vIGFubm90YXRpb25cbiAqIEByZXR1cm5zIHsqfSAtIGFycmF5IG9mIEFTVCBub2Rlc1xuICovXG5mdW5jdGlvbiBnZXRSZXR1cm5Ob2RlcyhmTm9kZSkge1xuICAgIFwidXNlIHN0cmljdFwiO1xuICAgIGNvbnN0IHJldHMgPSBbXTtcbiAgICBpZiAoZk5vZGUudHlwZSAhPT0gJ0Z1bmN0aW9uRXhwcmVzc2lvbidcbiAgICAgICAgJiYgZk5vZGUudHlwZSAhPT0gJ0Z1bmN0aW9uRGVjbGFyYXRpb24nKSB7XG4gICAgICAgIHRocm93IEVycm9yKCdmTm9kZSBzaG91bGQgYmUgYSBmdW5jdGlvbiBub2RlJyk7XG4gICAgfVxuXG4gICAgY29uc3Qgd2Fsa2VyID0gd2Fsay5tYWtlKHtcbiAgICAgICAgUmV0dXJuU3RhdGVtZW50OiAobm9kZSkgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIHJldHMucHVzaChub2RlKTtcbiAgICAgICAgfSxcbiAgICAgICAgRnVuY3Rpb246ICgpID0+IHtcbiAgICAgICAgICAgIC8vIG5vdCB2aXNpdCBpbm5lciBmdW5jdGlvbnNcbiAgICAgICAgfVxuICAgIH0sIHdhbGsuYmFzZSk7XG5cbiAgICB3YWxrLnJlY3Vyc2l2ZShmTm9kZS5ib2R5LCB1bmRlZmluZWQsIHdhbGtlcik7XG5cbiAgICByZXR1cm4gcmV0cztcbn1cblxuLyoqXG4gKiBGaW5kIHJldHVybiBub2RlcyBjb3JyZXNwb25kaW5nIHRvIHRoZSBwb3NpdGlvblxuICogaWYgdGhlIHBvcyBpcyBvbiBhIGZ1bmN0aW9uIGtleXdvcmRcbiAqXG4gKiBAcGFyYW0gYXN0IC0gQVNUIG5vZGUgb2YgYSBwcm9ncmFtLCBwb3NzaWJseSB3aXRoIG5vIGFubm90YXRpb25cbiAqIEBwYXJhbSBwb3MgLSBjdXJzb3IgcG9zaXRpb25cbiAqIEBwYXJhbSBpbmNsdWRlRnVuY3Rpb25LZXl3b3JkIC0gd2hldGhlciB0byBpbmNsdWRlIGZ1bmN0aW9uIGtleXdvcmQgcmFuZ2VcbiAqIEByZXR1cm5zIHtBcnJheX0gLSBhcnJheSBvZiBBU1Qgbm9kZXMgb2YgcmV0dXJuIHN0YXRlbWVudHNcbiAqL1xuZnVuY3Rpb24gZmluZFJldHVyblN0YXRlbWVudHMoYXN0LCBwb3MsIGluY2x1ZGVGdW5jdGlvbktleXdvcmQpIHtcbiAgICBcInVzZSBzdHJpY3RcIjtcblxuICAgIGNvbnN0IGZOb2RlID0gb25GdW5jdGlvbk9yUmV0dXJuS2V5d29yZChhc3QsIHBvcyk7XG4gICAgaWYgKCFmTm9kZSkge1xuICAgICAgICAvLyBwb3MgaXMgbm90IG9uIGZ1bmN0aW9uIGtleXdvcmRcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuXG4gICAgY29uc3QgcmV0cyA9IGdldFJldHVybk5vZGVzKGZOb2RlKTtcbiAgICAvLyB3aGVuIGZ1bmN0aW9uIGRvZXMgbm90IGhhdmUgcmV0dXJuIHN0YXRlbWVudHMsXG4gICAgLy8gaW5kaWNhdGUgaXQgYnkgdGhlIGNsb3NpbmcgYnJhY2Ugb2YgdGhlIGZ1bmN0aW9uIGJvZHlcbiAgICBpZiAocmV0cy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgcmV0cy5wdXNoKHtzdGFydDogZk5vZGUuZW5kIC0gMSwgZW5kOiBmTm9kZS5lbmR9KTtcbiAgICB9XG4gICAgaWYgKGluY2x1ZGVGdW5jdGlvbktleXdvcmQpIHtcbiAgICAgICAgcmV0cy5wdXNoKHtzdGFydDogZk5vZGUuc3RhcnQsIGVuZDogZk5vZGUuc3RhcnQgKyA4fSk7XG4gICAgfVxuICAgIHJldHVybiByZXRzO1xufVxuXG5leHBvcnRzLm9uRnVuY3Rpb25PclJldHVybktleXdvcmQgPSBvbkZ1bmN0aW9uT3JSZXR1cm5LZXl3b3JkO1xuZXhwb3J0cy5maW5kUmV0dXJuU3RhdGVtZW50cyA9IGZpbmRSZXR1cm5TdGF0ZW1lbnRzOyIsImNvbnN0IHdhbGsgPSByZXF1aXJlKCdhY29ybi9kaXN0L3dhbGsnKTtcbmNvbnN0IG15V2Fsa2VyID0gcmVxdWlyZSgnLi91dGlsL215V2Fsa2VyJyk7XG5cbi8qKlxuICogQ2hlY2sgd2hldGhlciBnaXZlbiBwb3MgaXMgb24gYSB0aGlzIGtleXdvcmRcbiAqIEBwYXJhbSBhc3QgLSBBU1Qgb2YgYSBwcm9ncmFtXG4gKiBAcGFyYW0gcG9zIC0gaW5kZXggcG9zaXRpb25cbiAqIEByZXR1cm5zIHsqfSAtIGZ1bmN0aW9uIG5vZGUgb3IgbnVsbFxuICovXG5mdW5jdGlvbiBvblRoaXNLZXl3b3JkKGFzdCwgcG9zKSB7XG4gICAgXCJ1c2Ugc3RyaWN0XCI7XG5cbiAgICAvLyBmaW5kIGZ1bmN0aW9uIG5vZGVcbiAgICAvLyBzdCBpcyB0aGUgZW5jbG9zaW5nIGZ1bmN0aW9uXG4gICAgY29uc3Qgd2Fsa2VyID0gbXlXYWxrZXIud3JhcFdhbGtlcih3YWxrLmJhc2UsXG4gICAgICAgIC8vIHByZVxuICAgICAgICAobm9kZSwgc3QpID0+IHtcbiAgICAgICAgICAgIGlmIChub2RlLnN0YXJ0ID4gcG9zIHx8IG5vZGUuZW5kIDwgcG9zKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAobm9kZS50eXBlID09PSAnVGhpc0V4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgc3Q7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSxcbiAgICAgICAgLy8gcG9zdFxuICAgICAgICB1bmRlZmluZWQsXG4gICAgICAgIC8vIHN0Q2hhbmdlXG4gICAgICAgIChub2RlLCBzdCkgPT4ge1xuICAgICAgICAgICAgaWYgKG5vZGUudHlwZSA9PT0gJ0Z1bmN0aW9uRGVjbGFyYXRpb24nXG4gICAgICAgICAgICAgICAgfHwgbm9kZS50eXBlID09PSAnRnVuY3Rpb25FeHByZXNzaW9uJykge1xuICAgICAgICAgICAgICAgIHJldHVybiBub2RlO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gc3Q7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgdHJ5IHtcbiAgICAgICAgd2Fsay5yZWN1cnNpdmUoYXN0LCB1bmRlZmluZWQsIHdhbGtlcik7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAoZSAmJiBlLnR5cGUgJiZcbiAgICAgICAgICAgIChlLnR5cGUgPT09ICdGdW5jdGlvbkV4cHJlc3Npb24nXG4gICAgICAgICAgICB8fCBlLnR5cGUgPT09ICdGdW5jdGlvbkRlY2xhcmF0aW9uJykpIHtcbiAgICAgICAgICAgIHJldHVybiBlO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhyb3cgZTtcbiAgICAgICAgfVxuICAgIH1cbiAgICAvLyBpZGVudGlmaWVyIG5vdCBmb3VuZFxuICAgIHJldHVybiBudWxsO1xufVxuXG4vKipcbiAqIEdpdmVuIGEgZnVuY3Rpb24gbm9kZSwgZmluZCBpdHMgdGhpcyBub2Rlc1xuICpcbiAqIEBwYXJhbSBmTm9kZSAtIEFTVCBub2RlIG9mIGEgZnVuY3Rpb24sIHBvc3NpYmx5IHdpdGggbm8gYW5ub3RhdGlvblxuICogQHJldHVybnMgeyp9IC0gYXJyYXkgb2YgQVNUIG5vZGVzXG4gKi9cbmZ1bmN0aW9uIGdldFRoaXNOb2RlcyhmTm9kZSkge1xuICAgIFwidXNlIHN0cmljdFwiO1xuICAgIGNvbnN0IHJldHMgPSBbXTtcbiAgICBpZiAoZk5vZGUudHlwZSAhPT0gJ0Z1bmN0aW9uRXhwcmVzc2lvbidcbiAgICAgICAgJiYgZk5vZGUudHlwZSAhPT0gJ0Z1bmN0aW9uRGVjbGFyYXRpb24nKSB7XG4gICAgICAgIHRocm93IEVycm9yKCdmTm9kZSBzaG91bGQgYmUgYSBmdW5jdGlvbiBub2RlJyk7XG4gICAgfVxuXG4gICAgY29uc3Qgd2Fsa2VyID0gd2Fsay5tYWtlKHtcbiAgICAgICAgVGhpc0V4cHJlc3Npb246IChub2RlKSA9PiB7XG4gICAgICAgICAgICByZXR1cm4gcmV0cy5wdXNoKG5vZGUpO1xuICAgICAgICB9LFxuICAgICAgICBGdW5jdGlvbjogKCkgPT4ge1xuICAgICAgICAgICAgLy8gbm90IHZpc2l0IGlubmVyIGZ1bmN0aW9uc1xuICAgICAgICB9XG4gICAgfSwgd2Fsay5iYXNlKTtcblxuICAgIHdhbGsucmVjdXJzaXZlKGZOb2RlLmJvZHksIHVuZGVmaW5lZCwgd2Fsa2VyKTtcblxuICAgIHJldHVybiByZXRzO1xufVxuXG4vKipcbiAqIEZpbmQgdGhpcyBub2RlcyBpZiB0aGUgcG9zIGlzIG9uIGEgdGhpcyBrZXl3b3JkXG4gKlxuICogQHBhcmFtIGFzdCAtIEFTVCBub2RlIG9mIGEgcHJvZ3JhbSwgcG9zc2libHkgd2l0aCBubyBhbm5vdGF0aW9uXG4gKiBAcGFyYW0gcG9zIC0gY3Vyc29yIHBvc2l0aW9uXG4gKiBAcGFyYW0gaW5jbHVkZUZ1bmN0aW9uS2V5d29yZCAtIHdoZXRoZXIgdG8gaW5jbHVkZSBmdW5jdGlvbiBrZXl3b3JkIHJhbmdlXG4gKiBAcmV0dXJucyB7QXJyYXl9IC0gYXJyYXkgb2YgQVNUIG5vZGVzIG9mIHJldHVybiBzdGF0ZW1lbnRzXG4gKi9cbmZ1bmN0aW9uIGZpbmRUaGlzRXhwcmVzc2lvbnMoYXN0LCBwb3MsIGluY2x1ZGVGdW5jdGlvbktleXdvcmQpIHtcbiAgICBcInVzZSBzdHJpY3RcIjtcblxuICAgIGNvbnN0IGZOb2RlID0gb25UaGlzS2V5d29yZChhc3QsIHBvcyk7XG4gICAgaWYgKCFmTm9kZSkge1xuICAgICAgICAvLyBwb3MgaXMgbm90IG9uIHRoaXMga2V5d29yZFxuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICBjb25zdCByZXRzID0gZ2V0VGhpc05vZGVzKGZOb2RlKTtcbiAgICBpZiAoaW5jbHVkZUZ1bmN0aW9uS2V5d29yZCkge1xuICAgICAgICByZXRzLnB1c2goe3N0YXJ0OiBmTm9kZS5zdGFydCwgZW5kOiBmTm9kZS5zdGFydCArIDh9KTtcbiAgICB9XG4gICAgcmV0dXJuIHJldHM7XG59XG5cbmV4cG9ydHMub25UaGlzS2V5d29yZCA9IG9uVGhpc0tleXdvcmQ7XG5leHBvcnRzLmZpbmRUaGlzRXhwcmVzc2lvbnMgPSBmaW5kVGhpc0V4cHJlc3Npb25zOyIsImNvbnN0IHdhbGsgPSByZXF1aXJlKCdhY29ybi9kaXN0L3dhbGsnKTtcblxuLyoqXG4gKiBhIHdhbGtlciB0aGF0IHZpc2l0cyBlYWNoIGlkIGV2ZW4gdGhvdWdoIGl0IGlzIHZhciBkZWNsYXJhdGlvblxuICogdGhlIHBhcmFtZXRlciB2YiBkZW5vdGUgdmFyQmxvY2tcbiAqL1xuY29uc3QgdmFyV2Fsa2VyPSB3YWxrLm1ha2Uoe1xuICAgIEZ1bmN0aW9uOiBmdW5jdGlvbiAobm9kZSwgdmIsIGMpIHtcbiAgICAgICAgJ3VzZSBzdHJpY3QnO1xuICAgICAgICBjb25zdCBpbm5lclZiID0gbm9kZS5ib2R5WydAYmxvY2snXTtcbiAgICAgICAgaWYgKG5vZGUuaWQpIGMobm9kZS5pZCwgaW5uZXJWYik7XG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgbm9kZS5wYXJhbXMubGVuZ3RoOyBpKyspXG4gICAgICAgICAgICBjKG5vZGUucGFyYW1zW2ldLCBpbm5lclZiKTtcbiAgICAgICAgYyhub2RlLmJvZHksIGlubmVyVmIpO1xuICAgIH0sXG4gICAgVHJ5U3RhdGVtZW50OiBmdW5jdGlvbiAobm9kZSwgdmIsIGMpIHtcbiAgICAgICAgYyhub2RlLmJsb2NrLCB2Yik7XG4gICAgICAgIGlmIChub2RlLmhhbmRsZXIpIHtcbiAgICAgICAgICAgIGMobm9kZS5oYW5kbGVyLCB2Yik7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG5vZGUuZmluYWxpemVyKSB7XG4gICAgICAgICAgICBjKG5vZGUuZmluYWxpemVyLCB2Yik7XG4gICAgICAgIH1cbiAgICB9LFxuICAgIENhdGNoQ2xhdXNlOiBmdW5jdGlvbiAobm9kZSwgdmIsIGMpIHtcbiAgICAgICAgY29uc3QgY2F0Y2hWYiA9IG5vZGUuYm9keVsnQGJsb2NrJ107XG4gICAgICAgIGMobm9kZS5wYXJhbSwgY2F0Y2hWYik7XG4gICAgICAgIGMobm9kZS5ib2R5LCBjYXRjaFZiKTtcbiAgICB9LFxuICAgIFZhcmlhYmxlRGVjbGFyYXRpb246IGZ1bmN0aW9uIChub2RlLCB2YiwgYykge1xuICAgICAgICAndXNlIHN0cmljdCc7XG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgbm9kZS5kZWNsYXJhdGlvbnMubGVuZ3RoOyArK2kpIHtcbiAgICAgICAgICAgIGNvbnN0IGRlY2wgPSBub2RlLmRlY2xhcmF0aW9uc1tpXTtcbiAgICAgICAgICAgIGMoZGVjbC5pZCwgdmIpO1xuICAgICAgICAgICAgaWYgKGRlY2wuaW5pdCkgYyhkZWNsLmluaXQsIHZiKTtcbiAgICAgICAgfVxuICAgIH0sXG4gICAgVmFyaWFibGVQYXR0ZXJuOiBmdW5jdGlvbiAobm9kZSwgdmIsIGMpIHtcbiAgICAgICAgJ3VzZSBzdHJpY3QnO1xuICAgICAgICBjKG5vZGUsIHZiLCAnSWRlbnRpZmllcicpO1xuICAgIH1cbn0pO1xuXG4vKipcbiAqIFdyYXAgYSB3YWxrZXIgd2l0aCBwcmUtIGFuZCBwb3N0LSBhY3Rpb25zXG4gKlxuICogQHBhcmFtIHByZU5vZGUgLSBBcHBseSBiZWZvcmUgdmlzaXRpbmcgdGhlIGN1cnJlbnQgbm9kZS5cbiAqIElmIHJldHVybnMgZmFsc2UsIGRvIG5vdCB2aXNpdCB0aGUgbm9kZS5cbiAqIEBwYXJhbSBwb3N0Tm9kZSAtIEFwcGx5IGFmdGVyIHZpc2l0aW5nIHRoZSBjdXJyZW50IG5vZGUuXG4gKiBJZiBnaXZlbiwgcmV0dXJuIHZhbHVlcyBhcmUgb3ZlcnJpZGRlbi5cbiAqIEByZXR1cm5zIHsqfSAtIGEgbmV3IHdhbGtlclxuICovXG5mdW5jdGlvbiB3cmFwV2Fsa2VyKHdhbGtlciwgcHJlTm9kZSwgcG9zdE5vZGUsIHN0Q2hhbmdlKSB7XG4gICAgJ3VzZSBzdHJpY3QnO1xuICAgIGNvbnN0IHJldFdhbGtlciA9IHt9O1xuICAgIC8vIHdyYXBwaW5nIGVhY2ggZnVuY3Rpb24gcHJlTm9kZSBhbmQgcG9zdE5vZGVcbiAgICBmb3IgKGxldCBub2RlVHlwZSBpbiB3YWxrZXIpIHtcbiAgICAgICAgaWYgKCF3YWxrZXIuaGFzT3duUHJvcGVydHkobm9kZVR5cGUpKSB7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICByZXRXYWxrZXJbbm9kZVR5cGVdID0gKG5vZGUsIHN0LCBjKSA9PiB7XG4gICAgICAgICAgICBsZXQgcmV0O1xuICAgICAgICAgICAgbGV0IG5ld1N0ID0gc3Q7XG4gICAgICAgICAgICBpZiAoc3RDaGFuZ2UpIHtcbiAgICAgICAgICAgICAgICBuZXdTdCA9IHN0Q2hhbmdlKG5vZGUsIHN0KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICghcHJlTm9kZSB8fCBwcmVOb2RlKG5vZGUsIG5ld1N0LCBjKSkge1xuICAgICAgICAgICAgICAgIHJldCA9IHdhbGtlcltub2RlVHlwZV0obm9kZSwgbmV3U3QsIGMpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAocG9zdE5vZGUpIHtcbiAgICAgICAgICAgICAgICByZXQgPSBwb3N0Tm9kZShub2RlLCBuZXdTdCwgYyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gcmV0O1xuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiByZXRXYWxrZXI7XG59XG5cblxuY2xhc3MgRm91bmQge1xuICAgIGNvbnN0cnVjdG9yKGluZm8pIHtcbiAgICAgICAgdGhpcy5pbmZvID0gaW5mbztcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGZpbmRJZGVudGlmaWVyQXQoYXN0LCBwb3MpIHtcbiAgICBcInVzZSBzdHJpY3RcIjtcblxuICAgIC8vIGZpbmQgdGhlIG5vZGVcbiAgICBjb25zdCB3YWxrZXIgPSB3cmFwV2Fsa2VyKHZhcldhbGtlcixcbiAgICAgICAgKG5vZGUsIHZiKSA9PiB7XG4gICAgICAgICAgICBpZiAobm9kZS5zdGFydCA+IHBvcyB8fCBub2RlLmVuZCA8IHBvcykge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChub2RlLnR5cGUgPT09ICdJZGVudGlmaWVyJyAmJiBub2RlLm5hbWUgIT09ICfinJYnKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEZvdW5kKHtub2RlOiBub2RlLCB2YjogdmJ9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9KTtcblxuICAgIHRyeSB7XG4gICAgICAgIHdhbGsucmVjdXJzaXZlKGFzdCwgYXN0WydAYmxvY2snXSwgd2Fsa2VyKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGlmIChlIGluc3RhbmNlb2YgRm91bmQpIHtcbiAgICAgICAgICAgIHJldHVybiBlLmluZm87XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aHJvdyBlO1xuICAgICAgICB9XG4gICAgfVxuICAgIC8vIGlkZW50aWZpZXIgbm90IGZvdW5kXG4gICAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIGZpbmRTdXJyb3VuZGluZ05vZGUoYXN0LCBzdGFydCwgZW5kKSB7XG4gICAgXCJ1c2Ugc3RyaWN0XCI7XG5cbiAgICBjb25zdCB3YWxrZXIgPSB3cmFwV2Fsa2VyKHZhcldhbGtlcixcbiAgICAgICAgbm9kZSA9PiAhKG5vZGUuc3RhcnQgPiBzdGFydCB8fCBub2RlLmVuZCA8IGVuZCksXG4gICAgICAgIG5vZGUgPT4geyB0aHJvdyBuZXcgRm91bmQobm9kZSk7IH1cbiAgICApO1xuXG4gICAgdHJ5IHtcbiAgICAgICAgd2Fsay5yZWN1cnNpdmUoYXN0LCB1bmRlZmluZWQsIHdhbGtlcik7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAoZSBpbnN0YW5jZW9mIEZvdW5kKSB7XG4gICAgICAgICAgICByZXR1cm4gZS5pbmZvO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhyb3cgZTtcbiAgICAgICAgfVxuICAgIH1cbiAgICAvLyBub2RlIG5vdCBmb3VuZFxuICAgIHJldHVybiBudWxsO1xufVxuXG5leHBvcnRzLkZvdW5kID0gRm91bmQ7XG5leHBvcnRzLndyYXBXYWxrZXIgPSB3cmFwV2Fsa2VyO1xuZXhwb3J0cy52YXJXYWxrZXIgPSB2YXJXYWxrZXI7XG5leHBvcnRzLmZpbmRJZGVudGlmaWVyQXQgPSBmaW5kSWRlbnRpZmllckF0O1xuZXhwb3J0cy5maW5kU3Vycm91bmRpbmdOb2RlID0gZmluZFN1cnJvdW5kaW5nTm9kZTsiLCIvKlxuIEphdmFTY3JpcHTripQgZ2xvYmFsLCBmdW5jdGlvbiBibG9jaywgY2F0Y2ggYmxvY2vsl5Ag67OA7IiY6rCAIOuLrOumsOuLpC5cbiBFUzbripQg7J2867CYIGJsb2Nr7JeQ64+EIOuLrOumsOuLpC5cblxuIFZhckJsb2Nr64qUIOqwgSBibG9ja+yXkCDri6zrprAg67OA7IiY65Ok7J2EIOuCmO2DgOuCuOuLpC5cbiAtIHBhcmVuICAgICAgOiBCbG9ja1ZhcnMsIOuwlOq5pSBibG9ja+ydhCDrgpjtg4DrgrTripQg6rCd7LK0XG4gLSBvcmlnaW5MYWJlbDogbnVtYmVyLCDtlbTri7kgQmxvY2tWYXJz6rCAIOyEoOyWuOuQnCBBU1Qgbm9kZeydmCBAbGFiZWxcbiAgICBvcmlnaW7snbQg65CgIOyImCDsnojripQgbm9kZeuKlFxuICAgIEZ1bmN0aW9uLmJvZHksIENhdGNoQ2xhdXNlLmJsb2NrIOuRkOqwgOyngOuLpC5cbiAgICDrkZDqsIDsp4Ag66qo65GQIEJsb2NrU3RhdGVtZW507J2064ukLlxuIC0gaXNDYXRjaCAgICA6IGJvb2xlYW4sXG4gICAqIHRydWUgIC0+IGNhdGNoIGJsb2NrXG4gICAqIGZhbHNlIC0+IGZ1bmN0aW9uIGJsb2NrLCBvciBnbG9iYWxcblxuIC0gcGFyYW1WYXJOYW1lcyA6IOunpOqwnOuzgOyImCDsnbTrpoQg66qp66GdLCDrp6TqsJwg67OA7IiYIOyInOyEnOuMgOuhnFxuIC0gbG9jYWxWYXJOYW1lcyA6IOyngOyXrSDrs4DsiJgg7J2066aEIOuqqeuhnSwg7Iic7IScIOustOydmOuvuFxuICAgIGFyZ3VtZW50c+ulvCDsgqzsmqntlZjripQg6rK97JqwIGxvY2FsVmFyTmFtZXPsl5Ag65Ox7J6l7ZWY6rOgLFxuICAgIGFyZ3VtZW50cyBvYmplY3Trpbwg7IKs7Jqp7ZWY66m0IHVzZUFyZ3VtZW50c09iamVjdCA9PSB0cnVlXG5cbiAtIChvcHRpb25hbCkgdXNlQXJndW1lbnRzT2JqZWN0OiBib29sZWFuXG4gICAg7ZWo7IiYIGJvZHkgYmxvY2vsnbgg6rK97Jqw7JeQ66eMIOyCrOyaqSDqsIDriqVcbiAgICAqIHRydWUgIDogYXJndW1lbnRzIG9iamVjdOqwgCDsgqzsmqnrkJjsl4jri6QuXG4gICAgICDspokg7ZWo7IiYIGJvZHnsl5DshJwg67OA7IiYIGFyZ3VtZW50c+ulvCDshKDslrgg7JeG7J20IOyCrOyaqe2WiOuLpC5cbiAgICAgIOydtCDqsr3smrAsIGFyZ3VtZW50c+uKlCDtlajsiJjsnZgg7KeA7JetIOuzgOyImOuhnCDrk7HroZ3rkJzri6QuXG4gICAgKiBmYWxzZSDsnbgg6rK97Jqw64qUIOyXhuuLpC4g6re465+06rGw66m0IOyVhOyYiCDrs4DsiJgg7J6Q7LK06rCAIOyXhuuLpC5cblxuIC0gdXNlZFZhcmlhYmxlcyA6IOqwgSBibG9ja+ydmCDrp6TqsJzrs4DsiJgsIOyngOyXreuzgOyImCDspJFcbiAgIOyCrOyaqeuQmOuKlCDsnITsuZjqsIAg7J6I64qUIOqyg+uTpOydmCDrqqnroZ1cblxuIC0gaW5zdGFuY2VzIDogRGVsdGEgLT4gVmFyQmxvY2vsnZgg67OA7IiY65OkIC0+IEFWYWxcbiAgIGdldEluc3RhbmNlKGRlbHRhKSDrpbwg7Ya17ZW0IOqwmeydgCBkZWx0YeuKlCDqsJnsnYAgbWFwcGluZyDso7zqsowg66eM65OsXG5cbiAtIHNjb3BlSW5zdGFuY2VzIDogW1Njb3BlXVxuICAg7ZiE7J6sIFZhckJsb2Nr7J2EIOuniOyngOunieycvOuhnCDtlZjripQgU2NvcGXrpbwg66qo65GQIOuqqOydgOuLpC5cbiAgIGdldFNjb3BlSW5zdGFuY2UoZGVsdGEsIHBhcmVuKSDsnYQg7Ya17ZW0IOqwmeydgCBzY29wZSBjaGFpbuydgFxuICAg6rCZ7J2AIOqwneyytOqwgCDrkJjrj4TroZ0g66eM65Og64ukLlxuKi9cbid1c2Ugc3RyaWN0JztcblxudmFyIHR5cGVzID0gcmVxdWlyZSgnLi9kb21haW5zL3R5cGVzJyk7XG52YXIgd2FsayA9IHJlcXVpcmUoJ2Fjb3JuL2Rpc3Qvd2FsaycpO1xudmFyIGF1eCA9IHJlcXVpcmUoJy4vYXV4Jyk7XG5cbmZ1bmN0aW9uIFZhckJsb2NrKHBhcmVuLCBvcmlnaW5Ob2RlLCBpc0NhdGNoKSB7XG4gICAgdGhpcy5wYXJlbiA9IHBhcmVuO1xuICAgIHRoaXMub3JpZ2luTm9kZSA9IG9yaWdpbk5vZGU7XG4gICAgdGhpcy5vcmlnaW5MYWJlbCA9IG9yaWdpbk5vZGVbJ0BsYWJlbCddO1xuICAgIHRoaXMuaXNDYXRjaCA9IGlzQ2F0Y2g7XG4gICAgdGhpcy5wYXJhbVZhck5hbWVzID0gW107XG4gICAgdGhpcy5sb2NhbFZhck5hbWVzID0gW107XG5cbiAgICB0aGlzLnVzZWRWYXJpYWJsZXMgPSBbXTtcbiAgICAvLyB0aGlzLnVzZUFyZ3VtZW50c09iamVjdFxuICAgIHRoaXMuaW5zdGFuY2VzID0gT2JqZWN0LmNyZWF0ZShudWxsKTtcbiAgICB0aGlzLnNjb3BlSW5zdGFuY2VzID0gW107XG59XG5cblZhckJsb2NrLnByb3RvdHlwZSA9IE9iamVjdC5jcmVhdGUobnVsbCk7XG5cblZhckJsb2NrLnByb3RvdHlwZS5pc0dsb2JhbCA9IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gdGhpcy5wYXJlbiA9PSBudWxsO1xufTtcblZhckJsb2NrLnByb3RvdHlwZS5pc0Z1bmN0aW9uID0gZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0aGlzLnBhcmVuICE9IG51bGwgJiYgdGhpcy5sb2NhbFZhck5hbWVzICE9IG51bGw7XG59O1xuVmFyQmxvY2sucHJvdG90eXBlLmlzQ2F0Y2hCbG9jayA9IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gdGhpcy5pc0NhdGNoO1xufTtcblxuVmFyQmxvY2sucHJvdG90eXBlLmdldExvY2FsVmFyTmFtZXMgPSBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIHRoaXMubG9jYWxWYXJOYW1lcztcbn07XG5WYXJCbG9jay5wcm90b3R5cGUuZ2V0UGFyYW1WYXJOYW1lcyA9IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gdGhpcy5wYXJhbVZhck5hbWVzO1xufTtcblZhckJsb2NrLnByb3RvdHlwZS5oYXNMb2NhbFZhciA9IGZ1bmN0aW9uICh2YXJOYW1lKSB7XG4gICAgcmV0dXJuIHRoaXMubG9jYWxWYXJOYW1lcyAmJiB0aGlzLmxvY2FsVmFyTmFtZXMuaW5kZXhPZih2YXJOYW1lKSA+IC0xO1xufTtcblZhckJsb2NrLnByb3RvdHlwZS5oYXNQYXJhbVZhciA9IGZ1bmN0aW9uICh2YXJOYW1lKSB7XG4gICAgcmV0dXJuIHRoaXMucGFyYW1WYXJOYW1lcy5pbmRleE9mKHZhck5hbWUpID4gLTE7XG59O1xuVmFyQmxvY2sucHJvdG90eXBlLmhhc1ZhciA9IGZ1bmN0aW9uICh2YXJOYW1lKSB7XG4gICAgcmV0dXJuIHRoaXMuaGFzUGFyYW1WYXIodmFyTmFtZSkgfHwgdGhpcy5oYXNMb2NhbFZhcih2YXJOYW1lKTtcbn07XG5cblZhckJsb2NrLnByb3RvdHlwZS5hZGREZWNsYXJlZExvY2FsVmFyID0gZnVuY3Rpb24gKHZhck5hbWUsIGlzRnVuRGVjbCkge1xuICAgIHZhciBjdXJyQmxvY2sgPSB0aGlzO1xuICAgIC8vIHBlZWwgb2ZmIGluaXRpYWwgY2F0Y2ggYmxvY2tzXG4gICAgLy8gZm9yIGZ1bmN0aW9uIGRlY2wsIHNraXAgYW55IGNhdGNoIGJsb2NrcyxcbiAgICAvLyBmb3IgdmFyaWFibGUgZGVjbCwgc2tpcCBjYXRjaCBibG9jayB3aXRoIGRpZmZlcmVudCB2YXJOYW1lLlxuICAgIHdoaWxlIChjdXJyQmxvY2suaXNDYXRjaEJsb2NrKCkgJiZcbiAgICAgICAgICAgKGlzRnVuRGVjbCB8fCAhY3VyckJsb2NrLmhhc1BhcmFtVmFyKHZhck5hbWUpKSkge1xuICAgICAgICBjdXJyQmxvY2sgPSBjdXJyQmxvY2sucGFyZW47XG4gICAgfVxuICAgIC8vIGlmIGFscmVhZHkgYWRkZWQsIGRvIG5vdCBhZGRcbiAgICBpZiAoIWN1cnJCbG9jay5oYXNWYXIodmFyTmFtZSkpIHtcbiAgICAgICAgY3VyckJsb2NrLmxvY2FsVmFyTmFtZXMucHVzaCh2YXJOYW1lKTtcbiAgICB9XG4gICAgLy8gcmV0dXJucyB0aGUgYmxvY2sgb2JqZWN0IHRoYXQgY29udGFpbnMgdGhlIHZhcmlhYmxlXG4gICAgcmV0dXJuIGN1cnJCbG9jaztcbn07XG5WYXJCbG9jay5wcm90b3R5cGUuYWRkUGFyYW1WYXIgPSBmdW5jdGlvbiAodmFyTmFtZSkge1xuICAgIHRoaXMucGFyYW1WYXJOYW1lcy5wdXNoKHZhck5hbWUpO1xufTtcblZhckJsb2NrLnByb3RvdHlwZS5maW5kVmFySW5DaGFpbiA9IGZ1bmN0aW9uICh2YXJOYW1lKSB7XG4gICAgdmFyIGN1cnJCbG9jayA9IHRoaXM7XG4gICAgd2hpbGUgKGN1cnJCbG9jayAmJiBjdXJyQmxvY2sucGFyZW4gJiYgIWN1cnJCbG9jay5oYXNWYXIodmFyTmFtZSkpIHtcbiAgICAgICAgY3VyckJsb2NrID0gY3VyckJsb2NrLnBhcmVuO1xuICAgIH1cbiAgICAvLyBpZiBub3QgZm91bmQsIGl0IHdpbGwgcmV0dXJuIHRoZSBnbG9iYWxcbiAgICByZXR1cm4gY3VyckJsb2NrO1xufTtcblxuVmFyQmxvY2sucHJvdG90eXBlLmFkZFVzZWRWYXIgPSBmdW5jdGlvbiAodmFyTmFtZSkge1xuICAgIGlmICh0aGlzLnVzZWRWYXJpYWJsZXMuaW5kZXhPZih2YXJOYW1lKSA9PT0gLTEpIHtcbiAgICAgICAgdGhpcy51c2VkVmFyaWFibGVzLnB1c2godmFyTmFtZSk7XG4gICAgfVxufTtcblZhckJsb2NrLnByb3RvdHlwZS5nZXRVc2VkVmFyTmFtZXMgPSBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIHRoaXMudXNlZFZhcmlhYmxlcztcbn07XG5WYXJCbG9jay5wcm90b3R5cGUuaXNVc2VkVmFyID0gZnVuY3Rpb24gKHZhck5hbWUpIHtcbiAgICByZXR1cm4gdGhpcy51c2VkVmFyaWFibGVzLmluZGV4T2YodmFyTmFtZSkgPiAtMTtcbn07XG5cbi8vIHJldHVybnMgYSBtYXBwaW5nXG5WYXJCbG9jay5wcm90b3R5cGUuZ2V0SW5zdGFuY2UgPSBmdW5jdGlvbiAoZGVsdGEpIHtcbiAgICBpZiAodGhpcy5pbnN0YW5jZXNbZGVsdGFdKSB7XG4gICAgICAgIHJldHVybiB0aGlzLmluc3RhbmNlc1tkZWx0YV07XG4gICAgfVxuICAgIC8vIGNvbnN0cnVjdCBWYXJNYXBcbiAgICB2YXIgdmFyTWFwID0gbmV3IE1hcCgpO1xuICAgIHZhciB2YXJOYW1lcyA9IHRoaXMuZ2V0UGFyYW1WYXJOYW1lcygpLmNvbmNhdCh0aGlzLmdldExvY2FsVmFyTmFtZXMoKSk7XG5cbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHZhck5hbWVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIHZhck1hcC5zZXQodmFyTmFtZXNbaV0sIG5ldyB0eXBlcy5BVmFsKCkpO1xuICAgIH1cbiAgICAvLyByZW1lbWJlciB0aGUgaW5zdGFuY2VcbiAgICB0aGlzLmluc3RhbmNlc1tkZWx0YV0gPSB2YXJNYXA7XG4gICAgcmV0dXJuIHZhck1hcDtcbn07XG4vLyByZXR1cm5zIGFuIGFycmF5XG5WYXJCbG9jay5wcm90b3R5cGUuZ2V0UGFyYW1BVmFscyA9IGZ1bmN0aW9uIChkZWx0YSkge1xuICAgIHZhciBpbnN0YW5jZSA9IHRoaXMuZ2V0SW5zdGFuY2UoZGVsdGEpO1xuICAgIHZhciBwYXJhbXMgPSBbXTtcbiAgICB0aGlzLmdldFBhcmFtVmFyTmFtZXMoKS5mb3JFYWNoKGZ1bmN0aW9uIChuYW1lKSB7XG4gICAgICAgIHBhcmFtcy5wdXNoKGluc3RhbmNlW2F1eC5pbnRlcm5hbE5hbWUobmFtZSldKTtcbiAgICB9KTtcbiAgICByZXR1cm4gcGFyYW1zO1xufTtcbi8vIHJldHVybnMgYW4gQVZhbFxuVmFyQmxvY2sucHJvdG90eXBlLmdldEFyZ3VtZW50c0FWYWwgPSBmdW5jdGlvbiAoZGVsdGEpIHtcbiAgICBpZiAoIXRoaXMudXNlQXJndW1lbnRzT2JqZWN0KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignTm90IGZvciB0aGlzIFZhckJsb2NrJyk7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLmdldEluc3RhbmNlKGRlbHRhKVthdXguaW50ZXJuYWxOYW1lKCdhcmd1bWVudHMnKV07XG59O1xuXG4vLyBnZXQgYSBTY29wZSBpbnN0YW5jZVxuVmFyQmxvY2sucHJvdG90eXBlLmdldFNjb3BlSW5zdGFuY2UgPSBmdW5jdGlvbiAocGFyZW4sIGRlbHRhKSB7XG4gICAgdmFyIHZhck1hcCA9IHRoaXMuZ2V0SW5zdGFuY2UoZGVsdGEpO1xuICAgIHZhciBmb3VuZCA9IG51bGw7XG5cbiAgICB0aGlzLnNjb3BlSW5zdGFuY2VzLmZvckVhY2goZnVuY3Rpb24gKHNjKSB7XG4gICAgICAgIGlmIChzYy5wYXJlbiA9PT0gcGFyZW4gJiYgc2MudmFyTWFwID09PSB2YXJNYXApIGZvdW5kID0gc2M7XG4gICAgfSk7XG5cbiAgICBpZiAoZm91bmQpIHtcbiAgICAgICAgcmV0dXJuIGZvdW5kO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHZhciBuZXdTY29wZUluc3RhbmNlID0gbmV3IFNjb3BlKHBhcmVuLCB2YXJNYXAsIHRoaXMpO1xuICAgICAgICB0aGlzLnNjb3BlSW5zdGFuY2VzLnB1c2gobmV3U2NvcGVJbnN0YW5jZSk7XG4gICAgICAgIHJldHVybiBuZXdTY29wZUluc3RhbmNlO1xuICAgIH1cbn07XG5cbnZhciBkZWNsYXJlZFZhcmlhYmxlRmluZGVyID0gd2Fsay5tYWtlKHtcbiAgIEZ1bmN0aW9uOiBmdW5jdGlvbiAobm9kZSwgY3VyckJsb2NrLCBjKSB7XG4gICAgICAgIHZhciBwYXJlbkJsb2NrID0gY3VyckJsb2NrO1xuICAgICAgICBpZiAobm9kZS5pZCkge1xuICAgICAgICAgICAgdmFyIGZ1bmNOYW1lID0gbm9kZS5pZC5uYW1lO1xuICAgICAgICAgICAgcGFyZW5CbG9jayA9IGN1cnJCbG9jay5hZGREZWNsYXJlZExvY2FsVmFyKGZ1bmNOYW1lLCB0cnVlKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBjcmVhdGUgYSBWYXJCbG9jayBmb3IgZnVuY3Rpb25cbiAgICAgICAgdmFyIGZ1bmNCbG9jayA9IG5ldyBWYXJCbG9jayhwYXJlbkJsb2NrLCBub2RlKTtcbiAgICAgICAgbm9kZS5ib2R5WydAYmxvY2snXSA9IGZ1bmNCbG9jaztcbiAgICAgICAgLy8gYWRkIGZ1bmN0aW9uIHBhcmFtZXRlcnMgdG8gdGhlIHNjb3BlXG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbm9kZS5wYXJhbXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgIHZhciBwYXJhbU5hbWUgPSBub2RlLnBhcmFtc1tpXS5uYW1lO1xuICAgICAgICAgICAgZnVuY0Jsb2NrLmFkZFBhcmFtVmFyKHBhcmFtTmFtZSk7XG4gICAgICAgIH1cbiAgICAgICAgYyhub2RlLmJvZHksIGZ1bmNCbG9jaywgdW5kZWZpbmVkKTtcbiAgICB9LFxuICAgIFZhcmlhYmxlRGVjbGFyYXRpb246IGZ1bmN0aW9uIChub2RlLCBjdXJyQmxvY2ssIGMpIHtcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBub2RlLmRlY2xhcmF0aW9ucy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgdmFyIGRlY2wgPSBub2RlLmRlY2xhcmF0aW9uc1tpXTtcbiAgICAgICAgICAgIHZhciBuYW1lID0gZGVjbC5pZC5uYW1lO1xuICAgICAgICAgICAgY3VyckJsb2NrLmFkZERlY2xhcmVkTG9jYWxWYXIobmFtZSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGRlY2wuaW5pdCkgYyhkZWNsLmluaXQsIGN1cnJCbG9jaywgdW5kZWZpbmVkKTtcbiAgICB9LFxuICAgIFRyeVN0YXRlbWVudDogZnVuY3Rpb24gKG5vZGUsIGN1cnJTY29wZSwgYykge1xuICAgICAgICBjKG5vZGUuYmxvY2ssIGN1cnJTY29wZSwgdW5kZWZpbmVkKTtcbiAgICAgICAgaWYgKG5vZGUuaGFuZGxlcikge1xuICAgICAgICAgICAgYyhub2RlLmhhbmRsZXIsIGN1cnJTY29wZSwgdW5kZWZpbmVkKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAobm9kZS5maW5hbGl6ZXIpIHtcbiAgICAgICAgICAgIGMobm9kZS5maW5hbGl6ZXIsIGN1cnJTY29wZSwgdW5kZWZpbmVkKTtcbiAgICAgICAgfVxuICAgIH0sXG4gICAgQ2F0Y2hDbGF1c2U6IGZ1bmN0aW9uIChub2RlLCBjdXJyQmxvY2ssIGMpIHtcbiAgICAgICAgdmFyIGNhdGNoQmxvY2sgPSBuZXcgVmFyQmxvY2soY3VyckJsb2NrLCBub2RlLCB0cnVlKTtcbiAgICAgICAgY2F0Y2hCbG9jay5hZGRQYXJhbVZhcihub2RlLnBhcmFtLm5hbWUpO1xuICAgICAgICBub2RlLmJvZHlbJ0BibG9jayddID0gY2F0Y2hCbG9jaztcbiAgICAgICAgYyhub2RlLmJvZHksIGNhdGNoQmxvY2ssIHVuZGVmaW5lZCk7XG4gICAgfVxufSk7XG5cbi8vIEZvciB2YXJpYWJsZXMgaW4gZ2xvYmFsIGFuZCBhcmd1bWVudHMgaW4gZnVuY3Rpb25zXG52YXIgdmFyaWFibGVVc2FnZUNvbGxlY3RvciA9IHdhbGsubWFrZSh7XG4gICAgVmFyaWFibGVQYXR0ZXJuOiBmdW5jdGlvbiAobm9kZSwgY3VyckJsb2NrLCBjKSB7XG4gICAgICAgIGMobm9kZSwgY3VyckJsb2NrLCAnSWRlbnRpZmllcicpO1xuICAgIH0sXG5cbiAgICBJZGVudGlmaWVyOiBmdW5jdGlvbiAobm9kZSwgY3VyckJsb2NrLCBjKSB7XG4gICAgICAgIHZhciBjb250YWluaW5nQmxvY2ssIHZhck5hbWUgPSBub2RlLm5hbWU7XG4gICAgICAgIGlmICh2YXJOYW1lICE9PSAnYXJndW1lbnRzJykge1xuICAgICAgICAgICAgY29udGFpbmluZ0Jsb2NrID0gY3VyckJsb2NrLmZpbmRWYXJJbkNoYWluKHZhck5hbWUpO1xuICAgICAgICAgICAgaWYgKGNvbnRhaW5pbmdCbG9jay5pc0dsb2JhbCgpKSB7XG4gICAgICAgICAgICAgICAgY29udGFpbmluZ0Jsb2NrLmFkZERlY2xhcmVkTG9jYWxWYXIodmFyTmFtZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb250YWluaW5nQmxvY2suYWRkVXNlZFZhcih2YXJOYW1lKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vIHZhck5hbWUgPT0gJ2FyZ3VtZW50cydcbiAgICAgICAgICAgIGNvbnRhaW5pbmdCbG9jayA9IGN1cnJCbG9jaztcbiAgICAgICAgICAgIHdoaWxlIChjb250YWluaW5nQmxvY2suaXNDYXRjaEJsb2NrKCkgJiZcbiAgICAgICAgICAgICAgICAgICAgIWNvbnRhaW5pbmdCbG9jay5oYXNQYXJhbVZhcih2YXJOYW1lKSkge1xuICAgICAgICAgICAgICAgIGNvbnRhaW5pbmdCbG9jayA9IGNvbnRhaW5pbmdCbG9jay5wYXJlbjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChjb250YWluaW5nQmxvY2suaGFzVmFyKHZhck5hbWUpKSB7XG4gICAgICAgICAgICAgICAgLy8gYXJndW1lbnRzIGlzIGV4cGxpY2l0bHkgZGVjbGFyZWRcbiAgICAgICAgICAgICAgICBjb250YWluaW5nQmxvY2suYWRkVXNlZFZhcih2YXJOYW1lKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLy8gYXJndW1lbnRzIGlzIG5vdCBleHBsaWNpdGx5IGRlY2xhcmVkXG4gICAgICAgICAgICAgICAgLy8gYWRkIGl0IGFzIGxvY2FsIHZhcmlhYmxlXG4gICAgICAgICAgICAgICAgY29udGFpbmluZ0Jsb2NrLmFkZERlY2xhcmVkTG9jYWxWYXIodmFyTmFtZSk7XG4gICAgICAgICAgICAgICAgLy8gYWxzbyBpdCBpcyB1c2VkXG4gICAgICAgICAgICAgICAgY29udGFpbmluZ0Jsb2NrLmFkZFVzZWRWYXIodmFyTmFtZSk7XG4gICAgICAgICAgICAgICAgaWYgKGNvbnRhaW5pbmdCbG9jay5pc0Z1bmN0aW9uKCkpIHtcbiAgICAgICAgICAgICAgICAgICAgY29udGFpbmluZ0Jsb2NrLnVzZUFyZ3VtZW50c09iamVjdCA9IHRydWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfSxcblxuICAgIFJldHVyblN0YXRlbWVudDogZnVuY3Rpb24gKG5vZGUsIGN1cnJCbG9jaywgYykge1xuICAgICAgICB2YXIgZnVuY3Rpb25CbG9jayA9IGN1cnJCbG9jaztcbiAgICAgICAgd2hpbGUgKGZ1bmN0aW9uQmxvY2suaXNDYXRjaEJsb2NrKCkpIHtcbiAgICAgICAgICAgIGZ1bmN0aW9uQmxvY2sgPSBmdW5jdGlvbkJsb2NrLnBhcmVuO1xuICAgICAgICB9XG4gICAgICAgIGlmICghZnVuY3Rpb25CbG9jay5pc0dsb2JhbCgpICYmIG5vZGUuYXJndW1lbnQgIT09IG51bGwpIHtcbiAgICAgICAgICAgIGZ1bmN0aW9uQmxvY2sudXNlUmV0dXJuV2l0aEFyZ3VtZW50ID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAobm9kZS5hcmd1bWVudCkge1xuICAgICAgICAgICAgYyhub2RlLmFyZ3VtZW50LCBjdXJyQmxvY2ssIHVuZGVmaW5lZCk7XG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgU2NvcGVCb2R5OiBmdW5jdGlvbiAobm9kZSwgY3VyckJsb2NrLCBjKSB7XG4gICAgICAgIGMobm9kZSwgbm9kZVsnQGJsb2NrJ10gfHwgY3VyckJsb2NrKTtcbiAgICB9XG59KTtcblxuXG5mdW5jdGlvbiBhbm5vdGF0ZUJsb2NrSW5mbyhhc3QsIGdCbG9jaykge1xuICAgIGlmICghZ0Jsb2NrKSB7XG4gICAgICAgIC8vIHdoZW4gZ2xvYmFsIGJsb2NrIGlzIG5vdCBnaXZlbiwgY3JlYXRlXG4gICAgICAgIGdCbG9jayA9IG5ldyBWYXJCbG9jayhudWxsLCBhc3QpO1xuICAgIH1cbiAgICBhc3RbJ0BibG9jayddID0gZ0Jsb2NrO1xuICAgIHdhbGsucmVjdXJzaXZlKGFzdCwgZ0Jsb2NrLCBudWxsLCBkZWNsYXJlZFZhcmlhYmxlRmluZGVyKTtcbiAgICB3YWxrLnJlY3Vyc2l2ZShhc3QsIGdCbG9jaywgbnVsbCwgdmFyaWFibGVVc2FnZUNvbGxlY3Rvcik7XG4gICAgcmV0dXJuIGFzdDtcbn1cblxuLy8gZGVmaW5lIHNjb3BlIG9iamVjdFxuZnVuY3Rpb24gU2NvcGUocGFyZW4sIHZhck1hcCwgdmIpIHtcbiAgICB0aGlzLnBhcmVuID0gcGFyZW47XG4gICAgdGhpcy52YXJNYXAgPSB2YXJNYXA7XG4gICAgdGhpcy52YiA9IHZiO1xufVxuU2NvcGUucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShudWxsKTtcbi8vIGZpbmQgQVZhbCBvZiBhIHZhcmlhYmxlIGluIHRoZSBjaGFpblxuU2NvcGUucHJvdG90eXBlLmdldEFWYWxPZiA9IGZ1bmN0aW9uICh2YXJOYW1lKSB7XG4gICAgdmFyIGN1cnIgPSB0aGlzO1xuICAgIHdoaWxlIChjdXJyICE9IG51bGwpIHtcbiAgICAgICAgaWYgKGN1cnIudmFyTWFwLmhhcyh2YXJOYW1lKSkge1xuICAgICAgICAgICAgcmV0dXJuIGN1cnIudmFyTWFwLmdldCh2YXJOYW1lKTtcbiAgICAgICAgfVxuICAgICAgICBjdXJyID0gY3Vyci5wYXJlbjtcbiAgICB9XG4gICAgdGhyb3cgbmV3IEVycm9yKCdTaG91bGQgaGF2ZSBmb3VuZCB0aGUgdmFyaWFibGUnKTtcbn07XG4vLyByZW1vdmUgaW5pdGlhbCBjYXRjaCBzY29wZXMgZnJvbSB0aGUgY2hhaW5cblNjb3BlLnByb3RvdHlwZS5yZW1vdmVJbml0aWFsQ2F0Y2hCbG9ja3MgPSBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIGN1cnIgPSB0aGlzO1xuICAgIHdoaWxlIChjdXJyLnZiLmlzQ2F0Y2hCbG9jaygpKSB7XG4gICAgICAgIGN1cnIgPSBjdXJyLnBhcmVuO1xuICAgIH1cbiAgICByZXR1cm4gY3Vycjtcbn07XG5cblxuZXhwb3J0cy5WYXJCbG9jayA9IFZhckJsb2NrO1xuZXhwb3J0cy5hbm5vdGF0ZUJsb2NrSW5mbyA9IGFubm90YXRlQmxvY2tJbmZvO1xuZXhwb3J0cy5TY29wZSA9IFNjb3BlO1xuIiwiY29uc3Qgd2FsayA9IHJlcXVpcmUoJ2Fjb3JuL2Rpc3Qvd2FsaycpO1xuY29uc3QgbXlXYWxrZXIgPSByZXF1aXJlKCcuL3V0aWwvbXlXYWxrZXInKTtcblxuLyoqXG4gKlxuICogQHBhcmFtIGFzdCAtIHNjb3BlIGFubm90YXRlZCBBU1RcbiAqIEBwYXJhbSB7bnVtYmVyfSBwb3MgLSBjaGFyYWN0ZXIgcG9zaXRpb25cbiAqIEByZXR1cm5zIHsqfSAtIGFycmF5IG9mIEFTVCBub2Rlc1xuICovXG5mdW5jdGlvbiBmaW5kVmFyUmVmc0F0KGFzdCwgcG9zKSB7XG4gICAgXCJ1c2Ugc3RyaWN0XCI7XG4gICAgY29uc3QgZm91bmQgPSBteVdhbGtlci5maW5kSWRlbnRpZmllckF0KGFzdCwgcG9zKTtcbiAgICBpZiAoIWZvdW5kKSB7XG4gICAgICAgIC8vIHBvcyBpcyBub3QgYXQgYSB2YXJpYWJsZVxuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgLy8gZmluZCByZWZzIGZvciB0aGUgaWQgbm9kZVxuICAgIGNvbnN0IHJlZnMgPSBmaW5kUmVmc1RvVmFyaWFibGUoYXN0LCBmb3VuZCk7XG5cbiAgICByZXR1cm4gcmVmcztcbn1cblxuLyoqXG4gKlxuICogQHBhcmFtIGFzdCAtIHNjb3BlIGFubm90YXRlZCBBU1RcbiAqIEBwYXJhbSBmb3VuZCAtIG5vZGUgYW5kIHZhckJsb2NrIG9mIHRoZSB2YXJpYWJsZVxuICogQHJldHVybnMge0FycmF5fSAtIGFycmF5IG9mIEFTVCBub2Rlc1xuICovXG5mdW5jdGlvbiBmaW5kUmVmc1RvVmFyaWFibGUoYXN0LCBmb3VuZCkge1xuICAgIFwidXNlIHN0cmljdFwiO1xuICAgIGNvbnN0IHZhck5hbWUgPSBmb3VuZC5ub2RlLm5hbWU7XG4gICAgY29uc3QgdmIxID0gZm91bmQudmIuZmluZFZhckluQ2hhaW4odmFyTmFtZSk7XG4gICAgY29uc3QgcmVmcyA9IFtdO1xuXG4gICAgY29uc3Qgd2Fsa2VyID0gd2Fsay5tYWtlKHtcbiAgICAgICAgSWRlbnRpZmllcjogKG5vZGUsIHZiKSA9PiB7XG4gICAgICAgICAgICBpZiAobm9kZS5uYW1lICE9PSB2YXJOYW1lKSByZXR1cm47XG4gICAgICAgICAgICBpZiAodmIxID09PSB2Yi5maW5kVmFySW5DaGFpbih2YXJOYW1lKSkge1xuICAgICAgICAgICAgICAgIHJlZnMucHVzaChub2RlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH0sIG15V2Fsa2VyLnZhcldhbGtlcik7XG5cbiAgICB3YWxrLnJlY3Vyc2l2ZSh2YjEub3JpZ2luTm9kZSwgdmIxLCB3YWxrZXIpO1xuICAgIHJldHVybiByZWZzO1xufVxuXG5leHBvcnRzLmZpbmRWYXJSZWZzQXQgPSBmaW5kVmFyUmVmc0F0OyIsIihmdW5jdGlvbihmKXtpZih0eXBlb2YgZXhwb3J0cz09PVwib2JqZWN0XCImJnR5cGVvZiBtb2R1bGUhPT1cInVuZGVmaW5lZFwiKXttb2R1bGUuZXhwb3J0cz1mKCl9ZWxzZSBpZih0eXBlb2YgZGVmaW5lPT09XCJmdW5jdGlvblwiJiZkZWZpbmUuYW1kKXtkZWZpbmUoW10sZil9ZWxzZXt2YXIgZztpZih0eXBlb2Ygd2luZG93IT09XCJ1bmRlZmluZWRcIil7Zz13aW5kb3d9ZWxzZSBpZih0eXBlb2YgZ2xvYmFsIT09XCJ1bmRlZmluZWRcIil7Zz1nbG9iYWx9ZWxzZSBpZih0eXBlb2Ygc2VsZiE9PVwidW5kZWZpbmVkXCIpe2c9c2VsZn1lbHNle2c9dGhpc31nLmFjb3JuID0gZigpfX0pKGZ1bmN0aW9uKCl7dmFyIGRlZmluZSxtb2R1bGUsZXhwb3J0cztyZXR1cm4gKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt2YXIgZj1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpO3Rocm93IGYuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixmfXZhciBsPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChsLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGwsbC5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkoezE6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1xuLy8gQSByZWN1cnNpdmUgZGVzY2VudCBwYXJzZXIgb3BlcmF0ZXMgYnkgZGVmaW5pbmcgZnVuY3Rpb25zIGZvciBhbGxcbi8vIHN5bnRhY3RpYyBlbGVtZW50cywgYW5kIHJlY3Vyc2l2ZWx5IGNhbGxpbmcgdGhvc2UsIGVhY2ggZnVuY3Rpb25cbi8vIGFkdmFuY2luZyB0aGUgaW5wdXQgc3RyZWFtIGFuZCByZXR1cm5pbmcgYW4gQVNUIG5vZGUuIFByZWNlZGVuY2Vcbi8vIG9mIGNvbnN0cnVjdHMgKGZvciBleGFtcGxlLCB0aGUgZmFjdCB0aGF0IGAheFsxXWAgbWVhbnMgYCEoeFsxXSlgXG4vLyBpbnN0ZWFkIG9mIGAoIXgpWzFdYCBpcyBoYW5kbGVkIGJ5IHRoZSBmYWN0IHRoYXQgdGhlIHBhcnNlclxuLy8gZnVuY3Rpb24gdGhhdCBwYXJzZXMgdW5hcnkgcHJlZml4IG9wZXJhdG9ycyBpcyBjYWxsZWQgZmlyc3QsIGFuZFxuLy8gaW4gdHVybiBjYWxscyB0aGUgZnVuY3Rpb24gdGhhdCBwYXJzZXMgYFtdYCBzdWJzY3JpcHRzIOKAlCB0aGF0XG4vLyB3YXksIGl0J2xsIHJlY2VpdmUgdGhlIG5vZGUgZm9yIGB4WzFdYCBhbHJlYWR5IHBhcnNlZCwgYW5kIHdyYXBzXG4vLyAqdGhhdCogaW4gdGhlIHVuYXJ5IG9wZXJhdG9yIG5vZGUuXG4vL1xuLy8gQWNvcm4gdXNlcyBhbiBbb3BlcmF0b3IgcHJlY2VkZW5jZSBwYXJzZXJdW29wcF0gdG8gaGFuZGxlIGJpbmFyeVxuLy8gb3BlcmF0b3IgcHJlY2VkZW5jZSwgYmVjYXVzZSBpdCBpcyBtdWNoIG1vcmUgY29tcGFjdCB0aGFuIHVzaW5nXG4vLyB0aGUgdGVjaG5pcXVlIG91dGxpbmVkIGFib3ZlLCB3aGljaCB1c2VzIGRpZmZlcmVudCwgbmVzdGluZ1xuLy8gZnVuY3Rpb25zIHRvIHNwZWNpZnkgcHJlY2VkZW5jZSwgZm9yIGFsbCBvZiB0aGUgdGVuIGJpbmFyeVxuLy8gcHJlY2VkZW5jZSBsZXZlbHMgdGhhdCBKYXZhU2NyaXB0IGRlZmluZXMuXG4vL1xuLy8gW29wcF06IGh0dHA6Ly9lbi53aWtpcGVkaWEub3JnL3dpa2kvT3BlcmF0b3ItcHJlY2VkZW5jZV9wYXJzZXJcblxuXCJ1c2Ugc3RyaWN0XCI7XG5cbnZhciBfdG9rZW50eXBlID0gX2RlcmVxXyhcIi4vdG9rZW50eXBlXCIpO1xuXG52YXIgX3N0YXRlID0gX2RlcmVxXyhcIi4vc3RhdGVcIik7XG5cbnZhciBfaWRlbnRpZmllciA9IF9kZXJlcV8oXCIuL2lkZW50aWZpZXJcIik7XG5cbnZhciBfdXRpbCA9IF9kZXJlcV8oXCIuL3V0aWxcIik7XG5cbnZhciBwcCA9IF9zdGF0ZS5QYXJzZXIucHJvdG90eXBlO1xuXG4vLyBDaGVjayBpZiBwcm9wZXJ0eSBuYW1lIGNsYXNoZXMgd2l0aCBhbHJlYWR5IGFkZGVkLlxuLy8gT2JqZWN0L2NsYXNzIGdldHRlcnMgYW5kIHNldHRlcnMgYXJlIG5vdCBhbGxvd2VkIHRvIGNsYXNoIOKAlFxuLy8gZWl0aGVyIHdpdGggZWFjaCBvdGhlciBvciB3aXRoIGFuIGluaXQgcHJvcGVydHkg4oCUIGFuZCBpblxuLy8gc3RyaWN0IG1vZGUsIGluaXQgcHJvcGVydGllcyBhcmUgYWxzbyBub3QgYWxsb3dlZCB0byBiZSByZXBlYXRlZC5cblxucHAuY2hlY2tQcm9wQ2xhc2ggPSBmdW5jdGlvbiAocHJvcCwgcHJvcEhhc2gpIHtcbiAgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2ICYmIChwcm9wLmNvbXB1dGVkIHx8IHByb3AubWV0aG9kIHx8IHByb3Auc2hvcnRoYW5kKSkgcmV0dXJuO1xuICB2YXIga2V5ID0gcHJvcC5rZXksXG4gICAgICBuYW1lID0gdW5kZWZpbmVkO1xuICBzd2l0Y2ggKGtleS50eXBlKSB7XG4gICAgY2FzZSBcIklkZW50aWZpZXJcIjpcbiAgICAgIG5hbWUgPSBrZXkubmFtZTticmVhaztcbiAgICBjYXNlIFwiTGl0ZXJhbFwiOlxuICAgICAgbmFtZSA9IFN0cmluZyhrZXkudmFsdWUpO2JyZWFrO1xuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm47XG4gIH1cbiAgdmFyIGtpbmQgPSBwcm9wLmtpbmQ7XG4gIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNikge1xuICAgIGlmIChuYW1lID09PSBcIl9fcHJvdG9fX1wiICYmIGtpbmQgPT09IFwiaW5pdFwiKSB7XG4gICAgICBpZiAocHJvcEhhc2gucHJvdG8pIHRoaXMucmFpc2Uoa2V5LnN0YXJ0LCBcIlJlZGVmaW5pdGlvbiBvZiBfX3Byb3RvX18gcHJvcGVydHlcIik7XG4gICAgICBwcm9wSGFzaC5wcm90byA9IHRydWU7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuICB2YXIgb3RoZXIgPSB1bmRlZmluZWQ7XG4gIGlmIChfdXRpbC5oYXMocHJvcEhhc2gsIG5hbWUpKSB7XG4gICAgb3RoZXIgPSBwcm9wSGFzaFtuYW1lXTtcbiAgICB2YXIgaXNHZXRTZXQgPSBraW5kICE9PSBcImluaXRcIjtcbiAgICBpZiAoKHRoaXMuc3RyaWN0IHx8IGlzR2V0U2V0KSAmJiBvdGhlcltraW5kXSB8fCAhKGlzR2V0U2V0IF4gb3RoZXIuaW5pdCkpIHRoaXMucmFpc2Uoa2V5LnN0YXJ0LCBcIlJlZGVmaW5pdGlvbiBvZiBwcm9wZXJ0eVwiKTtcbiAgfSBlbHNlIHtcbiAgICBvdGhlciA9IHByb3BIYXNoW25hbWVdID0ge1xuICAgICAgaW5pdDogZmFsc2UsXG4gICAgICBnZXQ6IGZhbHNlLFxuICAgICAgc2V0OiBmYWxzZVxuICAgIH07XG4gIH1cbiAgb3RoZXJba2luZF0gPSB0cnVlO1xufTtcblxuLy8gIyMjIEV4cHJlc3Npb24gcGFyc2luZ1xuXG4vLyBUaGVzZSBuZXN0LCBmcm9tIHRoZSBtb3N0IGdlbmVyYWwgZXhwcmVzc2lvbiB0eXBlIGF0IHRoZSB0b3AgdG9cbi8vICdhdG9taWMnLCBub25kaXZpc2libGUgZXhwcmVzc2lvbiB0eXBlcyBhdCB0aGUgYm90dG9tLiBNb3N0IG9mXG4vLyB0aGUgZnVuY3Rpb25zIHdpbGwgc2ltcGx5IGxldCB0aGUgZnVuY3Rpb24ocykgYmVsb3cgdGhlbSBwYXJzZSxcbi8vIGFuZCwgKmlmKiB0aGUgc3ludGFjdGljIGNvbnN0cnVjdCB0aGV5IGhhbmRsZSBpcyBwcmVzZW50LCB3cmFwXG4vLyB0aGUgQVNUIG5vZGUgdGhhdCB0aGUgaW5uZXIgcGFyc2VyIGdhdmUgdGhlbSBpbiBhbm90aGVyIG5vZGUuXG5cbi8vIFBhcnNlIGEgZnVsbCBleHByZXNzaW9uLiBUaGUgb3B0aW9uYWwgYXJndW1lbnRzIGFyZSB1c2VkIHRvXG4vLyBmb3JiaWQgdGhlIGBpbmAgb3BlcmF0b3IgKGluIGZvciBsb29wcyBpbml0YWxpemF0aW9uIGV4cHJlc3Npb25zKVxuLy8gYW5kIHByb3ZpZGUgcmVmZXJlbmNlIGZvciBzdG9yaW5nICc9JyBvcGVyYXRvciBpbnNpZGUgc2hvcnRoYW5kXG4vLyBwcm9wZXJ0eSBhc3NpZ25tZW50IGluIGNvbnRleHRzIHdoZXJlIGJvdGggb2JqZWN0IGV4cHJlc3Npb25cbi8vIGFuZCBvYmplY3QgcGF0dGVybiBtaWdodCBhcHBlYXIgKHNvIGl0J3MgcG9zc2libGUgdG8gcmFpc2Vcbi8vIGRlbGF5ZWQgc3ludGF4IGVycm9yIGF0IGNvcnJlY3QgcG9zaXRpb24pLlxuXG5wcC5wYXJzZUV4cHJlc3Npb24gPSBmdW5jdGlvbiAobm9JbiwgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcykge1xuICB2YXIgc3RhcnRQb3MgPSB0aGlzLnN0YXJ0LFxuICAgICAgc3RhcnRMb2MgPSB0aGlzLnN0YXJ0TG9jO1xuICB2YXIgZXhwciA9IHRoaXMucGFyc2VNYXliZUFzc2lnbihub0luLCByZWZTaG9ydGhhbmREZWZhdWx0UG9zKTtcbiAgaWYgKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5jb21tYSkge1xuICAgIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGVBdChzdGFydFBvcywgc3RhcnRMb2MpO1xuICAgIG5vZGUuZXhwcmVzc2lvbnMgPSBbZXhwcl07XG4gICAgd2hpbGUgKHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuY29tbWEpKSBub2RlLmV4cHJlc3Npb25zLnB1c2godGhpcy5wYXJzZU1heWJlQXNzaWduKG5vSW4sIHJlZlNob3J0aGFuZERlZmF1bHRQb3MpKTtcbiAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiU2VxdWVuY2VFeHByZXNzaW9uXCIpO1xuICB9XG4gIHJldHVybiBleHByO1xufTtcblxuLy8gUGFyc2UgYW4gYXNzaWdubWVudCBleHByZXNzaW9uLiBUaGlzIGluY2x1ZGVzIGFwcGxpY2F0aW9ucyBvZlxuLy8gb3BlcmF0b3JzIGxpa2UgYCs9YC5cblxucHAucGFyc2VNYXliZUFzc2lnbiA9IGZ1bmN0aW9uIChub0luLCByZWZTaG9ydGhhbmREZWZhdWx0UG9zLCBhZnRlckxlZnRQYXJzZSkge1xuICBpZiAodGhpcy50eXBlID09IF90b2tlbnR5cGUudHlwZXMuX3lpZWxkICYmIHRoaXMuaW5HZW5lcmF0b3IpIHJldHVybiB0aGlzLnBhcnNlWWllbGQoKTtcblxuICB2YXIgZmFpbE9uU2hvcnRoYW5kQXNzaWduID0gdW5kZWZpbmVkO1xuICBpZiAoIXJlZlNob3J0aGFuZERlZmF1bHRQb3MpIHtcbiAgICByZWZTaG9ydGhhbmREZWZhdWx0UG9zID0geyBzdGFydDogMCB9O1xuICAgIGZhaWxPblNob3J0aGFuZEFzc2lnbiA9IHRydWU7XG4gIH0gZWxzZSB7XG4gICAgZmFpbE9uU2hvcnRoYW5kQXNzaWduID0gZmFsc2U7XG4gIH1cbiAgdmFyIHN0YXJ0UG9zID0gdGhpcy5zdGFydCxcbiAgICAgIHN0YXJ0TG9jID0gdGhpcy5zdGFydExvYztcbiAgaWYgKHRoaXMudHlwZSA9PSBfdG9rZW50eXBlLnR5cGVzLnBhcmVuTCB8fCB0aGlzLnR5cGUgPT0gX3Rva2VudHlwZS50eXBlcy5uYW1lKSB0aGlzLnBvdGVudGlhbEFycm93QXQgPSB0aGlzLnN0YXJ0O1xuICB2YXIgbGVmdCA9IHRoaXMucGFyc2VNYXliZUNvbmRpdGlvbmFsKG5vSW4sIHJlZlNob3J0aGFuZERlZmF1bHRQb3MpO1xuICBpZiAoYWZ0ZXJMZWZ0UGFyc2UpIGxlZnQgPSBhZnRlckxlZnRQYXJzZS5jYWxsKHRoaXMsIGxlZnQsIHN0YXJ0UG9zLCBzdGFydExvYyk7XG4gIGlmICh0aGlzLnR5cGUuaXNBc3NpZ24pIHtcbiAgICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlQXQoc3RhcnRQb3MsIHN0YXJ0TG9jKTtcbiAgICBub2RlLm9wZXJhdG9yID0gdGhpcy52YWx1ZTtcbiAgICBub2RlLmxlZnQgPSB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuZXEgPyB0aGlzLnRvQXNzaWduYWJsZShsZWZ0KSA6IGxlZnQ7XG4gICAgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcy5zdGFydCA9IDA7IC8vIHJlc2V0IGJlY2F1c2Ugc2hvcnRoYW5kIGRlZmF1bHQgd2FzIHVzZWQgY29ycmVjdGx5XG4gICAgdGhpcy5jaGVja0xWYWwobGVmdCk7XG4gICAgdGhpcy5uZXh0KCk7XG4gICAgbm9kZS5yaWdodCA9IHRoaXMucGFyc2VNYXliZUFzc2lnbihub0luKTtcbiAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiQXNzaWdubWVudEV4cHJlc3Npb25cIik7XG4gIH0gZWxzZSBpZiAoZmFpbE9uU2hvcnRoYW5kQXNzaWduICYmIHJlZlNob3J0aGFuZERlZmF1bHRQb3Muc3RhcnQpIHtcbiAgICB0aGlzLnVuZXhwZWN0ZWQocmVmU2hvcnRoYW5kRGVmYXVsdFBvcy5zdGFydCk7XG4gIH1cbiAgcmV0dXJuIGxlZnQ7XG59O1xuXG4vLyBQYXJzZSBhIHRlcm5hcnkgY29uZGl0aW9uYWwgKGA/OmApIG9wZXJhdG9yLlxuXG5wcC5wYXJzZU1heWJlQ29uZGl0aW9uYWwgPSBmdW5jdGlvbiAobm9JbiwgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcykge1xuICB2YXIgc3RhcnRQb3MgPSB0aGlzLnN0YXJ0LFxuICAgICAgc3RhcnRMb2MgPSB0aGlzLnN0YXJ0TG9jO1xuICB2YXIgZXhwciA9IHRoaXMucGFyc2VFeHByT3BzKG5vSW4sIHJlZlNob3J0aGFuZERlZmF1bHRQb3MpO1xuICBpZiAocmVmU2hvcnRoYW5kRGVmYXVsdFBvcyAmJiByZWZTaG9ydGhhbmREZWZhdWx0UG9zLnN0YXJ0KSByZXR1cm4gZXhwcjtcbiAgaWYgKHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMucXVlc3Rpb24pKSB7XG4gICAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZUF0KHN0YXJ0UG9zLCBzdGFydExvYyk7XG4gICAgbm9kZS50ZXN0ID0gZXhwcjtcbiAgICBub2RlLmNvbnNlcXVlbnQgPSB0aGlzLnBhcnNlTWF5YmVBc3NpZ24oKTtcbiAgICB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmNvbG9uKTtcbiAgICBub2RlLmFsdGVybmF0ZSA9IHRoaXMucGFyc2VNYXliZUFzc2lnbihub0luKTtcbiAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiQ29uZGl0aW9uYWxFeHByZXNzaW9uXCIpO1xuICB9XG4gIHJldHVybiBleHByO1xufTtcblxuLy8gU3RhcnQgdGhlIHByZWNlZGVuY2UgcGFyc2VyLlxuXG5wcC5wYXJzZUV4cHJPcHMgPSBmdW5jdGlvbiAobm9JbiwgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcykge1xuICB2YXIgc3RhcnRQb3MgPSB0aGlzLnN0YXJ0LFxuICAgICAgc3RhcnRMb2MgPSB0aGlzLnN0YXJ0TG9jO1xuICB2YXIgZXhwciA9IHRoaXMucGFyc2VNYXliZVVuYXJ5KHJlZlNob3J0aGFuZERlZmF1bHRQb3MpO1xuICBpZiAocmVmU2hvcnRoYW5kRGVmYXVsdFBvcyAmJiByZWZTaG9ydGhhbmREZWZhdWx0UG9zLnN0YXJ0KSByZXR1cm4gZXhwcjtcbiAgcmV0dXJuIHRoaXMucGFyc2VFeHByT3AoZXhwciwgc3RhcnRQb3MsIHN0YXJ0TG9jLCAtMSwgbm9Jbik7XG59O1xuXG4vLyBQYXJzZSBiaW5hcnkgb3BlcmF0b3JzIHdpdGggdGhlIG9wZXJhdG9yIHByZWNlZGVuY2UgcGFyc2luZ1xuLy8gYWxnb3JpdGhtLiBgbGVmdGAgaXMgdGhlIGxlZnQtaGFuZCBzaWRlIG9mIHRoZSBvcGVyYXRvci5cbi8vIGBtaW5QcmVjYCBwcm92aWRlcyBjb250ZXh0IHRoYXQgYWxsb3dzIHRoZSBmdW5jdGlvbiB0byBzdG9wIGFuZFxuLy8gZGVmZXIgZnVydGhlciBwYXJzZXIgdG8gb25lIG9mIGl0cyBjYWxsZXJzIHdoZW4gaXQgZW5jb3VudGVycyBhblxuLy8gb3BlcmF0b3IgdGhhdCBoYXMgYSBsb3dlciBwcmVjZWRlbmNlIHRoYW4gdGhlIHNldCBpdCBpcyBwYXJzaW5nLlxuXG5wcC5wYXJzZUV4cHJPcCA9IGZ1bmN0aW9uIChsZWZ0LCBsZWZ0U3RhcnRQb3MsIGxlZnRTdGFydExvYywgbWluUHJlYywgbm9Jbikge1xuICB2YXIgcHJlYyA9IHRoaXMudHlwZS5iaW5vcDtcbiAgaWYgKHByZWMgIT0gbnVsbCAmJiAoIW5vSW4gfHwgdGhpcy50eXBlICE9PSBfdG9rZW50eXBlLnR5cGVzLl9pbikpIHtcbiAgICBpZiAocHJlYyA+IG1pblByZWMpIHtcbiAgICAgIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGVBdChsZWZ0U3RhcnRQb3MsIGxlZnRTdGFydExvYyk7XG4gICAgICBub2RlLmxlZnQgPSBsZWZ0O1xuICAgICAgbm9kZS5vcGVyYXRvciA9IHRoaXMudmFsdWU7XG4gICAgICB2YXIgb3AgPSB0aGlzLnR5cGU7XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIHZhciBzdGFydFBvcyA9IHRoaXMuc3RhcnQsXG4gICAgICAgICAgc3RhcnRMb2MgPSB0aGlzLnN0YXJ0TG9jO1xuICAgICAgbm9kZS5yaWdodCA9IHRoaXMucGFyc2VFeHByT3AodGhpcy5wYXJzZU1heWJlVW5hcnkoKSwgc3RhcnRQb3MsIHN0YXJ0TG9jLCBwcmVjLCBub0luKTtcbiAgICAgIHRoaXMuZmluaXNoTm9kZShub2RlLCBvcCA9PT0gX3Rva2VudHlwZS50eXBlcy5sb2dpY2FsT1IgfHwgb3AgPT09IF90b2tlbnR5cGUudHlwZXMubG9naWNhbEFORCA/IFwiTG9naWNhbEV4cHJlc3Npb25cIiA6IFwiQmluYXJ5RXhwcmVzc2lvblwiKTtcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlRXhwck9wKG5vZGUsIGxlZnRTdGFydFBvcywgbGVmdFN0YXJ0TG9jLCBtaW5QcmVjLCBub0luKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGxlZnQ7XG59O1xuXG4vLyBQYXJzZSB1bmFyeSBvcGVyYXRvcnMsIGJvdGggcHJlZml4IGFuZCBwb3N0Zml4LlxuXG5wcC5wYXJzZU1heWJlVW5hcnkgPSBmdW5jdGlvbiAocmVmU2hvcnRoYW5kRGVmYXVsdFBvcykge1xuICBpZiAodGhpcy50eXBlLnByZWZpeCkge1xuICAgIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGUoKSxcbiAgICAgICAgdXBkYXRlID0gdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmluY0RlYztcbiAgICBub2RlLm9wZXJhdG9yID0gdGhpcy52YWx1ZTtcbiAgICBub2RlLnByZWZpeCA9IHRydWU7XG4gICAgdGhpcy5uZXh0KCk7XG4gICAgbm9kZS5hcmd1bWVudCA9IHRoaXMucGFyc2VNYXliZVVuYXJ5KCk7XG4gICAgaWYgKHJlZlNob3J0aGFuZERlZmF1bHRQb3MgJiYgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcy5zdGFydCkgdGhpcy51bmV4cGVjdGVkKHJlZlNob3J0aGFuZERlZmF1bHRQb3Muc3RhcnQpO1xuICAgIGlmICh1cGRhdGUpIHRoaXMuY2hlY2tMVmFsKG5vZGUuYXJndW1lbnQpO2Vsc2UgaWYgKHRoaXMuc3RyaWN0ICYmIG5vZGUub3BlcmF0b3IgPT09IFwiZGVsZXRlXCIgJiYgbm9kZS5hcmd1bWVudC50eXBlID09PSBcIklkZW50aWZpZXJcIikgdGhpcy5yYWlzZShub2RlLnN0YXJ0LCBcIkRlbGV0aW5nIGxvY2FsIHZhcmlhYmxlIGluIHN0cmljdCBtb2RlXCIpO1xuICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgdXBkYXRlID8gXCJVcGRhdGVFeHByZXNzaW9uXCIgOiBcIlVuYXJ5RXhwcmVzc2lvblwiKTtcbiAgfVxuICB2YXIgc3RhcnRQb3MgPSB0aGlzLnN0YXJ0LFxuICAgICAgc3RhcnRMb2MgPSB0aGlzLnN0YXJ0TG9jO1xuICB2YXIgZXhwciA9IHRoaXMucGFyc2VFeHByU3Vic2NyaXB0cyhyZWZTaG9ydGhhbmREZWZhdWx0UG9zKTtcbiAgaWYgKHJlZlNob3J0aGFuZERlZmF1bHRQb3MgJiYgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcy5zdGFydCkgcmV0dXJuIGV4cHI7XG4gIHdoaWxlICh0aGlzLnR5cGUucG9zdGZpeCAmJiAhdGhpcy5jYW5JbnNlcnRTZW1pY29sb24oKSkge1xuICAgIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGVBdChzdGFydFBvcywgc3RhcnRMb2MpO1xuICAgIG5vZGUub3BlcmF0b3IgPSB0aGlzLnZhbHVlO1xuICAgIG5vZGUucHJlZml4ID0gZmFsc2U7XG4gICAgbm9kZS5hcmd1bWVudCA9IGV4cHI7XG4gICAgdGhpcy5jaGVja0xWYWwoZXhwcik7XG4gICAgdGhpcy5uZXh0KCk7XG4gICAgZXhwciA9IHRoaXMuZmluaXNoTm9kZShub2RlLCBcIlVwZGF0ZUV4cHJlc3Npb25cIik7XG4gIH1cbiAgcmV0dXJuIGV4cHI7XG59O1xuXG4vLyBQYXJzZSBjYWxsLCBkb3QsIGFuZCBgW11gLXN1YnNjcmlwdCBleHByZXNzaW9ucy5cblxucHAucGFyc2VFeHByU3Vic2NyaXB0cyA9IGZ1bmN0aW9uIChyZWZTaG9ydGhhbmREZWZhdWx0UG9zKSB7XG4gIHZhciBzdGFydFBvcyA9IHRoaXMuc3RhcnQsXG4gICAgICBzdGFydExvYyA9IHRoaXMuc3RhcnRMb2M7XG4gIHZhciBleHByID0gdGhpcy5wYXJzZUV4cHJBdG9tKHJlZlNob3J0aGFuZERlZmF1bHRQb3MpO1xuICBpZiAocmVmU2hvcnRoYW5kRGVmYXVsdFBvcyAmJiByZWZTaG9ydGhhbmREZWZhdWx0UG9zLnN0YXJ0KSByZXR1cm4gZXhwcjtcbiAgcmV0dXJuIHRoaXMucGFyc2VTdWJzY3JpcHRzKGV4cHIsIHN0YXJ0UG9zLCBzdGFydExvYyk7XG59O1xuXG5wcC5wYXJzZVN1YnNjcmlwdHMgPSBmdW5jdGlvbiAoYmFzZSwgc3RhcnRQb3MsIHN0YXJ0TG9jLCBub0NhbGxzKSB7XG4gIGZvciAoOzspIHtcbiAgICBpZiAodGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5kb3QpKSB7XG4gICAgICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlQXQoc3RhcnRQb3MsIHN0YXJ0TG9jKTtcbiAgICAgIG5vZGUub2JqZWN0ID0gYmFzZTtcbiAgICAgIG5vZGUucHJvcGVydHkgPSB0aGlzLnBhcnNlSWRlbnQodHJ1ZSk7XG4gICAgICBub2RlLmNvbXB1dGVkID0gZmFsc2U7XG4gICAgICBiYXNlID0gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiTWVtYmVyRXhwcmVzc2lvblwiKTtcbiAgICB9IGVsc2UgaWYgKHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuYnJhY2tldEwpKSB7XG4gICAgICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlQXQoc3RhcnRQb3MsIHN0YXJ0TG9jKTtcbiAgICAgIG5vZGUub2JqZWN0ID0gYmFzZTtcbiAgICAgIG5vZGUucHJvcGVydHkgPSB0aGlzLnBhcnNlRXhwcmVzc2lvbigpO1xuICAgICAgbm9kZS5jb21wdXRlZCA9IHRydWU7XG4gICAgICB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmJyYWNrZXRSKTtcbiAgICAgIGJhc2UgPSB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJNZW1iZXJFeHByZXNzaW9uXCIpO1xuICAgIH0gZWxzZSBpZiAoIW5vQ2FsbHMgJiYgdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5wYXJlbkwpKSB7XG4gICAgICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlQXQoc3RhcnRQb3MsIHN0YXJ0TG9jKTtcbiAgICAgIG5vZGUuY2FsbGVlID0gYmFzZTtcbiAgICAgIG5vZGUuYXJndW1lbnRzID0gdGhpcy5wYXJzZUV4cHJMaXN0KF90b2tlbnR5cGUudHlwZXMucGFyZW5SLCBmYWxzZSk7XG4gICAgICBiYXNlID0gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiQ2FsbEV4cHJlc3Npb25cIik7XG4gICAgfSBlbHNlIGlmICh0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuYmFja1F1b3RlKSB7XG4gICAgICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlQXQoc3RhcnRQb3MsIHN0YXJ0TG9jKTtcbiAgICAgIG5vZGUudGFnID0gYmFzZTtcbiAgICAgIG5vZGUucXVhc2kgPSB0aGlzLnBhcnNlVGVtcGxhdGUoKTtcbiAgICAgIGJhc2UgPSB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJUYWdnZWRUZW1wbGF0ZUV4cHJlc3Npb25cIik7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiBiYXNlO1xuICAgIH1cbiAgfVxufTtcblxuLy8gUGFyc2UgYW4gYXRvbWljIGV4cHJlc3Npb24g4oCUIGVpdGhlciBhIHNpbmdsZSB0b2tlbiB0aGF0IGlzIGFuXG4vLyBleHByZXNzaW9uLCBhbiBleHByZXNzaW9uIHN0YXJ0ZWQgYnkgYSBrZXl3b3JkIGxpa2UgYGZ1bmN0aW9uYCBvclxuLy8gYG5ld2AsIG9yIGFuIGV4cHJlc3Npb24gd3JhcHBlZCBpbiBwdW5jdHVhdGlvbiBsaWtlIGAoKWAsIGBbXWAsXG4vLyBvciBge31gLlxuXG5wcC5wYXJzZUV4cHJBdG9tID0gZnVuY3Rpb24gKHJlZlNob3J0aGFuZERlZmF1bHRQb3MpIHtcbiAgdmFyIG5vZGUgPSB1bmRlZmluZWQsXG4gICAgICBjYW5CZUFycm93ID0gdGhpcy5wb3RlbnRpYWxBcnJvd0F0ID09IHRoaXMuc3RhcnQ7XG4gIHN3aXRjaCAodGhpcy50eXBlKSB7XG4gICAgY2FzZSBfdG9rZW50eXBlLnR5cGVzLl9zdXBlcjpcbiAgICAgIGlmICghdGhpcy5pbkZ1bmN0aW9uKSB0aGlzLnJhaXNlKHRoaXMuc3RhcnQsIFwiJ3N1cGVyJyBvdXRzaWRlIG9mIGZ1bmN0aW9uIG9yIGNsYXNzXCIpO1xuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5fdGhpczpcbiAgICAgIHZhciB0eXBlID0gdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl90aGlzID8gXCJUaGlzRXhwcmVzc2lvblwiIDogXCJTdXBlclwiO1xuICAgICAgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgdHlwZSk7XG5cbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuX3lpZWxkOlxuICAgICAgaWYgKHRoaXMuaW5HZW5lcmF0b3IpIHRoaXMudW5leHBlY3RlZCgpO1xuXG4gICAgY2FzZSBfdG9rZW50eXBlLnR5cGVzLm5hbWU6XG4gICAgICB2YXIgc3RhcnRQb3MgPSB0aGlzLnN0YXJ0LFxuICAgICAgICAgIHN0YXJ0TG9jID0gdGhpcy5zdGFydExvYztcbiAgICAgIHZhciBpZCA9IHRoaXMucGFyc2VJZGVudCh0aGlzLnR5cGUgIT09IF90b2tlbnR5cGUudHlwZXMubmFtZSk7XG4gICAgICBpZiAoY2FuQmVBcnJvdyAmJiAhdGhpcy5jYW5JbnNlcnRTZW1pY29sb24oKSAmJiB0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLmFycm93KSkgcmV0dXJuIHRoaXMucGFyc2VBcnJvd0V4cHJlc3Npb24odGhpcy5zdGFydE5vZGVBdChzdGFydFBvcywgc3RhcnRMb2MpLCBbaWRdKTtcbiAgICAgIHJldHVybiBpZDtcblxuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5yZWdleHA6XG4gICAgICB2YXIgdmFsdWUgPSB0aGlzLnZhbHVlO1xuICAgICAgbm9kZSA9IHRoaXMucGFyc2VMaXRlcmFsKHZhbHVlLnZhbHVlKTtcbiAgICAgIG5vZGUucmVnZXggPSB7IHBhdHRlcm46IHZhbHVlLnBhdHRlcm4sIGZsYWdzOiB2YWx1ZS5mbGFncyB9O1xuICAgICAgcmV0dXJuIG5vZGU7XG5cbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMubnVtOmNhc2UgX3Rva2VudHlwZS50eXBlcy5zdHJpbmc6XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZUxpdGVyYWwodGhpcy52YWx1ZSk7XG5cbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuX251bGw6Y2FzZSBfdG9rZW50eXBlLnR5cGVzLl90cnVlOmNhc2UgX3Rva2VudHlwZS50eXBlcy5fZmFsc2U6XG4gICAgICBub2RlID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgICAgIG5vZGUudmFsdWUgPSB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX251bGwgPyBudWxsIDogdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl90cnVlO1xuICAgICAgbm9kZS5yYXcgPSB0aGlzLnR5cGUua2V5d29yZDtcbiAgICAgIHRoaXMubmV4dCgpO1xuICAgICAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkxpdGVyYWxcIik7XG5cbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMucGFyZW5MOlxuICAgICAgcmV0dXJuIHRoaXMucGFyc2VQYXJlbkFuZERpc3Rpbmd1aXNoRXhwcmVzc2lvbihjYW5CZUFycm93KTtcblxuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5icmFja2V0TDpcbiAgICAgIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICAgICAgdGhpcy5uZXh0KCk7XG4gICAgICAvLyBjaGVjayB3aGV0aGVyIHRoaXMgaXMgYXJyYXkgY29tcHJlaGVuc2lvbiBvciByZWd1bGFyIGFycmF5XG4gICAgICBpZiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDcgJiYgdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9mb3IpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMucGFyc2VDb21wcmVoZW5zaW9uKG5vZGUsIGZhbHNlKTtcbiAgICAgIH1cbiAgICAgIG5vZGUuZWxlbWVudHMgPSB0aGlzLnBhcnNlRXhwckxpc3QoX3Rva2VudHlwZS50eXBlcy5icmFja2V0UiwgdHJ1ZSwgdHJ1ZSwgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcyk7XG4gICAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiQXJyYXlFeHByZXNzaW9uXCIpO1xuXG4gICAgY2FzZSBfdG9rZW50eXBlLnR5cGVzLmJyYWNlTDpcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlT2JqKGZhbHNlLCByZWZTaG9ydGhhbmREZWZhdWx0UG9zKTtcblxuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5fZnVuY3Rpb246XG4gICAgICBub2RlID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgICAgIHRoaXMubmV4dCgpO1xuICAgICAgcmV0dXJuIHRoaXMucGFyc2VGdW5jdGlvbihub2RlLCBmYWxzZSk7XG5cbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuX2NsYXNzOlxuICAgICAgcmV0dXJuIHRoaXMucGFyc2VDbGFzcyh0aGlzLnN0YXJ0Tm9kZSgpLCBmYWxzZSk7XG5cbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuX25ldzpcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlTmV3KCk7XG5cbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuYmFja1F1b3RlOlxuICAgICAgcmV0dXJuIHRoaXMucGFyc2VUZW1wbGF0ZSgpO1xuXG4gICAgZGVmYXVsdDpcbiAgICAgIHRoaXMudW5leHBlY3RlZCgpO1xuICB9XG59O1xuXG5wcC5wYXJzZUxpdGVyYWwgPSBmdW5jdGlvbiAodmFsdWUpIHtcbiAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICBub2RlLnZhbHVlID0gdmFsdWU7XG4gIG5vZGUucmF3ID0gdGhpcy5pbnB1dC5zbGljZSh0aGlzLnN0YXJ0LCB0aGlzLmVuZCk7XG4gIHRoaXMubmV4dCgpO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiTGl0ZXJhbFwiKTtcbn07XG5cbnBwLnBhcnNlUGFyZW5FeHByZXNzaW9uID0gZnVuY3Rpb24gKCkge1xuICB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLnBhcmVuTCk7XG4gIHZhciB2YWwgPSB0aGlzLnBhcnNlRXhwcmVzc2lvbigpO1xuICB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLnBhcmVuUik7XG4gIHJldHVybiB2YWw7XG59O1xuXG5wcC5wYXJzZVBhcmVuQW5kRGlzdGluZ3Vpc2hFeHByZXNzaW9uID0gZnVuY3Rpb24gKGNhbkJlQXJyb3cpIHtcbiAgdmFyIHN0YXJ0UG9zID0gdGhpcy5zdGFydCxcbiAgICAgIHN0YXJ0TG9jID0gdGhpcy5zdGFydExvYyxcbiAgICAgIHZhbCA9IHVuZGVmaW5lZDtcbiAgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KSB7XG4gICAgdGhpcy5uZXh0KCk7XG5cbiAgICBpZiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDcgJiYgdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9mb3IpIHtcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlQ29tcHJlaGVuc2lvbih0aGlzLnN0YXJ0Tm9kZUF0KHN0YXJ0UG9zLCBzdGFydExvYyksIHRydWUpO1xuICAgIH1cblxuICAgIHZhciBpbm5lclN0YXJ0UG9zID0gdGhpcy5zdGFydCxcbiAgICAgICAgaW5uZXJTdGFydExvYyA9IHRoaXMuc3RhcnRMb2M7XG4gICAgdmFyIGV4cHJMaXN0ID0gW10sXG4gICAgICAgIGZpcnN0ID0gdHJ1ZTtcbiAgICB2YXIgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcyA9IHsgc3RhcnQ6IDAgfSxcbiAgICAgICAgc3ByZWFkU3RhcnQgPSB1bmRlZmluZWQsXG4gICAgICAgIGlubmVyUGFyZW5TdGFydCA9IHVuZGVmaW5lZDtcbiAgICB3aGlsZSAodGhpcy50eXBlICE9PSBfdG9rZW50eXBlLnR5cGVzLnBhcmVuUikge1xuICAgICAgZmlyc3QgPyBmaXJzdCA9IGZhbHNlIDogdGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5jb21tYSk7XG4gICAgICBpZiAodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmVsbGlwc2lzKSB7XG4gICAgICAgIHNwcmVhZFN0YXJ0ID0gdGhpcy5zdGFydDtcbiAgICAgICAgZXhwckxpc3QucHVzaCh0aGlzLnBhcnNlUGFyZW5JdGVtKHRoaXMucGFyc2VSZXN0KCkpKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBpZiAodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLnBhcmVuTCAmJiAhaW5uZXJQYXJlblN0YXJ0KSB7XG4gICAgICAgICAgaW5uZXJQYXJlblN0YXJ0ID0gdGhpcy5zdGFydDtcbiAgICAgICAgfVxuICAgICAgICBleHByTGlzdC5wdXNoKHRoaXMucGFyc2VNYXliZUFzc2lnbihmYWxzZSwgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcywgdGhpcy5wYXJzZVBhcmVuSXRlbSkpO1xuICAgICAgfVxuICAgIH1cbiAgICB2YXIgaW5uZXJFbmRQb3MgPSB0aGlzLnN0YXJ0LFxuICAgICAgICBpbm5lckVuZExvYyA9IHRoaXMuc3RhcnRMb2M7XG4gICAgdGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5wYXJlblIpO1xuXG4gICAgaWYgKGNhbkJlQXJyb3cgJiYgIXRoaXMuY2FuSW5zZXJ0U2VtaWNvbG9uKCkgJiYgdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5hcnJvdykpIHtcbiAgICAgIGlmIChpbm5lclBhcmVuU3RhcnQpIHRoaXMudW5leHBlY3RlZChpbm5lclBhcmVuU3RhcnQpO1xuICAgICAgcmV0dXJuIHRoaXMucGFyc2VQYXJlbkFycm93TGlzdChzdGFydFBvcywgc3RhcnRMb2MsIGV4cHJMaXN0KTtcbiAgICB9XG5cbiAgICBpZiAoIWV4cHJMaXN0Lmxlbmd0aCkgdGhpcy51bmV4cGVjdGVkKHRoaXMubGFzdFRva1N0YXJ0KTtcbiAgICBpZiAoc3ByZWFkU3RhcnQpIHRoaXMudW5leHBlY3RlZChzcHJlYWRTdGFydCk7XG4gICAgaWYgKHJlZlNob3J0aGFuZERlZmF1bHRQb3Muc3RhcnQpIHRoaXMudW5leHBlY3RlZChyZWZTaG9ydGhhbmREZWZhdWx0UG9zLnN0YXJ0KTtcblxuICAgIGlmIChleHByTGlzdC5sZW5ndGggPiAxKSB7XG4gICAgICB2YWwgPSB0aGlzLnN0YXJ0Tm9kZUF0KGlubmVyU3RhcnRQb3MsIGlubmVyU3RhcnRMb2MpO1xuICAgICAgdmFsLmV4cHJlc3Npb25zID0gZXhwckxpc3Q7XG4gICAgICB0aGlzLmZpbmlzaE5vZGVBdCh2YWwsIFwiU2VxdWVuY2VFeHByZXNzaW9uXCIsIGlubmVyRW5kUG9zLCBpbm5lckVuZExvYyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHZhbCA9IGV4cHJMaXN0WzBdO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICB2YWwgPSB0aGlzLnBhcnNlUGFyZW5FeHByZXNzaW9uKCk7XG4gIH1cblxuICBpZiAodGhpcy5vcHRpb25zLnByZXNlcnZlUGFyZW5zKSB7XG4gICAgdmFyIHBhciA9IHRoaXMuc3RhcnROb2RlQXQoc3RhcnRQb3MsIHN0YXJ0TG9jKTtcbiAgICBwYXIuZXhwcmVzc2lvbiA9IHZhbDtcbiAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKHBhciwgXCJQYXJlbnRoZXNpemVkRXhwcmVzc2lvblwiKTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gdmFsO1xuICB9XG59O1xuXG5wcC5wYXJzZVBhcmVuSXRlbSA9IGZ1bmN0aW9uIChpdGVtKSB7XG4gIHJldHVybiBpdGVtO1xufTtcblxucHAucGFyc2VQYXJlbkFycm93TGlzdCA9IGZ1bmN0aW9uIChzdGFydFBvcywgc3RhcnRMb2MsIGV4cHJMaXN0KSB7XG4gIHJldHVybiB0aGlzLnBhcnNlQXJyb3dFeHByZXNzaW9uKHRoaXMuc3RhcnROb2RlQXQoc3RhcnRQb3MsIHN0YXJ0TG9jKSwgZXhwckxpc3QpO1xufTtcblxuLy8gTmV3J3MgcHJlY2VkZW5jZSBpcyBzbGlnaHRseSB0cmlja3kuIEl0IG11c3QgYWxsb3cgaXRzIGFyZ3VtZW50XG4vLyB0byBiZSBhIGBbXWAgb3IgZG90IHN1YnNjcmlwdCBleHByZXNzaW9uLCBidXQgbm90IGEgY2FsbCDigJQgYXRcbi8vIGxlYXN0LCBub3Qgd2l0aG91dCB3cmFwcGluZyBpdCBpbiBwYXJlbnRoZXNlcy4gVGh1cywgaXQgdXNlcyB0aGVcblxudmFyIGVtcHR5ID0gW107XG5cbnBwLnBhcnNlTmV3ID0gZnVuY3Rpb24gKCkge1xuICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gIHZhciBtZXRhID0gdGhpcy5wYXJzZUlkZW50KHRydWUpO1xuICBpZiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYgJiYgdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5kb3QpKSB7XG4gICAgbm9kZS5tZXRhID0gbWV0YTtcbiAgICBub2RlLnByb3BlcnR5ID0gdGhpcy5wYXJzZUlkZW50KHRydWUpO1xuICAgIGlmIChub2RlLnByb3BlcnR5Lm5hbWUgIT09IFwidGFyZ2V0XCIpIHRoaXMucmFpc2Uobm9kZS5wcm9wZXJ0eS5zdGFydCwgXCJUaGUgb25seSB2YWxpZCBtZXRhIHByb3BlcnR5IGZvciBuZXcgaXMgbmV3LnRhcmdldFwiKTtcbiAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiTWV0YVByb3BlcnR5XCIpO1xuICB9XG4gIHZhciBzdGFydFBvcyA9IHRoaXMuc3RhcnQsXG4gICAgICBzdGFydExvYyA9IHRoaXMuc3RhcnRMb2M7XG4gIG5vZGUuY2FsbGVlID0gdGhpcy5wYXJzZVN1YnNjcmlwdHModGhpcy5wYXJzZUV4cHJBdG9tKCksIHN0YXJ0UG9zLCBzdGFydExvYywgdHJ1ZSk7XG4gIGlmICh0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLnBhcmVuTCkpIG5vZGUuYXJndW1lbnRzID0gdGhpcy5wYXJzZUV4cHJMaXN0KF90b2tlbnR5cGUudHlwZXMucGFyZW5SLCBmYWxzZSk7ZWxzZSBub2RlLmFyZ3VtZW50cyA9IGVtcHR5O1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiTmV3RXhwcmVzc2lvblwiKTtcbn07XG5cbi8vIFBhcnNlIHRlbXBsYXRlIGV4cHJlc3Npb24uXG5cbnBwLnBhcnNlVGVtcGxhdGVFbGVtZW50ID0gZnVuY3Rpb24gKCkge1xuICB2YXIgZWxlbSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gIGVsZW0udmFsdWUgPSB7XG4gICAgcmF3OiB0aGlzLmlucHV0LnNsaWNlKHRoaXMuc3RhcnQsIHRoaXMuZW5kKS5yZXBsYWNlKC9cXHJcXG4/L2csICdcXG4nKSxcbiAgICBjb29rZWQ6IHRoaXMudmFsdWVcbiAgfTtcbiAgdGhpcy5uZXh0KCk7XG4gIGVsZW0udGFpbCA9IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5iYWNrUXVvdGU7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUoZWxlbSwgXCJUZW1wbGF0ZUVsZW1lbnRcIik7XG59O1xuXG5wcC5wYXJzZVRlbXBsYXRlID0gZnVuY3Rpb24gKCkge1xuICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gIHRoaXMubmV4dCgpO1xuICBub2RlLmV4cHJlc3Npb25zID0gW107XG4gIHZhciBjdXJFbHQgPSB0aGlzLnBhcnNlVGVtcGxhdGVFbGVtZW50KCk7XG4gIG5vZGUucXVhc2lzID0gW2N1ckVsdF07XG4gIHdoaWxlICghY3VyRWx0LnRhaWwpIHtcbiAgICB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmRvbGxhckJyYWNlTCk7XG4gICAgbm9kZS5leHByZXNzaW9ucy5wdXNoKHRoaXMucGFyc2VFeHByZXNzaW9uKCkpO1xuICAgIHRoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMuYnJhY2VSKTtcbiAgICBub2RlLnF1YXNpcy5wdXNoKGN1ckVsdCA9IHRoaXMucGFyc2VUZW1wbGF0ZUVsZW1lbnQoKSk7XG4gIH1cbiAgdGhpcy5uZXh0KCk7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJUZW1wbGF0ZUxpdGVyYWxcIik7XG59O1xuXG4vLyBQYXJzZSBhbiBvYmplY3QgbGl0ZXJhbCBvciBiaW5kaW5nIHBhdHRlcm4uXG5cbnBwLnBhcnNlT2JqID0gZnVuY3Rpb24gKGlzUGF0dGVybiwgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcykge1xuICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCksXG4gICAgICBmaXJzdCA9IHRydWUsXG4gICAgICBwcm9wSGFzaCA9IHt9O1xuICBub2RlLnByb3BlcnRpZXMgPSBbXTtcbiAgdGhpcy5uZXh0KCk7XG4gIHdoaWxlICghdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5icmFjZVIpKSB7XG4gICAgaWYgKCFmaXJzdCkge1xuICAgICAgdGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5jb21tYSk7XG4gICAgICBpZiAodGhpcy5hZnRlclRyYWlsaW5nQ29tbWEoX3Rva2VudHlwZS50eXBlcy5icmFjZVIpKSBicmVhaztcbiAgICB9IGVsc2UgZmlyc3QgPSBmYWxzZTtcblxuICAgIHZhciBwcm9wID0gdGhpcy5zdGFydE5vZGUoKSxcbiAgICAgICAgaXNHZW5lcmF0b3IgPSB1bmRlZmluZWQsXG4gICAgICAgIHN0YXJ0UG9zID0gdW5kZWZpbmVkLFxuICAgICAgICBzdGFydExvYyA9IHVuZGVmaW5lZDtcbiAgICBpZiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpIHtcbiAgICAgIHByb3AubWV0aG9kID0gZmFsc2U7XG4gICAgICBwcm9wLnNob3J0aGFuZCA9IGZhbHNlO1xuICAgICAgaWYgKGlzUGF0dGVybiB8fCByZWZTaG9ydGhhbmREZWZhdWx0UG9zKSB7XG4gICAgICAgIHN0YXJ0UG9zID0gdGhpcy5zdGFydDtcbiAgICAgICAgc3RhcnRMb2MgPSB0aGlzLnN0YXJ0TG9jO1xuICAgICAgfVxuICAgICAgaWYgKCFpc1BhdHRlcm4pIGlzR2VuZXJhdG9yID0gdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5zdGFyKTtcbiAgICB9XG4gICAgdGhpcy5wYXJzZVByb3BlcnR5TmFtZShwcm9wKTtcbiAgICB0aGlzLnBhcnNlUHJvcGVydHlWYWx1ZShwcm9wLCBpc1BhdHRlcm4sIGlzR2VuZXJhdG9yLCBzdGFydFBvcywgc3RhcnRMb2MsIHJlZlNob3J0aGFuZERlZmF1bHRQb3MpO1xuICAgIHRoaXMuY2hlY2tQcm9wQ2xhc2gocHJvcCwgcHJvcEhhc2gpO1xuICAgIG5vZGUucHJvcGVydGllcy5wdXNoKHRoaXMuZmluaXNoTm9kZShwcm9wLCBcIlByb3BlcnR5XCIpKTtcbiAgfVxuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIGlzUGF0dGVybiA/IFwiT2JqZWN0UGF0dGVyblwiIDogXCJPYmplY3RFeHByZXNzaW9uXCIpO1xufTtcblxucHAucGFyc2VQcm9wZXJ0eVZhbHVlID0gZnVuY3Rpb24gKHByb3AsIGlzUGF0dGVybiwgaXNHZW5lcmF0b3IsIHN0YXJ0UG9zLCBzdGFydExvYywgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcykge1xuICBpZiAodGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5jb2xvbikpIHtcbiAgICBwcm9wLnZhbHVlID0gaXNQYXR0ZXJuID8gdGhpcy5wYXJzZU1heWJlRGVmYXVsdCh0aGlzLnN0YXJ0LCB0aGlzLnN0YXJ0TG9jKSA6IHRoaXMucGFyc2VNYXliZUFzc2lnbihmYWxzZSwgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcyk7XG4gICAgcHJvcC5raW5kID0gXCJpbml0XCI7XG4gIH0gZWxzZSBpZiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYgJiYgdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLnBhcmVuTCkge1xuICAgIGlmIChpc1BhdHRlcm4pIHRoaXMudW5leHBlY3RlZCgpO1xuICAgIHByb3Aua2luZCA9IFwiaW5pdFwiO1xuICAgIHByb3AubWV0aG9kID0gdHJ1ZTtcbiAgICBwcm9wLnZhbHVlID0gdGhpcy5wYXJzZU1ldGhvZChpc0dlbmVyYXRvcik7XG4gIH0gZWxzZSBpZiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDUgJiYgIXByb3AuY29tcHV0ZWQgJiYgcHJvcC5rZXkudHlwZSA9PT0gXCJJZGVudGlmaWVyXCIgJiYgKHByb3Aua2V5Lm5hbWUgPT09IFwiZ2V0XCIgfHwgcHJvcC5rZXkubmFtZSA9PT0gXCJzZXRcIikgJiYgKHRoaXMudHlwZSAhPSBfdG9rZW50eXBlLnR5cGVzLmNvbW1hICYmIHRoaXMudHlwZSAhPSBfdG9rZW50eXBlLnR5cGVzLmJyYWNlUikpIHtcbiAgICBpZiAoaXNHZW5lcmF0b3IgfHwgaXNQYXR0ZXJuKSB0aGlzLnVuZXhwZWN0ZWQoKTtcbiAgICBwcm9wLmtpbmQgPSBwcm9wLmtleS5uYW1lO1xuICAgIHRoaXMucGFyc2VQcm9wZXJ0eU5hbWUocHJvcCk7XG4gICAgcHJvcC52YWx1ZSA9IHRoaXMucGFyc2VNZXRob2QoZmFsc2UpO1xuICAgIHZhciBwYXJhbUNvdW50ID0gcHJvcC5raW5kID09PSBcImdldFwiID8gMCA6IDE7XG4gICAgaWYgKHByb3AudmFsdWUucGFyYW1zLmxlbmd0aCAhPT0gcGFyYW1Db3VudCkge1xuICAgICAgdmFyIHN0YXJ0ID0gcHJvcC52YWx1ZS5zdGFydDtcbiAgICAgIGlmIChwcm9wLmtpbmQgPT09IFwiZ2V0XCIpIHRoaXMucmFpc2Uoc3RhcnQsIFwiZ2V0dGVyIHNob3VsZCBoYXZlIG5vIHBhcmFtc1wiKTtlbHNlIHRoaXMucmFpc2Uoc3RhcnQsIFwic2V0dGVyIHNob3VsZCBoYXZlIGV4YWN0bHkgb25lIHBhcmFtXCIpO1xuICAgIH1cbiAgfSBlbHNlIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNiAmJiAhcHJvcC5jb21wdXRlZCAmJiBwcm9wLmtleS50eXBlID09PSBcIklkZW50aWZpZXJcIikge1xuICAgIHByb3Aua2luZCA9IFwiaW5pdFwiO1xuICAgIGlmIChpc1BhdHRlcm4pIHtcbiAgICAgIGlmICh0aGlzLmlzS2V5d29yZChwcm9wLmtleS5uYW1lKSB8fCB0aGlzLnN0cmljdCAmJiAoX2lkZW50aWZpZXIucmVzZXJ2ZWRXb3Jkcy5zdHJpY3RCaW5kKHByb3Aua2V5Lm5hbWUpIHx8IF9pZGVudGlmaWVyLnJlc2VydmVkV29yZHMuc3RyaWN0KHByb3Aua2V5Lm5hbWUpKSB8fCAhdGhpcy5vcHRpb25zLmFsbG93UmVzZXJ2ZWQgJiYgdGhpcy5pc1Jlc2VydmVkV29yZChwcm9wLmtleS5uYW1lKSkgdGhpcy5yYWlzZShwcm9wLmtleS5zdGFydCwgXCJCaW5kaW5nIFwiICsgcHJvcC5rZXkubmFtZSk7XG4gICAgICBwcm9wLnZhbHVlID0gdGhpcy5wYXJzZU1heWJlRGVmYXVsdChzdGFydFBvcywgc3RhcnRMb2MsIHByb3Aua2V5KTtcbiAgICB9IGVsc2UgaWYgKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5lcSAmJiByZWZTaG9ydGhhbmREZWZhdWx0UG9zKSB7XG4gICAgICBpZiAoIXJlZlNob3J0aGFuZERlZmF1bHRQb3Muc3RhcnQpIHJlZlNob3J0aGFuZERlZmF1bHRQb3Muc3RhcnQgPSB0aGlzLnN0YXJ0O1xuICAgICAgcHJvcC52YWx1ZSA9IHRoaXMucGFyc2VNYXliZURlZmF1bHQoc3RhcnRQb3MsIHN0YXJ0TG9jLCBwcm9wLmtleSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHByb3AudmFsdWUgPSBwcm9wLmtleTtcbiAgICB9XG4gICAgcHJvcC5zaG9ydGhhbmQgPSB0cnVlO1xuICB9IGVsc2UgdGhpcy51bmV4cGVjdGVkKCk7XG59O1xuXG5wcC5wYXJzZVByb3BlcnR5TmFtZSA9IGZ1bmN0aW9uIChwcm9wKSB7XG4gIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNikge1xuICAgIGlmICh0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLmJyYWNrZXRMKSkge1xuICAgICAgcHJvcC5jb21wdXRlZCA9IHRydWU7XG4gICAgICBwcm9wLmtleSA9IHRoaXMucGFyc2VNYXliZUFzc2lnbigpO1xuICAgICAgdGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5icmFja2V0Uik7XG4gICAgICByZXR1cm4gcHJvcC5rZXk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHByb3AuY29tcHV0ZWQgPSBmYWxzZTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHByb3Aua2V5ID0gdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLm51bSB8fCB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuc3RyaW5nID8gdGhpcy5wYXJzZUV4cHJBdG9tKCkgOiB0aGlzLnBhcnNlSWRlbnQodHJ1ZSk7XG59O1xuXG4vLyBJbml0aWFsaXplIGVtcHR5IGZ1bmN0aW9uIG5vZGUuXG5cbnBwLmluaXRGdW5jdGlvbiA9IGZ1bmN0aW9uIChub2RlKSB7XG4gIG5vZGUuaWQgPSBudWxsO1xuICBpZiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpIHtcbiAgICBub2RlLmdlbmVyYXRvciA9IGZhbHNlO1xuICAgIG5vZGUuZXhwcmVzc2lvbiA9IGZhbHNlO1xuICB9XG59O1xuXG4vLyBQYXJzZSBvYmplY3Qgb3IgY2xhc3MgbWV0aG9kLlxuXG5wcC5wYXJzZU1ldGhvZCA9IGZ1bmN0aW9uIChpc0dlbmVyYXRvcikge1xuICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gIHRoaXMuaW5pdEZ1bmN0aW9uKG5vZGUpO1xuICB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLnBhcmVuTCk7XG4gIG5vZGUucGFyYW1zID0gdGhpcy5wYXJzZUJpbmRpbmdMaXN0KF90b2tlbnR5cGUudHlwZXMucGFyZW5SLCBmYWxzZSwgZmFsc2UpO1xuICB2YXIgYWxsb3dFeHByZXNzaW9uQm9keSA9IHVuZGVmaW5lZDtcbiAgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KSB7XG4gICAgbm9kZS5nZW5lcmF0b3IgPSBpc0dlbmVyYXRvcjtcbiAgfVxuICB0aGlzLnBhcnNlRnVuY3Rpb25Cb2R5KG5vZGUsIGZhbHNlKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkZ1bmN0aW9uRXhwcmVzc2lvblwiKTtcbn07XG5cbi8vIFBhcnNlIGFycm93IGZ1bmN0aW9uIGV4cHJlc3Npb24gd2l0aCBnaXZlbiBwYXJhbWV0ZXJzLlxuXG5wcC5wYXJzZUFycm93RXhwcmVzc2lvbiA9IGZ1bmN0aW9uIChub2RlLCBwYXJhbXMpIHtcbiAgdGhpcy5pbml0RnVuY3Rpb24obm9kZSk7XG4gIG5vZGUucGFyYW1zID0gdGhpcy50b0Fzc2lnbmFibGVMaXN0KHBhcmFtcywgdHJ1ZSk7XG4gIHRoaXMucGFyc2VGdW5jdGlvbkJvZHkobm9kZSwgdHJ1ZSk7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJBcnJvd0Z1bmN0aW9uRXhwcmVzc2lvblwiKTtcbn07XG5cbi8vIFBhcnNlIGZ1bmN0aW9uIGJvZHkgYW5kIGNoZWNrIHBhcmFtZXRlcnMuXG5cbnBwLnBhcnNlRnVuY3Rpb25Cb2R5ID0gZnVuY3Rpb24gKG5vZGUsIGFsbG93RXhwcmVzc2lvbikge1xuICB2YXIgaXNFeHByZXNzaW9uID0gYWxsb3dFeHByZXNzaW9uICYmIHRoaXMudHlwZSAhPT0gX3Rva2VudHlwZS50eXBlcy5icmFjZUw7XG5cbiAgaWYgKGlzRXhwcmVzc2lvbikge1xuICAgIG5vZGUuYm9keSA9IHRoaXMucGFyc2VNYXliZUFzc2lnbigpO1xuICAgIG5vZGUuZXhwcmVzc2lvbiA9IHRydWU7XG4gIH0gZWxzZSB7XG4gICAgLy8gU3RhcnQgYSBuZXcgc2NvcGUgd2l0aCByZWdhcmQgdG8gbGFiZWxzIGFuZCB0aGUgYGluRnVuY3Rpb25gXG4gICAgLy8gZmxhZyAocmVzdG9yZSB0aGVtIHRvIHRoZWlyIG9sZCB2YWx1ZSBhZnRlcndhcmRzKS5cbiAgICB2YXIgb2xkSW5GdW5jID0gdGhpcy5pbkZ1bmN0aW9uLFxuICAgICAgICBvbGRJbkdlbiA9IHRoaXMuaW5HZW5lcmF0b3IsXG4gICAgICAgIG9sZExhYmVscyA9IHRoaXMubGFiZWxzO1xuICAgIHRoaXMuaW5GdW5jdGlvbiA9IHRydWU7dGhpcy5pbkdlbmVyYXRvciA9IG5vZGUuZ2VuZXJhdG9yO3RoaXMubGFiZWxzID0gW107XG4gICAgbm9kZS5ib2R5ID0gdGhpcy5wYXJzZUJsb2NrKHRydWUpO1xuICAgIG5vZGUuZXhwcmVzc2lvbiA9IGZhbHNlO1xuICAgIHRoaXMuaW5GdW5jdGlvbiA9IG9sZEluRnVuYzt0aGlzLmluR2VuZXJhdG9yID0gb2xkSW5HZW47dGhpcy5sYWJlbHMgPSBvbGRMYWJlbHM7XG4gIH1cblxuICAvLyBJZiB0aGlzIGlzIGEgc3RyaWN0IG1vZGUgZnVuY3Rpb24sIHZlcmlmeSB0aGF0IGFyZ3VtZW50IG5hbWVzXG4gIC8vIGFyZSBub3QgcmVwZWF0ZWQsIGFuZCBpdCBkb2VzIG5vdCB0cnkgdG8gYmluZCB0aGUgd29yZHMgYGV2YWxgXG4gIC8vIG9yIGBhcmd1bWVudHNgLlxuICBpZiAodGhpcy5zdHJpY3QgfHwgIWlzRXhwcmVzc2lvbiAmJiBub2RlLmJvZHkuYm9keS5sZW5ndGggJiYgdGhpcy5pc1VzZVN0cmljdChub2RlLmJvZHkuYm9keVswXSkpIHtcbiAgICB2YXIgbmFtZUhhc2ggPSB7fSxcbiAgICAgICAgb2xkU3RyaWN0ID0gdGhpcy5zdHJpY3Q7XG4gICAgdGhpcy5zdHJpY3QgPSB0cnVlO1xuICAgIGlmIChub2RlLmlkKSB0aGlzLmNoZWNrTFZhbChub2RlLmlkLCB0cnVlKTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IG5vZGUucGFyYW1zLmxlbmd0aDsgaSsrKSB7XG4gICAgICB0aGlzLmNoZWNrTFZhbChub2RlLnBhcmFtc1tpXSwgdHJ1ZSwgbmFtZUhhc2gpO1xuICAgIH10aGlzLnN0cmljdCA9IG9sZFN0cmljdDtcbiAgfVxufTtcblxuLy8gUGFyc2VzIGEgY29tbWEtc2VwYXJhdGVkIGxpc3Qgb2YgZXhwcmVzc2lvbnMsIGFuZCByZXR1cm5zIHRoZW0gYXNcbi8vIGFuIGFycmF5LiBgY2xvc2VgIGlzIHRoZSB0b2tlbiB0eXBlIHRoYXQgZW5kcyB0aGUgbGlzdCwgYW5kXG4vLyBgYWxsb3dFbXB0eWAgY2FuIGJlIHR1cm5lZCBvbiB0byBhbGxvdyBzdWJzZXF1ZW50IGNvbW1hcyB3aXRoXG4vLyBub3RoaW5nIGluIGJldHdlZW4gdGhlbSB0byBiZSBwYXJzZWQgYXMgYG51bGxgICh3aGljaCBpcyBuZWVkZWRcbi8vIGZvciBhcnJheSBsaXRlcmFscykuXG5cbnBwLnBhcnNlRXhwckxpc3QgPSBmdW5jdGlvbiAoY2xvc2UsIGFsbG93VHJhaWxpbmdDb21tYSwgYWxsb3dFbXB0eSwgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcykge1xuICB2YXIgZWx0cyA9IFtdLFxuICAgICAgZmlyc3QgPSB0cnVlO1xuICB3aGlsZSAoIXRoaXMuZWF0KGNsb3NlKSkge1xuICAgIGlmICghZmlyc3QpIHtcbiAgICAgIHRoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMuY29tbWEpO1xuICAgICAgaWYgKGFsbG93VHJhaWxpbmdDb21tYSAmJiB0aGlzLmFmdGVyVHJhaWxpbmdDb21tYShjbG9zZSkpIGJyZWFrO1xuICAgIH0gZWxzZSBmaXJzdCA9IGZhbHNlO1xuXG4gICAgdmFyIGVsdCA9IHVuZGVmaW5lZDtcbiAgICBpZiAoYWxsb3dFbXB0eSAmJiB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuY29tbWEpIGVsdCA9IG51bGw7ZWxzZSBpZiAodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmVsbGlwc2lzKSBlbHQgPSB0aGlzLnBhcnNlU3ByZWFkKHJlZlNob3J0aGFuZERlZmF1bHRQb3MpO2Vsc2UgZWx0ID0gdGhpcy5wYXJzZU1heWJlQXNzaWduKGZhbHNlLCByZWZTaG9ydGhhbmREZWZhdWx0UG9zKTtcbiAgICBlbHRzLnB1c2goZWx0KTtcbiAgfVxuICByZXR1cm4gZWx0cztcbn07XG5cbi8vIFBhcnNlIHRoZSBuZXh0IHRva2VuIGFzIGFuIGlkZW50aWZpZXIuIElmIGBsaWJlcmFsYCBpcyB0cnVlICh1c2VkXG4vLyB3aGVuIHBhcnNpbmcgcHJvcGVydGllcyksIGl0IHdpbGwgYWxzbyBjb252ZXJ0IGtleXdvcmRzIGludG9cbi8vIGlkZW50aWZpZXJzLlxuXG5wcC5wYXJzZUlkZW50ID0gZnVuY3Rpb24gKGxpYmVyYWwpIHtcbiAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICBpZiAobGliZXJhbCAmJiB0aGlzLm9wdGlvbnMuYWxsb3dSZXNlcnZlZCA9PSBcIm5ldmVyXCIpIGxpYmVyYWwgPSBmYWxzZTtcbiAgaWYgKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5uYW1lKSB7XG4gICAgaWYgKCFsaWJlcmFsICYmICghdGhpcy5vcHRpb25zLmFsbG93UmVzZXJ2ZWQgJiYgdGhpcy5pc1Jlc2VydmVkV29yZCh0aGlzLnZhbHVlKSB8fCB0aGlzLnN0cmljdCAmJiBfaWRlbnRpZmllci5yZXNlcnZlZFdvcmRzLnN0cmljdCh0aGlzLnZhbHVlKSAmJiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYgfHwgdGhpcy5pbnB1dC5zbGljZSh0aGlzLnN0YXJ0LCB0aGlzLmVuZCkuaW5kZXhPZihcIlxcXFxcIikgPT0gLTEpKSkgdGhpcy5yYWlzZSh0aGlzLnN0YXJ0LCBcIlRoZSBrZXl3b3JkICdcIiArIHRoaXMudmFsdWUgKyBcIicgaXMgcmVzZXJ2ZWRcIik7XG4gICAgbm9kZS5uYW1lID0gdGhpcy52YWx1ZTtcbiAgfSBlbHNlIGlmIChsaWJlcmFsICYmIHRoaXMudHlwZS5rZXl3b3JkKSB7XG4gICAgbm9kZS5uYW1lID0gdGhpcy50eXBlLmtleXdvcmQ7XG4gIH0gZWxzZSB7XG4gICAgdGhpcy51bmV4cGVjdGVkKCk7XG4gIH1cbiAgdGhpcy5uZXh0KCk7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJJZGVudGlmaWVyXCIpO1xufTtcblxuLy8gUGFyc2VzIHlpZWxkIGV4cHJlc3Npb24gaW5zaWRlIGdlbmVyYXRvci5cblxucHAucGFyc2VZaWVsZCA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICB0aGlzLm5leHQoKTtcbiAgaWYgKHRoaXMudHlwZSA9PSBfdG9rZW50eXBlLnR5cGVzLnNlbWkgfHwgdGhpcy5jYW5JbnNlcnRTZW1pY29sb24oKSB8fCB0aGlzLnR5cGUgIT0gX3Rva2VudHlwZS50eXBlcy5zdGFyICYmICF0aGlzLnR5cGUuc3RhcnRzRXhwcikge1xuICAgIG5vZGUuZGVsZWdhdGUgPSBmYWxzZTtcbiAgICBub2RlLmFyZ3VtZW50ID0gbnVsbDtcbiAgfSBlbHNlIHtcbiAgICBub2RlLmRlbGVnYXRlID0gdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5zdGFyKTtcbiAgICBub2RlLmFyZ3VtZW50ID0gdGhpcy5wYXJzZU1heWJlQXNzaWduKCk7XG4gIH1cbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIllpZWxkRXhwcmVzc2lvblwiKTtcbn07XG5cbi8vIFBhcnNlcyBhcnJheSBhbmQgZ2VuZXJhdG9yIGNvbXByZWhlbnNpb25zLlxuXG5wcC5wYXJzZUNvbXByZWhlbnNpb24gPSBmdW5jdGlvbiAobm9kZSwgaXNHZW5lcmF0b3IpIHtcbiAgbm9kZS5ibG9ja3MgPSBbXTtcbiAgd2hpbGUgKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fZm9yKSB7XG4gICAgdmFyIGJsb2NrID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgICB0aGlzLm5leHQoKTtcbiAgICB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLnBhcmVuTCk7XG4gICAgYmxvY2subGVmdCA9IHRoaXMucGFyc2VCaW5kaW5nQXRvbSgpO1xuICAgIHRoaXMuY2hlY2tMVmFsKGJsb2NrLmxlZnQsIHRydWUpO1xuICAgIHRoaXMuZXhwZWN0Q29udGV4dHVhbChcIm9mXCIpO1xuICAgIGJsb2NrLnJpZ2h0ID0gdGhpcy5wYXJzZUV4cHJlc3Npb24oKTtcbiAgICB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLnBhcmVuUik7XG4gICAgbm9kZS5ibG9ja3MucHVzaCh0aGlzLmZpbmlzaE5vZGUoYmxvY2ssIFwiQ29tcHJlaGVuc2lvbkJsb2NrXCIpKTtcbiAgfVxuICBub2RlLmZpbHRlciA9IHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuX2lmKSA/IHRoaXMucGFyc2VQYXJlbkV4cHJlc3Npb24oKSA6IG51bGw7XG4gIG5vZGUuYm9keSA9IHRoaXMucGFyc2VFeHByZXNzaW9uKCk7XG4gIHRoaXMuZXhwZWN0KGlzR2VuZXJhdG9yID8gX3Rva2VudHlwZS50eXBlcy5wYXJlblIgOiBfdG9rZW50eXBlLnR5cGVzLmJyYWNrZXRSKTtcbiAgbm9kZS5nZW5lcmF0b3IgPSBpc0dlbmVyYXRvcjtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkNvbXByZWhlbnNpb25FeHByZXNzaW9uXCIpO1xufTtcblxufSx7XCIuL2lkZW50aWZpZXJcIjoyLFwiLi9zdGF0ZVwiOjEwLFwiLi90b2tlbnR5cGVcIjoxNCxcIi4vdXRpbFwiOjE1fV0sMjpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7XG4vLyBUaGlzIGlzIGEgdHJpY2sgdGFrZW4gZnJvbSBFc3ByaW1hLiBJdCB0dXJucyBvdXQgdGhhdCwgb25cbi8vIG5vbi1DaHJvbWUgYnJvd3NlcnMsIHRvIGNoZWNrIHdoZXRoZXIgYSBzdHJpbmcgaXMgaW4gYSBzZXQsIGFcbi8vIHByZWRpY2F0ZSBjb250YWluaW5nIGEgYmlnIHVnbHkgYHN3aXRjaGAgc3RhdGVtZW50IGlzIGZhc3RlciB0aGFuXG4vLyBhIHJlZ3VsYXIgZXhwcmVzc2lvbiwgYW5kIG9uIENocm9tZSB0aGUgdHdvIGFyZSBhYm91dCBvbiBwYXIuXG4vLyBUaGlzIGZ1bmN0aW9uIHVzZXMgYGV2YWxgIChub24tbGV4aWNhbCkgdG8gcHJvZHVjZSBzdWNoIGFcbi8vIHByZWRpY2F0ZSBmcm9tIGEgc3BhY2Utc2VwYXJhdGVkIHN0cmluZyBvZiB3b3Jkcy5cbi8vXG4vLyBJdCBzdGFydHMgYnkgc29ydGluZyB0aGUgd29yZHMgYnkgbGVuZ3RoLlxuXG5cInVzZSBzdHJpY3RcIjtcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcbmV4cG9ydHMuaXNJZGVudGlmaWVyU3RhcnQgPSBpc0lkZW50aWZpZXJTdGFydDtcbmV4cG9ydHMuaXNJZGVudGlmaWVyQ2hhciA9IGlzSWRlbnRpZmllckNoYXI7XG5mdW5jdGlvbiBtYWtlUHJlZGljYXRlKHdvcmRzKSB7XG4gIHdvcmRzID0gd29yZHMuc3BsaXQoXCIgXCIpO1xuICB2YXIgZiA9IFwiXCIsXG4gICAgICBjYXRzID0gW107XG4gIG91dDogZm9yICh2YXIgaSA9IDA7IGkgPCB3b3Jkcy5sZW5ndGg7ICsraSkge1xuICAgIGZvciAodmFyIGogPSAwOyBqIDwgY2F0cy5sZW5ndGg7ICsraikge1xuICAgICAgaWYgKGNhdHNbal1bMF0ubGVuZ3RoID09IHdvcmRzW2ldLmxlbmd0aCkge1xuICAgICAgICBjYXRzW2pdLnB1c2god29yZHNbaV0pO1xuICAgICAgICBjb250aW51ZSBvdXQ7XG4gICAgICB9XG4gICAgfWNhdHMucHVzaChbd29yZHNbaV1dKTtcbiAgfVxuICBmdW5jdGlvbiBjb21wYXJlVG8oYXJyKSB7XG4gICAgaWYgKGFyci5sZW5ndGggPT0gMSkgcmV0dXJuIGYgKz0gXCJyZXR1cm4gc3RyID09PSBcIiArIEpTT04uc3RyaW5naWZ5KGFyclswXSkgKyBcIjtcIjtcbiAgICBmICs9IFwic3dpdGNoKHN0cil7XCI7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBhcnIubGVuZ3RoOyArK2kpIHtcbiAgICAgIGYgKz0gXCJjYXNlIFwiICsgSlNPTi5zdHJpbmdpZnkoYXJyW2ldKSArIFwiOlwiO1xuICAgIH1mICs9IFwicmV0dXJuIHRydWV9cmV0dXJuIGZhbHNlO1wiO1xuICB9XG5cbiAgLy8gV2hlbiB0aGVyZSBhcmUgbW9yZSB0aGFuIHRocmVlIGxlbmd0aCBjYXRlZ29yaWVzLCBhbiBvdXRlclxuICAvLyBzd2l0Y2ggZmlyc3QgZGlzcGF0Y2hlcyBvbiB0aGUgbGVuZ3RocywgdG8gc2F2ZSBvbiBjb21wYXJpc29ucy5cblxuICBpZiAoY2F0cy5sZW5ndGggPiAzKSB7XG4gICAgY2F0cy5zb3J0KGZ1bmN0aW9uIChhLCBiKSB7XG4gICAgICByZXR1cm4gYi5sZW5ndGggLSBhLmxlbmd0aDtcbiAgICB9KTtcbiAgICBmICs9IFwic3dpdGNoKHN0ci5sZW5ndGgpe1wiO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgY2F0cy5sZW5ndGg7ICsraSkge1xuICAgICAgdmFyIGNhdCA9IGNhdHNbaV07XG4gICAgICBmICs9IFwiY2FzZSBcIiArIGNhdFswXS5sZW5ndGggKyBcIjpcIjtcbiAgICAgIGNvbXBhcmVUbyhjYXQpO1xuICAgIH1cbiAgICBmICs9IFwifVwiO1xuXG4gICAgLy8gT3RoZXJ3aXNlLCBzaW1wbHkgZ2VuZXJhdGUgYSBmbGF0IGBzd2l0Y2hgIHN0YXRlbWVudC5cbiAgfSBlbHNlIHtcbiAgICAgIGNvbXBhcmVUbyh3b3Jkcyk7XG4gICAgfVxuICByZXR1cm4gbmV3IEZ1bmN0aW9uKFwic3RyXCIsIGYpO1xufVxuXG4vLyBSZXNlcnZlZCB3b3JkIGxpc3RzIGZvciB2YXJpb3VzIGRpYWxlY3RzIG9mIHRoZSBsYW5ndWFnZVxuXG52YXIgcmVzZXJ2ZWRXb3JkcyA9IHtcbiAgMzogbWFrZVByZWRpY2F0ZShcImFic3RyYWN0IGJvb2xlYW4gYnl0ZSBjaGFyIGNsYXNzIGRvdWJsZSBlbnVtIGV4cG9ydCBleHRlbmRzIGZpbmFsIGZsb2F0IGdvdG8gaW1wbGVtZW50cyBpbXBvcnQgaW50IGludGVyZmFjZSBsb25nIG5hdGl2ZSBwYWNrYWdlIHByaXZhdGUgcHJvdGVjdGVkIHB1YmxpYyBzaG9ydCBzdGF0aWMgc3VwZXIgc3luY2hyb25pemVkIHRocm93cyB0cmFuc2llbnQgdm9sYXRpbGVcIiksXG4gIDU6IG1ha2VQcmVkaWNhdGUoXCJjbGFzcyBlbnVtIGV4dGVuZHMgc3VwZXIgY29uc3QgZXhwb3J0IGltcG9ydFwiKSxcbiAgNjogbWFrZVByZWRpY2F0ZShcImVudW0gYXdhaXRcIiksXG4gIHN0cmljdDogbWFrZVByZWRpY2F0ZShcImltcGxlbWVudHMgaW50ZXJmYWNlIGxldCBwYWNrYWdlIHByaXZhdGUgcHJvdGVjdGVkIHB1YmxpYyBzdGF0aWMgeWllbGRcIiksXG4gIHN0cmljdEJpbmQ6IG1ha2VQcmVkaWNhdGUoXCJldmFsIGFyZ3VtZW50c1wiKVxufTtcblxuZXhwb3J0cy5yZXNlcnZlZFdvcmRzID0gcmVzZXJ2ZWRXb3Jkcztcbi8vIEFuZCB0aGUga2V5d29yZHNcblxudmFyIGVjbWE1QW5kTGVzc0tleXdvcmRzID0gXCJicmVhayBjYXNlIGNhdGNoIGNvbnRpbnVlIGRlYnVnZ2VyIGRlZmF1bHQgZG8gZWxzZSBmaW5hbGx5IGZvciBmdW5jdGlvbiBpZiByZXR1cm4gc3dpdGNoIHRocm93IHRyeSB2YXIgd2hpbGUgd2l0aCBudWxsIHRydWUgZmFsc2UgaW5zdGFuY2VvZiB0eXBlb2Ygdm9pZCBkZWxldGUgbmV3IGluIHRoaXNcIjtcblxudmFyIGtleXdvcmRzID0ge1xuICA1OiBtYWtlUHJlZGljYXRlKGVjbWE1QW5kTGVzc0tleXdvcmRzKSxcbiAgNjogbWFrZVByZWRpY2F0ZShlY21hNUFuZExlc3NLZXl3b3JkcyArIFwiIGxldCBjb25zdCBjbGFzcyBleHRlbmRzIGV4cG9ydCBpbXBvcnQgeWllbGQgc3VwZXJcIilcbn07XG5cbmV4cG9ydHMua2V5d29yZHMgPSBrZXl3b3Jkcztcbi8vICMjIENoYXJhY3RlciBjYXRlZ29yaWVzXG5cbi8vIEJpZyB1Z2x5IHJlZ3VsYXIgZXhwcmVzc2lvbnMgdGhhdCBtYXRjaCBjaGFyYWN0ZXJzIGluIHRoZVxuLy8gd2hpdGVzcGFjZSwgaWRlbnRpZmllciwgYW5kIGlkZW50aWZpZXItc3RhcnQgY2F0ZWdvcmllcy4gVGhlc2Vcbi8vIGFyZSBvbmx5IGFwcGxpZWQgd2hlbiBhIGNoYXJhY3RlciBpcyBmb3VuZCB0byBhY3R1YWxseSBoYXZlIGFcbi8vIGNvZGUgcG9pbnQgYWJvdmUgMTI4LlxuLy8gR2VuZXJhdGVkIGJ5IGB0b29scy9nZW5lcmF0ZS1pZGVudGlmaWVyLXJlZ2V4LmpzYC5cblxudmFyIG5vbkFTQ0lJaWRlbnRpZmllclN0YXJ0Q2hhcnMgPSBcIsKqwrXCusOALcOWw5gtw7bDuC3LgcuGLcuRy6Aty6TLrMuuzbAtzbTNts23zbotzb3Nv86GzogtzorOjM6OLc6hzqMtz7XPty3SgdKKLdSv1LEt1ZbVmdWhLdaH15At16rXsC3XstigLdmK2a7Zr9mxLduT25Xbpdum267br9u6Ldu827/ckNySLdyv3Y0t3qXesd+KLd+q37Tftd+64KCALeCgleCgmuCgpOCgqOChgC3goZjgoqAt4KKy4KSELeCkueCkveClkOClmC3gpaHgpbEt4KaA4KaFLeCmjOCmj+CmkOCmky3gpqjgpqot4Kaw4Kay4Ka2LeCmueCmveCnjuCnnOCnneCnny3gp6Hgp7Dgp7HgqIUt4KiK4KiP4KiQ4KiTLeCoqOCoqi3gqLDgqLLgqLPgqLXgqLbgqLjgqLngqZkt4Kmc4Kme4KmyLeCptOCqhS3gqo3gqo8t4KqR4KqTLeCqqOCqqi3gqrDgqrLgqrPgqrUt4Kq54Kq94KuQ4Kug4Kuh4KyFLeCsjOCsj+CskOCsky3grKjgrKot4Kyw4Kyy4Kyz4Ky1LeCsueCsveCtnOCtneCtny3graHgrbHgroPgroUt4K6K4K6OLeCukOCuki3grpXgrpngrprgrpzgrp7grp/grqPgrqTgrqgt4K6q4K6uLeCuueCvkOCwhS3gsIzgsI4t4LCQ4LCSLeCwqOCwqi3gsLngsL3gsZjgsZngsaDgsaHgsoUt4LKM4LKOLeCykOCyki3gsqjgsqot4LKz4LK1LeCyueCyveCznuCzoOCzoeCzseCzsuC0hS3gtIzgtI4t4LSQ4LSSLeC0uuC0veC1juC1oOC1oeC1ui3gtb/gtoUt4LaW4LaaLeC2seC2sy3gtrvgtr3gt4At4LeG4LiBLeC4sOC4suC4s+C5gC3guYbguoHguoLguoTguofguojguorguo3gupQt4LqX4LqZLeC6n+C6oS3guqPguqXguqfguqrguqvguq0t4Lqw4Lqy4Lqz4Lq94LuALeC7hOC7huC7nC3gu5/gvIDgvYAt4L2H4L2JLeC9rOC+iC3gvozhgIAt4YCq4YC/4YGQLeGBleGBmi3hgZ3hgaHhgaXhgabhga4t4YGw4YG1LeGCgeGCjuGCoC3hg4Xhg4fhg43hg5At4YO64YO8LeGJiOGJii3hiY3hiZAt4YmW4YmY4YmaLeGJneGJoC3hiojhioot4YqN4YqQLeGKsOGKsi3hirXhirgt4Yq+4YuA4YuCLeGLheGLiC3hi5bhi5gt4YyQ4YySLeGMleGMmC3hjZrhjoAt4Y6P4Y6gLeGPtOGQgS3hmazhma8t4Zm/4ZqBLeGamuGaoC3hm6rhm64t4Zu44ZyALeGcjOGcji3hnJHhnKAt4Zyx4Z2ALeGdkeGdoC3hnazhna4t4Z2w4Z6ALeGes+Gfl+GfnOGgoC3hobfhooAt4aKo4aKq4aKwLeGjteGkgC3hpJ7hpZAt4aWt4aWwLeGltOGmgC3hpqvhp4Et4aeH4aiALeGoluGooC3hqZThqqfhrIUt4ayz4a2FLeGti+Gugy3hrqDhrq7hrq/hrrot4a+l4bCALeGwo+GxjS3hsY/hsZot4bG94bOpLeGzrOGzri3hs7Hhs7Xhs7bhtIAt4ba/4biALeG8leG8mC3hvJ3hvKAt4b2F4b2ILeG9jeG9kC3hvZfhvZnhvZvhvZ3hvZ8t4b294b6ALeG+tOG+ti3hvrzhvr7hv4It4b+E4b+GLeG/jOG/kC3hv5Phv5Yt4b+b4b+gLeG/rOG/si3hv7Thv7Yt4b+84oGx4oG/4oKQLeKCnOKEguKEh+KEii3ihJPihJXihJgt4oSd4oSk4oSm4oSo4oSqLeKEueKEvC3ihL/ihYUt4oWJ4oWO4oWgLeKGiOKwgC3isK7isLAt4rGe4rGgLeKzpOKzqy3is67is7Lis7PitIAt4rSl4rSn4rSt4rSwLeK1p+K1r+K2gC3itpbitqAt4ram4raoLeK2ruK2sC3itrbitrgt4ra+4reALeK3huK3iC3it47it5At4reW4reYLeK3nuOAhS3jgIfjgKEt44Cp44CxLeOAteOAuC3jgLzjgYEt44KW44KbLeOCn+OCoS3jg7rjg7wt44O/44SFLeOEreOEsS3jho7jhqAt44a644ewLeOHv+OQgC3ktrXkuIAt6b+M6oCALeqSjOqTkC3qk73qlIAt6piM6piQLeqYn+qYquqYq+qZgC3qma7qmb8t6pqd6pqgLeqbr+qcly3qnJ/qnKIt6p6I6p6LLeqejuqekC3qnq3qnrDqnrHqn7ct6qCB6qCDLeqgheqghy3qoIrqoIwt6qCi6qGALeqhs+qigi3qorPqo7It6qO36qO76qSKLeqkpeqksC3qpYbqpaAt6qW86qaELeqmsuqnj+qnoC3qp6Tqp6Yt6qev6qe6LeqnvuqogC3qqKjqqYAt6qmC6qmELeqpi+qpoC3qqbbqqbrqqb4t6qqv6qqx6qq16qq26qq5LeqqveqrgOqrguqrmy3qq53qq6At6quq6quyLeqrtOqsgS3qrIbqrIkt6qyO6qyRLeqsluqsoC3qrKbqrKgt6qyu6qywLeqtmuqtnC3qrZ/qraTqraXqr4At6q+i6rCALe2eo+2esC3tn4btn4st7Z+776SALe+pre+psC3vq5nvrIAt76yG76yTLe+sl++sne+sny3vrKjvrKot76y276y4Le+svO+svu+tgO+tge+tg++thO+thi3vrrHvr5Mt77S977WQLe+2j++2ki3vt4fvt7At77e777mwLe+5tO+5ti3vu7zvvKEt77y6772BLe+9mu+9pi3vvr7vv4It77+H77+KLe+/j++/ki3vv5fvv5ot77+cXCI7XG52YXIgbm9uQVNDSUlpZGVudGlmaWVyQ2hhcnMgPSBcIuKAjOKAjcK3zIAtza/Oh9KDLdKH1pEt1r3Wv9eB14LXhNeF14fYkC3YmtmLLdmp2bDbli3bnNufLduk26fbqNuqLdut27At27nckdywLd2K3qYt3rDfgC3fid+rLd+z4KCWLeCgmeCgmy3goKPgoKUt4KCn4KCpLeCgreChmS3goZvgo6Qt4KSD4KS6LeCkvOCkvi3gpY/gpZEt4KWX4KWi4KWj4KWmLeClr+CmgS3gpoPgprzgpr4t4KeE4KeH4KeI4KeLLeCnjeCnl+CnouCno+Cnpi3gp6/gqIEt4KiD4Ki84Ki+LeCpguCph+CpiOCpiy3gqY3gqZHgqaYt4Kmx4Km14KqBLeCqg+CqvOCqvi3gq4Xgq4ct4KuJ4KuLLeCrjeCrouCro+Crpi3gq6/grIEt4KyD4Ky84Ky+LeCthOCth+CtiOCtiy3grY3grZbgrZfgraLgraPgraYt4K2v4K6C4K6+LeCvguCvhi3gr4jgr4ot4K+N4K+X4K+mLeCvr+CwgC3gsIPgsL4t4LGE4LGGLeCxiOCxii3gsY3gsZXgsZbgsaLgsaPgsaYt4LGv4LKBLeCyg+CyvOCyvi3gs4Tgs4Yt4LOI4LOKLeCzjeCzleCzluCzouCzo+Czpi3gs6/gtIEt4LSD4LS+LeC1hOC1hi3gtYjgtYot4LWN4LWX4LWi4LWj4LWmLeC1r+C2guC2g+C3iuC3jy3gt5Tgt5bgt5gt4Lef4LemLeC3r+C3suC3s+C4seC4tC3guLrguYct4LmO4LmQLeC5meC6seC6tC3gurngurvgurzgu4gt4LuN4LuQLeC7meC8mOC8meC8oC3gvKngvLXgvLfgvLngvL7gvL/gvbEt4L6E4L6G4L6H4L6NLeC+l+C+mS3gvrzgv4bhgKst4YC+4YGALeGBieGBli3hgZnhgZ4t4YGg4YGiLeGBpOGBpy3hga3hgbEt4YG04YKCLeGCjeGCjy3hgp3hjZ0t4Y2f4Y2pLeGNseGcki3hnJThnLIt4Zy04Z2S4Z2T4Z2y4Z2z4Z60LeGfk+GfneGfoC3hn6nhoIst4aCN4aCQLeGgmeGiqeGkoC3hpKvhpLAt4aS74aWGLeGlj+GmsC3hp4Dhp4jhp4nhp5At4aea4aiXLeGom+GplS3hqZ7hqaAt4am84am/LeGqieGqkC3hqpnhqrAt4aq94ayALeGshOGstC3hrYThrZAt4a2Z4a2rLeGts+GugC3hroLhrqEt4a6t4a6wLeGuueGvpi3hr7PhsKQt4bC34bGALeGxieGxkC3hsZnhs5At4bOS4bOULeGzqOGzreGzsi3hs7Ths7jhs7nht4At4be14be8LeG3v+KAv+KBgOKBlOKDkC3ig5zig6Hig6Ut4oOw4rOvLeKzseK1v+K3oC3it7/jgKot44Cv44KZ44Ka6pigLeqYqeqZr+qZtC3qmb3qmp/qm7Dqm7HqoILqoIbqoIvqoKMt6qCn6qKA6qKB6qK0LeqjhOqjkC3qo5nqo6At6qOx6qSALeqkieqkpi3qpK3qpYct6qWT6qaALeqmg+qmsy3qp4Dqp5At6qeZ6qel6qewLeqnueqoqS3qqLbqqYPqqYzqqY3qqZAt6qmZ6qm7LeqpveqqsOqqsi3qqrTqqrfqqrjqqr7qqr/qq4Hqq6st6quv6qu16qu26q+jLeqvquqvrOqvreqvsC3qr7nvrJ7vuIAt77iP77igLe+4re+4s++4tO+5jS3vuY/vvJAt77yZ77y/XCI7XG5cbnZhciBub25BU0NJSWlkZW50aWZpZXJTdGFydCA9IG5ldyBSZWdFeHAoXCJbXCIgKyBub25BU0NJSWlkZW50aWZpZXJTdGFydENoYXJzICsgXCJdXCIpO1xudmFyIG5vbkFTQ0lJaWRlbnRpZmllciA9IG5ldyBSZWdFeHAoXCJbXCIgKyBub25BU0NJSWlkZW50aWZpZXJTdGFydENoYXJzICsgbm9uQVNDSUlpZGVudGlmaWVyQ2hhcnMgKyBcIl1cIik7XG5cbm5vbkFTQ0lJaWRlbnRpZmllclN0YXJ0Q2hhcnMgPSBub25BU0NJSWlkZW50aWZpZXJDaGFycyA9IG51bGw7XG5cbi8vIFRoZXNlIGFyZSBhIHJ1bi1sZW5ndGggYW5kIG9mZnNldCBlbmNvZGVkIHJlcHJlc2VudGF0aW9uIG9mIHRoZVxuLy8gPjB4ZmZmZiBjb2RlIHBvaW50cyB0aGF0IGFyZSBhIHZhbGlkIHBhcnQgb2YgaWRlbnRpZmllcnMuIFRoZVxuLy8gb2Zmc2V0IHN0YXJ0cyBhdCAweDEwMDAwLCBhbmQgZWFjaCBwYWlyIG9mIG51bWJlcnMgcmVwcmVzZW50cyBhblxuLy8gb2Zmc2V0IHRvIHRoZSBuZXh0IHJhbmdlLCBhbmQgdGhlbiBhIHNpemUgb2YgdGhlIHJhbmdlLiBUaGV5IHdlcmVcbi8vIGdlbmVyYXRlZCBieSB0b29scy9nZW5lcmF0ZS1pZGVudGlmaWVyLXJlZ2V4LmpzXG52YXIgYXN0cmFsSWRlbnRpZmllclN0YXJ0Q29kZXMgPSBbMCwgMTEsIDIsIDI1LCAyLCAxOCwgMiwgMSwgMiwgMTQsIDMsIDEzLCAzNSwgMTIyLCA3MCwgNTIsIDI2OCwgMjgsIDQsIDQ4LCA0OCwgMzEsIDE3LCAyNiwgNiwgMzcsIDExLCAyOSwgMywgMzUsIDUsIDcsIDIsIDQsIDQzLCAxNTcsIDk5LCAzOSwgOSwgNTEsIDE1NywgMzEwLCAxMCwgMjEsIDExLCA3LCAxNTMsIDUsIDMsIDAsIDIsIDQzLCAyLCAxLCA0LCAwLCAzLCAyMiwgMTEsIDIyLCAxMCwgMzAsIDk4LCAyMSwgMTEsIDI1LCA3MSwgNTUsIDcsIDEsIDY1LCAwLCAxNiwgMywgMiwgMiwgMiwgMjYsIDQ1LCAyOCwgNCwgMjgsIDM2LCA3LCAyLCAyNywgMjgsIDUzLCAxMSwgMjEsIDExLCAxOCwgMTQsIDE3LCAxMTEsIDcyLCA5NTUsIDUyLCA3NiwgNDQsIDMzLCAyNCwgMjcsIDM1LCA0MiwgMzQsIDQsIDAsIDEzLCA0NywgMTUsIDMsIDIyLCAwLCAzOCwgMTcsIDIsIDI0LCAxMzMsIDQ2LCAzOSwgNywgMywgMSwgMywgMjEsIDIsIDYsIDIsIDEsIDIsIDQsIDQsIDAsIDMyLCA0LCAyODcsIDQ3LCAyMSwgMSwgMiwgMCwgMTg1LCA0NiwgODIsIDQ3LCAyMSwgMCwgNjAsIDQyLCA1MDIsIDYzLCAzMiwgMCwgNDQ5LCA1NiwgMTI4OCwgOTIwLCAxMDQsIDExMCwgMjk2MiwgMTA3MCwgMTMyNjYsIDU2OCwgOCwgMzAsIDExNCwgMjksIDE5LCA0NywgMTcsIDMsIDMyLCAyMCwgNiwgMTgsIDg4MSwgNjgsIDEyLCAwLCA2NywgMTIsIDE2NDgxLCAxLCAzMDcxLCAxMDYsIDYsIDEyLCA0LCA4LCA4LCA5LCA1OTkxLCA4NCwgMiwgNzAsIDIsIDEsIDMsIDAsIDMsIDEsIDMsIDMsIDIsIDExLCAyLCAwLCAyLCA2LCAyLCA2NCwgMiwgMywgMywgNywgMiwgNiwgMiwgMjcsIDIsIDMsIDIsIDQsIDIsIDAsIDQsIDYsIDIsIDMzOSwgMywgMjQsIDIsIDI0LCAyLCAzMCwgMiwgMjQsIDIsIDMwLCAyLCAyNCwgMiwgMzAsIDIsIDI0LCAyLCAzMCwgMiwgMjQsIDIsIDcsIDQxNDksIDE5NiwgMTM0MCwgMywgMiwgMjYsIDIsIDEsIDIsIDAsIDMsIDAsIDIsIDksIDIsIDMsIDIsIDAsIDIsIDAsIDcsIDAsIDUsIDAsIDIsIDAsIDIsIDAsIDIsIDIsIDIsIDEsIDIsIDAsIDMsIDAsIDIsIDAsIDIsIDAsIDIsIDAsIDIsIDAsIDIsIDEsIDIsIDAsIDMsIDMsIDIsIDYsIDIsIDMsIDIsIDMsIDIsIDAsIDIsIDksIDIsIDE2LCA2LCAyLCAyLCA0LCAyLCAxNiwgNDQyMSwgNDI3MTAsIDQyLCA0MTQ4LCAxMiwgMjIxLCAxNjM1NSwgNTQxXTtcbnZhciBhc3RyYWxJZGVudGlmaWVyQ29kZXMgPSBbNTA5LCAwLCAyMjcsIDAsIDE1MCwgNCwgMjk0LCA5LCAxMzY4LCAyLCAyLCAxLCA2LCAzLCA0MSwgMiwgNSwgMCwgMTY2LCAxLCAxMzA2LCAyLCA1NCwgMTQsIDMyLCA5LCAxNiwgMywgNDYsIDEwLCA1NCwgOSwgNywgMiwgMzcsIDEzLCAyLCA5LCA1MiwgMCwgMTMsIDIsIDQ5LCAxMywgMTYsIDksIDgzLCAxMSwgMTY4LCAxMSwgNiwgOSwgOCwgMiwgNTcsIDAsIDIsIDYsIDMsIDEsIDMsIDIsIDEwLCAwLCAxMSwgMSwgMywgNiwgNCwgNCwgMzE2LCAxOSwgMTMsIDksIDIxNCwgNiwgMywgOCwgMTEyLCAxNiwgMTYsIDksIDgyLCAxMiwgOSwgOSwgNTM1LCA5LCAyMDg1NSwgOSwgMTM1LCA0LCA2MCwgNiwgMjYsIDksIDEwMTYsIDQ1LCAxNywgMywgMTk3MjMsIDEsIDUzMTksIDQsIDQsIDUsIDksIDcsIDMsIDYsIDMxLCAzLCAxNDksIDIsIDE0MTgsIDQ5LCA0MzA1LCA2LCA3OTI2MTgsIDIzOV07XG5cbi8vIFRoaXMgaGFzIGEgY29tcGxleGl0eSBsaW5lYXIgdG8gdGhlIHZhbHVlIG9mIHRoZSBjb2RlLiBUaGVcbi8vIGFzc3VtcHRpb24gaXMgdGhhdCBsb29raW5nIHVwIGFzdHJhbCBpZGVudGlmaWVyIGNoYXJhY3RlcnMgaXNcbi8vIHJhcmUuXG5mdW5jdGlvbiBpc0luQXN0cmFsU2V0KGNvZGUsIHNldCkge1xuICB2YXIgcG9zID0gMHgxMDAwMDtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBzZXQubGVuZ3RoOyBpICs9IDIpIHtcbiAgICBwb3MgKz0gc2V0W2ldO1xuICAgIGlmIChwb3MgPiBjb2RlKSByZXR1cm4gZmFsc2U7XG4gICAgcG9zICs9IHNldFtpICsgMV07XG4gICAgaWYgKHBvcyA+PSBjb2RlKSByZXR1cm4gdHJ1ZTtcbiAgfVxufVxuXG4vLyBUZXN0IHdoZXRoZXIgYSBnaXZlbiBjaGFyYWN0ZXIgY29kZSBzdGFydHMgYW4gaWRlbnRpZmllci5cblxuZnVuY3Rpb24gaXNJZGVudGlmaWVyU3RhcnQoY29kZSwgYXN0cmFsKSB7XG4gIGlmIChjb2RlIDwgNjUpIHJldHVybiBjb2RlID09PSAzNjtcbiAgaWYgKGNvZGUgPCA5MSkgcmV0dXJuIHRydWU7XG4gIGlmIChjb2RlIDwgOTcpIHJldHVybiBjb2RlID09PSA5NTtcbiAgaWYgKGNvZGUgPCAxMjMpIHJldHVybiB0cnVlO1xuICBpZiAoY29kZSA8PSAweGZmZmYpIHJldHVybiBjb2RlID49IDB4YWEgJiYgbm9uQVNDSUlpZGVudGlmaWVyU3RhcnQudGVzdChTdHJpbmcuZnJvbUNoYXJDb2RlKGNvZGUpKTtcbiAgaWYgKGFzdHJhbCA9PT0gZmFsc2UpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGlzSW5Bc3RyYWxTZXQoY29kZSwgYXN0cmFsSWRlbnRpZmllclN0YXJ0Q29kZXMpO1xufVxuXG4vLyBUZXN0IHdoZXRoZXIgYSBnaXZlbiBjaGFyYWN0ZXIgaXMgcGFydCBvZiBhbiBpZGVudGlmaWVyLlxuXG5mdW5jdGlvbiBpc0lkZW50aWZpZXJDaGFyKGNvZGUsIGFzdHJhbCkge1xuICBpZiAoY29kZSA8IDQ4KSByZXR1cm4gY29kZSA9PT0gMzY7XG4gIGlmIChjb2RlIDwgNTgpIHJldHVybiB0cnVlO1xuICBpZiAoY29kZSA8IDY1KSByZXR1cm4gZmFsc2U7XG4gIGlmIChjb2RlIDwgOTEpIHJldHVybiB0cnVlO1xuICBpZiAoY29kZSA8IDk3KSByZXR1cm4gY29kZSA9PT0gOTU7XG4gIGlmIChjb2RlIDwgMTIzKSByZXR1cm4gdHJ1ZTtcbiAgaWYgKGNvZGUgPD0gMHhmZmZmKSByZXR1cm4gY29kZSA+PSAweGFhICYmIG5vbkFTQ0lJaWRlbnRpZmllci50ZXN0KFN0cmluZy5mcm9tQ2hhckNvZGUoY29kZSkpO1xuICBpZiAoYXN0cmFsID09PSBmYWxzZSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaXNJbkFzdHJhbFNldChjb2RlLCBhc3RyYWxJZGVudGlmaWVyU3RhcnRDb2RlcykgfHwgaXNJbkFzdHJhbFNldChjb2RlLCBhc3RyYWxJZGVudGlmaWVyQ29kZXMpO1xufVxuXG59LHt9XSwzOltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXtcbi8vIEFjb3JuIGlzIGEgdGlueSwgZmFzdCBKYXZhU2NyaXB0IHBhcnNlciB3cml0dGVuIGluIEphdmFTY3JpcHQuXG4vL1xuLy8gQWNvcm4gd2FzIHdyaXR0ZW4gYnkgTWFyaWpuIEhhdmVyYmVrZSwgSW5ndmFyIFN0ZXBhbnlhbiwgYW5kXG4vLyB2YXJpb3VzIGNvbnRyaWJ1dG9ycyBhbmQgcmVsZWFzZWQgdW5kZXIgYW4gTUlUIGxpY2Vuc2UuXG4vL1xuLy8gR2l0IHJlcG9zaXRvcmllcyBmb3IgQWNvcm4gYXJlIGF2YWlsYWJsZSBhdFxuLy9cbi8vICAgICBodHRwOi8vbWFyaWpuaGF2ZXJiZWtlLm5sL2dpdC9hY29yblxuLy8gICAgIGh0dHBzOi8vZ2l0aHViLmNvbS9tYXJpam5oL2Fjb3JuLmdpdFxuLy9cbi8vIFBsZWFzZSB1c2UgdGhlIFtnaXRodWIgYnVnIHRyYWNrZXJdW2doYnRdIHRvIHJlcG9ydCBpc3N1ZXMuXG4vL1xuLy8gW2doYnRdOiBodHRwczovL2dpdGh1Yi5jb20vbWFyaWpuaC9hY29ybi9pc3N1ZXNcbi8vXG4vLyBUaGlzIGZpbGUgZGVmaW5lcyB0aGUgbWFpbiBwYXJzZXIgaW50ZXJmYWNlLiBUaGUgbGlicmFyeSBhbHNvIGNvbWVzXG4vLyB3aXRoIGEgW2Vycm9yLXRvbGVyYW50IHBhcnNlcl1bZGFtbWl0XSBhbmQgYW5cbi8vIFthYnN0cmFjdCBzeW50YXggdHJlZSB3YWxrZXJdW3dhbGtdLCBkZWZpbmVkIGluIG90aGVyIGZpbGVzLlxuLy9cbi8vIFtkYW1taXRdOiBhY29ybl9sb29zZS5qc1xuLy8gW3dhbGtdOiB1dGlsL3dhbGsuanNcblxuXCJ1c2Ugc3RyaWN0XCI7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5leHBvcnRzLnBhcnNlID0gcGFyc2U7XG5leHBvcnRzLnBhcnNlRXhwcmVzc2lvbkF0ID0gcGFyc2VFeHByZXNzaW9uQXQ7XG5leHBvcnRzLnRva2VuaXplciA9IHRva2VuaXplcjtcblxudmFyIF9zdGF0ZSA9IF9kZXJlcV8oXCIuL3N0YXRlXCIpO1xuXG52YXIgX29wdGlvbnMgPSBfZGVyZXFfKFwiLi9vcHRpb25zXCIpO1xuXG5fZGVyZXFfKFwiLi9wYXJzZXV0aWxcIik7XG5cbl9kZXJlcV8oXCIuL3N0YXRlbWVudFwiKTtcblxuX2RlcmVxXyhcIi4vbHZhbFwiKTtcblxuX2RlcmVxXyhcIi4vZXhwcmVzc2lvblwiKTtcblxuX2RlcmVxXyhcIi4vbG9jYXRpb25cIik7XG5cbmV4cG9ydHMuUGFyc2VyID0gX3N0YXRlLlBhcnNlcjtcbmV4cG9ydHMucGx1Z2lucyA9IF9zdGF0ZS5wbHVnaW5zO1xuZXhwb3J0cy5kZWZhdWx0T3B0aW9ucyA9IF9vcHRpb25zLmRlZmF1bHRPcHRpb25zO1xuXG52YXIgX2xvY3V0aWwgPSBfZGVyZXFfKFwiLi9sb2N1dGlsXCIpO1xuXG5leHBvcnRzLlBvc2l0aW9uID0gX2xvY3V0aWwuUG9zaXRpb247XG5leHBvcnRzLlNvdXJjZUxvY2F0aW9uID0gX2xvY3V0aWwuU291cmNlTG9jYXRpb247XG5leHBvcnRzLmdldExpbmVJbmZvID0gX2xvY3V0aWwuZ2V0TGluZUluZm87XG5cbnZhciBfbm9kZSA9IF9kZXJlcV8oXCIuL25vZGVcIik7XG5cbmV4cG9ydHMuTm9kZSA9IF9ub2RlLk5vZGU7XG5cbnZhciBfdG9rZW50eXBlID0gX2RlcmVxXyhcIi4vdG9rZW50eXBlXCIpO1xuXG5leHBvcnRzLlRva2VuVHlwZSA9IF90b2tlbnR5cGUuVG9rZW5UeXBlO1xuZXhwb3J0cy50b2tUeXBlcyA9IF90b2tlbnR5cGUudHlwZXM7XG5cbnZhciBfdG9rZW5jb250ZXh0ID0gX2RlcmVxXyhcIi4vdG9rZW5jb250ZXh0XCIpO1xuXG5leHBvcnRzLlRva0NvbnRleHQgPSBfdG9rZW5jb250ZXh0LlRva0NvbnRleHQ7XG5leHBvcnRzLnRva0NvbnRleHRzID0gX3Rva2VuY29udGV4dC50eXBlcztcblxudmFyIF9pZGVudGlmaWVyID0gX2RlcmVxXyhcIi4vaWRlbnRpZmllclwiKTtcblxuZXhwb3J0cy5pc0lkZW50aWZpZXJDaGFyID0gX2lkZW50aWZpZXIuaXNJZGVudGlmaWVyQ2hhcjtcbmV4cG9ydHMuaXNJZGVudGlmaWVyU3RhcnQgPSBfaWRlbnRpZmllci5pc0lkZW50aWZpZXJTdGFydDtcblxudmFyIF90b2tlbml6ZSA9IF9kZXJlcV8oXCIuL3Rva2VuaXplXCIpO1xuXG5leHBvcnRzLlRva2VuID0gX3Rva2VuaXplLlRva2VuO1xuXG52YXIgX3doaXRlc3BhY2UgPSBfZGVyZXFfKFwiLi93aGl0ZXNwYWNlXCIpO1xuXG5leHBvcnRzLmlzTmV3TGluZSA9IF93aGl0ZXNwYWNlLmlzTmV3TGluZTtcbmV4cG9ydHMubGluZUJyZWFrID0gX3doaXRlc3BhY2UubGluZUJyZWFrO1xuZXhwb3J0cy5saW5lQnJlYWtHID0gX3doaXRlc3BhY2UubGluZUJyZWFrRztcbnZhciB2ZXJzaW9uID0gXCIyLjIuMFwiO1xuXG5leHBvcnRzLnZlcnNpb24gPSB2ZXJzaW9uO1xuLy8gVGhlIG1haW4gZXhwb3J0ZWQgaW50ZXJmYWNlICh1bmRlciBgc2VsZi5hY29ybmAgd2hlbiBpbiB0aGVcbi8vIGJyb3dzZXIpIGlzIGEgYHBhcnNlYCBmdW5jdGlvbiB0aGF0IHRha2VzIGEgY29kZSBzdHJpbmcgYW5kXG4vLyByZXR1cm5zIGFuIGFic3RyYWN0IHN5bnRheCB0cmVlIGFzIHNwZWNpZmllZCBieSBbTW96aWxsYSBwYXJzZXJcbi8vIEFQSV1bYXBpXS5cbi8vXG4vLyBbYXBpXTogaHR0cHM6Ly9kZXZlbG9wZXIubW96aWxsYS5vcmcvZW4tVVMvZG9jcy9TcGlkZXJNb25rZXkvUGFyc2VyX0FQSVxuXG5mdW5jdGlvbiBwYXJzZShpbnB1dCwgb3B0aW9ucykge1xuICByZXR1cm4gbmV3IF9zdGF0ZS5QYXJzZXIob3B0aW9ucywgaW5wdXQpLnBhcnNlKCk7XG59XG5cbi8vIFRoaXMgZnVuY3Rpb24gdHJpZXMgdG8gcGFyc2UgYSBzaW5nbGUgZXhwcmVzc2lvbiBhdCBhIGdpdmVuXG4vLyBvZmZzZXQgaW4gYSBzdHJpbmcuIFVzZWZ1bCBmb3IgcGFyc2luZyBtaXhlZC1sYW5ndWFnZSBmb3JtYXRzXG4vLyB0aGF0IGVtYmVkIEphdmFTY3JpcHQgZXhwcmVzc2lvbnMuXG5cbmZ1bmN0aW9uIHBhcnNlRXhwcmVzc2lvbkF0KGlucHV0LCBwb3MsIG9wdGlvbnMpIHtcbiAgdmFyIHAgPSBuZXcgX3N0YXRlLlBhcnNlcihvcHRpb25zLCBpbnB1dCwgcG9zKTtcbiAgcC5uZXh0VG9rZW4oKTtcbiAgcmV0dXJuIHAucGFyc2VFeHByZXNzaW9uKCk7XG59XG5cbi8vIEFjb3JuIGlzIG9yZ2FuaXplZCBhcyBhIHRva2VuaXplciBhbmQgYSByZWN1cnNpdmUtZGVzY2VudCBwYXJzZXIuXG4vLyBUaGUgYHRva2VuaXplYCBleHBvcnQgcHJvdmlkZXMgYW4gaW50ZXJmYWNlIHRvIHRoZSB0b2tlbml6ZXIuXG5cbmZ1bmN0aW9uIHRva2VuaXplcihpbnB1dCwgb3B0aW9ucykge1xuICByZXR1cm4gbmV3IF9zdGF0ZS5QYXJzZXIob3B0aW9ucywgaW5wdXQpO1xufVxuXG59LHtcIi4vZXhwcmVzc2lvblwiOjEsXCIuL2lkZW50aWZpZXJcIjoyLFwiLi9sb2NhdGlvblwiOjQsXCIuL2xvY3V0aWxcIjo1LFwiLi9sdmFsXCI6NixcIi4vbm9kZVwiOjcsXCIuL29wdGlvbnNcIjo4LFwiLi9wYXJzZXV0aWxcIjo5LFwiLi9zdGF0ZVwiOjEwLFwiLi9zdGF0ZW1lbnRcIjoxMSxcIi4vdG9rZW5jb250ZXh0XCI6MTIsXCIuL3Rva2VuaXplXCI6MTMsXCIuL3Rva2VudHlwZVwiOjE0LFwiLi93aGl0ZXNwYWNlXCI6MTZ9XSw0OltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXtcblwidXNlIHN0cmljdFwiO1xuXG52YXIgX3N0YXRlID0gX2RlcmVxXyhcIi4vc3RhdGVcIik7XG5cbnZhciBfbG9jdXRpbCA9IF9kZXJlcV8oXCIuL2xvY3V0aWxcIik7XG5cbnZhciBwcCA9IF9zdGF0ZS5QYXJzZXIucHJvdG90eXBlO1xuXG4vLyBUaGlzIGZ1bmN0aW9uIGlzIHVzZWQgdG8gcmFpc2UgZXhjZXB0aW9ucyBvbiBwYXJzZSBlcnJvcnMuIEl0XG4vLyB0YWtlcyBhbiBvZmZzZXQgaW50ZWdlciAoaW50byB0aGUgY3VycmVudCBgaW5wdXRgKSB0byBpbmRpY2F0ZVxuLy8gdGhlIGxvY2F0aW9uIG9mIHRoZSBlcnJvciwgYXR0YWNoZXMgdGhlIHBvc2l0aW9uIHRvIHRoZSBlbmRcbi8vIG9mIHRoZSBlcnJvciBtZXNzYWdlLCBhbmQgdGhlbiByYWlzZXMgYSBgU3ludGF4RXJyb3JgIHdpdGggdGhhdFxuLy8gbWVzc2FnZS5cblxucHAucmFpc2UgPSBmdW5jdGlvbiAocG9zLCBtZXNzYWdlKSB7XG4gIHZhciBsb2MgPSBfbG9jdXRpbC5nZXRMaW5lSW5mbyh0aGlzLmlucHV0LCBwb3MpO1xuICBtZXNzYWdlICs9IFwiIChcIiArIGxvYy5saW5lICsgXCI6XCIgKyBsb2MuY29sdW1uICsgXCIpXCI7XG4gIHZhciBlcnIgPSBuZXcgU3ludGF4RXJyb3IobWVzc2FnZSk7XG4gIGVyci5wb3MgPSBwb3M7ZXJyLmxvYyA9IGxvYztlcnIucmFpc2VkQXQgPSB0aGlzLnBvcztcbiAgdGhyb3cgZXJyO1xufTtcblxucHAuY3VyUG9zaXRpb24gPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLm9wdGlvbnMubG9jYXRpb25zKSB7XG4gICAgcmV0dXJuIG5ldyBfbG9jdXRpbC5Qb3NpdGlvbih0aGlzLmN1ckxpbmUsIHRoaXMucG9zIC0gdGhpcy5saW5lU3RhcnQpO1xuICB9XG59O1xuXG59LHtcIi4vbG9jdXRpbFwiOjUsXCIuL3N0YXRlXCI6MTB9XSw1OltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXtcblwidXNlIHN0cmljdFwiO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuZXhwb3J0cy5nZXRMaW5lSW5mbyA9IGdldExpbmVJbmZvO1xuXG5mdW5jdGlvbiBfY2xhc3NDYWxsQ2hlY2soaW5zdGFuY2UsIENvbnN0cnVjdG9yKSB7IGlmICghKGluc3RhbmNlIGluc3RhbmNlb2YgQ29uc3RydWN0b3IpKSB7IHRocm93IG5ldyBUeXBlRXJyb3IoXCJDYW5ub3QgY2FsbCBhIGNsYXNzIGFzIGEgZnVuY3Rpb25cIik7IH0gfVxuXG52YXIgX3doaXRlc3BhY2UgPSBfZGVyZXFfKFwiLi93aGl0ZXNwYWNlXCIpO1xuXG4vLyBUaGVzZSBhcmUgdXNlZCB3aGVuIGBvcHRpb25zLmxvY2F0aW9uc2AgaXMgb24sIGZvciB0aGVcbi8vIGBzdGFydExvY2AgYW5kIGBlbmRMb2NgIHByb3BlcnRpZXMuXG5cbnZhciBQb3NpdGlvbiA9IChmdW5jdGlvbiAoKSB7XG4gIGZ1bmN0aW9uIFBvc2l0aW9uKGxpbmUsIGNvbCkge1xuICAgIF9jbGFzc0NhbGxDaGVjayh0aGlzLCBQb3NpdGlvbik7XG5cbiAgICB0aGlzLmxpbmUgPSBsaW5lO1xuICAgIHRoaXMuY29sdW1uID0gY29sO1xuICB9XG5cbiAgUG9zaXRpb24ucHJvdG90eXBlLm9mZnNldCA9IGZ1bmN0aW9uIG9mZnNldChuKSB7XG4gICAgcmV0dXJuIG5ldyBQb3NpdGlvbih0aGlzLmxpbmUsIHRoaXMuY29sdW1uICsgbik7XG4gIH07XG5cbiAgcmV0dXJuIFBvc2l0aW9uO1xufSkoKTtcblxuZXhwb3J0cy5Qb3NpdGlvbiA9IFBvc2l0aW9uO1xuXG52YXIgU291cmNlTG9jYXRpb24gPSBmdW5jdGlvbiBTb3VyY2VMb2NhdGlvbihwLCBzdGFydCwgZW5kKSB7XG4gIF9jbGFzc0NhbGxDaGVjayh0aGlzLCBTb3VyY2VMb2NhdGlvbik7XG5cbiAgdGhpcy5zdGFydCA9IHN0YXJ0O1xuICB0aGlzLmVuZCA9IGVuZDtcbiAgaWYgKHAuc291cmNlRmlsZSAhPT0gbnVsbCkgdGhpcy5zb3VyY2UgPSBwLnNvdXJjZUZpbGU7XG59XG5cbi8vIFRoZSBgZ2V0TGluZUluZm9gIGZ1bmN0aW9uIGlzIG1vc3RseSB1c2VmdWwgd2hlbiB0aGVcbi8vIGBsb2NhdGlvbnNgIG9wdGlvbiBpcyBvZmYgKGZvciBwZXJmb3JtYW5jZSByZWFzb25zKSBhbmQgeW91XG4vLyB3YW50IHRvIGZpbmQgdGhlIGxpbmUvY29sdW1uIHBvc2l0aW9uIGZvciBhIGdpdmVuIGNoYXJhY3RlclxuLy8gb2Zmc2V0LiBgaW5wdXRgIHNob3VsZCBiZSB0aGUgY29kZSBzdHJpbmcgdGhhdCB0aGUgb2Zmc2V0IHJlZmVyc1xuLy8gaW50by5cblxuO1xuXG5leHBvcnRzLlNvdXJjZUxvY2F0aW9uID0gU291cmNlTG9jYXRpb247XG5cbmZ1bmN0aW9uIGdldExpbmVJbmZvKGlucHV0LCBvZmZzZXQpIHtcbiAgZm9yICh2YXIgbGluZSA9IDEsIGN1ciA9IDA7Oykge1xuICAgIF93aGl0ZXNwYWNlLmxpbmVCcmVha0cubGFzdEluZGV4ID0gY3VyO1xuICAgIHZhciBtYXRjaCA9IF93aGl0ZXNwYWNlLmxpbmVCcmVha0cuZXhlYyhpbnB1dCk7XG4gICAgaWYgKG1hdGNoICYmIG1hdGNoLmluZGV4IDwgb2Zmc2V0KSB7XG4gICAgICArK2xpbmU7XG4gICAgICBjdXIgPSBtYXRjaC5pbmRleCArIG1hdGNoWzBdLmxlbmd0aDtcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIG5ldyBQb3NpdGlvbihsaW5lLCBvZmZzZXQgLSBjdXIpO1xuICAgIH1cbiAgfVxufVxuXG59LHtcIi4vd2hpdGVzcGFjZVwiOjE2fV0sNjpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7XG5cInVzZSBzdHJpY3RcIjtcblxudmFyIF90b2tlbnR5cGUgPSBfZGVyZXFfKFwiLi90b2tlbnR5cGVcIik7XG5cbnZhciBfc3RhdGUgPSBfZGVyZXFfKFwiLi9zdGF0ZVwiKTtcblxudmFyIF9pZGVudGlmaWVyID0gX2RlcmVxXyhcIi4vaWRlbnRpZmllclwiKTtcblxudmFyIF91dGlsID0gX2RlcmVxXyhcIi4vdXRpbFwiKTtcblxudmFyIHBwID0gX3N0YXRlLlBhcnNlci5wcm90b3R5cGU7XG5cbi8vIENvbnZlcnQgZXhpc3RpbmcgZXhwcmVzc2lvbiBhdG9tIHRvIGFzc2lnbmFibGUgcGF0dGVyblxuLy8gaWYgcG9zc2libGUuXG5cbnBwLnRvQXNzaWduYWJsZSA9IGZ1bmN0aW9uIChub2RlLCBpc0JpbmRpbmcpIHtcbiAgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2ICYmIG5vZGUpIHtcbiAgICBzd2l0Y2ggKG5vZGUudHlwZSkge1xuICAgICAgY2FzZSBcIklkZW50aWZpZXJcIjpcbiAgICAgIGNhc2UgXCJPYmplY3RQYXR0ZXJuXCI6XG4gICAgICBjYXNlIFwiQXJyYXlQYXR0ZXJuXCI6XG4gICAgICBjYXNlIFwiQXNzaWdubWVudFBhdHRlcm5cIjpcbiAgICAgICAgYnJlYWs7XG5cbiAgICAgIGNhc2UgXCJPYmplY3RFeHByZXNzaW9uXCI6XG4gICAgICAgIG5vZGUudHlwZSA9IFwiT2JqZWN0UGF0dGVyblwiO1xuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IG5vZGUucHJvcGVydGllcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgIHZhciBwcm9wID0gbm9kZS5wcm9wZXJ0aWVzW2ldO1xuICAgICAgICAgIGlmIChwcm9wLmtpbmQgIT09IFwiaW5pdFwiKSB0aGlzLnJhaXNlKHByb3Aua2V5LnN0YXJ0LCBcIk9iamVjdCBwYXR0ZXJuIGNhbid0IGNvbnRhaW4gZ2V0dGVyIG9yIHNldHRlclwiKTtcbiAgICAgICAgICB0aGlzLnRvQXNzaWduYWJsZShwcm9wLnZhbHVlLCBpc0JpbmRpbmcpO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuXG4gICAgICBjYXNlIFwiQXJyYXlFeHByZXNzaW9uXCI6XG4gICAgICAgIG5vZGUudHlwZSA9IFwiQXJyYXlQYXR0ZXJuXCI7XG4gICAgICAgIHRoaXMudG9Bc3NpZ25hYmxlTGlzdChub2RlLmVsZW1lbnRzLCBpc0JpbmRpbmcpO1xuICAgICAgICBicmVhaztcblxuICAgICAgY2FzZSBcIkFzc2lnbm1lbnRFeHByZXNzaW9uXCI6XG4gICAgICAgIGlmIChub2RlLm9wZXJhdG9yID09PSBcIj1cIikge1xuICAgICAgICAgIG5vZGUudHlwZSA9IFwiQXNzaWdubWVudFBhdHRlcm5cIjtcbiAgICAgICAgICBkZWxldGUgbm9kZS5vcGVyYXRvcjtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aGlzLnJhaXNlKG5vZGUubGVmdC5lbmQsIFwiT25seSAnPScgb3BlcmF0b3IgY2FuIGJlIHVzZWQgZm9yIHNwZWNpZnlpbmcgZGVmYXVsdCB2YWx1ZS5cIik7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG5cbiAgICAgIGNhc2UgXCJQYXJlbnRoZXNpemVkRXhwcmVzc2lvblwiOlxuICAgICAgICBub2RlLmV4cHJlc3Npb24gPSB0aGlzLnRvQXNzaWduYWJsZShub2RlLmV4cHJlc3Npb24sIGlzQmluZGluZyk7XG4gICAgICAgIGJyZWFrO1xuXG4gICAgICBjYXNlIFwiTWVtYmVyRXhwcmVzc2lvblwiOlxuICAgICAgICBpZiAoIWlzQmluZGluZykgYnJlYWs7XG5cbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRoaXMucmFpc2Uobm9kZS5zdGFydCwgXCJBc3NpZ25pbmcgdG8gcnZhbHVlXCIpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gbm9kZTtcbn07XG5cbi8vIENvbnZlcnQgbGlzdCBvZiBleHByZXNzaW9uIGF0b21zIHRvIGJpbmRpbmcgbGlzdC5cblxucHAudG9Bc3NpZ25hYmxlTGlzdCA9IGZ1bmN0aW9uIChleHByTGlzdCwgaXNCaW5kaW5nKSB7XG4gIHZhciBlbmQgPSBleHByTGlzdC5sZW5ndGg7XG4gIGlmIChlbmQpIHtcbiAgICB2YXIgbGFzdCA9IGV4cHJMaXN0W2VuZCAtIDFdO1xuICAgIGlmIChsYXN0ICYmIGxhc3QudHlwZSA9PSBcIlJlc3RFbGVtZW50XCIpIHtcbiAgICAgIC0tZW5kO1xuICAgIH0gZWxzZSBpZiAobGFzdCAmJiBsYXN0LnR5cGUgPT0gXCJTcHJlYWRFbGVtZW50XCIpIHtcbiAgICAgIGxhc3QudHlwZSA9IFwiUmVzdEVsZW1lbnRcIjtcbiAgICAgIHZhciBhcmcgPSBsYXN0LmFyZ3VtZW50O1xuICAgICAgdGhpcy50b0Fzc2lnbmFibGUoYXJnLCBpc0JpbmRpbmcpO1xuICAgICAgaWYgKGFyZy50eXBlICE9PSBcIklkZW50aWZpZXJcIiAmJiBhcmcudHlwZSAhPT0gXCJNZW1iZXJFeHByZXNzaW9uXCIgJiYgYXJnLnR5cGUgIT09IFwiQXJyYXlQYXR0ZXJuXCIpIHRoaXMudW5leHBlY3RlZChhcmcuc3RhcnQpO1xuICAgICAgLS1lbmQ7XG4gICAgfVxuICB9XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgZW5kOyBpKyspIHtcbiAgICB2YXIgZWx0ID0gZXhwckxpc3RbaV07XG4gICAgaWYgKGVsdCkgdGhpcy50b0Fzc2lnbmFibGUoZWx0LCBpc0JpbmRpbmcpO1xuICB9XG4gIHJldHVybiBleHByTGlzdDtcbn07XG5cbi8vIFBhcnNlcyBzcHJlYWQgZWxlbWVudC5cblxucHAucGFyc2VTcHJlYWQgPSBmdW5jdGlvbiAocmVmU2hvcnRoYW5kRGVmYXVsdFBvcykge1xuICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gIHRoaXMubmV4dCgpO1xuICBub2RlLmFyZ3VtZW50ID0gdGhpcy5wYXJzZU1heWJlQXNzaWduKHJlZlNob3J0aGFuZERlZmF1bHRQb3MpO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiU3ByZWFkRWxlbWVudFwiKTtcbn07XG5cbnBwLnBhcnNlUmVzdCA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICB0aGlzLm5leHQoKTtcbiAgbm9kZS5hcmd1bWVudCA9IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5uYW1lIHx8IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5icmFja2V0TCA/IHRoaXMucGFyc2VCaW5kaW5nQXRvbSgpIDogdGhpcy51bmV4cGVjdGVkKCk7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJSZXN0RWxlbWVudFwiKTtcbn07XG5cbi8vIFBhcnNlcyBsdmFsdWUgKGFzc2lnbmFibGUpIGF0b20uXG5cbnBwLnBhcnNlQmluZGluZ0F0b20gPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPCA2KSByZXR1cm4gdGhpcy5wYXJzZUlkZW50KCk7XG4gIHN3aXRjaCAodGhpcy50eXBlKSB7XG4gICAgY2FzZSBfdG9rZW50eXBlLnR5cGVzLm5hbWU6XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZUlkZW50KCk7XG5cbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuYnJhY2tldEw6XG4gICAgICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIG5vZGUuZWxlbWVudHMgPSB0aGlzLnBhcnNlQmluZGluZ0xpc3QoX3Rva2VudHlwZS50eXBlcy5icmFja2V0UiwgdHJ1ZSwgdHJ1ZSk7XG4gICAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiQXJyYXlQYXR0ZXJuXCIpO1xuXG4gICAgY2FzZSBfdG9rZW50eXBlLnR5cGVzLmJyYWNlTDpcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlT2JqKHRydWUpO1xuXG4gICAgZGVmYXVsdDpcbiAgICAgIHRoaXMudW5leHBlY3RlZCgpO1xuICB9XG59O1xuXG5wcC5wYXJzZUJpbmRpbmdMaXN0ID0gZnVuY3Rpb24gKGNsb3NlLCBhbGxvd0VtcHR5LCBhbGxvd1RyYWlsaW5nQ29tbWEpIHtcbiAgdmFyIGVsdHMgPSBbXSxcbiAgICAgIGZpcnN0ID0gdHJ1ZTtcbiAgd2hpbGUgKCF0aGlzLmVhdChjbG9zZSkpIHtcbiAgICBpZiAoZmlyc3QpIGZpcnN0ID0gZmFsc2U7ZWxzZSB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmNvbW1hKTtcbiAgICBpZiAoYWxsb3dFbXB0eSAmJiB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuY29tbWEpIHtcbiAgICAgIGVsdHMucHVzaChudWxsKTtcbiAgICB9IGVsc2UgaWYgKGFsbG93VHJhaWxpbmdDb21tYSAmJiB0aGlzLmFmdGVyVHJhaWxpbmdDb21tYShjbG9zZSkpIHtcbiAgICAgIGJyZWFrO1xuICAgIH0gZWxzZSBpZiAodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmVsbGlwc2lzKSB7XG4gICAgICB2YXIgcmVzdCA9IHRoaXMucGFyc2VSZXN0KCk7XG4gICAgICB0aGlzLnBhcnNlQmluZGluZ0xpc3RJdGVtKHJlc3QpO1xuICAgICAgZWx0cy5wdXNoKHJlc3QpO1xuICAgICAgdGhpcy5leHBlY3QoY2xvc2UpO1xuICAgICAgYnJlYWs7XG4gICAgfSBlbHNlIHtcbiAgICAgIHZhciBlbGVtID0gdGhpcy5wYXJzZU1heWJlRGVmYXVsdCh0aGlzLnN0YXJ0LCB0aGlzLnN0YXJ0TG9jKTtcbiAgICAgIHRoaXMucGFyc2VCaW5kaW5nTGlzdEl0ZW0oZWxlbSk7XG4gICAgICBlbHRzLnB1c2goZWxlbSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBlbHRzO1xufTtcblxucHAucGFyc2VCaW5kaW5nTGlzdEl0ZW0gPSBmdW5jdGlvbiAocGFyYW0pIHtcbiAgcmV0dXJuIHBhcmFtO1xufTtcblxuLy8gUGFyc2VzIGFzc2lnbm1lbnQgcGF0dGVybiBhcm91bmQgZ2l2ZW4gYXRvbSBpZiBwb3NzaWJsZS5cblxucHAucGFyc2VNYXliZURlZmF1bHQgPSBmdW5jdGlvbiAoc3RhcnRQb3MsIHN0YXJ0TG9jLCBsZWZ0KSB7XG4gIGxlZnQgPSBsZWZ0IHx8IHRoaXMucGFyc2VCaW5kaW5nQXRvbSgpO1xuICBpZiAoIXRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuZXEpKSByZXR1cm4gbGVmdDtcbiAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZUF0KHN0YXJ0UG9zLCBzdGFydExvYyk7XG4gIG5vZGUubGVmdCA9IGxlZnQ7XG4gIG5vZGUucmlnaHQgPSB0aGlzLnBhcnNlTWF5YmVBc3NpZ24oKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkFzc2lnbm1lbnRQYXR0ZXJuXCIpO1xufTtcblxuLy8gVmVyaWZ5IHRoYXQgYSBub2RlIGlzIGFuIGx2YWwg4oCUIHNvbWV0aGluZyB0aGF0IGNhbiBiZSBhc3NpZ25lZFxuLy8gdG8uXG5cbnBwLmNoZWNrTFZhbCA9IGZ1bmN0aW9uIChleHByLCBpc0JpbmRpbmcsIGNoZWNrQ2xhc2hlcykge1xuICBzd2l0Y2ggKGV4cHIudHlwZSkge1xuICAgIGNhc2UgXCJJZGVudGlmaWVyXCI6XG4gICAgICBpZiAodGhpcy5zdHJpY3QgJiYgKF9pZGVudGlmaWVyLnJlc2VydmVkV29yZHMuc3RyaWN0QmluZChleHByLm5hbWUpIHx8IF9pZGVudGlmaWVyLnJlc2VydmVkV29yZHMuc3RyaWN0KGV4cHIubmFtZSkpKSB0aGlzLnJhaXNlKGV4cHIuc3RhcnQsIChpc0JpbmRpbmcgPyBcIkJpbmRpbmcgXCIgOiBcIkFzc2lnbmluZyB0byBcIikgKyBleHByLm5hbWUgKyBcIiBpbiBzdHJpY3QgbW9kZVwiKTtcbiAgICAgIGlmIChjaGVja0NsYXNoZXMpIHtcbiAgICAgICAgaWYgKF91dGlsLmhhcyhjaGVja0NsYXNoZXMsIGV4cHIubmFtZSkpIHRoaXMucmFpc2UoZXhwci5zdGFydCwgXCJBcmd1bWVudCBuYW1lIGNsYXNoIGluIHN0cmljdCBtb2RlXCIpO1xuICAgICAgICBjaGVja0NsYXNoZXNbZXhwci5uYW1lXSA9IHRydWU7XG4gICAgICB9XG4gICAgICBicmVhaztcblxuICAgIGNhc2UgXCJNZW1iZXJFeHByZXNzaW9uXCI6XG4gICAgICBpZiAoaXNCaW5kaW5nKSB0aGlzLnJhaXNlKGV4cHIuc3RhcnQsIChpc0JpbmRpbmcgPyBcIkJpbmRpbmdcIiA6IFwiQXNzaWduaW5nIHRvXCIpICsgXCIgbWVtYmVyIGV4cHJlc3Npb25cIik7XG4gICAgICBicmVhaztcblxuICAgIGNhc2UgXCJPYmplY3RQYXR0ZXJuXCI6XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGV4cHIucHJvcGVydGllcy5sZW5ndGg7IGkrKykge1xuICAgICAgICB0aGlzLmNoZWNrTFZhbChleHByLnByb3BlcnRpZXNbaV0udmFsdWUsIGlzQmluZGluZywgY2hlY2tDbGFzaGVzKTtcbiAgICAgIH1icmVhaztcblxuICAgIGNhc2UgXCJBcnJheVBhdHRlcm5cIjpcbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZXhwci5lbGVtZW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgICB2YXIgZWxlbSA9IGV4cHIuZWxlbWVudHNbaV07XG4gICAgICAgIGlmIChlbGVtKSB0aGlzLmNoZWNrTFZhbChlbGVtLCBpc0JpbmRpbmcsIGNoZWNrQ2xhc2hlcyk7XG4gICAgICB9XG4gICAgICBicmVhaztcblxuICAgIGNhc2UgXCJBc3NpZ25tZW50UGF0dGVyblwiOlxuICAgICAgdGhpcy5jaGVja0xWYWwoZXhwci5sZWZ0LCBpc0JpbmRpbmcsIGNoZWNrQ2xhc2hlcyk7XG4gICAgICBicmVhaztcblxuICAgIGNhc2UgXCJSZXN0RWxlbWVudFwiOlxuICAgICAgdGhpcy5jaGVja0xWYWwoZXhwci5hcmd1bWVudCwgaXNCaW5kaW5nLCBjaGVja0NsYXNoZXMpO1xuICAgICAgYnJlYWs7XG5cbiAgICBjYXNlIFwiUGFyZW50aGVzaXplZEV4cHJlc3Npb25cIjpcbiAgICAgIHRoaXMuY2hlY2tMVmFsKGV4cHIuZXhwcmVzc2lvbiwgaXNCaW5kaW5nLCBjaGVja0NsYXNoZXMpO1xuICAgICAgYnJlYWs7XG5cbiAgICBkZWZhdWx0OlxuICAgICAgdGhpcy5yYWlzZShleHByLnN0YXJ0LCAoaXNCaW5kaW5nID8gXCJCaW5kaW5nXCIgOiBcIkFzc2lnbmluZyB0b1wiKSArIFwiIHJ2YWx1ZVwiKTtcbiAgfVxufTtcblxufSx7XCIuL2lkZW50aWZpZXJcIjoyLFwiLi9zdGF0ZVwiOjEwLFwiLi90b2tlbnR5cGVcIjoxNCxcIi4vdXRpbFwiOjE1fV0sNzpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7XG5cInVzZSBzdHJpY3RcIjtcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcblxuZnVuY3Rpb24gX2NsYXNzQ2FsbENoZWNrKGluc3RhbmNlLCBDb25zdHJ1Y3RvcikgeyBpZiAoIShpbnN0YW5jZSBpbnN0YW5jZW9mIENvbnN0cnVjdG9yKSkgeyB0aHJvdyBuZXcgVHlwZUVycm9yKFwiQ2Fubm90IGNhbGwgYSBjbGFzcyBhcyBhIGZ1bmN0aW9uXCIpOyB9IH1cblxudmFyIF9zdGF0ZSA9IF9kZXJlcV8oXCIuL3N0YXRlXCIpO1xuXG52YXIgX2xvY3V0aWwgPSBfZGVyZXFfKFwiLi9sb2N1dGlsXCIpO1xuXG52YXIgTm9kZSA9IGZ1bmN0aW9uIE5vZGUocGFyc2VyLCBwb3MsIGxvYykge1xuICBfY2xhc3NDYWxsQ2hlY2sodGhpcywgTm9kZSk7XG5cbiAgdGhpcy50eXBlID0gXCJcIjtcbiAgdGhpcy5zdGFydCA9IHBvcztcbiAgdGhpcy5lbmQgPSAwO1xuICBpZiAocGFyc2VyLm9wdGlvbnMubG9jYXRpb25zKSB0aGlzLmxvYyA9IG5ldyBfbG9jdXRpbC5Tb3VyY2VMb2NhdGlvbihwYXJzZXIsIGxvYyk7XG4gIGlmIChwYXJzZXIub3B0aW9ucy5kaXJlY3RTb3VyY2VGaWxlKSB0aGlzLnNvdXJjZUZpbGUgPSBwYXJzZXIub3B0aW9ucy5kaXJlY3RTb3VyY2VGaWxlO1xuICBpZiAocGFyc2VyLm9wdGlvbnMucmFuZ2VzKSB0aGlzLnJhbmdlID0gW3BvcywgMF07XG59XG5cbi8vIFN0YXJ0IGFuIEFTVCBub2RlLCBhdHRhY2hpbmcgYSBzdGFydCBvZmZzZXQuXG5cbjtcblxuZXhwb3J0cy5Ob2RlID0gTm9kZTtcbnZhciBwcCA9IF9zdGF0ZS5QYXJzZXIucHJvdG90eXBlO1xuXG5wcC5zdGFydE5vZGUgPSBmdW5jdGlvbiAoKSB7XG4gIHJldHVybiBuZXcgTm9kZSh0aGlzLCB0aGlzLnN0YXJ0LCB0aGlzLnN0YXJ0TG9jKTtcbn07XG5cbnBwLnN0YXJ0Tm9kZUF0ID0gZnVuY3Rpb24gKHBvcywgbG9jKSB7XG4gIHJldHVybiBuZXcgTm9kZSh0aGlzLCBwb3MsIGxvYyk7XG59O1xuXG4vLyBGaW5pc2ggYW4gQVNUIG5vZGUsIGFkZGluZyBgdHlwZWAgYW5kIGBlbmRgIHByb3BlcnRpZXMuXG5cbmZ1bmN0aW9uIGZpbmlzaE5vZGVBdChub2RlLCB0eXBlLCBwb3MsIGxvYykge1xuICBub2RlLnR5cGUgPSB0eXBlO1xuICBub2RlLmVuZCA9IHBvcztcbiAgaWYgKHRoaXMub3B0aW9ucy5sb2NhdGlvbnMpIG5vZGUubG9jLmVuZCA9IGxvYztcbiAgaWYgKHRoaXMub3B0aW9ucy5yYW5nZXMpIG5vZGUucmFuZ2VbMV0gPSBwb3M7XG4gIHJldHVybiBub2RlO1xufVxuXG5wcC5maW5pc2hOb2RlID0gZnVuY3Rpb24gKG5vZGUsIHR5cGUpIHtcbiAgcmV0dXJuIGZpbmlzaE5vZGVBdC5jYWxsKHRoaXMsIG5vZGUsIHR5cGUsIHRoaXMubGFzdFRva0VuZCwgdGhpcy5sYXN0VG9rRW5kTG9jKTtcbn07XG5cbi8vIEZpbmlzaCBub2RlIGF0IGdpdmVuIHBvc2l0aW9uXG5cbnBwLmZpbmlzaE5vZGVBdCA9IGZ1bmN0aW9uIChub2RlLCB0eXBlLCBwb3MsIGxvYykge1xuICByZXR1cm4gZmluaXNoTm9kZUF0LmNhbGwodGhpcywgbm9kZSwgdHlwZSwgcG9zLCBsb2MpO1xufTtcblxufSx7XCIuL2xvY3V0aWxcIjo1LFwiLi9zdGF0ZVwiOjEwfV0sODpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7XG5cInVzZSBzdHJpY3RcIjtcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcbmV4cG9ydHMuZ2V0T3B0aW9ucyA9IGdldE9wdGlvbnM7XG5cbnZhciBfdXRpbCA9IF9kZXJlcV8oXCIuL3V0aWxcIik7XG5cbnZhciBfbG9jdXRpbCA9IF9kZXJlcV8oXCIuL2xvY3V0aWxcIik7XG5cbi8vIEEgc2Vjb25kIG9wdGlvbmFsIGFyZ3VtZW50IGNhbiBiZSBnaXZlbiB0byBmdXJ0aGVyIGNvbmZpZ3VyZVxuLy8gdGhlIHBhcnNlciBwcm9jZXNzLiBUaGVzZSBvcHRpb25zIGFyZSByZWNvZ25pemVkOlxuXG52YXIgZGVmYXVsdE9wdGlvbnMgPSB7XG4gIC8vIGBlY21hVmVyc2lvbmAgaW5kaWNhdGVzIHRoZSBFQ01BU2NyaXB0IHZlcnNpb24gdG8gcGFyc2UuIE11c3RcbiAgLy8gYmUgZWl0aGVyIDMsIG9yIDUsIG9yIDYuIFRoaXMgaW5mbHVlbmNlcyBzdXBwb3J0IGZvciBzdHJpY3RcbiAgLy8gbW9kZSwgdGhlIHNldCBvZiByZXNlcnZlZCB3b3Jkcywgc3VwcG9ydCBmb3IgZ2V0dGVycyBhbmRcbiAgLy8gc2V0dGVycyBhbmQgb3RoZXIgZmVhdHVyZXMuXG4gIGVjbWFWZXJzaW9uOiA1LFxuICAvLyBTb3VyY2UgdHlwZSAoXCJzY3JpcHRcIiBvciBcIm1vZHVsZVwiKSBmb3IgZGlmZmVyZW50IHNlbWFudGljc1xuICBzb3VyY2VUeXBlOiBcInNjcmlwdFwiLFxuICAvLyBgb25JbnNlcnRlZFNlbWljb2xvbmAgY2FuIGJlIGEgY2FsbGJhY2sgdGhhdCB3aWxsIGJlIGNhbGxlZFxuICAvLyB3aGVuIGEgc2VtaWNvbG9uIGlzIGF1dG9tYXRpY2FsbHkgaW5zZXJ0ZWQuIEl0IHdpbGwgYmUgcGFzc2VkXG4gIC8vIHRoIHBvc2l0aW9uIG9mIHRoZSBjb21tYSBhcyBhbiBvZmZzZXQsIGFuZCBpZiBgbG9jYXRpb25zYCBpc1xuICAvLyBlbmFibGVkLCBpdCBpcyBnaXZlbiB0aGUgbG9jYXRpb24gYXMgYSBge2xpbmUsIGNvbHVtbn1gIG9iamVjdFxuICAvLyBhcyBzZWNvbmQgYXJndW1lbnQuXG4gIG9uSW5zZXJ0ZWRTZW1pY29sb246IG51bGwsXG4gIC8vIGBvblRyYWlsaW5nQ29tbWFgIGlzIHNpbWlsYXIgdG8gYG9uSW5zZXJ0ZWRTZW1pY29sb25gLCBidXQgZm9yXG4gIC8vIHRyYWlsaW5nIGNvbW1hcy5cbiAgb25UcmFpbGluZ0NvbW1hOiBudWxsLFxuICAvLyBCeSBkZWZhdWx0LCByZXNlcnZlZCB3b3JkcyBhcmUgbm90IGVuZm9yY2VkLiBEaXNhYmxlXG4gIC8vIGBhbGxvd1Jlc2VydmVkYCB0byBlbmZvcmNlIHRoZW0uIFdoZW4gdGhpcyBvcHRpb24gaGFzIHRoZVxuICAvLyB2YWx1ZSBcIm5ldmVyXCIsIHJlc2VydmVkIHdvcmRzIGFuZCBrZXl3b3JkcyBjYW4gYWxzbyBub3QgYmVcbiAgLy8gdXNlZCBhcyBwcm9wZXJ0eSBuYW1lcy5cbiAgYWxsb3dSZXNlcnZlZDogdHJ1ZSxcbiAgLy8gV2hlbiBlbmFibGVkLCBhIHJldHVybiBhdCB0aGUgdG9wIGxldmVsIGlzIG5vdCBjb25zaWRlcmVkIGFuXG4gIC8vIGVycm9yLlxuICBhbGxvd1JldHVybk91dHNpZGVGdW5jdGlvbjogZmFsc2UsXG4gIC8vIFdoZW4gZW5hYmxlZCwgaW1wb3J0L2V4cG9ydCBzdGF0ZW1lbnRzIGFyZSBub3QgY29uc3RyYWluZWQgdG9cbiAgLy8gYXBwZWFyaW5nIGF0IHRoZSB0b3Agb2YgdGhlIHByb2dyYW0uXG4gIGFsbG93SW1wb3J0RXhwb3J0RXZlcnl3aGVyZTogZmFsc2UsXG4gIC8vIFdoZW4gZW5hYmxlZCwgaGFzaGJhbmcgZGlyZWN0aXZlIGluIHRoZSBiZWdpbm5pbmcgb2YgZmlsZVxuICAvLyBpcyBhbGxvd2VkIGFuZCB0cmVhdGVkIGFzIGEgbGluZSBjb21tZW50LlxuICBhbGxvd0hhc2hCYW5nOiBmYWxzZSxcbiAgLy8gV2hlbiBgbG9jYXRpb25zYCBpcyBvbiwgYGxvY2AgcHJvcGVydGllcyBob2xkaW5nIG9iamVjdHMgd2l0aFxuICAvLyBgc3RhcnRgIGFuZCBgZW5kYCBwcm9wZXJ0aWVzIGluIGB7bGluZSwgY29sdW1ufWAgZm9ybSAod2l0aFxuICAvLyBsaW5lIGJlaW5nIDEtYmFzZWQgYW5kIGNvbHVtbiAwLWJhc2VkKSB3aWxsIGJlIGF0dGFjaGVkIHRvIHRoZVxuICAvLyBub2Rlcy5cbiAgbG9jYXRpb25zOiBmYWxzZSxcbiAgLy8gQSBmdW5jdGlvbiBjYW4gYmUgcGFzc2VkIGFzIGBvblRva2VuYCBvcHRpb24sIHdoaWNoIHdpbGxcbiAgLy8gY2F1c2UgQWNvcm4gdG8gY2FsbCB0aGF0IGZ1bmN0aW9uIHdpdGggb2JqZWN0IGluIHRoZSBzYW1lXG4gIC8vIGZvcm1hdCBhcyB0b2tlbml6ZSgpIHJldHVybnMuIE5vdGUgdGhhdCB5b3UgYXJlIG5vdFxuICAvLyBhbGxvd2VkIHRvIGNhbGwgdGhlIHBhcnNlciBmcm9tIHRoZSBjYWxsYmFja+KAlHRoYXQgd2lsbFxuICAvLyBjb3JydXB0IGl0cyBpbnRlcm5hbCBzdGF0ZS5cbiAgb25Ub2tlbjogbnVsbCxcbiAgLy8gQSBmdW5jdGlvbiBjYW4gYmUgcGFzc2VkIGFzIGBvbkNvbW1lbnRgIG9wdGlvbiwgd2hpY2ggd2lsbFxuICAvLyBjYXVzZSBBY29ybiB0byBjYWxsIHRoYXQgZnVuY3Rpb24gd2l0aCBgKGJsb2NrLCB0ZXh0LCBzdGFydCxcbiAgLy8gZW5kKWAgcGFyYW1ldGVycyB3aGVuZXZlciBhIGNvbW1lbnQgaXMgc2tpcHBlZC4gYGJsb2NrYCBpcyBhXG4gIC8vIGJvb2xlYW4gaW5kaWNhdGluZyB3aGV0aGVyIHRoaXMgaXMgYSBibG9jayAoYC8qICovYCkgY29tbWVudCxcbiAgLy8gYHRleHRgIGlzIHRoZSBjb250ZW50IG9mIHRoZSBjb21tZW50LCBhbmQgYHN0YXJ0YCBhbmQgYGVuZGAgYXJlXG4gIC8vIGNoYXJhY3RlciBvZmZzZXRzIHRoYXQgZGVub3RlIHRoZSBzdGFydCBhbmQgZW5kIG9mIHRoZSBjb21tZW50LlxuICAvLyBXaGVuIHRoZSBgbG9jYXRpb25zYCBvcHRpb24gaXMgb24sIHR3byBtb3JlIHBhcmFtZXRlcnMgYXJlXG4gIC8vIHBhc3NlZCwgdGhlIGZ1bGwgYHtsaW5lLCBjb2x1bW59YCBsb2NhdGlvbnMgb2YgdGhlIHN0YXJ0IGFuZFxuICAvLyBlbmQgb2YgdGhlIGNvbW1lbnRzLiBOb3RlIHRoYXQgeW91IGFyZSBub3QgYWxsb3dlZCB0byBjYWxsIHRoZVxuICAvLyBwYXJzZXIgZnJvbSB0aGUgY2FsbGJhY2vigJR0aGF0IHdpbGwgY29ycnVwdCBpdHMgaW50ZXJuYWwgc3RhdGUuXG4gIG9uQ29tbWVudDogbnVsbCxcbiAgLy8gTm9kZXMgaGF2ZSB0aGVpciBzdGFydCBhbmQgZW5kIGNoYXJhY3RlcnMgb2Zmc2V0cyByZWNvcmRlZCBpblxuICAvLyBgc3RhcnRgIGFuZCBgZW5kYCBwcm9wZXJ0aWVzIChkaXJlY3RseSBvbiB0aGUgbm9kZSwgcmF0aGVyIHRoYW5cbiAgLy8gdGhlIGBsb2NgIG9iamVjdCwgd2hpY2ggaG9sZHMgbGluZS9jb2x1bW4gZGF0YS4gVG8gYWxzbyBhZGQgYVxuICAvLyBbc2VtaS1zdGFuZGFyZGl6ZWRdW3JhbmdlXSBgcmFuZ2VgIHByb3BlcnR5IGhvbGRpbmcgYSBgW3N0YXJ0LFxuICAvLyBlbmRdYCBhcnJheSB3aXRoIHRoZSBzYW1lIG51bWJlcnMsIHNldCB0aGUgYHJhbmdlc2Agb3B0aW9uIHRvXG4gIC8vIGB0cnVlYC5cbiAgLy9cbiAgLy8gW3JhbmdlXTogaHR0cHM6Ly9idWd6aWxsYS5tb3ppbGxhLm9yZy9zaG93X2J1Zy5jZ2k/aWQ9NzQ1Njc4XG4gIHJhbmdlczogZmFsc2UsXG4gIC8vIEl0IGlzIHBvc3NpYmxlIHRvIHBhcnNlIG11bHRpcGxlIGZpbGVzIGludG8gYSBzaW5nbGUgQVNUIGJ5XG4gIC8vIHBhc3NpbmcgdGhlIHRyZWUgcHJvZHVjZWQgYnkgcGFyc2luZyB0aGUgZmlyc3QgZmlsZSBhc1xuICAvLyBgcHJvZ3JhbWAgb3B0aW9uIGluIHN1YnNlcXVlbnQgcGFyc2VzLiBUaGlzIHdpbGwgYWRkIHRoZVxuICAvLyB0b3BsZXZlbCBmb3JtcyBvZiB0aGUgcGFyc2VkIGZpbGUgdG8gdGhlIGBQcm9ncmFtYCAodG9wKSBub2RlXG4gIC8vIG9mIGFuIGV4aXN0aW5nIHBhcnNlIHRyZWUuXG4gIHByb2dyYW06IG51bGwsXG4gIC8vIFdoZW4gYGxvY2F0aW9uc2AgaXMgb24sIHlvdSBjYW4gcGFzcyB0aGlzIHRvIHJlY29yZCB0aGUgc291cmNlXG4gIC8vIGZpbGUgaW4gZXZlcnkgbm9kZSdzIGBsb2NgIG9iamVjdC5cbiAgc291cmNlRmlsZTogbnVsbCxcbiAgLy8gVGhpcyB2YWx1ZSwgaWYgZ2l2ZW4sIGlzIHN0b3JlZCBpbiBldmVyeSBub2RlLCB3aGV0aGVyXG4gIC8vIGBsb2NhdGlvbnNgIGlzIG9uIG9yIG9mZi5cbiAgZGlyZWN0U291cmNlRmlsZTogbnVsbCxcbiAgLy8gV2hlbiBlbmFibGVkLCBwYXJlbnRoZXNpemVkIGV4cHJlc3Npb25zIGFyZSByZXByZXNlbnRlZCBieVxuICAvLyAobm9uLXN0YW5kYXJkKSBQYXJlbnRoZXNpemVkRXhwcmVzc2lvbiBub2Rlc1xuICBwcmVzZXJ2ZVBhcmVuczogZmFsc2UsXG4gIHBsdWdpbnM6IHt9XG59O1xuXG5leHBvcnRzLmRlZmF1bHRPcHRpb25zID0gZGVmYXVsdE9wdGlvbnM7XG4vLyBJbnRlcnByZXQgYW5kIGRlZmF1bHQgYW4gb3B0aW9ucyBvYmplY3RcblxuZnVuY3Rpb24gZ2V0T3B0aW9ucyhvcHRzKSB7XG4gIHZhciBvcHRpb25zID0ge307XG4gIGZvciAodmFyIG9wdCBpbiBkZWZhdWx0T3B0aW9ucykge1xuICAgIG9wdGlvbnNbb3B0XSA9IG9wdHMgJiYgX3V0aWwuaGFzKG9wdHMsIG9wdCkgPyBvcHRzW29wdF0gOiBkZWZhdWx0T3B0aW9uc1tvcHRdO1xuICB9aWYgKF91dGlsLmlzQXJyYXkob3B0aW9ucy5vblRva2VuKSkge1xuICAgIChmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgdG9rZW5zID0gb3B0aW9ucy5vblRva2VuO1xuICAgICAgb3B0aW9ucy5vblRva2VuID0gZnVuY3Rpb24gKHRva2VuKSB7XG4gICAgICAgIHJldHVybiB0b2tlbnMucHVzaCh0b2tlbik7XG4gICAgICB9O1xuICAgIH0pKCk7XG4gIH1cbiAgaWYgKF91dGlsLmlzQXJyYXkob3B0aW9ucy5vbkNvbW1lbnQpKSBvcHRpb25zLm9uQ29tbWVudCA9IHB1c2hDb21tZW50KG9wdGlvbnMsIG9wdGlvbnMub25Db21tZW50KTtcblxuICByZXR1cm4gb3B0aW9ucztcbn1cblxuZnVuY3Rpb24gcHVzaENvbW1lbnQob3B0aW9ucywgYXJyYXkpIHtcbiAgcmV0dXJuIGZ1bmN0aW9uIChibG9jaywgdGV4dCwgc3RhcnQsIGVuZCwgc3RhcnRMb2MsIGVuZExvYykge1xuICAgIHZhciBjb21tZW50ID0ge1xuICAgICAgdHlwZTogYmxvY2sgPyAnQmxvY2snIDogJ0xpbmUnLFxuICAgICAgdmFsdWU6IHRleHQsXG4gICAgICBzdGFydDogc3RhcnQsXG4gICAgICBlbmQ6IGVuZFxuICAgIH07XG4gICAgaWYgKG9wdGlvbnMubG9jYXRpb25zKSBjb21tZW50LmxvYyA9IG5ldyBfbG9jdXRpbC5Tb3VyY2VMb2NhdGlvbih0aGlzLCBzdGFydExvYywgZW5kTG9jKTtcbiAgICBpZiAob3B0aW9ucy5yYW5nZXMpIGNvbW1lbnQucmFuZ2UgPSBbc3RhcnQsIGVuZF07XG4gICAgYXJyYXkucHVzaChjb21tZW50KTtcbiAgfTtcbn1cblxufSx7XCIuL2xvY3V0aWxcIjo1LFwiLi91dGlsXCI6MTV9XSw5OltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXtcblwidXNlIHN0cmljdFwiO1xuXG52YXIgX3Rva2VudHlwZSA9IF9kZXJlcV8oXCIuL3Rva2VudHlwZVwiKTtcblxudmFyIF9zdGF0ZSA9IF9kZXJlcV8oXCIuL3N0YXRlXCIpO1xuXG52YXIgX3doaXRlc3BhY2UgPSBfZGVyZXFfKFwiLi93aGl0ZXNwYWNlXCIpO1xuXG52YXIgcHAgPSBfc3RhdGUuUGFyc2VyLnByb3RvdHlwZTtcblxuLy8gIyMgUGFyc2VyIHV0aWxpdGllc1xuXG4vLyBUZXN0IHdoZXRoZXIgYSBzdGF0ZW1lbnQgbm9kZSBpcyB0aGUgc3RyaW5nIGxpdGVyYWwgYFwidXNlIHN0cmljdFwiYC5cblxucHAuaXNVc2VTdHJpY3QgPSBmdW5jdGlvbiAoc3RtdCkge1xuICByZXR1cm4gdGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDUgJiYgc3RtdC50eXBlID09PSBcIkV4cHJlc3Npb25TdGF0ZW1lbnRcIiAmJiBzdG10LmV4cHJlc3Npb24udHlwZSA9PT0gXCJMaXRlcmFsXCIgJiYgc3RtdC5leHByZXNzaW9uLnJhdy5zbGljZSgxLCAtMSkgPT09IFwidXNlIHN0cmljdFwiO1xufTtcblxuLy8gUHJlZGljYXRlIHRoYXQgdGVzdHMgd2hldGhlciB0aGUgbmV4dCB0b2tlbiBpcyBvZiB0aGUgZ2l2ZW5cbi8vIHR5cGUsIGFuZCBpZiB5ZXMsIGNvbnN1bWVzIGl0IGFzIGEgc2lkZSBlZmZlY3QuXG5cbnBwLmVhdCA9IGZ1bmN0aW9uICh0eXBlKSB7XG4gIGlmICh0aGlzLnR5cGUgPT09IHR5cGUpIHtcbiAgICB0aGlzLm5leHQoKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn07XG5cbi8vIFRlc3RzIHdoZXRoZXIgcGFyc2VkIHRva2VuIGlzIGEgY29udGV4dHVhbCBrZXl3b3JkLlxuXG5wcC5pc0NvbnRleHR1YWwgPSBmdW5jdGlvbiAobmFtZSkge1xuICByZXR1cm4gdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLm5hbWUgJiYgdGhpcy52YWx1ZSA9PT0gbmFtZTtcbn07XG5cbi8vIENvbnN1bWVzIGNvbnRleHR1YWwga2V5d29yZCBpZiBwb3NzaWJsZS5cblxucHAuZWF0Q29udGV4dHVhbCA9IGZ1bmN0aW9uIChuYW1lKSB7XG4gIHJldHVybiB0aGlzLnZhbHVlID09PSBuYW1lICYmIHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMubmFtZSk7XG59O1xuXG4vLyBBc3NlcnRzIHRoYXQgZm9sbG93aW5nIHRva2VuIGlzIGdpdmVuIGNvbnRleHR1YWwga2V5d29yZC5cblxucHAuZXhwZWN0Q29udGV4dHVhbCA9IGZ1bmN0aW9uIChuYW1lKSB7XG4gIGlmICghdGhpcy5lYXRDb250ZXh0dWFsKG5hbWUpKSB0aGlzLnVuZXhwZWN0ZWQoKTtcbn07XG5cbi8vIFRlc3Qgd2hldGhlciBhIHNlbWljb2xvbiBjYW4gYmUgaW5zZXJ0ZWQgYXQgdGhlIGN1cnJlbnQgcG9zaXRpb24uXG5cbnBwLmNhbkluc2VydFNlbWljb2xvbiA9IGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5lb2YgfHwgdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmJyYWNlUiB8fCBfd2hpdGVzcGFjZS5saW5lQnJlYWsudGVzdCh0aGlzLmlucHV0LnNsaWNlKHRoaXMubGFzdFRva0VuZCwgdGhpcy5zdGFydCkpO1xufTtcblxucHAuaW5zZXJ0U2VtaWNvbG9uID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5jYW5JbnNlcnRTZW1pY29sb24oKSkge1xuICAgIGlmICh0aGlzLm9wdGlvbnMub25JbnNlcnRlZFNlbWljb2xvbikgdGhpcy5vcHRpb25zLm9uSW5zZXJ0ZWRTZW1pY29sb24odGhpcy5sYXN0VG9rRW5kLCB0aGlzLmxhc3RUb2tFbmRMb2MpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG59O1xuXG4vLyBDb25zdW1lIGEgc2VtaWNvbG9uLCBvciwgZmFpbGluZyB0aGF0LCBzZWUgaWYgd2UgYXJlIGFsbG93ZWQgdG9cbi8vIHByZXRlbmQgdGhhdCB0aGVyZSBpcyBhIHNlbWljb2xvbiBhdCB0aGlzIHBvc2l0aW9uLlxuXG5wcC5zZW1pY29sb24gPSBmdW5jdGlvbiAoKSB7XG4gIGlmICghdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5zZW1pKSAmJiAhdGhpcy5pbnNlcnRTZW1pY29sb24oKSkgdGhpcy51bmV4cGVjdGVkKCk7XG59O1xuXG5wcC5hZnRlclRyYWlsaW5nQ29tbWEgPSBmdW5jdGlvbiAodG9rVHlwZSkge1xuICBpZiAodGhpcy50eXBlID09IHRva1R5cGUpIHtcbiAgICBpZiAodGhpcy5vcHRpb25zLm9uVHJhaWxpbmdDb21tYSkgdGhpcy5vcHRpb25zLm9uVHJhaWxpbmdDb21tYSh0aGlzLmxhc3RUb2tTdGFydCwgdGhpcy5sYXN0VG9rU3RhcnRMb2MpO1xuICAgIHRoaXMubmV4dCgpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG59O1xuXG4vLyBFeHBlY3QgYSB0b2tlbiBvZiBhIGdpdmVuIHR5cGUuIElmIGZvdW5kLCBjb25zdW1lIGl0LCBvdGhlcndpc2UsXG4vLyByYWlzZSBhbiB1bmV4cGVjdGVkIHRva2VuIGVycm9yLlxuXG5wcC5leHBlY3QgPSBmdW5jdGlvbiAodHlwZSkge1xuICB0aGlzLmVhdCh0eXBlKSB8fCB0aGlzLnVuZXhwZWN0ZWQoKTtcbn07XG5cbi8vIFJhaXNlIGFuIHVuZXhwZWN0ZWQgdG9rZW4gZXJyb3IuXG5cbnBwLnVuZXhwZWN0ZWQgPSBmdW5jdGlvbiAocG9zKSB7XG4gIHRoaXMucmFpc2UocG9zICE9IG51bGwgPyBwb3MgOiB0aGlzLnN0YXJ0LCBcIlVuZXhwZWN0ZWQgdG9rZW5cIik7XG59O1xuXG59LHtcIi4vc3RhdGVcIjoxMCxcIi4vdG9rZW50eXBlXCI6MTQsXCIuL3doaXRlc3BhY2VcIjoxNn1dLDEwOltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXtcblwidXNlIHN0cmljdFwiO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuXG5mdW5jdGlvbiBfY2xhc3NDYWxsQ2hlY2soaW5zdGFuY2UsIENvbnN0cnVjdG9yKSB7IGlmICghKGluc3RhbmNlIGluc3RhbmNlb2YgQ29uc3RydWN0b3IpKSB7IHRocm93IG5ldyBUeXBlRXJyb3IoXCJDYW5ub3QgY2FsbCBhIGNsYXNzIGFzIGEgZnVuY3Rpb25cIik7IH0gfVxuXG52YXIgX2lkZW50aWZpZXIgPSBfZGVyZXFfKFwiLi9pZGVudGlmaWVyXCIpO1xuXG52YXIgX3Rva2VudHlwZSA9IF9kZXJlcV8oXCIuL3Rva2VudHlwZVwiKTtcblxudmFyIF93aGl0ZXNwYWNlID0gX2RlcmVxXyhcIi4vd2hpdGVzcGFjZVwiKTtcblxudmFyIF9vcHRpb25zID0gX2RlcmVxXyhcIi4vb3B0aW9uc1wiKTtcblxuLy8gUmVnaXN0ZXJlZCBwbHVnaW5zXG52YXIgcGx1Z2lucyA9IHt9O1xuXG5leHBvcnRzLnBsdWdpbnMgPSBwbHVnaW5zO1xuXG52YXIgUGFyc2VyID0gKGZ1bmN0aW9uICgpIHtcbiAgZnVuY3Rpb24gUGFyc2VyKG9wdGlvbnMsIGlucHV0LCBzdGFydFBvcykge1xuICAgIF9jbGFzc0NhbGxDaGVjayh0aGlzLCBQYXJzZXIpO1xuXG4gICAgdGhpcy5vcHRpb25zID0gX29wdGlvbnMuZ2V0T3B0aW9ucyhvcHRpb25zKTtcbiAgICB0aGlzLnNvdXJjZUZpbGUgPSB0aGlzLm9wdGlvbnMuc291cmNlRmlsZTtcbiAgICB0aGlzLmlzS2V5d29yZCA9IF9pZGVudGlmaWVyLmtleXdvcmRzW3RoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2ID8gNiA6IDVdO1xuICAgIHRoaXMuaXNSZXNlcnZlZFdvcmQgPSBfaWRlbnRpZmllci5yZXNlcnZlZFdvcmRzW3RoaXMub3B0aW9ucy5lY21hVmVyc2lvbl07XG4gICAgdGhpcy5pbnB1dCA9IFN0cmluZyhpbnB1dCk7XG5cbiAgICAvLyBVc2VkIHRvIHNpZ25hbCB0byBjYWxsZXJzIG9mIGByZWFkV29yZDFgIHdoZXRoZXIgdGhlIHdvcmRcbiAgICAvLyBjb250YWluZWQgYW55IGVzY2FwZSBzZXF1ZW5jZXMuIFRoaXMgaXMgbmVlZGVkIGJlY2F1c2Ugd29yZHMgd2l0aFxuICAgIC8vIGVzY2FwZSBzZXF1ZW5jZXMgbXVzdCBub3QgYmUgaW50ZXJwcmV0ZWQgYXMga2V5d29yZHMuXG4gICAgdGhpcy5jb250YWluc0VzYyA9IGZhbHNlO1xuXG4gICAgLy8gTG9hZCBwbHVnaW5zXG4gICAgdGhpcy5sb2FkUGx1Z2lucyh0aGlzLm9wdGlvbnMucGx1Z2lucyk7XG5cbiAgICAvLyBTZXQgdXAgdG9rZW4gc3RhdGVcblxuICAgIC8vIFRoZSBjdXJyZW50IHBvc2l0aW9uIG9mIHRoZSB0b2tlbml6ZXIgaW4gdGhlIGlucHV0LlxuICAgIGlmIChzdGFydFBvcykge1xuICAgICAgdGhpcy5wb3MgPSBzdGFydFBvcztcbiAgICAgIHRoaXMubGluZVN0YXJ0ID0gTWF0aC5tYXgoMCwgdGhpcy5pbnB1dC5sYXN0SW5kZXhPZihcIlxcblwiLCBzdGFydFBvcykpO1xuICAgICAgdGhpcy5jdXJMaW5lID0gdGhpcy5pbnB1dC5zbGljZSgwLCB0aGlzLmxpbmVTdGFydCkuc3BsaXQoX3doaXRlc3BhY2UubGluZUJyZWFrKS5sZW5ndGg7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMucG9zID0gdGhpcy5saW5lU3RhcnQgPSAwO1xuICAgICAgdGhpcy5jdXJMaW5lID0gMTtcbiAgICB9XG5cbiAgICAvLyBQcm9wZXJ0aWVzIG9mIHRoZSBjdXJyZW50IHRva2VuOlxuICAgIC8vIEl0cyB0eXBlXG4gICAgdGhpcy50eXBlID0gX3Rva2VudHlwZS50eXBlcy5lb2Y7XG4gICAgLy8gRm9yIHRva2VucyB0aGF0IGluY2x1ZGUgbW9yZSBpbmZvcm1hdGlvbiB0aGFuIHRoZWlyIHR5cGUsIHRoZSB2YWx1ZVxuICAgIHRoaXMudmFsdWUgPSBudWxsO1xuICAgIC8vIEl0cyBzdGFydCBhbmQgZW5kIG9mZnNldFxuICAgIHRoaXMuc3RhcnQgPSB0aGlzLmVuZCA9IHRoaXMucG9zO1xuICAgIC8vIEFuZCwgaWYgbG9jYXRpb25zIGFyZSB1c2VkLCB0aGUge2xpbmUsIGNvbHVtbn0gb2JqZWN0XG4gICAgLy8gY29ycmVzcG9uZGluZyB0byB0aG9zZSBvZmZzZXRzXG4gICAgdGhpcy5zdGFydExvYyA9IHRoaXMuZW5kTG9jID0gdGhpcy5jdXJQb3NpdGlvbigpO1xuXG4gICAgLy8gUG9zaXRpb24gaW5mb3JtYXRpb24gZm9yIHRoZSBwcmV2aW91cyB0b2tlblxuICAgIHRoaXMubGFzdFRva0VuZExvYyA9IHRoaXMubGFzdFRva1N0YXJ0TG9jID0gbnVsbDtcbiAgICB0aGlzLmxhc3RUb2tTdGFydCA9IHRoaXMubGFzdFRva0VuZCA9IHRoaXMucG9zO1xuXG4gICAgLy8gVGhlIGNvbnRleHQgc3RhY2sgaXMgdXNlZCB0byBzdXBlcmZpY2lhbGx5IHRyYWNrIHN5bnRhY3RpY1xuICAgIC8vIGNvbnRleHQgdG8gcHJlZGljdCB3aGV0aGVyIGEgcmVndWxhciBleHByZXNzaW9uIGlzIGFsbG93ZWQgaW4gYVxuICAgIC8vIGdpdmVuIHBvc2l0aW9uLlxuICAgIHRoaXMuY29udGV4dCA9IHRoaXMuaW5pdGlhbENvbnRleHQoKTtcbiAgICB0aGlzLmV4cHJBbGxvd2VkID0gdHJ1ZTtcblxuICAgIC8vIEZpZ3VyZSBvdXQgaWYgaXQncyBhIG1vZHVsZSBjb2RlLlxuICAgIHRoaXMuc3RyaWN0ID0gdGhpcy5pbk1vZHVsZSA9IHRoaXMub3B0aW9ucy5zb3VyY2VUeXBlID09PSBcIm1vZHVsZVwiO1xuXG4gICAgLy8gVXNlZCB0byBzaWduaWZ5IHRoZSBzdGFydCBvZiBhIHBvdGVudGlhbCBhcnJvdyBmdW5jdGlvblxuICAgIHRoaXMucG90ZW50aWFsQXJyb3dBdCA9IC0xO1xuXG4gICAgLy8gRmxhZ3MgdG8gdHJhY2sgd2hldGhlciB3ZSBhcmUgaW4gYSBmdW5jdGlvbiwgYSBnZW5lcmF0b3IuXG4gICAgdGhpcy5pbkZ1bmN0aW9uID0gdGhpcy5pbkdlbmVyYXRvciA9IGZhbHNlO1xuICAgIC8vIExhYmVscyBpbiBzY29wZS5cbiAgICB0aGlzLmxhYmVscyA9IFtdO1xuXG4gICAgLy8gSWYgZW5hYmxlZCwgc2tpcCBsZWFkaW5nIGhhc2hiYW5nIGxpbmUuXG4gICAgaWYgKHRoaXMucG9zID09PSAwICYmIHRoaXMub3B0aW9ucy5hbGxvd0hhc2hCYW5nICYmIHRoaXMuaW5wdXQuc2xpY2UoMCwgMikgPT09ICcjIScpIHRoaXMuc2tpcExpbmVDb21tZW50KDIpO1xuICB9XG5cbiAgUGFyc2VyLnByb3RvdHlwZS5leHRlbmQgPSBmdW5jdGlvbiBleHRlbmQobmFtZSwgZikge1xuICAgIHRoaXNbbmFtZV0gPSBmKHRoaXNbbmFtZV0pO1xuICB9O1xuXG4gIFBhcnNlci5wcm90b3R5cGUubG9hZFBsdWdpbnMgPSBmdW5jdGlvbiBsb2FkUGx1Z2lucyhwbHVnaW5Db25maWdzKSB7XG4gICAgZm9yICh2YXIgX25hbWUgaW4gcGx1Z2luQ29uZmlncykge1xuICAgICAgdmFyIHBsdWdpbiA9IHBsdWdpbnNbX25hbWVdO1xuICAgICAgaWYgKCFwbHVnaW4pIHRocm93IG5ldyBFcnJvcihcIlBsdWdpbiAnXCIgKyBfbmFtZSArIFwiJyBub3QgZm91bmRcIik7XG4gICAgICBwbHVnaW4odGhpcywgcGx1Z2luQ29uZmlnc1tfbmFtZV0pO1xuICAgIH1cbiAgfTtcblxuICBQYXJzZXIucHJvdG90eXBlLnBhcnNlID0gZnVuY3Rpb24gcGFyc2UoKSB7XG4gICAgdmFyIG5vZGUgPSB0aGlzLm9wdGlvbnMucHJvZ3JhbSB8fCB0aGlzLnN0YXJ0Tm9kZSgpO1xuICAgIHRoaXMubmV4dFRva2VuKCk7XG4gICAgcmV0dXJuIHRoaXMucGFyc2VUb3BMZXZlbChub2RlKTtcbiAgfTtcblxuICByZXR1cm4gUGFyc2VyO1xufSkoKTtcblxuZXhwb3J0cy5QYXJzZXIgPSBQYXJzZXI7XG5cbn0se1wiLi9pZGVudGlmaWVyXCI6MixcIi4vb3B0aW9uc1wiOjgsXCIuL3Rva2VudHlwZVwiOjE0LFwiLi93aGl0ZXNwYWNlXCI6MTZ9XSwxMTpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7XG5cInVzZSBzdHJpY3RcIjtcblxudmFyIF90b2tlbnR5cGUgPSBfZGVyZXFfKFwiLi90b2tlbnR5cGVcIik7XG5cbnZhciBfc3RhdGUgPSBfZGVyZXFfKFwiLi9zdGF0ZVwiKTtcblxudmFyIF93aGl0ZXNwYWNlID0gX2RlcmVxXyhcIi4vd2hpdGVzcGFjZVwiKTtcblxudmFyIHBwID0gX3N0YXRlLlBhcnNlci5wcm90b3R5cGU7XG5cbi8vICMjIyBTdGF0ZW1lbnQgcGFyc2luZ1xuXG4vLyBQYXJzZSBhIHByb2dyYW0uIEluaXRpYWxpemVzIHRoZSBwYXJzZXIsIHJlYWRzIGFueSBudW1iZXIgb2Zcbi8vIHN0YXRlbWVudHMsIGFuZCB3cmFwcyB0aGVtIGluIGEgUHJvZ3JhbSBub2RlLiAgT3B0aW9uYWxseSB0YWtlcyBhXG4vLyBgcHJvZ3JhbWAgYXJndW1lbnQuICBJZiBwcmVzZW50LCB0aGUgc3RhdGVtZW50cyB3aWxsIGJlIGFwcGVuZGVkXG4vLyB0byBpdHMgYm9keSBpbnN0ZWFkIG9mIGNyZWF0aW5nIGEgbmV3IG5vZGUuXG5cbnBwLnBhcnNlVG9wTGV2ZWwgPSBmdW5jdGlvbiAobm9kZSkge1xuICB2YXIgZmlyc3QgPSB0cnVlO1xuICBpZiAoIW5vZGUuYm9keSkgbm9kZS5ib2R5ID0gW107XG4gIHdoaWxlICh0aGlzLnR5cGUgIT09IF90b2tlbnR5cGUudHlwZXMuZW9mKSB7XG4gICAgdmFyIHN0bXQgPSB0aGlzLnBhcnNlU3RhdGVtZW50KHRydWUsIHRydWUpO1xuICAgIG5vZGUuYm9keS5wdXNoKHN0bXQpO1xuICAgIGlmIChmaXJzdCkge1xuICAgICAgaWYgKHRoaXMuaXNVc2VTdHJpY3Qoc3RtdCkpIHRoaXMuc2V0U3RyaWN0KHRydWUpO1xuICAgICAgZmlyc3QgPSBmYWxzZTtcbiAgICB9XG4gIH1cbiAgdGhpcy5uZXh0KCk7XG4gIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNikge1xuICAgIG5vZGUuc291cmNlVHlwZSA9IHRoaXMub3B0aW9ucy5zb3VyY2VUeXBlO1xuICB9XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJQcm9ncmFtXCIpO1xufTtcblxudmFyIGxvb3BMYWJlbCA9IHsga2luZDogXCJsb29wXCIgfSxcbiAgICBzd2l0Y2hMYWJlbCA9IHsga2luZDogXCJzd2l0Y2hcIiB9O1xuXG4vLyBQYXJzZSBhIHNpbmdsZSBzdGF0ZW1lbnQuXG4vL1xuLy8gSWYgZXhwZWN0aW5nIGEgc3RhdGVtZW50IGFuZCBmaW5kaW5nIGEgc2xhc2ggb3BlcmF0b3IsIHBhcnNlIGFcbi8vIHJlZ3VsYXIgZXhwcmVzc2lvbiBsaXRlcmFsLiBUaGlzIGlzIHRvIGhhbmRsZSBjYXNlcyBsaWtlXG4vLyBgaWYgKGZvbykgL2JsYWgvLmV4ZWMoZm9vKWAsIHdoZXJlIGxvb2tpbmcgYXQgdGhlIHByZXZpb3VzIHRva2VuXG4vLyBkb2VzIG5vdCBoZWxwLlxuXG5wcC5wYXJzZVN0YXRlbWVudCA9IGZ1bmN0aW9uIChkZWNsYXJhdGlvbiwgdG9wTGV2ZWwpIHtcbiAgdmFyIHN0YXJ0dHlwZSA9IHRoaXMudHlwZSxcbiAgICAgIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuXG4gIC8vIE1vc3QgdHlwZXMgb2Ygc3RhdGVtZW50cyBhcmUgcmVjb2duaXplZCBieSB0aGUga2V5d29yZCB0aGV5XG4gIC8vIHN0YXJ0IHdpdGguIE1hbnkgYXJlIHRyaXZpYWwgdG8gcGFyc2UsIHNvbWUgcmVxdWlyZSBhIGJpdCBvZlxuICAvLyBjb21wbGV4aXR5LlxuXG4gIHN3aXRjaCAoc3RhcnR0eXBlKSB7XG4gICAgY2FzZSBfdG9rZW50eXBlLnR5cGVzLl9icmVhazpjYXNlIF90b2tlbnR5cGUudHlwZXMuX2NvbnRpbnVlOlxuICAgICAgcmV0dXJuIHRoaXMucGFyc2VCcmVha0NvbnRpbnVlU3RhdGVtZW50KG5vZGUsIHN0YXJ0dHlwZS5rZXl3b3JkKTtcbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuX2RlYnVnZ2VyOlxuICAgICAgcmV0dXJuIHRoaXMucGFyc2VEZWJ1Z2dlclN0YXRlbWVudChub2RlKTtcbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuX2RvOlxuICAgICAgcmV0dXJuIHRoaXMucGFyc2VEb1N0YXRlbWVudChub2RlKTtcbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuX2ZvcjpcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlRm9yU3RhdGVtZW50KG5vZGUpO1xuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5fZnVuY3Rpb246XG4gICAgICBpZiAoIWRlY2xhcmF0aW9uICYmIHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KSB0aGlzLnVuZXhwZWN0ZWQoKTtcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlRnVuY3Rpb25TdGF0ZW1lbnQobm9kZSk7XG4gICAgY2FzZSBfdG9rZW50eXBlLnR5cGVzLl9jbGFzczpcbiAgICAgIGlmICghZGVjbGFyYXRpb24pIHRoaXMudW5leHBlY3RlZCgpO1xuICAgICAgcmV0dXJuIHRoaXMucGFyc2VDbGFzcyhub2RlLCB0cnVlKTtcbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuX2lmOlxuICAgICAgcmV0dXJuIHRoaXMucGFyc2VJZlN0YXRlbWVudChub2RlKTtcbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuX3JldHVybjpcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlUmV0dXJuU3RhdGVtZW50KG5vZGUpO1xuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5fc3dpdGNoOlxuICAgICAgcmV0dXJuIHRoaXMucGFyc2VTd2l0Y2hTdGF0ZW1lbnQobm9kZSk7XG4gICAgY2FzZSBfdG9rZW50eXBlLnR5cGVzLl90aHJvdzpcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlVGhyb3dTdGF0ZW1lbnQobm9kZSk7XG4gICAgY2FzZSBfdG9rZW50eXBlLnR5cGVzLl90cnk6XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZVRyeVN0YXRlbWVudChub2RlKTtcbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuX2xldDpjYXNlIF90b2tlbnR5cGUudHlwZXMuX2NvbnN0OlxuICAgICAgaWYgKCFkZWNsYXJhdGlvbikgdGhpcy51bmV4cGVjdGVkKCk7IC8vIE5PVEU6IGZhbGxzIHRocm91Z2ggdG8gX3ZhclxuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5fdmFyOlxuICAgICAgcmV0dXJuIHRoaXMucGFyc2VWYXJTdGF0ZW1lbnQobm9kZSwgc3RhcnR0eXBlKTtcbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuX3doaWxlOlxuICAgICAgcmV0dXJuIHRoaXMucGFyc2VXaGlsZVN0YXRlbWVudChub2RlKTtcbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuX3dpdGg6XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZVdpdGhTdGF0ZW1lbnQobm9kZSk7XG4gICAgY2FzZSBfdG9rZW50eXBlLnR5cGVzLmJyYWNlTDpcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlQmxvY2soKTtcbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuc2VtaTpcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlRW1wdHlTdGF0ZW1lbnQobm9kZSk7XG4gICAgY2FzZSBfdG9rZW50eXBlLnR5cGVzLl9leHBvcnQ6XG4gICAgY2FzZSBfdG9rZW50eXBlLnR5cGVzLl9pbXBvcnQ6XG4gICAgICBpZiAoIXRoaXMub3B0aW9ucy5hbGxvd0ltcG9ydEV4cG9ydEV2ZXJ5d2hlcmUpIHtcbiAgICAgICAgaWYgKCF0b3BMZXZlbCkgdGhpcy5yYWlzZSh0aGlzLnN0YXJ0LCBcIidpbXBvcnQnIGFuZCAnZXhwb3J0JyBtYXkgb25seSBhcHBlYXIgYXQgdGhlIHRvcCBsZXZlbFwiKTtcbiAgICAgICAgaWYgKCF0aGlzLmluTW9kdWxlKSB0aGlzLnJhaXNlKHRoaXMuc3RhcnQsIFwiJ2ltcG9ydCcgYW5kICdleHBvcnQnIG1heSBhcHBlYXIgb25seSB3aXRoICdzb3VyY2VUeXBlOiBtb2R1bGUnXCIpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHN0YXJ0dHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5faW1wb3J0ID8gdGhpcy5wYXJzZUltcG9ydChub2RlKSA6IHRoaXMucGFyc2VFeHBvcnQobm9kZSk7XG5cbiAgICAvLyBJZiB0aGUgc3RhdGVtZW50IGRvZXMgbm90IHN0YXJ0IHdpdGggYSBzdGF0ZW1lbnQga2V5d29yZCBvciBhXG4gICAgLy8gYnJhY2UsIGl0J3MgYW4gRXhwcmVzc2lvblN0YXRlbWVudCBvciBMYWJlbGVkU3RhdGVtZW50LiBXZVxuICAgIC8vIHNpbXBseSBzdGFydCBwYXJzaW5nIGFuIGV4cHJlc3Npb24sIGFuZCBhZnRlcndhcmRzLCBpZiB0aGVcbiAgICAvLyBuZXh0IHRva2VuIGlzIGEgY29sb24gYW5kIHRoZSBleHByZXNzaW9uIHdhcyBhIHNpbXBsZVxuICAgIC8vIElkZW50aWZpZXIgbm9kZSwgd2Ugc3dpdGNoIHRvIGludGVycHJldGluZyBpdCBhcyBhIGxhYmVsLlxuICAgIGRlZmF1bHQ6XG4gICAgICB2YXIgbWF5YmVOYW1lID0gdGhpcy52YWx1ZSxcbiAgICAgICAgICBleHByID0gdGhpcy5wYXJzZUV4cHJlc3Npb24oKTtcbiAgICAgIGlmIChzdGFydHR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMubmFtZSAmJiBleHByLnR5cGUgPT09IFwiSWRlbnRpZmllclwiICYmIHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuY29sb24pKSByZXR1cm4gdGhpcy5wYXJzZUxhYmVsZWRTdGF0ZW1lbnQobm9kZSwgbWF5YmVOYW1lLCBleHByKTtlbHNlIHJldHVybiB0aGlzLnBhcnNlRXhwcmVzc2lvblN0YXRlbWVudChub2RlLCBleHByKTtcbiAgfVxufTtcblxucHAucGFyc2VCcmVha0NvbnRpbnVlU3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUsIGtleXdvcmQpIHtcbiAgdmFyIGlzQnJlYWsgPSBrZXl3b3JkID09IFwiYnJlYWtcIjtcbiAgdGhpcy5uZXh0KCk7XG4gIGlmICh0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLnNlbWkpIHx8IHRoaXMuaW5zZXJ0U2VtaWNvbG9uKCkpIG5vZGUubGFiZWwgPSBudWxsO2Vsc2UgaWYgKHRoaXMudHlwZSAhPT0gX3Rva2VudHlwZS50eXBlcy5uYW1lKSB0aGlzLnVuZXhwZWN0ZWQoKTtlbHNlIHtcbiAgICBub2RlLmxhYmVsID0gdGhpcy5wYXJzZUlkZW50KCk7XG4gICAgdGhpcy5zZW1pY29sb24oKTtcbiAgfVxuXG4gIC8vIFZlcmlmeSB0aGF0IHRoZXJlIGlzIGFuIGFjdHVhbCBkZXN0aW5hdGlvbiB0byBicmVhayBvclxuICAvLyBjb250aW51ZSB0by5cbiAgZm9yICh2YXIgaSA9IDA7IGkgPCB0aGlzLmxhYmVscy5sZW5ndGg7ICsraSkge1xuICAgIHZhciBsYWIgPSB0aGlzLmxhYmVsc1tpXTtcbiAgICBpZiAobm9kZS5sYWJlbCA9PSBudWxsIHx8IGxhYi5uYW1lID09PSBub2RlLmxhYmVsLm5hbWUpIHtcbiAgICAgIGlmIChsYWIua2luZCAhPSBudWxsICYmIChpc0JyZWFrIHx8IGxhYi5raW5kID09PSBcImxvb3BcIikpIGJyZWFrO1xuICAgICAgaWYgKG5vZGUubGFiZWwgJiYgaXNCcmVhaykgYnJlYWs7XG4gICAgfVxuICB9XG4gIGlmIChpID09PSB0aGlzLmxhYmVscy5sZW5ndGgpIHRoaXMucmFpc2Uobm9kZS5zdGFydCwgXCJVbnN5bnRhY3RpYyBcIiArIGtleXdvcmQpO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIGlzQnJlYWsgPyBcIkJyZWFrU3RhdGVtZW50XCIgOiBcIkNvbnRpbnVlU3RhdGVtZW50XCIpO1xufTtcblxucHAucGFyc2VEZWJ1Z2dlclN0YXRlbWVudCA9IGZ1bmN0aW9uIChub2RlKSB7XG4gIHRoaXMubmV4dCgpO1xuICB0aGlzLnNlbWljb2xvbigpO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiRGVidWdnZXJTdGF0ZW1lbnRcIik7XG59O1xuXG5wcC5wYXJzZURvU3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUpIHtcbiAgdGhpcy5uZXh0KCk7XG4gIHRoaXMubGFiZWxzLnB1c2gobG9vcExhYmVsKTtcbiAgbm9kZS5ib2R5ID0gdGhpcy5wYXJzZVN0YXRlbWVudChmYWxzZSk7XG4gIHRoaXMubGFiZWxzLnBvcCgpO1xuICB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLl93aGlsZSk7XG4gIG5vZGUudGVzdCA9IHRoaXMucGFyc2VQYXJlbkV4cHJlc3Npb24oKTtcbiAgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KSB0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLnNlbWkpO2Vsc2UgdGhpcy5zZW1pY29sb24oKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkRvV2hpbGVTdGF0ZW1lbnRcIik7XG59O1xuXG4vLyBEaXNhbWJpZ3VhdGluZyBiZXR3ZWVuIGEgYGZvcmAgYW5kIGEgYGZvcmAvYGluYCBvciBgZm9yYC9gb2ZgXG4vLyBsb29wIGlzIG5vbi10cml2aWFsLiBCYXNpY2FsbHksIHdlIGhhdmUgdG8gcGFyc2UgdGhlIGluaXQgYHZhcmBcbi8vIHN0YXRlbWVudCBvciBleHByZXNzaW9uLCBkaXNhbGxvd2luZyB0aGUgYGluYCBvcGVyYXRvciAoc2VlXG4vLyB0aGUgc2Vjb25kIHBhcmFtZXRlciB0byBgcGFyc2VFeHByZXNzaW9uYCksIGFuZCB0aGVuIGNoZWNrXG4vLyB3aGV0aGVyIHRoZSBuZXh0IHRva2VuIGlzIGBpbmAgb3IgYG9mYC4gV2hlbiB0aGVyZSBpcyBubyBpbml0XG4vLyBwYXJ0IChzZW1pY29sb24gaW1tZWRpYXRlbHkgYWZ0ZXIgdGhlIG9wZW5pbmcgcGFyZW50aGVzaXMpLCBpdFxuLy8gaXMgYSByZWd1bGFyIGBmb3JgIGxvb3AuXG5cbnBwLnBhcnNlRm9yU3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUpIHtcbiAgdGhpcy5uZXh0KCk7XG4gIHRoaXMubGFiZWxzLnB1c2gobG9vcExhYmVsKTtcbiAgdGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5wYXJlbkwpO1xuICBpZiAodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLnNlbWkpIHJldHVybiB0aGlzLnBhcnNlRm9yKG5vZGUsIG51bGwpO1xuICBpZiAodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl92YXIgfHwgdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9sZXQgfHwgdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9jb25zdCkge1xuICAgIHZhciBfaW5pdCA9IHRoaXMuc3RhcnROb2RlKCksXG4gICAgICAgIHZhcktpbmQgPSB0aGlzLnR5cGU7XG4gICAgdGhpcy5uZXh0KCk7XG4gICAgdGhpcy5wYXJzZVZhcihfaW5pdCwgdHJ1ZSwgdmFyS2luZCk7XG4gICAgdGhpcy5maW5pc2hOb2RlKF9pbml0LCBcIlZhcmlhYmxlRGVjbGFyYXRpb25cIik7XG4gICAgaWYgKCh0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2luIHx8IHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2ICYmIHRoaXMuaXNDb250ZXh0dWFsKFwib2ZcIikpICYmIF9pbml0LmRlY2xhcmF0aW9ucy5sZW5ndGggPT09IDEgJiYgISh2YXJLaW5kICE9PSBfdG9rZW50eXBlLnR5cGVzLl92YXIgJiYgX2luaXQuZGVjbGFyYXRpb25zWzBdLmluaXQpKSByZXR1cm4gdGhpcy5wYXJzZUZvckluKG5vZGUsIF9pbml0KTtcbiAgICByZXR1cm4gdGhpcy5wYXJzZUZvcihub2RlLCBfaW5pdCk7XG4gIH1cbiAgdmFyIHJlZlNob3J0aGFuZERlZmF1bHRQb3MgPSB7IHN0YXJ0OiAwIH07XG4gIHZhciBpbml0ID0gdGhpcy5wYXJzZUV4cHJlc3Npb24odHJ1ZSwgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcyk7XG4gIGlmICh0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2luIHx8IHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2ICYmIHRoaXMuaXNDb250ZXh0dWFsKFwib2ZcIikpIHtcbiAgICB0aGlzLnRvQXNzaWduYWJsZShpbml0KTtcbiAgICB0aGlzLmNoZWNrTFZhbChpbml0KTtcbiAgICByZXR1cm4gdGhpcy5wYXJzZUZvckluKG5vZGUsIGluaXQpO1xuICB9IGVsc2UgaWYgKHJlZlNob3J0aGFuZERlZmF1bHRQb3Muc3RhcnQpIHtcbiAgICB0aGlzLnVuZXhwZWN0ZWQocmVmU2hvcnRoYW5kRGVmYXVsdFBvcy5zdGFydCk7XG4gIH1cbiAgcmV0dXJuIHRoaXMucGFyc2VGb3Iobm9kZSwgaW5pdCk7XG59O1xuXG5wcC5wYXJzZUZ1bmN0aW9uU3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUpIHtcbiAgdGhpcy5uZXh0KCk7XG4gIHJldHVybiB0aGlzLnBhcnNlRnVuY3Rpb24obm9kZSwgdHJ1ZSk7XG59O1xuXG5wcC5wYXJzZUlmU3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUpIHtcbiAgdGhpcy5uZXh0KCk7XG4gIG5vZGUudGVzdCA9IHRoaXMucGFyc2VQYXJlbkV4cHJlc3Npb24oKTtcbiAgbm9kZS5jb25zZXF1ZW50ID0gdGhpcy5wYXJzZVN0YXRlbWVudChmYWxzZSk7XG4gIG5vZGUuYWx0ZXJuYXRlID0gdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5fZWxzZSkgPyB0aGlzLnBhcnNlU3RhdGVtZW50KGZhbHNlKSA6IG51bGw7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJJZlN0YXRlbWVudFwiKTtcbn07XG5cbnBwLnBhcnNlUmV0dXJuU3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUpIHtcbiAgaWYgKCF0aGlzLmluRnVuY3Rpb24gJiYgIXRoaXMub3B0aW9ucy5hbGxvd1JldHVybk91dHNpZGVGdW5jdGlvbikgdGhpcy5yYWlzZSh0aGlzLnN0YXJ0LCBcIidyZXR1cm4nIG91dHNpZGUgb2YgZnVuY3Rpb25cIik7XG4gIHRoaXMubmV4dCgpO1xuXG4gIC8vIEluIGByZXR1cm5gIChhbmQgYGJyZWFrYC9gY29udGludWVgKSwgdGhlIGtleXdvcmRzIHdpdGhcbiAgLy8gb3B0aW9uYWwgYXJndW1lbnRzLCB3ZSBlYWdlcmx5IGxvb2sgZm9yIGEgc2VtaWNvbG9uIG9yIHRoZVxuICAvLyBwb3NzaWJpbGl0eSB0byBpbnNlcnQgb25lLlxuXG4gIGlmICh0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLnNlbWkpIHx8IHRoaXMuaW5zZXJ0U2VtaWNvbG9uKCkpIG5vZGUuYXJndW1lbnQgPSBudWxsO2Vsc2Uge1xuICAgIG5vZGUuYXJndW1lbnQgPSB0aGlzLnBhcnNlRXhwcmVzc2lvbigpO3RoaXMuc2VtaWNvbG9uKCk7XG4gIH1cbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIlJldHVyblN0YXRlbWVudFwiKTtcbn07XG5cbnBwLnBhcnNlU3dpdGNoU3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUpIHtcbiAgdGhpcy5uZXh0KCk7XG4gIG5vZGUuZGlzY3JpbWluYW50ID0gdGhpcy5wYXJzZVBhcmVuRXhwcmVzc2lvbigpO1xuICBub2RlLmNhc2VzID0gW107XG4gIHRoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMuYnJhY2VMKTtcbiAgdGhpcy5sYWJlbHMucHVzaChzd2l0Y2hMYWJlbCk7XG5cbiAgLy8gU3RhdGVtZW50cyB1bmRlciBtdXN0IGJlIGdyb3VwZWQgKGJ5IGxhYmVsKSBpbiBTd2l0Y2hDYXNlXG4gIC8vIG5vZGVzLiBgY3VyYCBpcyB1c2VkIHRvIGtlZXAgdGhlIG5vZGUgdGhhdCB3ZSBhcmUgY3VycmVudGx5XG4gIC8vIGFkZGluZyBzdGF0ZW1lbnRzIHRvLlxuXG4gIGZvciAodmFyIGN1ciwgc2F3RGVmYXVsdCA9IGZhbHNlOyB0aGlzLnR5cGUgIT0gX3Rva2VudHlwZS50eXBlcy5icmFjZVI7KSB7XG4gICAgaWYgKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fY2FzZSB8fCB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2RlZmF1bHQpIHtcbiAgICAgIHZhciBpc0Nhc2UgPSB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2Nhc2U7XG4gICAgICBpZiAoY3VyKSB0aGlzLmZpbmlzaE5vZGUoY3VyLCBcIlN3aXRjaENhc2VcIik7XG4gICAgICBub2RlLmNhc2VzLnB1c2goY3VyID0gdGhpcy5zdGFydE5vZGUoKSk7XG4gICAgICBjdXIuY29uc2VxdWVudCA9IFtdO1xuICAgICAgdGhpcy5uZXh0KCk7XG4gICAgICBpZiAoaXNDYXNlKSB7XG4gICAgICAgIGN1ci50ZXN0ID0gdGhpcy5wYXJzZUV4cHJlc3Npb24oKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGlmIChzYXdEZWZhdWx0KSB0aGlzLnJhaXNlKHRoaXMubGFzdFRva1N0YXJ0LCBcIk11bHRpcGxlIGRlZmF1bHQgY2xhdXNlc1wiKTtcbiAgICAgICAgc2F3RGVmYXVsdCA9IHRydWU7XG4gICAgICAgIGN1ci50ZXN0ID0gbnVsbDtcbiAgICAgIH1cbiAgICAgIHRoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMuY29sb24pO1xuICAgIH0gZWxzZSB7XG4gICAgICBpZiAoIWN1cikgdGhpcy51bmV4cGVjdGVkKCk7XG4gICAgICBjdXIuY29uc2VxdWVudC5wdXNoKHRoaXMucGFyc2VTdGF0ZW1lbnQodHJ1ZSkpO1xuICAgIH1cbiAgfVxuICBpZiAoY3VyKSB0aGlzLmZpbmlzaE5vZGUoY3VyLCBcIlN3aXRjaENhc2VcIik7XG4gIHRoaXMubmV4dCgpOyAvLyBDbG9zaW5nIGJyYWNlXG4gIHRoaXMubGFiZWxzLnBvcCgpO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiU3dpdGNoU3RhdGVtZW50XCIpO1xufTtcblxucHAucGFyc2VUaHJvd1N0YXRlbWVudCA9IGZ1bmN0aW9uIChub2RlKSB7XG4gIHRoaXMubmV4dCgpO1xuICBpZiAoX3doaXRlc3BhY2UubGluZUJyZWFrLnRlc3QodGhpcy5pbnB1dC5zbGljZSh0aGlzLmxhc3RUb2tFbmQsIHRoaXMuc3RhcnQpKSkgdGhpcy5yYWlzZSh0aGlzLmxhc3RUb2tFbmQsIFwiSWxsZWdhbCBuZXdsaW5lIGFmdGVyIHRocm93XCIpO1xuICBub2RlLmFyZ3VtZW50ID0gdGhpcy5wYXJzZUV4cHJlc3Npb24oKTtcbiAgdGhpcy5zZW1pY29sb24oKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIlRocm93U3RhdGVtZW50XCIpO1xufTtcblxuLy8gUmV1c2VkIGVtcHR5IGFycmF5IGFkZGVkIGZvciBub2RlIGZpZWxkcyB0aGF0IGFyZSBhbHdheXMgZW1wdHkuXG5cbnZhciBlbXB0eSA9IFtdO1xuXG5wcC5wYXJzZVRyeVN0YXRlbWVudCA9IGZ1bmN0aW9uIChub2RlKSB7XG4gIHRoaXMubmV4dCgpO1xuICBub2RlLmJsb2NrID0gdGhpcy5wYXJzZUJsb2NrKCk7XG4gIG5vZGUuaGFuZGxlciA9IG51bGw7XG4gIGlmICh0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2NhdGNoKSB7XG4gICAgdmFyIGNsYXVzZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gICAgdGhpcy5uZXh0KCk7XG4gICAgdGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5wYXJlbkwpO1xuICAgIGNsYXVzZS5wYXJhbSA9IHRoaXMucGFyc2VCaW5kaW5nQXRvbSgpO1xuICAgIHRoaXMuY2hlY2tMVmFsKGNsYXVzZS5wYXJhbSwgdHJ1ZSk7XG4gICAgdGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5wYXJlblIpO1xuICAgIGNsYXVzZS5ndWFyZCA9IG51bGw7XG4gICAgY2xhdXNlLmJvZHkgPSB0aGlzLnBhcnNlQmxvY2soKTtcbiAgICBub2RlLmhhbmRsZXIgPSB0aGlzLmZpbmlzaE5vZGUoY2xhdXNlLCBcIkNhdGNoQ2xhdXNlXCIpO1xuICB9XG4gIG5vZGUuZ3VhcmRlZEhhbmRsZXJzID0gZW1wdHk7XG4gIG5vZGUuZmluYWxpemVyID0gdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5fZmluYWxseSkgPyB0aGlzLnBhcnNlQmxvY2soKSA6IG51bGw7XG4gIGlmICghbm9kZS5oYW5kbGVyICYmICFub2RlLmZpbmFsaXplcikgdGhpcy5yYWlzZShub2RlLnN0YXJ0LCBcIk1pc3NpbmcgY2F0Y2ggb3IgZmluYWxseSBjbGF1c2VcIik7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJUcnlTdGF0ZW1lbnRcIik7XG59O1xuXG5wcC5wYXJzZVZhclN0YXRlbWVudCA9IGZ1bmN0aW9uIChub2RlLCBraW5kKSB7XG4gIHRoaXMubmV4dCgpO1xuICB0aGlzLnBhcnNlVmFyKG5vZGUsIGZhbHNlLCBraW5kKTtcbiAgdGhpcy5zZW1pY29sb24oKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIlZhcmlhYmxlRGVjbGFyYXRpb25cIik7XG59O1xuXG5wcC5wYXJzZVdoaWxlU3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUpIHtcbiAgdGhpcy5uZXh0KCk7XG4gIG5vZGUudGVzdCA9IHRoaXMucGFyc2VQYXJlbkV4cHJlc3Npb24oKTtcbiAgdGhpcy5sYWJlbHMucHVzaChsb29wTGFiZWwpO1xuICBub2RlLmJvZHkgPSB0aGlzLnBhcnNlU3RhdGVtZW50KGZhbHNlKTtcbiAgdGhpcy5sYWJlbHMucG9wKCk7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJXaGlsZVN0YXRlbWVudFwiKTtcbn07XG5cbnBwLnBhcnNlV2l0aFN0YXRlbWVudCA9IGZ1bmN0aW9uIChub2RlKSB7XG4gIGlmICh0aGlzLnN0cmljdCkgdGhpcy5yYWlzZSh0aGlzLnN0YXJ0LCBcIid3aXRoJyBpbiBzdHJpY3QgbW9kZVwiKTtcbiAgdGhpcy5uZXh0KCk7XG4gIG5vZGUub2JqZWN0ID0gdGhpcy5wYXJzZVBhcmVuRXhwcmVzc2lvbigpO1xuICBub2RlLmJvZHkgPSB0aGlzLnBhcnNlU3RhdGVtZW50KGZhbHNlKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIldpdGhTdGF0ZW1lbnRcIik7XG59O1xuXG5wcC5wYXJzZUVtcHR5U3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUpIHtcbiAgdGhpcy5uZXh0KCk7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJFbXB0eVN0YXRlbWVudFwiKTtcbn07XG5cbnBwLnBhcnNlTGFiZWxlZFN0YXRlbWVudCA9IGZ1bmN0aW9uIChub2RlLCBtYXliZU5hbWUsIGV4cHIpIHtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCB0aGlzLmxhYmVscy5sZW5ndGg7ICsraSkge1xuICAgIGlmICh0aGlzLmxhYmVsc1tpXS5uYW1lID09PSBtYXliZU5hbWUpIHRoaXMucmFpc2UoZXhwci5zdGFydCwgXCJMYWJlbCAnXCIgKyBtYXliZU5hbWUgKyBcIicgaXMgYWxyZWFkeSBkZWNsYXJlZFwiKTtcbiAgfXZhciBraW5kID0gdGhpcy50eXBlLmlzTG9vcCA/IFwibG9vcFwiIDogdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9zd2l0Y2ggPyBcInN3aXRjaFwiIDogbnVsbDtcbiAgZm9yICh2YXIgaSA9IHRoaXMubGFiZWxzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgdmFyIGxhYmVsID0gdGhpcy5sYWJlbHNbaV07XG4gICAgaWYgKGxhYmVsLnN0YXRlbWVudFN0YXJ0ID09IG5vZGUuc3RhcnQpIHtcbiAgICAgIGxhYmVsLnN0YXRlbWVudFN0YXJ0ID0gdGhpcy5zdGFydDtcbiAgICAgIGxhYmVsLmtpbmQgPSBraW5kO1xuICAgIH0gZWxzZSBicmVhaztcbiAgfVxuICB0aGlzLmxhYmVscy5wdXNoKHsgbmFtZTogbWF5YmVOYW1lLCBraW5kOiBraW5kLCBzdGF0ZW1lbnRTdGFydDogdGhpcy5zdGFydCB9KTtcbiAgbm9kZS5ib2R5ID0gdGhpcy5wYXJzZVN0YXRlbWVudCh0cnVlKTtcbiAgdGhpcy5sYWJlbHMucG9wKCk7XG4gIG5vZGUubGFiZWwgPSBleHByO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiTGFiZWxlZFN0YXRlbWVudFwiKTtcbn07XG5cbnBwLnBhcnNlRXhwcmVzc2lvblN0YXRlbWVudCA9IGZ1bmN0aW9uIChub2RlLCBleHByKSB7XG4gIG5vZGUuZXhwcmVzc2lvbiA9IGV4cHI7XG4gIHRoaXMuc2VtaWNvbG9uKCk7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJFeHByZXNzaW9uU3RhdGVtZW50XCIpO1xufTtcblxuLy8gUGFyc2UgYSBzZW1pY29sb24tZW5jbG9zZWQgYmxvY2sgb2Ygc3RhdGVtZW50cywgaGFuZGxpbmcgYFwidXNlXG4vLyBzdHJpY3RcImAgZGVjbGFyYXRpb25zIHdoZW4gYGFsbG93U3RyaWN0YCBpcyB0cnVlICh1c2VkIGZvclxuLy8gZnVuY3Rpb24gYm9kaWVzKS5cblxucHAucGFyc2VCbG9jayA9IGZ1bmN0aW9uIChhbGxvd1N0cmljdCkge1xuICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCksXG4gICAgICBmaXJzdCA9IHRydWUsXG4gICAgICBvbGRTdHJpY3QgPSB1bmRlZmluZWQ7XG4gIG5vZGUuYm9keSA9IFtdO1xuICB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmJyYWNlTCk7XG4gIHdoaWxlICghdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5icmFjZVIpKSB7XG4gICAgdmFyIHN0bXQgPSB0aGlzLnBhcnNlU3RhdGVtZW50KHRydWUpO1xuICAgIG5vZGUuYm9keS5wdXNoKHN0bXQpO1xuICAgIGlmIChmaXJzdCAmJiBhbGxvd1N0cmljdCAmJiB0aGlzLmlzVXNlU3RyaWN0KHN0bXQpKSB7XG4gICAgICBvbGRTdHJpY3QgPSB0aGlzLnN0cmljdDtcbiAgICAgIHRoaXMuc2V0U3RyaWN0KHRoaXMuc3RyaWN0ID0gdHJ1ZSk7XG4gICAgfVxuICAgIGZpcnN0ID0gZmFsc2U7XG4gIH1cbiAgaWYgKG9sZFN0cmljdCA9PT0gZmFsc2UpIHRoaXMuc2V0U3RyaWN0KGZhbHNlKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkJsb2NrU3RhdGVtZW50XCIpO1xufTtcblxuLy8gUGFyc2UgYSByZWd1bGFyIGBmb3JgIGxvb3AuIFRoZSBkaXNhbWJpZ3VhdGlvbiBjb2RlIGluXG4vLyBgcGFyc2VTdGF0ZW1lbnRgIHdpbGwgYWxyZWFkeSBoYXZlIHBhcnNlZCB0aGUgaW5pdCBzdGF0ZW1lbnQgb3Jcbi8vIGV4cHJlc3Npb24uXG5cbnBwLnBhcnNlRm9yID0gZnVuY3Rpb24gKG5vZGUsIGluaXQpIHtcbiAgbm9kZS5pbml0ID0gaW5pdDtcbiAgdGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5zZW1pKTtcbiAgbm9kZS50ZXN0ID0gdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLnNlbWkgPyBudWxsIDogdGhpcy5wYXJzZUV4cHJlc3Npb24oKTtcbiAgdGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5zZW1pKTtcbiAgbm9kZS51cGRhdGUgPSB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMucGFyZW5SID8gbnVsbCA6IHRoaXMucGFyc2VFeHByZXNzaW9uKCk7XG4gIHRoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMucGFyZW5SKTtcbiAgbm9kZS5ib2R5ID0gdGhpcy5wYXJzZVN0YXRlbWVudChmYWxzZSk7XG4gIHRoaXMubGFiZWxzLnBvcCgpO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiRm9yU3RhdGVtZW50XCIpO1xufTtcblxuLy8gUGFyc2UgYSBgZm9yYC9gaW5gIGFuZCBgZm9yYC9gb2ZgIGxvb3AsIHdoaWNoIGFyZSBhbG1vc3Rcbi8vIHNhbWUgZnJvbSBwYXJzZXIncyBwZXJzcGVjdGl2ZS5cblxucHAucGFyc2VGb3JJbiA9IGZ1bmN0aW9uIChub2RlLCBpbml0KSB7XG4gIHZhciB0eXBlID0gdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9pbiA/IFwiRm9ySW5TdGF0ZW1lbnRcIiA6IFwiRm9yT2ZTdGF0ZW1lbnRcIjtcbiAgdGhpcy5uZXh0KCk7XG4gIG5vZGUubGVmdCA9IGluaXQ7XG4gIG5vZGUucmlnaHQgPSB0aGlzLnBhcnNlRXhwcmVzc2lvbigpO1xuICB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLnBhcmVuUik7XG4gIG5vZGUuYm9keSA9IHRoaXMucGFyc2VTdGF0ZW1lbnQoZmFsc2UpO1xuICB0aGlzLmxhYmVscy5wb3AoKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCB0eXBlKTtcbn07XG5cbi8vIFBhcnNlIGEgbGlzdCBvZiB2YXJpYWJsZSBkZWNsYXJhdGlvbnMuXG5cbnBwLnBhcnNlVmFyID0gZnVuY3Rpb24gKG5vZGUsIGlzRm9yLCBraW5kKSB7XG4gIG5vZGUuZGVjbGFyYXRpb25zID0gW107XG4gIG5vZGUua2luZCA9IGtpbmQua2V5d29yZDtcbiAgZm9yICg7Oykge1xuICAgIHZhciBkZWNsID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgICB0aGlzLnBhcnNlVmFySWQoZGVjbCk7XG4gICAgaWYgKHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuZXEpKSB7XG4gICAgICBkZWNsLmluaXQgPSB0aGlzLnBhcnNlTWF5YmVBc3NpZ24oaXNGb3IpO1xuICAgIH0gZWxzZSBpZiAoa2luZCA9PT0gX3Rva2VudHlwZS50eXBlcy5fY29uc3QgJiYgISh0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2luIHx8IHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2ICYmIHRoaXMuaXNDb250ZXh0dWFsKFwib2ZcIikpKSB7XG4gICAgICB0aGlzLnVuZXhwZWN0ZWQoKTtcbiAgICB9IGVsc2UgaWYgKGRlY2wuaWQudHlwZSAhPSBcIklkZW50aWZpZXJcIiAmJiAhKGlzRm9yICYmICh0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2luIHx8IHRoaXMuaXNDb250ZXh0dWFsKFwib2ZcIikpKSkge1xuICAgICAgdGhpcy5yYWlzZSh0aGlzLmxhc3RUb2tFbmQsIFwiQ29tcGxleCBiaW5kaW5nIHBhdHRlcm5zIHJlcXVpcmUgYW4gaW5pdGlhbGl6YXRpb24gdmFsdWVcIik7XG4gICAgfSBlbHNlIHtcbiAgICAgIGRlY2wuaW5pdCA9IG51bGw7XG4gICAgfVxuICAgIG5vZGUuZGVjbGFyYXRpb25zLnB1c2godGhpcy5maW5pc2hOb2RlKGRlY2wsIFwiVmFyaWFibGVEZWNsYXJhdG9yXCIpKTtcbiAgICBpZiAoIXRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuY29tbWEpKSBicmVhaztcbiAgfVxuICByZXR1cm4gbm9kZTtcbn07XG5cbnBwLnBhcnNlVmFySWQgPSBmdW5jdGlvbiAoZGVjbCkge1xuICBkZWNsLmlkID0gdGhpcy5wYXJzZUJpbmRpbmdBdG9tKCk7XG4gIHRoaXMuY2hlY2tMVmFsKGRlY2wuaWQsIHRydWUpO1xufTtcblxuLy8gUGFyc2UgYSBmdW5jdGlvbiBkZWNsYXJhdGlvbiBvciBsaXRlcmFsIChkZXBlbmRpbmcgb24gdGhlXG4vLyBgaXNTdGF0ZW1lbnRgIHBhcmFtZXRlcikuXG5cbnBwLnBhcnNlRnVuY3Rpb24gPSBmdW5jdGlvbiAobm9kZSwgaXNTdGF0ZW1lbnQsIGFsbG93RXhwcmVzc2lvbkJvZHkpIHtcbiAgdGhpcy5pbml0RnVuY3Rpb24obm9kZSk7XG4gIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNikgbm9kZS5nZW5lcmF0b3IgPSB0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLnN0YXIpO1xuICBpZiAoaXNTdGF0ZW1lbnQgfHwgdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLm5hbWUpIG5vZGUuaWQgPSB0aGlzLnBhcnNlSWRlbnQoKTtcbiAgdGhpcy5wYXJzZUZ1bmN0aW9uUGFyYW1zKG5vZGUpO1xuICB0aGlzLnBhcnNlRnVuY3Rpb25Cb2R5KG5vZGUsIGFsbG93RXhwcmVzc2lvbkJvZHkpO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIGlzU3RhdGVtZW50ID8gXCJGdW5jdGlvbkRlY2xhcmF0aW9uXCIgOiBcIkZ1bmN0aW9uRXhwcmVzc2lvblwiKTtcbn07XG5cbnBwLnBhcnNlRnVuY3Rpb25QYXJhbXMgPSBmdW5jdGlvbiAobm9kZSkge1xuICB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLnBhcmVuTCk7XG4gIG5vZGUucGFyYW1zID0gdGhpcy5wYXJzZUJpbmRpbmdMaXN0KF90b2tlbnR5cGUudHlwZXMucGFyZW5SLCBmYWxzZSwgZmFsc2UpO1xufTtcblxuLy8gUGFyc2UgYSBjbGFzcyBkZWNsYXJhdGlvbiBvciBsaXRlcmFsIChkZXBlbmRpbmcgb24gdGhlXG4vLyBgaXNTdGF0ZW1lbnRgIHBhcmFtZXRlcikuXG5cbnBwLnBhcnNlQ2xhc3MgPSBmdW5jdGlvbiAobm9kZSwgaXNTdGF0ZW1lbnQpIHtcbiAgdGhpcy5uZXh0KCk7XG4gIHRoaXMucGFyc2VDbGFzc0lkKG5vZGUsIGlzU3RhdGVtZW50KTtcbiAgdGhpcy5wYXJzZUNsYXNzU3VwZXIobm9kZSk7XG4gIHZhciBjbGFzc0JvZHkgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICB2YXIgaGFkQ29uc3RydWN0b3IgPSBmYWxzZTtcbiAgY2xhc3NCb2R5LmJvZHkgPSBbXTtcbiAgdGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5icmFjZUwpO1xuICB3aGlsZSAoIXRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuYnJhY2VSKSkge1xuICAgIGlmICh0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLnNlbWkpKSBjb250aW51ZTtcbiAgICB2YXIgbWV0aG9kID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgICB2YXIgaXNHZW5lcmF0b3IgPSB0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLnN0YXIpO1xuICAgIHZhciBpc01heWJlU3RhdGljID0gdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLm5hbWUgJiYgdGhpcy52YWx1ZSA9PT0gXCJzdGF0aWNcIjtcbiAgICB0aGlzLnBhcnNlUHJvcGVydHlOYW1lKG1ldGhvZCk7XG4gICAgbWV0aG9kW1wic3RhdGljXCJdID0gaXNNYXliZVN0YXRpYyAmJiB0aGlzLnR5cGUgIT09IF90b2tlbnR5cGUudHlwZXMucGFyZW5MO1xuICAgIGlmIChtZXRob2RbXCJzdGF0aWNcIl0pIHtcbiAgICAgIGlmIChpc0dlbmVyYXRvcikgdGhpcy51bmV4cGVjdGVkKCk7XG4gICAgICBpc0dlbmVyYXRvciA9IHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuc3Rhcik7XG4gICAgICB0aGlzLnBhcnNlUHJvcGVydHlOYW1lKG1ldGhvZCk7XG4gICAgfVxuICAgIG1ldGhvZC5raW5kID0gXCJtZXRob2RcIjtcbiAgICB2YXIgaXNHZXRTZXQgPSBmYWxzZTtcbiAgICBpZiAoIW1ldGhvZC5jb21wdXRlZCkge1xuICAgICAgdmFyIGtleSA9IG1ldGhvZC5rZXk7XG5cbiAgICAgIGlmICghaXNHZW5lcmF0b3IgJiYga2V5LnR5cGUgPT09IFwiSWRlbnRpZmllclwiICYmIHRoaXMudHlwZSAhPT0gX3Rva2VudHlwZS50eXBlcy5wYXJlbkwgJiYgKGtleS5uYW1lID09PSBcImdldFwiIHx8IGtleS5uYW1lID09PSBcInNldFwiKSkge1xuICAgICAgICBpc0dldFNldCA9IHRydWU7XG4gICAgICAgIG1ldGhvZC5raW5kID0ga2V5Lm5hbWU7XG4gICAgICAgIGtleSA9IHRoaXMucGFyc2VQcm9wZXJ0eU5hbWUobWV0aG9kKTtcbiAgICAgIH1cbiAgICAgIGlmICghbWV0aG9kW1wic3RhdGljXCJdICYmIChrZXkudHlwZSA9PT0gXCJJZGVudGlmaWVyXCIgJiYga2V5Lm5hbWUgPT09IFwiY29uc3RydWN0b3JcIiB8fCBrZXkudHlwZSA9PT0gXCJMaXRlcmFsXCIgJiYga2V5LnZhbHVlID09PSBcImNvbnN0cnVjdG9yXCIpKSB7XG4gICAgICAgIGlmIChoYWRDb25zdHJ1Y3RvcikgdGhpcy5yYWlzZShrZXkuc3RhcnQsIFwiRHVwbGljYXRlIGNvbnN0cnVjdG9yIGluIHRoZSBzYW1lIGNsYXNzXCIpO1xuICAgICAgICBpZiAoaXNHZXRTZXQpIHRoaXMucmFpc2Uoa2V5LnN0YXJ0LCBcIkNvbnN0cnVjdG9yIGNhbid0IGhhdmUgZ2V0L3NldCBtb2RpZmllclwiKTtcbiAgICAgICAgaWYgKGlzR2VuZXJhdG9yKSB0aGlzLnJhaXNlKGtleS5zdGFydCwgXCJDb25zdHJ1Y3RvciBjYW4ndCBiZSBhIGdlbmVyYXRvclwiKTtcbiAgICAgICAgbWV0aG9kLmtpbmQgPSBcImNvbnN0cnVjdG9yXCI7XG4gICAgICAgIGhhZENvbnN0cnVjdG9yID0gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG4gICAgdGhpcy5wYXJzZUNsYXNzTWV0aG9kKGNsYXNzQm9keSwgbWV0aG9kLCBpc0dlbmVyYXRvcik7XG4gICAgaWYgKGlzR2V0U2V0KSB7XG4gICAgICB2YXIgcGFyYW1Db3VudCA9IG1ldGhvZC5raW5kID09PSBcImdldFwiID8gMCA6IDE7XG4gICAgICBpZiAobWV0aG9kLnZhbHVlLnBhcmFtcy5sZW5ndGggIT09IHBhcmFtQ291bnQpIHtcbiAgICAgICAgdmFyIHN0YXJ0ID0gbWV0aG9kLnZhbHVlLnN0YXJ0O1xuICAgICAgICBpZiAobWV0aG9kLmtpbmQgPT09IFwiZ2V0XCIpIHRoaXMucmFpc2Uoc3RhcnQsIFwiZ2V0dGVyIHNob3VsZCBoYXZlIG5vIHBhcmFtc1wiKTtlbHNlIHRoaXMucmFpc2Uoc3RhcnQsIFwic2V0dGVyIHNob3VsZCBoYXZlIGV4YWN0bHkgb25lIHBhcmFtXCIpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuICBub2RlLmJvZHkgPSB0aGlzLmZpbmlzaE5vZGUoY2xhc3NCb2R5LCBcIkNsYXNzQm9keVwiKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBpc1N0YXRlbWVudCA/IFwiQ2xhc3NEZWNsYXJhdGlvblwiIDogXCJDbGFzc0V4cHJlc3Npb25cIik7XG59O1xuXG5wcC5wYXJzZUNsYXNzTWV0aG9kID0gZnVuY3Rpb24gKGNsYXNzQm9keSwgbWV0aG9kLCBpc0dlbmVyYXRvcikge1xuICBtZXRob2QudmFsdWUgPSB0aGlzLnBhcnNlTWV0aG9kKGlzR2VuZXJhdG9yKTtcbiAgY2xhc3NCb2R5LmJvZHkucHVzaCh0aGlzLmZpbmlzaE5vZGUobWV0aG9kLCBcIk1ldGhvZERlZmluaXRpb25cIikpO1xufTtcblxucHAucGFyc2VDbGFzc0lkID0gZnVuY3Rpb24gKG5vZGUsIGlzU3RhdGVtZW50KSB7XG4gIG5vZGUuaWQgPSB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMubmFtZSA/IHRoaXMucGFyc2VJZGVudCgpIDogaXNTdGF0ZW1lbnQgPyB0aGlzLnVuZXhwZWN0ZWQoKSA6IG51bGw7XG59O1xuXG5wcC5wYXJzZUNsYXNzU3VwZXIgPSBmdW5jdGlvbiAobm9kZSkge1xuICBub2RlLnN1cGVyQ2xhc3MgPSB0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLl9leHRlbmRzKSA/IHRoaXMucGFyc2VFeHByU3Vic2NyaXB0cygpIDogbnVsbDtcbn07XG5cbi8vIFBhcnNlcyBtb2R1bGUgZXhwb3J0IGRlY2xhcmF0aW9uLlxuXG5wcC5wYXJzZUV4cG9ydCA9IGZ1bmN0aW9uIChub2RlKSB7XG4gIHRoaXMubmV4dCgpO1xuICAvLyBleHBvcnQgKiBmcm9tICcuLi4nXG4gIGlmICh0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLnN0YXIpKSB7XG4gICAgdGhpcy5leHBlY3RDb250ZXh0dWFsKFwiZnJvbVwiKTtcbiAgICBub2RlLnNvdXJjZSA9IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5zdHJpbmcgPyB0aGlzLnBhcnNlRXhwckF0b20oKSA6IHRoaXMudW5leHBlY3RlZCgpO1xuICAgIHRoaXMuc2VtaWNvbG9uKCk7XG4gICAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkV4cG9ydEFsbERlY2xhcmF0aW9uXCIpO1xuICB9XG4gIGlmICh0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLl9kZWZhdWx0KSkge1xuICAgIC8vIGV4cG9ydCBkZWZhdWx0IC4uLlxuICAgIHZhciBleHByID0gdGhpcy5wYXJzZU1heWJlQXNzaWduKCk7XG4gICAgdmFyIG5lZWRzU2VtaSA9IHRydWU7XG4gICAgaWYgKGV4cHIudHlwZSA9PSBcIkZ1bmN0aW9uRXhwcmVzc2lvblwiIHx8IGV4cHIudHlwZSA9PSBcIkNsYXNzRXhwcmVzc2lvblwiKSB7XG4gICAgICBuZWVkc1NlbWkgPSBmYWxzZTtcbiAgICAgIGlmIChleHByLmlkKSB7XG4gICAgICAgIGV4cHIudHlwZSA9IGV4cHIudHlwZSA9PSBcIkZ1bmN0aW9uRXhwcmVzc2lvblwiID8gXCJGdW5jdGlvbkRlY2xhcmF0aW9uXCIgOiBcIkNsYXNzRGVjbGFyYXRpb25cIjtcbiAgICAgIH1cbiAgICB9XG4gICAgbm9kZS5kZWNsYXJhdGlvbiA9IGV4cHI7XG4gICAgaWYgKG5lZWRzU2VtaSkgdGhpcy5zZW1pY29sb24oKTtcbiAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiRXhwb3J0RGVmYXVsdERlY2xhcmF0aW9uXCIpO1xuICB9XG4gIC8vIGV4cG9ydCB2YXJ8Y29uc3R8bGV0fGZ1bmN0aW9ufGNsYXNzIC4uLlxuICBpZiAodGhpcy5zaG91bGRQYXJzZUV4cG9ydFN0YXRlbWVudCgpKSB7XG4gICAgbm9kZS5kZWNsYXJhdGlvbiA9IHRoaXMucGFyc2VTdGF0ZW1lbnQodHJ1ZSk7XG4gICAgbm9kZS5zcGVjaWZpZXJzID0gW107XG4gICAgbm9kZS5zb3VyY2UgPSBudWxsO1xuICB9IGVsc2Uge1xuICAgIC8vIGV4cG9ydCB7IHgsIHkgYXMgeiB9IFtmcm9tICcuLi4nXVxuICAgIG5vZGUuZGVjbGFyYXRpb24gPSBudWxsO1xuICAgIG5vZGUuc3BlY2lmaWVycyA9IHRoaXMucGFyc2VFeHBvcnRTcGVjaWZpZXJzKCk7XG4gICAgaWYgKHRoaXMuZWF0Q29udGV4dHVhbChcImZyb21cIikpIHtcbiAgICAgIG5vZGUuc291cmNlID0gdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLnN0cmluZyA/IHRoaXMucGFyc2VFeHByQXRvbSgpIDogdGhpcy51bmV4cGVjdGVkKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG5vZGUuc291cmNlID0gbnVsbDtcbiAgICB9XG4gICAgdGhpcy5zZW1pY29sb24oKTtcbiAgfVxuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiRXhwb3J0TmFtZWREZWNsYXJhdGlvblwiKTtcbn07XG5cbnBwLnNob3VsZFBhcnNlRXhwb3J0U3RhdGVtZW50ID0gZnVuY3Rpb24gKCkge1xuICByZXR1cm4gdGhpcy50eXBlLmtleXdvcmQ7XG59O1xuXG4vLyBQYXJzZXMgYSBjb21tYS1zZXBhcmF0ZWQgbGlzdCBvZiBtb2R1bGUgZXhwb3J0cy5cblxucHAucGFyc2VFeHBvcnRTcGVjaWZpZXJzID0gZnVuY3Rpb24gKCkge1xuICB2YXIgbm9kZXMgPSBbXSxcbiAgICAgIGZpcnN0ID0gdHJ1ZTtcbiAgLy8gZXhwb3J0IHsgeCwgeSBhcyB6IH0gW2Zyb20gJy4uLiddXG4gIHRoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMuYnJhY2VMKTtcbiAgd2hpbGUgKCF0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLmJyYWNlUikpIHtcbiAgICBpZiAoIWZpcnN0KSB7XG4gICAgICB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmNvbW1hKTtcbiAgICAgIGlmICh0aGlzLmFmdGVyVHJhaWxpbmdDb21tYShfdG9rZW50eXBlLnR5cGVzLmJyYWNlUikpIGJyZWFrO1xuICAgIH0gZWxzZSBmaXJzdCA9IGZhbHNlO1xuXG4gICAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICAgIG5vZGUubG9jYWwgPSB0aGlzLnBhcnNlSWRlbnQodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9kZWZhdWx0KTtcbiAgICBub2RlLmV4cG9ydGVkID0gdGhpcy5lYXRDb250ZXh0dWFsKFwiYXNcIikgPyB0aGlzLnBhcnNlSWRlbnQodHJ1ZSkgOiBub2RlLmxvY2FsO1xuICAgIG5vZGVzLnB1c2godGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiRXhwb3J0U3BlY2lmaWVyXCIpKTtcbiAgfVxuICByZXR1cm4gbm9kZXM7XG59O1xuXG4vLyBQYXJzZXMgaW1wb3J0IGRlY2xhcmF0aW9uLlxuXG5wcC5wYXJzZUltcG9ydCA9IGZ1bmN0aW9uIChub2RlKSB7XG4gIHRoaXMubmV4dCgpO1xuICAvLyBpbXBvcnQgJy4uLidcbiAgaWYgKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5zdHJpbmcpIHtcbiAgICBub2RlLnNwZWNpZmllcnMgPSBlbXB0eTtcbiAgICBub2RlLnNvdXJjZSA9IHRoaXMucGFyc2VFeHByQXRvbSgpO1xuICB9IGVsc2Uge1xuICAgIG5vZGUuc3BlY2lmaWVycyA9IHRoaXMucGFyc2VJbXBvcnRTcGVjaWZpZXJzKCk7XG4gICAgdGhpcy5leHBlY3RDb250ZXh0dWFsKFwiZnJvbVwiKTtcbiAgICBub2RlLnNvdXJjZSA9IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5zdHJpbmcgPyB0aGlzLnBhcnNlRXhwckF0b20oKSA6IHRoaXMudW5leHBlY3RlZCgpO1xuICB9XG4gIHRoaXMuc2VtaWNvbG9uKCk7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJJbXBvcnREZWNsYXJhdGlvblwiKTtcbn07XG5cbi8vIFBhcnNlcyBhIGNvbW1hLXNlcGFyYXRlZCBsaXN0IG9mIG1vZHVsZSBpbXBvcnRzLlxuXG5wcC5wYXJzZUltcG9ydFNwZWNpZmllcnMgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBub2RlcyA9IFtdLFxuICAgICAgZmlyc3QgPSB0cnVlO1xuICBpZiAodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLm5hbWUpIHtcbiAgICAvLyBpbXBvcnQgZGVmYXVsdE9iaiwgeyB4LCB5IGFzIHogfSBmcm9tICcuLi4nXG4gICAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICAgIG5vZGUubG9jYWwgPSB0aGlzLnBhcnNlSWRlbnQoKTtcbiAgICB0aGlzLmNoZWNrTFZhbChub2RlLmxvY2FsLCB0cnVlKTtcbiAgICBub2Rlcy5wdXNoKHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkltcG9ydERlZmF1bHRTcGVjaWZpZXJcIikpO1xuICAgIGlmICghdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5jb21tYSkpIHJldHVybiBub2RlcztcbiAgfVxuICBpZiAodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLnN0YXIpIHtcbiAgICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gICAgdGhpcy5uZXh0KCk7XG4gICAgdGhpcy5leHBlY3RDb250ZXh0dWFsKFwiYXNcIik7XG4gICAgbm9kZS5sb2NhbCA9IHRoaXMucGFyc2VJZGVudCgpO1xuICAgIHRoaXMuY2hlY2tMVmFsKG5vZGUubG9jYWwsIHRydWUpO1xuICAgIG5vZGVzLnB1c2godGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiSW1wb3J0TmFtZXNwYWNlU3BlY2lmaWVyXCIpKTtcbiAgICByZXR1cm4gbm9kZXM7XG4gIH1cbiAgdGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5icmFjZUwpO1xuICB3aGlsZSAoIXRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuYnJhY2VSKSkge1xuICAgIGlmICghZmlyc3QpIHtcbiAgICAgIHRoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMuY29tbWEpO1xuICAgICAgaWYgKHRoaXMuYWZ0ZXJUcmFpbGluZ0NvbW1hKF90b2tlbnR5cGUudHlwZXMuYnJhY2VSKSkgYnJlYWs7XG4gICAgfSBlbHNlIGZpcnN0ID0gZmFsc2U7XG5cbiAgICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gICAgbm9kZS5pbXBvcnRlZCA9IHRoaXMucGFyc2VJZGVudCh0cnVlKTtcbiAgICBub2RlLmxvY2FsID0gdGhpcy5lYXRDb250ZXh0dWFsKFwiYXNcIikgPyB0aGlzLnBhcnNlSWRlbnQoKSA6IG5vZGUuaW1wb3J0ZWQ7XG4gICAgdGhpcy5jaGVja0xWYWwobm9kZS5sb2NhbCwgdHJ1ZSk7XG4gICAgbm9kZXMucHVzaCh0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJJbXBvcnRTcGVjaWZpZXJcIikpO1xuICB9XG4gIHJldHVybiBub2Rlcztcbn07XG5cbn0se1wiLi9zdGF0ZVwiOjEwLFwiLi90b2tlbnR5cGVcIjoxNCxcIi4vd2hpdGVzcGFjZVwiOjE2fV0sMTI6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1xuLy8gVGhlIGFsZ29yaXRobSB1c2VkIHRvIGRldGVybWluZSB3aGV0aGVyIGEgcmVnZXhwIGNhbiBhcHBlYXIgYXQgYVxuLy8gZ2l2ZW4gcG9pbnQgaW4gdGhlIHByb2dyYW0gaXMgbG9vc2VseSBiYXNlZCBvbiBzd2VldC5qcycgYXBwcm9hY2guXG4vLyBTZWUgaHR0cHM6Ly9naXRodWIuY29tL21vemlsbGEvc3dlZXQuanMvd2lraS9kZXNpZ25cblxuXCJ1c2Ugc3RyaWN0XCI7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5cbmZ1bmN0aW9uIF9jbGFzc0NhbGxDaGVjayhpbnN0YW5jZSwgQ29uc3RydWN0b3IpIHsgaWYgKCEoaW5zdGFuY2UgaW5zdGFuY2VvZiBDb25zdHJ1Y3RvcikpIHsgdGhyb3cgbmV3IFR5cGVFcnJvcihcIkNhbm5vdCBjYWxsIGEgY2xhc3MgYXMgYSBmdW5jdGlvblwiKTsgfSB9XG5cbnZhciBfc3RhdGUgPSBfZGVyZXFfKFwiLi9zdGF0ZVwiKTtcblxudmFyIF90b2tlbnR5cGUgPSBfZGVyZXFfKFwiLi90b2tlbnR5cGVcIik7XG5cbnZhciBfd2hpdGVzcGFjZSA9IF9kZXJlcV8oXCIuL3doaXRlc3BhY2VcIik7XG5cbnZhciBUb2tDb250ZXh0ID0gZnVuY3Rpb24gVG9rQ29udGV4dCh0b2tlbiwgaXNFeHByLCBwcmVzZXJ2ZVNwYWNlLCBvdmVycmlkZSkge1xuICBfY2xhc3NDYWxsQ2hlY2sodGhpcywgVG9rQ29udGV4dCk7XG5cbiAgdGhpcy50b2tlbiA9IHRva2VuO1xuICB0aGlzLmlzRXhwciA9ICEhaXNFeHByO1xuICB0aGlzLnByZXNlcnZlU3BhY2UgPSAhIXByZXNlcnZlU3BhY2U7XG4gIHRoaXMub3ZlcnJpZGUgPSBvdmVycmlkZTtcbn07XG5cbmV4cG9ydHMuVG9rQ29udGV4dCA9IFRva0NvbnRleHQ7XG52YXIgdHlwZXMgPSB7XG4gIGJfc3RhdDogbmV3IFRva0NvbnRleHQoXCJ7XCIsIGZhbHNlKSxcbiAgYl9leHByOiBuZXcgVG9rQ29udGV4dChcIntcIiwgdHJ1ZSksXG4gIGJfdG1wbDogbmV3IFRva0NvbnRleHQoXCIke1wiLCB0cnVlKSxcbiAgcF9zdGF0OiBuZXcgVG9rQ29udGV4dChcIihcIiwgZmFsc2UpLFxuICBwX2V4cHI6IG5ldyBUb2tDb250ZXh0KFwiKFwiLCB0cnVlKSxcbiAgcV90bXBsOiBuZXcgVG9rQ29udGV4dChcImBcIiwgdHJ1ZSwgdHJ1ZSwgZnVuY3Rpb24gKHApIHtcbiAgICByZXR1cm4gcC5yZWFkVG1wbFRva2VuKCk7XG4gIH0pLFxuICBmX2V4cHI6IG5ldyBUb2tDb250ZXh0KFwiZnVuY3Rpb25cIiwgdHJ1ZSlcbn07XG5cbmV4cG9ydHMudHlwZXMgPSB0eXBlcztcbnZhciBwcCA9IF9zdGF0ZS5QYXJzZXIucHJvdG90eXBlO1xuXG5wcC5pbml0aWFsQ29udGV4dCA9IGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIFt0eXBlcy5iX3N0YXRdO1xufTtcblxucHAuYnJhY2VJc0Jsb2NrID0gZnVuY3Rpb24gKHByZXZUeXBlKSB7XG4gIGlmIChwcmV2VHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5jb2xvbikge1xuICAgIHZhciBfcGFyZW50ID0gdGhpcy5jdXJDb250ZXh0KCk7XG4gICAgaWYgKF9wYXJlbnQgPT09IHR5cGVzLmJfc3RhdCB8fCBfcGFyZW50ID09PSB0eXBlcy5iX2V4cHIpIHJldHVybiAhX3BhcmVudC5pc0V4cHI7XG4gIH1cbiAgaWYgKHByZXZUeXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9yZXR1cm4pIHJldHVybiBfd2hpdGVzcGFjZS5saW5lQnJlYWsudGVzdCh0aGlzLmlucHV0LnNsaWNlKHRoaXMubGFzdFRva0VuZCwgdGhpcy5zdGFydCkpO1xuICBpZiAocHJldlR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2Vsc2UgfHwgcHJldlR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuc2VtaSB8fCBwcmV2VHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5lb2YgfHwgcHJldlR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMucGFyZW5SKSByZXR1cm4gdHJ1ZTtcbiAgaWYgKHByZXZUeXBlID09IF90b2tlbnR5cGUudHlwZXMuYnJhY2VMKSByZXR1cm4gdGhpcy5jdXJDb250ZXh0KCkgPT09IHR5cGVzLmJfc3RhdDtcbiAgcmV0dXJuICF0aGlzLmV4cHJBbGxvd2VkO1xufTtcblxucHAudXBkYXRlQ29udGV4dCA9IGZ1bmN0aW9uIChwcmV2VHlwZSkge1xuICB2YXIgdXBkYXRlID0gdW5kZWZpbmVkLFxuICAgICAgdHlwZSA9IHRoaXMudHlwZTtcbiAgaWYgKHR5cGUua2V5d29yZCAmJiBwcmV2VHlwZSA9PSBfdG9rZW50eXBlLnR5cGVzLmRvdCkgdGhpcy5leHByQWxsb3dlZCA9IGZhbHNlO2Vsc2UgaWYgKHVwZGF0ZSA9IHR5cGUudXBkYXRlQ29udGV4dCkgdXBkYXRlLmNhbGwodGhpcywgcHJldlR5cGUpO2Vsc2UgdGhpcy5leHByQWxsb3dlZCA9IHR5cGUuYmVmb3JlRXhwcjtcbn07XG5cbi8vIFRva2VuLXNwZWNpZmljIGNvbnRleHQgdXBkYXRlIGNvZGVcblxuX3Rva2VudHlwZS50eXBlcy5wYXJlblIudXBkYXRlQ29udGV4dCA9IF90b2tlbnR5cGUudHlwZXMuYnJhY2VSLnVwZGF0ZUNvbnRleHQgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmNvbnRleHQubGVuZ3RoID09IDEpIHtcbiAgICB0aGlzLmV4cHJBbGxvd2VkID0gdHJ1ZTtcbiAgICByZXR1cm47XG4gIH1cbiAgdmFyIG91dCA9IHRoaXMuY29udGV4dC5wb3AoKTtcbiAgaWYgKG91dCA9PT0gdHlwZXMuYl9zdGF0ICYmIHRoaXMuY3VyQ29udGV4dCgpID09PSB0eXBlcy5mX2V4cHIpIHtcbiAgICB0aGlzLmNvbnRleHQucG9wKCk7XG4gICAgdGhpcy5leHByQWxsb3dlZCA9IGZhbHNlO1xuICB9IGVsc2UgaWYgKG91dCA9PT0gdHlwZXMuYl90bXBsKSB7XG4gICAgdGhpcy5leHByQWxsb3dlZCA9IHRydWU7XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5leHByQWxsb3dlZCA9ICFvdXQuaXNFeHByO1xuICB9XG59O1xuXG5fdG9rZW50eXBlLnR5cGVzLmJyYWNlTC51cGRhdGVDb250ZXh0ID0gZnVuY3Rpb24gKHByZXZUeXBlKSB7XG4gIHRoaXMuY29udGV4dC5wdXNoKHRoaXMuYnJhY2VJc0Jsb2NrKHByZXZUeXBlKSA/IHR5cGVzLmJfc3RhdCA6IHR5cGVzLmJfZXhwcik7XG4gIHRoaXMuZXhwckFsbG93ZWQgPSB0cnVlO1xufTtcblxuX3Rva2VudHlwZS50eXBlcy5kb2xsYXJCcmFjZUwudXBkYXRlQ29udGV4dCA9IGZ1bmN0aW9uICgpIHtcbiAgdGhpcy5jb250ZXh0LnB1c2godHlwZXMuYl90bXBsKTtcbiAgdGhpcy5leHByQWxsb3dlZCA9IHRydWU7XG59O1xuXG5fdG9rZW50eXBlLnR5cGVzLnBhcmVuTC51cGRhdGVDb250ZXh0ID0gZnVuY3Rpb24gKHByZXZUeXBlKSB7XG4gIHZhciBzdGF0ZW1lbnRQYXJlbnMgPSBwcmV2VHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5faWYgfHwgcHJldlR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2ZvciB8fCBwcmV2VHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fd2l0aCB8fCBwcmV2VHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fd2hpbGU7XG4gIHRoaXMuY29udGV4dC5wdXNoKHN0YXRlbWVudFBhcmVucyA/IHR5cGVzLnBfc3RhdCA6IHR5cGVzLnBfZXhwcik7XG4gIHRoaXMuZXhwckFsbG93ZWQgPSB0cnVlO1xufTtcblxuX3Rva2VudHlwZS50eXBlcy5pbmNEZWMudXBkYXRlQ29udGV4dCA9IGZ1bmN0aW9uICgpIHtcbiAgLy8gdG9rRXhwckFsbG93ZWQgc3RheXMgdW5jaGFuZ2VkXG59O1xuXG5fdG9rZW50eXBlLnR5cGVzLl9mdW5jdGlvbi51cGRhdGVDb250ZXh0ID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5jdXJDb250ZXh0KCkgIT09IHR5cGVzLmJfc3RhdCkgdGhpcy5jb250ZXh0LnB1c2godHlwZXMuZl9leHByKTtcbiAgdGhpcy5leHByQWxsb3dlZCA9IGZhbHNlO1xufTtcblxuX3Rva2VudHlwZS50eXBlcy5iYWNrUXVvdGUudXBkYXRlQ29udGV4dCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuY3VyQ29udGV4dCgpID09PSB0eXBlcy5xX3RtcGwpIHRoaXMuY29udGV4dC5wb3AoKTtlbHNlIHRoaXMuY29udGV4dC5wdXNoKHR5cGVzLnFfdG1wbCk7XG4gIHRoaXMuZXhwckFsbG93ZWQgPSBmYWxzZTtcbn07XG5cbn0se1wiLi9zdGF0ZVwiOjEwLFwiLi90b2tlbnR5cGVcIjoxNCxcIi4vd2hpdGVzcGFjZVwiOjE2fV0sMTM6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1xuXCJ1c2Ugc3RyaWN0XCI7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5cbmZ1bmN0aW9uIF9jbGFzc0NhbGxDaGVjayhpbnN0YW5jZSwgQ29uc3RydWN0b3IpIHsgaWYgKCEoaW5zdGFuY2UgaW5zdGFuY2VvZiBDb25zdHJ1Y3RvcikpIHsgdGhyb3cgbmV3IFR5cGVFcnJvcihcIkNhbm5vdCBjYWxsIGEgY2xhc3MgYXMgYSBmdW5jdGlvblwiKTsgfSB9XG5cbnZhciBfaWRlbnRpZmllciA9IF9kZXJlcV8oXCIuL2lkZW50aWZpZXJcIik7XG5cbnZhciBfdG9rZW50eXBlID0gX2RlcmVxXyhcIi4vdG9rZW50eXBlXCIpO1xuXG52YXIgX3N0YXRlID0gX2RlcmVxXyhcIi4vc3RhdGVcIik7XG5cbnZhciBfbG9jdXRpbCA9IF9kZXJlcV8oXCIuL2xvY3V0aWxcIik7XG5cbnZhciBfd2hpdGVzcGFjZSA9IF9kZXJlcV8oXCIuL3doaXRlc3BhY2VcIik7XG5cbi8vIE9iamVjdCB0eXBlIHVzZWQgdG8gcmVwcmVzZW50IHRva2Vucy4gTm90ZSB0aGF0IG5vcm1hbGx5LCB0b2tlbnNcbi8vIHNpbXBseSBleGlzdCBhcyBwcm9wZXJ0aWVzIG9uIHRoZSBwYXJzZXIgb2JqZWN0LiBUaGlzIGlzIG9ubHlcbi8vIHVzZWQgZm9yIHRoZSBvblRva2VuIGNhbGxiYWNrIGFuZCB0aGUgZXh0ZXJuYWwgdG9rZW5pemVyLlxuXG52YXIgVG9rZW4gPSBmdW5jdGlvbiBUb2tlbihwKSB7XG4gIF9jbGFzc0NhbGxDaGVjayh0aGlzLCBUb2tlbik7XG5cbiAgdGhpcy50eXBlID0gcC50eXBlO1xuICB0aGlzLnZhbHVlID0gcC52YWx1ZTtcbiAgdGhpcy5zdGFydCA9IHAuc3RhcnQ7XG4gIHRoaXMuZW5kID0gcC5lbmQ7XG4gIGlmIChwLm9wdGlvbnMubG9jYXRpb25zKSB0aGlzLmxvYyA9IG5ldyBfbG9jdXRpbC5Tb3VyY2VMb2NhdGlvbihwLCBwLnN0YXJ0TG9jLCBwLmVuZExvYyk7XG4gIGlmIChwLm9wdGlvbnMucmFuZ2VzKSB0aGlzLnJhbmdlID0gW3Auc3RhcnQsIHAuZW5kXTtcbn1cblxuLy8gIyMgVG9rZW5pemVyXG5cbjtcblxuZXhwb3J0cy5Ub2tlbiA9IFRva2VuO1xudmFyIHBwID0gX3N0YXRlLlBhcnNlci5wcm90b3R5cGU7XG5cbi8vIEFyZSB3ZSBydW5uaW5nIHVuZGVyIFJoaW5vP1xudmFyIGlzUmhpbm8gPSB0eXBlb2YgUGFja2FnZXMgPT0gXCJvYmplY3RcIiAmJiBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwoUGFja2FnZXMpID09IFwiW29iamVjdCBKYXZhUGFja2FnZV1cIjtcblxuLy8gTW92ZSB0byB0aGUgbmV4dCB0b2tlblxuXG5wcC5uZXh0ID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5vcHRpb25zLm9uVG9rZW4pIHRoaXMub3B0aW9ucy5vblRva2VuKG5ldyBUb2tlbih0aGlzKSk7XG5cbiAgdGhpcy5sYXN0VG9rRW5kID0gdGhpcy5lbmQ7XG4gIHRoaXMubGFzdFRva1N0YXJ0ID0gdGhpcy5zdGFydDtcbiAgdGhpcy5sYXN0VG9rRW5kTG9jID0gdGhpcy5lbmRMb2M7XG4gIHRoaXMubGFzdFRva1N0YXJ0TG9jID0gdGhpcy5zdGFydExvYztcbiAgdGhpcy5uZXh0VG9rZW4oKTtcbn07XG5cbnBwLmdldFRva2VuID0gZnVuY3Rpb24gKCkge1xuICB0aGlzLm5leHQoKTtcbiAgcmV0dXJuIG5ldyBUb2tlbih0aGlzKTtcbn07XG5cbi8vIElmIHdlJ3JlIGluIGFuIEVTNiBlbnZpcm9ubWVudCwgbWFrZSBwYXJzZXJzIGl0ZXJhYmxlXG5pZiAodHlwZW9mIFN5bWJvbCAhPT0gXCJ1bmRlZmluZWRcIikgcHBbU3ltYm9sLml0ZXJhdG9yXSA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICByZXR1cm4geyBuZXh0OiBmdW5jdGlvbiBuZXh0KCkge1xuICAgICAgdmFyIHRva2VuID0gc2VsZi5nZXRUb2tlbigpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgZG9uZTogdG9rZW4udHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5lb2YsXG4gICAgICAgIHZhbHVlOiB0b2tlblxuICAgICAgfTtcbiAgICB9IH07XG59O1xuXG4vLyBUb2dnbGUgc3RyaWN0IG1vZGUuIFJlLXJlYWRzIHRoZSBuZXh0IG51bWJlciBvciBzdHJpbmcgdG8gcGxlYXNlXG4vLyBwZWRhbnRpYyB0ZXN0cyAoYFwidXNlIHN0cmljdFwiOyAwMTA7YCBzaG91bGQgZmFpbCkuXG5cbnBwLnNldFN0cmljdCA9IGZ1bmN0aW9uIChzdHJpY3QpIHtcbiAgdGhpcy5zdHJpY3QgPSBzdHJpY3Q7XG4gIGlmICh0aGlzLnR5cGUgIT09IF90b2tlbnR5cGUudHlwZXMubnVtICYmIHRoaXMudHlwZSAhPT0gX3Rva2VudHlwZS50eXBlcy5zdHJpbmcpIHJldHVybjtcbiAgdGhpcy5wb3MgPSB0aGlzLnN0YXJ0O1xuICBpZiAodGhpcy5vcHRpb25zLmxvY2F0aW9ucykge1xuICAgIHdoaWxlICh0aGlzLnBvcyA8IHRoaXMubGluZVN0YXJ0KSB7XG4gICAgICB0aGlzLmxpbmVTdGFydCA9IHRoaXMuaW5wdXQubGFzdEluZGV4T2YoXCJcXG5cIiwgdGhpcy5saW5lU3RhcnQgLSAyKSArIDE7XG4gICAgICAtLXRoaXMuY3VyTGluZTtcbiAgICB9XG4gIH1cbiAgdGhpcy5uZXh0VG9rZW4oKTtcbn07XG5cbnBwLmN1ckNvbnRleHQgPSBmdW5jdGlvbiAoKSB7XG4gIHJldHVybiB0aGlzLmNvbnRleHRbdGhpcy5jb250ZXh0Lmxlbmd0aCAtIDFdO1xufTtcblxuLy8gUmVhZCBhIHNpbmdsZSB0b2tlbiwgdXBkYXRpbmcgdGhlIHBhcnNlciBvYmplY3QncyB0b2tlbi1yZWxhdGVkXG4vLyBwcm9wZXJ0aWVzLlxuXG5wcC5uZXh0VG9rZW4gPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBjdXJDb250ZXh0ID0gdGhpcy5jdXJDb250ZXh0KCk7XG4gIGlmICghY3VyQ29udGV4dCB8fCAhY3VyQ29udGV4dC5wcmVzZXJ2ZVNwYWNlKSB0aGlzLnNraXBTcGFjZSgpO1xuXG4gIHRoaXMuc3RhcnQgPSB0aGlzLnBvcztcbiAgaWYgKHRoaXMub3B0aW9ucy5sb2NhdGlvbnMpIHRoaXMuc3RhcnRMb2MgPSB0aGlzLmN1clBvc2l0aW9uKCk7XG4gIGlmICh0aGlzLnBvcyA+PSB0aGlzLmlucHV0Lmxlbmd0aCkgcmV0dXJuIHRoaXMuZmluaXNoVG9rZW4oX3Rva2VudHlwZS50eXBlcy5lb2YpO1xuXG4gIGlmIChjdXJDb250ZXh0Lm92ZXJyaWRlKSByZXR1cm4gY3VyQ29udGV4dC5vdmVycmlkZSh0aGlzKTtlbHNlIHRoaXMucmVhZFRva2VuKHRoaXMuZnVsbENoYXJDb2RlQXRQb3MoKSk7XG59O1xuXG5wcC5yZWFkVG9rZW4gPSBmdW5jdGlvbiAoY29kZSkge1xuICAvLyBJZGVudGlmaWVyIG9yIGtleXdvcmQuICdcXHVYWFhYJyBzZXF1ZW5jZXMgYXJlIGFsbG93ZWQgaW5cbiAgLy8gaWRlbnRpZmllcnMsIHNvICdcXCcgYWxzbyBkaXNwYXRjaGVzIHRvIHRoYXQuXG4gIGlmIChfaWRlbnRpZmllci5pc0lkZW50aWZpZXJTdGFydChjb2RlLCB0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNikgfHwgY29kZSA9PT0gOTIgLyogJ1xcJyAqLykgcmV0dXJuIHRoaXMucmVhZFdvcmQoKTtcblxuICByZXR1cm4gdGhpcy5nZXRUb2tlbkZyb21Db2RlKGNvZGUpO1xufTtcblxucHAuZnVsbENoYXJDb2RlQXRQb3MgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBjb2RlID0gdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zKTtcbiAgaWYgKGNvZGUgPD0gMHhkN2ZmIHx8IGNvZGUgPj0gMHhlMDAwKSByZXR1cm4gY29kZTtcbiAgdmFyIG5leHQgPSB0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAxKTtcbiAgcmV0dXJuIChjb2RlIDw8IDEwKSArIG5leHQgLSAweDM1ZmRjMDA7XG59O1xuXG5wcC5za2lwQmxvY2tDb21tZW50ID0gZnVuY3Rpb24gKCkge1xuICB2YXIgc3RhcnRMb2MgPSB0aGlzLm9wdGlvbnMub25Db21tZW50ICYmIHRoaXMuY3VyUG9zaXRpb24oKTtcbiAgdmFyIHN0YXJ0ID0gdGhpcy5wb3MsXG4gICAgICBlbmQgPSB0aGlzLmlucHV0LmluZGV4T2YoXCIqL1wiLCB0aGlzLnBvcyArPSAyKTtcbiAgaWYgKGVuZCA9PT0gLTEpIHRoaXMucmFpc2UodGhpcy5wb3MgLSAyLCBcIlVudGVybWluYXRlZCBjb21tZW50XCIpO1xuICB0aGlzLnBvcyA9IGVuZCArIDI7XG4gIGlmICh0aGlzLm9wdGlvbnMubG9jYXRpb25zKSB7XG4gICAgX3doaXRlc3BhY2UubGluZUJyZWFrRy5sYXN0SW5kZXggPSBzdGFydDtcbiAgICB2YXIgbWF0Y2ggPSB1bmRlZmluZWQ7XG4gICAgd2hpbGUgKChtYXRjaCA9IF93aGl0ZXNwYWNlLmxpbmVCcmVha0cuZXhlYyh0aGlzLmlucHV0KSkgJiYgbWF0Y2guaW5kZXggPCB0aGlzLnBvcykge1xuICAgICAgKyt0aGlzLmN1ckxpbmU7XG4gICAgICB0aGlzLmxpbmVTdGFydCA9IG1hdGNoLmluZGV4ICsgbWF0Y2hbMF0ubGVuZ3RoO1xuICAgIH1cbiAgfVxuICBpZiAodGhpcy5vcHRpb25zLm9uQ29tbWVudCkgdGhpcy5vcHRpb25zLm9uQ29tbWVudCh0cnVlLCB0aGlzLmlucHV0LnNsaWNlKHN0YXJ0ICsgMiwgZW5kKSwgc3RhcnQsIHRoaXMucG9zLCBzdGFydExvYywgdGhpcy5jdXJQb3NpdGlvbigpKTtcbn07XG5cbnBwLnNraXBMaW5lQ29tbWVudCA9IGZ1bmN0aW9uIChzdGFydFNraXApIHtcbiAgdmFyIHN0YXJ0ID0gdGhpcy5wb3M7XG4gIHZhciBzdGFydExvYyA9IHRoaXMub3B0aW9ucy5vbkNvbW1lbnQgJiYgdGhpcy5jdXJQb3NpdGlvbigpO1xuICB2YXIgY2ggPSB0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKz0gc3RhcnRTa2lwKTtcbiAgd2hpbGUgKHRoaXMucG9zIDwgdGhpcy5pbnB1dC5sZW5ndGggJiYgY2ggIT09IDEwICYmIGNoICE9PSAxMyAmJiBjaCAhPT0gODIzMiAmJiBjaCAhPT0gODIzMykge1xuICAgICsrdGhpcy5wb3M7XG4gICAgY2ggPSB0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MpO1xuICB9XG4gIGlmICh0aGlzLm9wdGlvbnMub25Db21tZW50KSB0aGlzLm9wdGlvbnMub25Db21tZW50KGZhbHNlLCB0aGlzLmlucHV0LnNsaWNlKHN0YXJ0ICsgc3RhcnRTa2lwLCB0aGlzLnBvcyksIHN0YXJ0LCB0aGlzLnBvcywgc3RhcnRMb2MsIHRoaXMuY3VyUG9zaXRpb24oKSk7XG59O1xuXG4vLyBDYWxsZWQgYXQgdGhlIHN0YXJ0IG9mIHRoZSBwYXJzZSBhbmQgYWZ0ZXIgZXZlcnkgdG9rZW4uIFNraXBzXG4vLyB3aGl0ZXNwYWNlIGFuZCBjb21tZW50cywgYW5kLlxuXG5wcC5za2lwU3BhY2UgPSBmdW5jdGlvbiAoKSB7XG4gIGxvb3A6IHdoaWxlICh0aGlzLnBvcyA8IHRoaXMuaW5wdXQubGVuZ3RoKSB7XG4gICAgdmFyIGNoID0gdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zKTtcbiAgICBzd2l0Y2ggKGNoKSB7XG4gICAgICBjYXNlIDMyOmNhc2UgMTYwOlxuICAgICAgICAvLyAnICdcbiAgICAgICAgKyt0aGlzLnBvcztcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIDEzOlxuICAgICAgICBpZiAodGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMSkgPT09IDEwKSB7XG4gICAgICAgICAgKyt0aGlzLnBvcztcbiAgICAgICAgfVxuICAgICAgY2FzZSAxMDpjYXNlIDgyMzI6Y2FzZSA4MjMzOlxuICAgICAgICArK3RoaXMucG9zO1xuICAgICAgICBpZiAodGhpcy5vcHRpb25zLmxvY2F0aW9ucykge1xuICAgICAgICAgICsrdGhpcy5jdXJMaW5lO1xuICAgICAgICAgIHRoaXMubGluZVN0YXJ0ID0gdGhpcy5wb3M7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIDQ3OlxuICAgICAgICAvLyAnLydcbiAgICAgICAgc3dpdGNoICh0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAxKSkge1xuICAgICAgICAgIGNhc2UgNDI6XG4gICAgICAgICAgICAvLyAnKidcbiAgICAgICAgICAgIHRoaXMuc2tpcEJsb2NrQ29tbWVudCgpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgY2FzZSA0NzpcbiAgICAgICAgICAgIHRoaXMuc2tpcExpbmVDb21tZW50KDIpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgIGJyZWFrIGxvb3A7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICBpZiAoY2ggPiA4ICYmIGNoIDwgMTQgfHwgY2ggPj0gNTc2MCAmJiBfd2hpdGVzcGFjZS5ub25BU0NJSXdoaXRlc3BhY2UudGVzdChTdHJpbmcuZnJvbUNoYXJDb2RlKGNoKSkpIHtcbiAgICAgICAgICArK3RoaXMucG9zO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGJyZWFrIGxvb3A7XG4gICAgICAgIH1cbiAgICB9XG4gIH1cbn07XG5cbi8vIENhbGxlZCBhdCB0aGUgZW5kIG9mIGV2ZXJ5IHRva2VuLiBTZXRzIGBlbmRgLCBgdmFsYCwgYW5kXG4vLyBtYWludGFpbnMgYGNvbnRleHRgIGFuZCBgZXhwckFsbG93ZWRgLCBhbmQgc2tpcHMgdGhlIHNwYWNlIGFmdGVyXG4vLyB0aGUgdG9rZW4sIHNvIHRoYXQgdGhlIG5leHQgb25lJ3MgYHN0YXJ0YCB3aWxsIHBvaW50IGF0IHRoZVxuLy8gcmlnaHQgcG9zaXRpb24uXG5cbnBwLmZpbmlzaFRva2VuID0gZnVuY3Rpb24gKHR5cGUsIHZhbCkge1xuICB0aGlzLmVuZCA9IHRoaXMucG9zO1xuICBpZiAodGhpcy5vcHRpb25zLmxvY2F0aW9ucykgdGhpcy5lbmRMb2MgPSB0aGlzLmN1clBvc2l0aW9uKCk7XG4gIHZhciBwcmV2VHlwZSA9IHRoaXMudHlwZTtcbiAgdGhpcy50eXBlID0gdHlwZTtcbiAgdGhpcy52YWx1ZSA9IHZhbDtcblxuICB0aGlzLnVwZGF0ZUNvbnRleHQocHJldlR5cGUpO1xufTtcblxuLy8gIyMjIFRva2VuIHJlYWRpbmdcblxuLy8gVGhpcyBpcyB0aGUgZnVuY3Rpb24gdGhhdCBpcyBjYWxsZWQgdG8gZmV0Y2ggdGhlIG5leHQgdG9rZW4uIEl0XG4vLyBpcyBzb21ld2hhdCBvYnNjdXJlLCBiZWNhdXNlIGl0IHdvcmtzIGluIGNoYXJhY3RlciBjb2RlcyByYXRoZXJcbi8vIHRoYW4gY2hhcmFjdGVycywgYW5kIGJlY2F1c2Ugb3BlcmF0b3IgcGFyc2luZyBoYXMgYmVlbiBpbmxpbmVkXG4vLyBpbnRvIGl0LlxuLy9cbi8vIEFsbCBpbiB0aGUgbmFtZSBvZiBzcGVlZC5cbi8vXG5wcC5yZWFkVG9rZW5fZG90ID0gZnVuY3Rpb24gKCkge1xuICB2YXIgbmV4dCA9IHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDEpO1xuICBpZiAobmV4dCA+PSA0OCAmJiBuZXh0IDw9IDU3KSByZXR1cm4gdGhpcy5yZWFkTnVtYmVyKHRydWUpO1xuICB2YXIgbmV4dDIgPSB0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAyKTtcbiAgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2ICYmIG5leHQgPT09IDQ2ICYmIG5leHQyID09PSA0Nikge1xuICAgIC8vIDQ2ID0gZG90ICcuJ1xuICAgIHRoaXMucG9zICs9IDM7XG4gICAgcmV0dXJuIHRoaXMuZmluaXNoVG9rZW4oX3Rva2VudHlwZS50eXBlcy5lbGxpcHNpcyk7XG4gIH0gZWxzZSB7XG4gICAgKyt0aGlzLnBvcztcbiAgICByZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLmRvdCk7XG4gIH1cbn07XG5cbnBwLnJlYWRUb2tlbl9zbGFzaCA9IGZ1bmN0aW9uICgpIHtcbiAgLy8gJy8nXG4gIHZhciBuZXh0ID0gdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMSk7XG4gIGlmICh0aGlzLmV4cHJBbGxvd2VkKSB7XG4gICAgKyt0aGlzLnBvcztyZXR1cm4gdGhpcy5yZWFkUmVnZXhwKCk7XG4gIH1cbiAgaWYgKG5leHQgPT09IDYxKSByZXR1cm4gdGhpcy5maW5pc2hPcChfdG9rZW50eXBlLnR5cGVzLmFzc2lnbiwgMik7XG4gIHJldHVybiB0aGlzLmZpbmlzaE9wKF90b2tlbnR5cGUudHlwZXMuc2xhc2gsIDEpO1xufTtcblxucHAucmVhZFRva2VuX211bHRfbW9kdWxvID0gZnVuY3Rpb24gKGNvZGUpIHtcbiAgLy8gJyUqJ1xuICB2YXIgbmV4dCA9IHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDEpO1xuICBpZiAobmV4dCA9PT0gNjEpIHJldHVybiB0aGlzLmZpbmlzaE9wKF90b2tlbnR5cGUudHlwZXMuYXNzaWduLCAyKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoT3AoY29kZSA9PT0gNDIgPyBfdG9rZW50eXBlLnR5cGVzLnN0YXIgOiBfdG9rZW50eXBlLnR5cGVzLm1vZHVsbywgMSk7XG59O1xuXG5wcC5yZWFkVG9rZW5fcGlwZV9hbXAgPSBmdW5jdGlvbiAoY29kZSkge1xuICAvLyAnfCYnXG4gIHZhciBuZXh0ID0gdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMSk7XG4gIGlmIChuZXh0ID09PSBjb2RlKSByZXR1cm4gdGhpcy5maW5pc2hPcChjb2RlID09PSAxMjQgPyBfdG9rZW50eXBlLnR5cGVzLmxvZ2ljYWxPUiA6IF90b2tlbnR5cGUudHlwZXMubG9naWNhbEFORCwgMik7XG4gIGlmIChuZXh0ID09PSA2MSkgcmV0dXJuIHRoaXMuZmluaXNoT3AoX3Rva2VudHlwZS50eXBlcy5hc3NpZ24sIDIpO1xuICByZXR1cm4gdGhpcy5maW5pc2hPcChjb2RlID09PSAxMjQgPyBfdG9rZW50eXBlLnR5cGVzLmJpdHdpc2VPUiA6IF90b2tlbnR5cGUudHlwZXMuYml0d2lzZUFORCwgMSk7XG59O1xuXG5wcC5yZWFkVG9rZW5fY2FyZXQgPSBmdW5jdGlvbiAoKSB7XG4gIC8vICdeJ1xuICB2YXIgbmV4dCA9IHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDEpO1xuICBpZiAobmV4dCA9PT0gNjEpIHJldHVybiB0aGlzLmZpbmlzaE9wKF90b2tlbnR5cGUudHlwZXMuYXNzaWduLCAyKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoT3AoX3Rva2VudHlwZS50eXBlcy5iaXR3aXNlWE9SLCAxKTtcbn07XG5cbnBwLnJlYWRUb2tlbl9wbHVzX21pbiA9IGZ1bmN0aW9uIChjb2RlKSB7XG4gIC8vICcrLSdcbiAgdmFyIG5leHQgPSB0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAxKTtcbiAgaWYgKG5leHQgPT09IGNvZGUpIHtcbiAgICBpZiAobmV4dCA9PSA0NSAmJiB0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAyKSA9PSA2MiAmJiBfd2hpdGVzcGFjZS5saW5lQnJlYWsudGVzdCh0aGlzLmlucHV0LnNsaWNlKHRoaXMubGFzdFRva0VuZCwgdGhpcy5wb3MpKSkge1xuICAgICAgLy8gQSBgLS0+YCBsaW5lIGNvbW1lbnRcbiAgICAgIHRoaXMuc2tpcExpbmVDb21tZW50KDMpO1xuICAgICAgdGhpcy5za2lwU3BhY2UoKTtcbiAgICAgIHJldHVybiB0aGlzLm5leHRUb2tlbigpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5maW5pc2hPcChfdG9rZW50eXBlLnR5cGVzLmluY0RlYywgMik7XG4gIH1cbiAgaWYgKG5leHQgPT09IDYxKSByZXR1cm4gdGhpcy5maW5pc2hPcChfdG9rZW50eXBlLnR5cGVzLmFzc2lnbiwgMik7XG4gIHJldHVybiB0aGlzLmZpbmlzaE9wKF90b2tlbnR5cGUudHlwZXMucGx1c01pbiwgMSk7XG59O1xuXG5wcC5yZWFkVG9rZW5fbHRfZ3QgPSBmdW5jdGlvbiAoY29kZSkge1xuICAvLyAnPD4nXG4gIHZhciBuZXh0ID0gdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMSk7XG4gIHZhciBzaXplID0gMTtcbiAgaWYgKG5leHQgPT09IGNvZGUpIHtcbiAgICBzaXplID0gY29kZSA9PT0gNjIgJiYgdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMikgPT09IDYyID8gMyA6IDI7XG4gICAgaWYgKHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIHNpemUpID09PSA2MSkgcmV0dXJuIHRoaXMuZmluaXNoT3AoX3Rva2VudHlwZS50eXBlcy5hc3NpZ24sIHNpemUgKyAxKTtcbiAgICByZXR1cm4gdGhpcy5maW5pc2hPcChfdG9rZW50eXBlLnR5cGVzLmJpdFNoaWZ0LCBzaXplKTtcbiAgfVxuICBpZiAobmV4dCA9PSAzMyAmJiBjb2RlID09IDYwICYmIHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDIpID09IDQ1ICYmIHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDMpID09IDQ1KSB7XG4gICAgaWYgKHRoaXMuaW5Nb2R1bGUpIHRoaXMudW5leHBlY3RlZCgpO1xuICAgIC8vIGA8IS0tYCwgYW4gWE1MLXN0eWxlIGNvbW1lbnQgdGhhdCBzaG91bGQgYmUgaW50ZXJwcmV0ZWQgYXMgYSBsaW5lIGNvbW1lbnRcbiAgICB0aGlzLnNraXBMaW5lQ29tbWVudCg0KTtcbiAgICB0aGlzLnNraXBTcGFjZSgpO1xuICAgIHJldHVybiB0aGlzLm5leHRUb2tlbigpO1xuICB9XG4gIGlmIChuZXh0ID09PSA2MSkgc2l6ZSA9IHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDIpID09PSA2MSA/IDMgOiAyO1xuICByZXR1cm4gdGhpcy5maW5pc2hPcChfdG9rZW50eXBlLnR5cGVzLnJlbGF0aW9uYWwsIHNpemUpO1xufTtcblxucHAucmVhZFRva2VuX2VxX2V4Y2wgPSBmdW5jdGlvbiAoY29kZSkge1xuICAvLyAnPSEnXG4gIHZhciBuZXh0ID0gdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMSk7XG4gIGlmIChuZXh0ID09PSA2MSkgcmV0dXJuIHRoaXMuZmluaXNoT3AoX3Rva2VudHlwZS50eXBlcy5lcXVhbGl0eSwgdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMikgPT09IDYxID8gMyA6IDIpO1xuICBpZiAoY29kZSA9PT0gNjEgJiYgbmV4dCA9PT0gNjIgJiYgdGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpIHtcbiAgICAvLyAnPT4nXG4gICAgdGhpcy5wb3MgKz0gMjtcbiAgICByZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLmFycm93KTtcbiAgfVxuICByZXR1cm4gdGhpcy5maW5pc2hPcChjb2RlID09PSA2MSA/IF90b2tlbnR5cGUudHlwZXMuZXEgOiBfdG9rZW50eXBlLnR5cGVzLnByZWZpeCwgMSk7XG59O1xuXG5wcC5nZXRUb2tlbkZyb21Db2RlID0gZnVuY3Rpb24gKGNvZGUpIHtcbiAgc3dpdGNoIChjb2RlKSB7XG4gICAgLy8gVGhlIGludGVycHJldGF0aW9uIG9mIGEgZG90IGRlcGVuZHMgb24gd2hldGhlciBpdCBpcyBmb2xsb3dlZFxuICAgIC8vIGJ5IGEgZGlnaXQgb3IgYW5vdGhlciB0d28gZG90cy5cbiAgICBjYXNlIDQ2OlxuICAgICAgLy8gJy4nXG4gICAgICByZXR1cm4gdGhpcy5yZWFkVG9rZW5fZG90KCk7XG5cbiAgICAvLyBQdW5jdHVhdGlvbiB0b2tlbnMuXG4gICAgY2FzZSA0MDpcbiAgICAgICsrdGhpcy5wb3M7cmV0dXJuIHRoaXMuZmluaXNoVG9rZW4oX3Rva2VudHlwZS50eXBlcy5wYXJlbkwpO1xuICAgIGNhc2UgNDE6XG4gICAgICArK3RoaXMucG9zO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMucGFyZW5SKTtcbiAgICBjYXNlIDU5OlxuICAgICAgKyt0aGlzLnBvcztyZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLnNlbWkpO1xuICAgIGNhc2UgNDQ6XG4gICAgICArK3RoaXMucG9zO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuY29tbWEpO1xuICAgIGNhc2UgOTE6XG4gICAgICArK3RoaXMucG9zO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuYnJhY2tldEwpO1xuICAgIGNhc2UgOTM6XG4gICAgICArK3RoaXMucG9zO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuYnJhY2tldFIpO1xuICAgIGNhc2UgMTIzOlxuICAgICAgKyt0aGlzLnBvcztyZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLmJyYWNlTCk7XG4gICAgY2FzZSAxMjU6XG4gICAgICArK3RoaXMucG9zO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuYnJhY2VSKTtcbiAgICBjYXNlIDU4OlxuICAgICAgKyt0aGlzLnBvcztyZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLmNvbG9uKTtcbiAgICBjYXNlIDYzOlxuICAgICAgKyt0aGlzLnBvcztyZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLnF1ZXN0aW9uKTtcblxuICAgIGNhc2UgOTY6XG4gICAgICAvLyAnYCdcbiAgICAgIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPCA2KSBicmVhaztcbiAgICAgICsrdGhpcy5wb3M7XG4gICAgICByZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLmJhY2tRdW90ZSk7XG5cbiAgICBjYXNlIDQ4OlxuICAgICAgLy8gJzAnXG4gICAgICB2YXIgbmV4dCA9IHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDEpO1xuICAgICAgaWYgKG5leHQgPT09IDEyMCB8fCBuZXh0ID09PSA4OCkgcmV0dXJuIHRoaXMucmVhZFJhZGl4TnVtYmVyKDE2KTsgLy8gJzB4JywgJzBYJyAtIGhleCBudW1iZXJcbiAgICAgIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNikge1xuICAgICAgICBpZiAobmV4dCA9PT0gMTExIHx8IG5leHQgPT09IDc5KSByZXR1cm4gdGhpcy5yZWFkUmFkaXhOdW1iZXIoOCk7IC8vICcwbycsICcwTycgLSBvY3RhbCBudW1iZXJcbiAgICAgICAgaWYgKG5leHQgPT09IDk4IHx8IG5leHQgPT09IDY2KSByZXR1cm4gdGhpcy5yZWFkUmFkaXhOdW1iZXIoMik7IC8vICcwYicsICcwQicgLSBiaW5hcnkgbnVtYmVyXG4gICAgICB9XG4gICAgLy8gQW55dGhpbmcgZWxzZSBiZWdpbm5pbmcgd2l0aCBhIGRpZ2l0IGlzIGFuIGludGVnZXIsIG9jdGFsXG4gICAgLy8gbnVtYmVyLCBvciBmbG9hdC5cbiAgICBjYXNlIDQ5OmNhc2UgNTA6Y2FzZSA1MTpjYXNlIDUyOmNhc2UgNTM6Y2FzZSA1NDpjYXNlIDU1OmNhc2UgNTY6Y2FzZSA1NzpcbiAgICAgIC8vIDEtOVxuICAgICAgcmV0dXJuIHRoaXMucmVhZE51bWJlcihmYWxzZSk7XG5cbiAgICAvLyBRdW90ZXMgcHJvZHVjZSBzdHJpbmdzLlxuICAgIGNhc2UgMzQ6Y2FzZSAzOTpcbiAgICAgIC8vICdcIicsIFwiJ1wiXG4gICAgICByZXR1cm4gdGhpcy5yZWFkU3RyaW5nKGNvZGUpO1xuXG4gICAgLy8gT3BlcmF0b3JzIGFyZSBwYXJzZWQgaW5saW5lIGluIHRpbnkgc3RhdGUgbWFjaGluZXMuICc9JyAoNjEpIGlzXG4gICAgLy8gb2Z0ZW4gcmVmZXJyZWQgdG8uIGBmaW5pc2hPcGAgc2ltcGx5IHNraXBzIHRoZSBhbW91bnQgb2ZcbiAgICAvLyBjaGFyYWN0ZXJzIGl0IGlzIGdpdmVuIGFzIHNlY29uZCBhcmd1bWVudCwgYW5kIHJldHVybnMgYSB0b2tlblxuICAgIC8vIG9mIHRoZSB0eXBlIGdpdmVuIGJ5IGl0cyBmaXJzdCBhcmd1bWVudC5cblxuICAgIGNhc2UgNDc6XG4gICAgICAvLyAnLydcbiAgICAgIHJldHVybiB0aGlzLnJlYWRUb2tlbl9zbGFzaCgpO1xuXG4gICAgY2FzZSAzNzpjYXNlIDQyOlxuICAgICAgLy8gJyUqJ1xuICAgICAgcmV0dXJuIHRoaXMucmVhZFRva2VuX211bHRfbW9kdWxvKGNvZGUpO1xuXG4gICAgY2FzZSAxMjQ6Y2FzZSAzODpcbiAgICAgIC8vICd8JidcbiAgICAgIHJldHVybiB0aGlzLnJlYWRUb2tlbl9waXBlX2FtcChjb2RlKTtcblxuICAgIGNhc2UgOTQ6XG4gICAgICAvLyAnXidcbiAgICAgIHJldHVybiB0aGlzLnJlYWRUb2tlbl9jYXJldCgpO1xuXG4gICAgY2FzZSA0MzpjYXNlIDQ1OlxuICAgICAgLy8gJystJ1xuICAgICAgcmV0dXJuIHRoaXMucmVhZFRva2VuX3BsdXNfbWluKGNvZGUpO1xuXG4gICAgY2FzZSA2MDpjYXNlIDYyOlxuICAgICAgLy8gJzw+J1xuICAgICAgcmV0dXJuIHRoaXMucmVhZFRva2VuX2x0X2d0KGNvZGUpO1xuXG4gICAgY2FzZSA2MTpjYXNlIDMzOlxuICAgICAgLy8gJz0hJ1xuICAgICAgcmV0dXJuIHRoaXMucmVhZFRva2VuX2VxX2V4Y2woY29kZSk7XG5cbiAgICBjYXNlIDEyNjpcbiAgICAgIC8vICd+J1xuICAgICAgcmV0dXJuIHRoaXMuZmluaXNoT3AoX3Rva2VudHlwZS50eXBlcy5wcmVmaXgsIDEpO1xuICB9XG5cbiAgdGhpcy5yYWlzZSh0aGlzLnBvcywgXCJVbmV4cGVjdGVkIGNoYXJhY3RlciAnXCIgKyBjb2RlUG9pbnRUb1N0cmluZyhjb2RlKSArIFwiJ1wiKTtcbn07XG5cbnBwLmZpbmlzaE9wID0gZnVuY3Rpb24gKHR5cGUsIHNpemUpIHtcbiAgdmFyIHN0ciA9IHRoaXMuaW5wdXQuc2xpY2UodGhpcy5wb3MsIHRoaXMucG9zICsgc2l6ZSk7XG4gIHRoaXMucG9zICs9IHNpemU7XG4gIHJldHVybiB0aGlzLmZpbmlzaFRva2VuKHR5cGUsIHN0cik7XG59O1xuXG4vLyBQYXJzZSBhIHJlZ3VsYXIgZXhwcmVzc2lvbi4gU29tZSBjb250ZXh0LWF3YXJlbmVzcyBpcyBuZWNlc3NhcnksXG4vLyBzaW5jZSBhICcvJyBpbnNpZGUgYSAnW10nIHNldCBkb2VzIG5vdCBlbmQgdGhlIGV4cHJlc3Npb24uXG5cbmZ1bmN0aW9uIHRyeUNyZWF0ZVJlZ2V4cChzcmMsIGZsYWdzLCB0aHJvd0Vycm9yQXQpIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gbmV3IFJlZ0V4cChzcmMsIGZsYWdzKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmICh0aHJvd0Vycm9yQXQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKGUgaW5zdGFuY2VvZiBTeW50YXhFcnJvcikgdGhpcy5yYWlzZSh0aHJvd0Vycm9yQXQsIFwiRXJyb3IgcGFyc2luZyByZWd1bGFyIGV4cHJlc3Npb246IFwiICsgZS5tZXNzYWdlKTtcbiAgICAgIHRoaXMucmFpc2UoZSk7XG4gICAgfVxuICB9XG59XG5cbnZhciByZWdleHBVbmljb2RlU3VwcG9ydCA9ICEhdHJ5Q3JlYXRlUmVnZXhwKFwi77+/XCIsIFwidVwiKTtcblxucHAucmVhZFJlZ2V4cCA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIF90aGlzID0gdGhpcztcblxuICB2YXIgZXNjYXBlZCA9IHVuZGVmaW5lZCxcbiAgICAgIGluQ2xhc3MgPSB1bmRlZmluZWQsXG4gICAgICBzdGFydCA9IHRoaXMucG9zO1xuICBmb3IgKDs7KSB7XG4gICAgaWYgKHRoaXMucG9zID49IHRoaXMuaW5wdXQubGVuZ3RoKSB0aGlzLnJhaXNlKHN0YXJ0LCBcIlVudGVybWluYXRlZCByZWd1bGFyIGV4cHJlc3Npb25cIik7XG4gICAgdmFyIGNoID0gdGhpcy5pbnB1dC5jaGFyQXQodGhpcy5wb3MpO1xuICAgIGlmIChfd2hpdGVzcGFjZS5saW5lQnJlYWsudGVzdChjaCkpIHRoaXMucmFpc2Uoc3RhcnQsIFwiVW50ZXJtaW5hdGVkIHJlZ3VsYXIgZXhwcmVzc2lvblwiKTtcbiAgICBpZiAoIWVzY2FwZWQpIHtcbiAgICAgIGlmIChjaCA9PT0gXCJbXCIpIGluQ2xhc3MgPSB0cnVlO2Vsc2UgaWYgKGNoID09PSBcIl1cIiAmJiBpbkNsYXNzKSBpbkNsYXNzID0gZmFsc2U7ZWxzZSBpZiAoY2ggPT09IFwiL1wiICYmICFpbkNsYXNzKSBicmVhaztcbiAgICAgIGVzY2FwZWQgPSBjaCA9PT0gXCJcXFxcXCI7XG4gICAgfSBlbHNlIGVzY2FwZWQgPSBmYWxzZTtcbiAgICArK3RoaXMucG9zO1xuICB9XG4gIHZhciBjb250ZW50ID0gdGhpcy5pbnB1dC5zbGljZShzdGFydCwgdGhpcy5wb3MpO1xuICArK3RoaXMucG9zO1xuICAvLyBOZWVkIHRvIHVzZSBgcmVhZFdvcmQxYCBiZWNhdXNlICdcXHVYWFhYJyBzZXF1ZW5jZXMgYXJlIGFsbG93ZWRcbiAgLy8gaGVyZSAoZG9uJ3QgYXNrKS5cbiAgdmFyIG1vZHMgPSB0aGlzLnJlYWRXb3JkMSgpO1xuICB2YXIgdG1wID0gY29udGVudDtcbiAgaWYgKG1vZHMpIHtcbiAgICB2YXIgdmFsaWRGbGFncyA9IC9eW2dtc2l5XSokLztcbiAgICBpZiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpIHZhbGlkRmxhZ3MgPSAvXltnbXNpeXVdKiQvO1xuICAgIGlmICghdmFsaWRGbGFncy50ZXN0KG1vZHMpKSB0aGlzLnJhaXNlKHN0YXJ0LCBcIkludmFsaWQgcmVndWxhciBleHByZXNzaW9uIGZsYWdcIik7XG4gICAgaWYgKG1vZHMuaW5kZXhPZigndScpID49IDAgJiYgIXJlZ2V4cFVuaWNvZGVTdXBwb3J0KSB7XG4gICAgICAvLyBSZXBsYWNlIGVhY2ggYXN0cmFsIHN5bWJvbCBhbmQgZXZlcnkgVW5pY29kZSBlc2NhcGUgc2VxdWVuY2UgdGhhdFxuICAgICAgLy8gcG9zc2libHkgcmVwcmVzZW50cyBhbiBhc3RyYWwgc3ltYm9sIG9yIGEgcGFpcmVkIHN1cnJvZ2F0ZSB3aXRoIGFcbiAgICAgIC8vIHNpbmdsZSBBU0NJSSBzeW1ib2wgdG8gYXZvaWQgdGhyb3dpbmcgb24gcmVndWxhciBleHByZXNzaW9ucyB0aGF0XG4gICAgICAvLyBhcmUgb25seSB2YWxpZCBpbiBjb21iaW5hdGlvbiB3aXRoIHRoZSBgL3VgIGZsYWcuXG4gICAgICAvLyBOb3RlOiByZXBsYWNpbmcgd2l0aCB0aGUgQVNDSUkgc3ltYm9sIGB4YCBtaWdodCBjYXVzZSBmYWxzZVxuICAgICAgLy8gbmVnYXRpdmVzIGluIHVubGlrZWx5IHNjZW5hcmlvcy4gRm9yIGV4YW1wbGUsIGBbXFx1ezYxfS1iXWAgaXMgYVxuICAgICAgLy8gcGVyZmVjdGx5IHZhbGlkIHBhdHRlcm4gdGhhdCBpcyBlcXVpdmFsZW50IHRvIGBbYS1iXWAsIGJ1dCBpdCB3b3VsZFxuICAgICAgLy8gYmUgcmVwbGFjZWQgYnkgYFt4LWJdYCB3aGljaCB0aHJvd3MgYW4gZXJyb3IuXG4gICAgICB0bXAgPSB0bXAucmVwbGFjZSgvXFxcXHVcXHsoWzAtOWEtZkEtRl0rKVxcfS9nLCBmdW5jdGlvbiAobWF0Y2gsIGNvZGUsIG9mZnNldCkge1xuICAgICAgICBjb2RlID0gTnVtYmVyKFwiMHhcIiArIGNvZGUpO1xuICAgICAgICBpZiAoY29kZSA+IDB4MTBGRkZGKSBfdGhpcy5yYWlzZShzdGFydCArIG9mZnNldCArIDMsIFwiQ29kZSBwb2ludCBvdXQgb2YgYm91bmRzXCIpO1xuICAgICAgICByZXR1cm4gXCJ4XCI7XG4gICAgICB9KTtcbiAgICAgIHRtcCA9IHRtcC5yZXBsYWNlKC9cXFxcdShbYS1mQS1GMC05XXs0fSl8W1xcdUQ4MDAtXFx1REJGRl1bXFx1REMwMC1cXHVERkZGXS9nLCBcInhcIik7XG4gICAgfVxuICB9XG4gIC8vIERldGVjdCBpbnZhbGlkIHJlZ3VsYXIgZXhwcmVzc2lvbnMuXG4gIHZhciB2YWx1ZSA9IG51bGw7XG4gIC8vIFJoaW5vJ3MgcmVndWxhciBleHByZXNzaW9uIHBhcnNlciBpcyBmbGFreSBhbmQgdGhyb3dzIHVuY2F0Y2hhYmxlIGV4Y2VwdGlvbnMsXG4gIC8vIHNvIGRvbid0IGRvIGRldGVjdGlvbiBpZiB3ZSBhcmUgcnVubmluZyB1bmRlciBSaGlub1xuICBpZiAoIWlzUmhpbm8pIHtcbiAgICB0cnlDcmVhdGVSZWdleHAodG1wLCB1bmRlZmluZWQsIHN0YXJ0KTtcbiAgICAvLyBHZXQgYSByZWd1bGFyIGV4cHJlc3Npb24gb2JqZWN0IGZvciB0aGlzIHBhdHRlcm4tZmxhZyBwYWlyLCBvciBgbnVsbGAgaW5cbiAgICAvLyBjYXNlIHRoZSBjdXJyZW50IGVudmlyb25tZW50IGRvZXNuJ3Qgc3VwcG9ydCB0aGUgZmxhZ3MgaXQgdXNlcy5cbiAgICB2YWx1ZSA9IHRyeUNyZWF0ZVJlZ2V4cChjb250ZW50LCBtb2RzKTtcbiAgfVxuICByZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLnJlZ2V4cCwgeyBwYXR0ZXJuOiBjb250ZW50LCBmbGFnczogbW9kcywgdmFsdWU6IHZhbHVlIH0pO1xufTtcblxuLy8gUmVhZCBhbiBpbnRlZ2VyIGluIHRoZSBnaXZlbiByYWRpeC4gUmV0dXJuIG51bGwgaWYgemVybyBkaWdpdHNcbi8vIHdlcmUgcmVhZCwgdGhlIGludGVnZXIgdmFsdWUgb3RoZXJ3aXNlLiBXaGVuIGBsZW5gIGlzIGdpdmVuLCB0aGlzXG4vLyB3aWxsIHJldHVybiBgbnVsbGAgdW5sZXNzIHRoZSBpbnRlZ2VyIGhhcyBleGFjdGx5IGBsZW5gIGRpZ2l0cy5cblxucHAucmVhZEludCA9IGZ1bmN0aW9uIChyYWRpeCwgbGVuKSB7XG4gIHZhciBzdGFydCA9IHRoaXMucG9zLFxuICAgICAgdG90YWwgPSAwO1xuICBmb3IgKHZhciBpID0gMCwgZSA9IGxlbiA9PSBudWxsID8gSW5maW5pdHkgOiBsZW47IGkgPCBlOyArK2kpIHtcbiAgICB2YXIgY29kZSA9IHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyksXG4gICAgICAgIHZhbCA9IHVuZGVmaW5lZDtcbiAgICBpZiAoY29kZSA+PSA5NykgdmFsID0gY29kZSAtIDk3ICsgMTA7IC8vIGFcbiAgICBlbHNlIGlmIChjb2RlID49IDY1KSB2YWwgPSBjb2RlIC0gNjUgKyAxMDsgLy8gQVxuICAgICAgZWxzZSBpZiAoY29kZSA+PSA0OCAmJiBjb2RlIDw9IDU3KSB2YWwgPSBjb2RlIC0gNDg7IC8vIDAtOVxuICAgICAgICBlbHNlIHZhbCA9IEluZmluaXR5O1xuICAgIGlmICh2YWwgPj0gcmFkaXgpIGJyZWFrO1xuICAgICsrdGhpcy5wb3M7XG4gICAgdG90YWwgPSB0b3RhbCAqIHJhZGl4ICsgdmFsO1xuICB9XG4gIGlmICh0aGlzLnBvcyA9PT0gc3RhcnQgfHwgbGVuICE9IG51bGwgJiYgdGhpcy5wb3MgLSBzdGFydCAhPT0gbGVuKSByZXR1cm4gbnVsbDtcblxuICByZXR1cm4gdG90YWw7XG59O1xuXG5wcC5yZWFkUmFkaXhOdW1iZXIgPSBmdW5jdGlvbiAocmFkaXgpIHtcbiAgdGhpcy5wb3MgKz0gMjsgLy8gMHhcbiAgdmFyIHZhbCA9IHRoaXMucmVhZEludChyYWRpeCk7XG4gIGlmICh2YWwgPT0gbnVsbCkgdGhpcy5yYWlzZSh0aGlzLnN0YXJ0ICsgMiwgXCJFeHBlY3RlZCBudW1iZXIgaW4gcmFkaXggXCIgKyByYWRpeCk7XG4gIGlmIChfaWRlbnRpZmllci5pc0lkZW50aWZpZXJTdGFydCh0aGlzLmZ1bGxDaGFyQ29kZUF0UG9zKCkpKSB0aGlzLnJhaXNlKHRoaXMucG9zLCBcIklkZW50aWZpZXIgZGlyZWN0bHkgYWZ0ZXIgbnVtYmVyXCIpO1xuICByZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLm51bSwgdmFsKTtcbn07XG5cbi8vIFJlYWQgYW4gaW50ZWdlciwgb2N0YWwgaW50ZWdlciwgb3IgZmxvYXRpbmctcG9pbnQgbnVtYmVyLlxuXG5wcC5yZWFkTnVtYmVyID0gZnVuY3Rpb24gKHN0YXJ0c1dpdGhEb3QpIHtcbiAgdmFyIHN0YXJ0ID0gdGhpcy5wb3MsXG4gICAgICBpc0Zsb2F0ID0gZmFsc2UsXG4gICAgICBvY3RhbCA9IHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcykgPT09IDQ4O1xuICBpZiAoIXN0YXJ0c1dpdGhEb3QgJiYgdGhpcy5yZWFkSW50KDEwKSA9PT0gbnVsbCkgdGhpcy5yYWlzZShzdGFydCwgXCJJbnZhbGlkIG51bWJlclwiKTtcbiAgdmFyIG5leHQgPSB0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MpO1xuICBpZiAobmV4dCA9PT0gNDYpIHtcbiAgICAvLyAnLidcbiAgICArK3RoaXMucG9zO1xuICAgIHRoaXMucmVhZEludCgxMCk7XG4gICAgaXNGbG9hdCA9IHRydWU7XG4gICAgbmV4dCA9IHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyk7XG4gIH1cbiAgaWYgKG5leHQgPT09IDY5IHx8IG5leHQgPT09IDEwMSkge1xuICAgIC8vICdlRSdcbiAgICBuZXh0ID0gdGhpcy5pbnB1dC5jaGFyQ29kZUF0KCsrdGhpcy5wb3MpO1xuICAgIGlmIChuZXh0ID09PSA0MyB8fCBuZXh0ID09PSA0NSkgKyt0aGlzLnBvczsgLy8gJystJ1xuICAgIGlmICh0aGlzLnJlYWRJbnQoMTApID09PSBudWxsKSB0aGlzLnJhaXNlKHN0YXJ0LCBcIkludmFsaWQgbnVtYmVyXCIpO1xuICAgIGlzRmxvYXQgPSB0cnVlO1xuICB9XG4gIGlmIChfaWRlbnRpZmllci5pc0lkZW50aWZpZXJTdGFydCh0aGlzLmZ1bGxDaGFyQ29kZUF0UG9zKCkpKSB0aGlzLnJhaXNlKHRoaXMucG9zLCBcIklkZW50aWZpZXIgZGlyZWN0bHkgYWZ0ZXIgbnVtYmVyXCIpO1xuXG4gIHZhciBzdHIgPSB0aGlzLmlucHV0LnNsaWNlKHN0YXJ0LCB0aGlzLnBvcyksXG4gICAgICB2YWwgPSB1bmRlZmluZWQ7XG4gIGlmIChpc0Zsb2F0KSB2YWwgPSBwYXJzZUZsb2F0KHN0cik7ZWxzZSBpZiAoIW9jdGFsIHx8IHN0ci5sZW5ndGggPT09IDEpIHZhbCA9IHBhcnNlSW50KHN0ciwgMTApO2Vsc2UgaWYgKC9bODldLy50ZXN0KHN0cikgfHwgdGhpcy5zdHJpY3QpIHRoaXMucmFpc2Uoc3RhcnQsIFwiSW52YWxpZCBudW1iZXJcIik7ZWxzZSB2YWwgPSBwYXJzZUludChzdHIsIDgpO1xuICByZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLm51bSwgdmFsKTtcbn07XG5cbi8vIFJlYWQgYSBzdHJpbmcgdmFsdWUsIGludGVycHJldGluZyBiYWNrc2xhc2gtZXNjYXBlcy5cblxucHAucmVhZENvZGVQb2ludCA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIGNoID0gdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zKSxcbiAgICAgIGNvZGUgPSB1bmRlZmluZWQ7XG5cbiAgaWYgKGNoID09PSAxMjMpIHtcbiAgICBpZiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uIDwgNikgdGhpcy51bmV4cGVjdGVkKCk7XG4gICAgdmFyIGNvZGVQb3MgPSArK3RoaXMucG9zO1xuICAgIGNvZGUgPSB0aGlzLnJlYWRIZXhDaGFyKHRoaXMuaW5wdXQuaW5kZXhPZignfScsIHRoaXMucG9zKSAtIHRoaXMucG9zKTtcbiAgICArK3RoaXMucG9zO1xuICAgIGlmIChjb2RlID4gMHgxMEZGRkYpIHRoaXMucmFpc2UoY29kZVBvcywgXCJDb2RlIHBvaW50IG91dCBvZiBib3VuZHNcIik7XG4gIH0gZWxzZSB7XG4gICAgY29kZSA9IHRoaXMucmVhZEhleENoYXIoNCk7XG4gIH1cbiAgcmV0dXJuIGNvZGU7XG59O1xuXG5mdW5jdGlvbiBjb2RlUG9pbnRUb1N0cmluZyhjb2RlKSB7XG4gIC8vIFVURi0xNiBEZWNvZGluZ1xuICBpZiAoY29kZSA8PSAweEZGRkYpIHJldHVybiBTdHJpbmcuZnJvbUNoYXJDb2RlKGNvZGUpO1xuICBjb2RlIC09IDB4MTAwMDA7XG4gIHJldHVybiBTdHJpbmcuZnJvbUNoYXJDb2RlKChjb2RlID4+IDEwKSArIDB4RDgwMCwgKGNvZGUgJiAxMDIzKSArIDB4REMwMCk7XG59XG5cbnBwLnJlYWRTdHJpbmcgPSBmdW5jdGlvbiAocXVvdGUpIHtcbiAgdmFyIG91dCA9IFwiXCIsXG4gICAgICBjaHVua1N0YXJ0ID0gKyt0aGlzLnBvcztcbiAgZm9yICg7Oykge1xuICAgIGlmICh0aGlzLnBvcyA+PSB0aGlzLmlucHV0Lmxlbmd0aCkgdGhpcy5yYWlzZSh0aGlzLnN0YXJ0LCBcIlVudGVybWluYXRlZCBzdHJpbmcgY29uc3RhbnRcIik7XG4gICAgdmFyIGNoID0gdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zKTtcbiAgICBpZiAoY2ggPT09IHF1b3RlKSBicmVhaztcbiAgICBpZiAoY2ggPT09IDkyKSB7XG4gICAgICAvLyAnXFwnXG4gICAgICBvdXQgKz0gdGhpcy5pbnB1dC5zbGljZShjaHVua1N0YXJ0LCB0aGlzLnBvcyk7XG4gICAgICBvdXQgKz0gdGhpcy5yZWFkRXNjYXBlZENoYXIoZmFsc2UpO1xuICAgICAgY2h1bmtTdGFydCA9IHRoaXMucG9zO1xuICAgIH0gZWxzZSB7XG4gICAgICBpZiAoX3doaXRlc3BhY2UuaXNOZXdMaW5lKGNoKSkgdGhpcy5yYWlzZSh0aGlzLnN0YXJ0LCBcIlVudGVybWluYXRlZCBzdHJpbmcgY29uc3RhbnRcIik7XG4gICAgICArK3RoaXMucG9zO1xuICAgIH1cbiAgfVxuICBvdXQgKz0gdGhpcy5pbnB1dC5zbGljZShjaHVua1N0YXJ0LCB0aGlzLnBvcysrKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoVG9rZW4oX3Rva2VudHlwZS50eXBlcy5zdHJpbmcsIG91dCk7XG59O1xuXG4vLyBSZWFkcyB0ZW1wbGF0ZSBzdHJpbmcgdG9rZW5zLlxuXG5wcC5yZWFkVG1wbFRva2VuID0gZnVuY3Rpb24gKCkge1xuICB2YXIgb3V0ID0gXCJcIixcbiAgICAgIGNodW5rU3RhcnQgPSB0aGlzLnBvcztcbiAgZm9yICg7Oykge1xuICAgIGlmICh0aGlzLnBvcyA+PSB0aGlzLmlucHV0Lmxlbmd0aCkgdGhpcy5yYWlzZSh0aGlzLnN0YXJ0LCBcIlVudGVybWluYXRlZCB0ZW1wbGF0ZVwiKTtcbiAgICB2YXIgY2ggPSB0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MpO1xuICAgIGlmIChjaCA9PT0gOTYgfHwgY2ggPT09IDM2ICYmIHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDEpID09PSAxMjMpIHtcbiAgICAgIC8vICdgJywgJyR7J1xuICAgICAgaWYgKHRoaXMucG9zID09PSB0aGlzLnN0YXJ0ICYmIHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy50ZW1wbGF0ZSkge1xuICAgICAgICBpZiAoY2ggPT09IDM2KSB7XG4gICAgICAgICAgdGhpcy5wb3MgKz0gMjtcbiAgICAgICAgICByZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLmRvbGxhckJyYWNlTCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgKyt0aGlzLnBvcztcbiAgICAgICAgICByZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLmJhY2tRdW90ZSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIG91dCArPSB0aGlzLmlucHV0LnNsaWNlKGNodW5rU3RhcnQsIHRoaXMucG9zKTtcbiAgICAgIHJldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMudGVtcGxhdGUsIG91dCk7XG4gICAgfVxuICAgIGlmIChjaCA9PT0gOTIpIHtcbiAgICAgIC8vICdcXCdcbiAgICAgIG91dCArPSB0aGlzLmlucHV0LnNsaWNlKGNodW5rU3RhcnQsIHRoaXMucG9zKTtcbiAgICAgIG91dCArPSB0aGlzLnJlYWRFc2NhcGVkQ2hhcih0cnVlKTtcbiAgICAgIGNodW5rU3RhcnQgPSB0aGlzLnBvcztcbiAgICB9IGVsc2UgaWYgKF93aGl0ZXNwYWNlLmlzTmV3TGluZShjaCkpIHtcbiAgICAgIG91dCArPSB0aGlzLmlucHV0LnNsaWNlKGNodW5rU3RhcnQsIHRoaXMucG9zKTtcbiAgICAgICsrdGhpcy5wb3M7XG4gICAgICBzd2l0Y2ggKGNoKSB7XG4gICAgICAgIGNhc2UgMTM6XG4gICAgICAgICAgaWYgKHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcykgPT09IDEwKSArK3RoaXMucG9zO1xuICAgICAgICBjYXNlIDEwOlxuICAgICAgICAgIG91dCArPSBcIlxcblwiO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgIG91dCArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKGNoKTtcbiAgICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9jYXRpb25zKSB7XG4gICAgICAgICsrdGhpcy5jdXJMaW5lO1xuICAgICAgICB0aGlzLmxpbmVTdGFydCA9IHRoaXMucG9zO1xuICAgICAgfVxuICAgICAgY2h1bmtTdGFydCA9IHRoaXMucG9zO1xuICAgIH0gZWxzZSB7XG4gICAgICArK3RoaXMucG9zO1xuICAgIH1cbiAgfVxufTtcblxuLy8gVXNlZCB0byByZWFkIGVzY2FwZWQgY2hhcmFjdGVyc1xuXG5wcC5yZWFkRXNjYXBlZENoYXIgPSBmdW5jdGlvbiAoaW5UZW1wbGF0ZSkge1xuICB2YXIgY2ggPSB0aGlzLmlucHV0LmNoYXJDb2RlQXQoKyt0aGlzLnBvcyk7XG4gICsrdGhpcy5wb3M7XG4gIHN3aXRjaCAoY2gpIHtcbiAgICBjYXNlIDExMDpcbiAgICAgIHJldHVybiBcIlxcblwiOyAvLyAnbicgLT4gJ1xcbidcbiAgICBjYXNlIDExNDpcbiAgICAgIHJldHVybiBcIlxcclwiOyAvLyAncicgLT4gJ1xccidcbiAgICBjYXNlIDEyMDpcbiAgICAgIHJldHVybiBTdHJpbmcuZnJvbUNoYXJDb2RlKHRoaXMucmVhZEhleENoYXIoMikpOyAvLyAneCdcbiAgICBjYXNlIDExNzpcbiAgICAgIHJldHVybiBjb2RlUG9pbnRUb1N0cmluZyh0aGlzLnJlYWRDb2RlUG9pbnQoKSk7IC8vICd1J1xuICAgIGNhc2UgMTE2OlxuICAgICAgcmV0dXJuIFwiXFx0XCI7IC8vICd0JyAtPiAnXFx0J1xuICAgIGNhc2UgOTg6XG4gICAgICByZXR1cm4gXCJcXGJcIjsgLy8gJ2InIC0+ICdcXGInXG4gICAgY2FzZSAxMTg6XG4gICAgICByZXR1cm4gXCJcXHUwMDBiXCI7IC8vICd2JyAtPiAnXFx1MDAwYidcbiAgICBjYXNlIDEwMjpcbiAgICAgIHJldHVybiBcIlxcZlwiOyAvLyAnZicgLT4gJ1xcZidcbiAgICBjYXNlIDEzOlxuICAgICAgaWYgKHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcykgPT09IDEwKSArK3RoaXMucG9zOyAvLyAnXFxyXFxuJ1xuICAgIGNhc2UgMTA6XG4gICAgICAvLyAnIFxcbidcbiAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9jYXRpb25zKSB7XG4gICAgICAgIHRoaXMubGluZVN0YXJ0ID0gdGhpcy5wb3M7Kyt0aGlzLmN1ckxpbmU7XG4gICAgICB9XG4gICAgICByZXR1cm4gXCJcIjtcbiAgICBkZWZhdWx0OlxuICAgICAgaWYgKGNoID49IDQ4ICYmIGNoIDw9IDU1KSB7XG4gICAgICAgIHZhciBvY3RhbFN0ciA9IHRoaXMuaW5wdXQuc3Vic3RyKHRoaXMucG9zIC0gMSwgMykubWF0Y2goL15bMC03XSsvKVswXTtcbiAgICAgICAgdmFyIG9jdGFsID0gcGFyc2VJbnQob2N0YWxTdHIsIDgpO1xuICAgICAgICBpZiAob2N0YWwgPiAyNTUpIHtcbiAgICAgICAgICBvY3RhbFN0ciA9IG9jdGFsU3RyLnNsaWNlKDAsIC0xKTtcbiAgICAgICAgICBvY3RhbCA9IHBhcnNlSW50KG9jdGFsU3RyLCA4KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAob2N0YWwgPiAwICYmICh0aGlzLnN0cmljdCB8fCBpblRlbXBsYXRlKSkge1xuICAgICAgICAgIHRoaXMucmFpc2UodGhpcy5wb3MgLSAyLCBcIk9jdGFsIGxpdGVyYWwgaW4gc3RyaWN0IG1vZGVcIik7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5wb3MgKz0gb2N0YWxTdHIubGVuZ3RoIC0gMTtcbiAgICAgICAgcmV0dXJuIFN0cmluZy5mcm9tQ2hhckNvZGUob2N0YWwpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIFN0cmluZy5mcm9tQ2hhckNvZGUoY2gpO1xuICB9XG59O1xuXG4vLyBVc2VkIHRvIHJlYWQgY2hhcmFjdGVyIGVzY2FwZSBzZXF1ZW5jZXMgKCdcXHgnLCAnXFx1JywgJ1xcVScpLlxuXG5wcC5yZWFkSGV4Q2hhciA9IGZ1bmN0aW9uIChsZW4pIHtcbiAgdmFyIGNvZGVQb3MgPSB0aGlzLnBvcztcbiAgdmFyIG4gPSB0aGlzLnJlYWRJbnQoMTYsIGxlbik7XG4gIGlmIChuID09PSBudWxsKSB0aGlzLnJhaXNlKGNvZGVQb3MsIFwiQmFkIGNoYXJhY3RlciBlc2NhcGUgc2VxdWVuY2VcIik7XG4gIHJldHVybiBuO1xufTtcblxuLy8gUmVhZCBhbiBpZGVudGlmaWVyLCBhbmQgcmV0dXJuIGl0IGFzIGEgc3RyaW5nLiBTZXRzIGB0aGlzLmNvbnRhaW5zRXNjYFxuLy8gdG8gd2hldGhlciB0aGUgd29yZCBjb250YWluZWQgYSAnXFx1JyBlc2NhcGUuXG4vL1xuLy8gSW5jcmVtZW50YWxseSBhZGRzIG9ubHkgZXNjYXBlZCBjaGFycywgYWRkaW5nIG90aGVyIGNodW5rcyBhcy1pc1xuLy8gYXMgYSBtaWNyby1vcHRpbWl6YXRpb24uXG5cbnBwLnJlYWRXb3JkMSA9IGZ1bmN0aW9uICgpIHtcbiAgdGhpcy5jb250YWluc0VzYyA9IGZhbHNlO1xuICB2YXIgd29yZCA9IFwiXCIsXG4gICAgICBmaXJzdCA9IHRydWUsXG4gICAgICBjaHVua1N0YXJ0ID0gdGhpcy5wb3M7XG4gIHZhciBhc3RyYWwgPSB0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNjtcbiAgd2hpbGUgKHRoaXMucG9zIDwgdGhpcy5pbnB1dC5sZW5ndGgpIHtcbiAgICB2YXIgY2ggPSB0aGlzLmZ1bGxDaGFyQ29kZUF0UG9zKCk7XG4gICAgaWYgKF9pZGVudGlmaWVyLmlzSWRlbnRpZmllckNoYXIoY2gsIGFzdHJhbCkpIHtcbiAgICAgIHRoaXMucG9zICs9IGNoIDw9IDB4ZmZmZiA/IDEgOiAyO1xuICAgIH0gZWxzZSBpZiAoY2ggPT09IDkyKSB7XG4gICAgICAvLyBcIlxcXCJcbiAgICAgIHRoaXMuY29udGFpbnNFc2MgPSB0cnVlO1xuICAgICAgd29yZCArPSB0aGlzLmlucHV0LnNsaWNlKGNodW5rU3RhcnQsIHRoaXMucG9zKTtcbiAgICAgIHZhciBlc2NTdGFydCA9IHRoaXMucG9zO1xuICAgICAgaWYgKHRoaXMuaW5wdXQuY2hhckNvZGVBdCgrK3RoaXMucG9zKSAhPSAxMTcpIC8vIFwidVwiXG4gICAgICAgIHRoaXMucmFpc2UodGhpcy5wb3MsIFwiRXhwZWN0aW5nIFVuaWNvZGUgZXNjYXBlIHNlcXVlbmNlIFxcXFx1WFhYWFwiKTtcbiAgICAgICsrdGhpcy5wb3M7XG4gICAgICB2YXIgZXNjID0gdGhpcy5yZWFkQ29kZVBvaW50KCk7XG4gICAgICBpZiAoIShmaXJzdCA/IF9pZGVudGlmaWVyLmlzSWRlbnRpZmllclN0YXJ0IDogX2lkZW50aWZpZXIuaXNJZGVudGlmaWVyQ2hhcikoZXNjLCBhc3RyYWwpKSB0aGlzLnJhaXNlKGVzY1N0YXJ0LCBcIkludmFsaWQgVW5pY29kZSBlc2NhcGVcIik7XG4gICAgICB3b3JkICs9IGNvZGVQb2ludFRvU3RyaW5nKGVzYyk7XG4gICAgICBjaHVua1N0YXJ0ID0gdGhpcy5wb3M7XG4gICAgfSBlbHNlIHtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBmaXJzdCA9IGZhbHNlO1xuICB9XG4gIHJldHVybiB3b3JkICsgdGhpcy5pbnB1dC5zbGljZShjaHVua1N0YXJ0LCB0aGlzLnBvcyk7XG59O1xuXG4vLyBSZWFkIGFuIGlkZW50aWZpZXIgb3Iga2V5d29yZCB0b2tlbi4gV2lsbCBjaGVjayBmb3IgcmVzZXJ2ZWRcbi8vIHdvcmRzIHdoZW4gbmVjZXNzYXJ5LlxuXG5wcC5yZWFkV29yZCA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIHdvcmQgPSB0aGlzLnJlYWRXb3JkMSgpO1xuICB2YXIgdHlwZSA9IF90b2tlbnR5cGUudHlwZXMubmFtZTtcbiAgaWYgKCh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNiB8fCAhdGhpcy5jb250YWluc0VzYykgJiYgdGhpcy5pc0tleXdvcmQod29yZCkpIHR5cGUgPSBfdG9rZW50eXBlLmtleXdvcmRzW3dvcmRdO1xuICByZXR1cm4gdGhpcy5maW5pc2hUb2tlbih0eXBlLCB3b3JkKTtcbn07XG5cbn0se1wiLi9pZGVudGlmaWVyXCI6MixcIi4vbG9jdXRpbFwiOjUsXCIuL3N0YXRlXCI6MTAsXCIuL3Rva2VudHlwZVwiOjE0LFwiLi93aGl0ZXNwYWNlXCI6MTZ9XSwxNDpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7XG4vLyAjIyBUb2tlbiB0eXBlc1xuXG4vLyBUaGUgYXNzaWdubWVudCBvZiBmaW5lLWdyYWluZWQsIGluZm9ybWF0aW9uLWNhcnJ5aW5nIHR5cGUgb2JqZWN0c1xuLy8gYWxsb3dzIHRoZSB0b2tlbml6ZXIgdG8gc3RvcmUgdGhlIGluZm9ybWF0aW9uIGl0IGhhcyBhYm91dCBhXG4vLyB0b2tlbiBpbiBhIHdheSB0aGF0IGlzIHZlcnkgY2hlYXAgZm9yIHRoZSBwYXJzZXIgdG8gbG9vayB1cC5cblxuLy8gQWxsIHRva2VuIHR5cGUgdmFyaWFibGVzIHN0YXJ0IHdpdGggYW4gdW5kZXJzY29yZSwgdG8gbWFrZSB0aGVtXG4vLyBlYXN5IHRvIHJlY29nbml6ZS5cblxuLy8gVGhlIGBiZWZvcmVFeHByYCBwcm9wZXJ0eSBpcyB1c2VkIHRvIGRpc2FtYmlndWF0ZSBiZXR3ZWVuIHJlZ3VsYXJcbi8vIGV4cHJlc3Npb25zIGFuZCBkaXZpc2lvbnMuIEl0IGlzIHNldCBvbiBhbGwgdG9rZW4gdHlwZXMgdGhhdCBjYW5cbi8vIGJlIGZvbGxvd2VkIGJ5IGFuIGV4cHJlc3Npb24gKHRodXMsIGEgc2xhc2ggYWZ0ZXIgdGhlbSB3b3VsZCBiZSBhXG4vLyByZWd1bGFyIGV4cHJlc3Npb24pLlxuLy9cbi8vIGBpc0xvb3BgIG1hcmtzIGEga2V5d29yZCBhcyBzdGFydGluZyBhIGxvb3AsIHdoaWNoIGlzIGltcG9ydGFudFxuLy8gdG8ga25vdyB3aGVuIHBhcnNpbmcgYSBsYWJlbCwgaW4gb3JkZXIgdG8gYWxsb3cgb3IgZGlzYWxsb3dcbi8vIGNvbnRpbnVlIGp1bXBzIHRvIHRoYXQgbGFiZWwuXG5cblwidXNlIHN0cmljdFwiO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuXG5mdW5jdGlvbiBfY2xhc3NDYWxsQ2hlY2soaW5zdGFuY2UsIENvbnN0cnVjdG9yKSB7IGlmICghKGluc3RhbmNlIGluc3RhbmNlb2YgQ29uc3RydWN0b3IpKSB7IHRocm93IG5ldyBUeXBlRXJyb3IoXCJDYW5ub3QgY2FsbCBhIGNsYXNzIGFzIGEgZnVuY3Rpb25cIik7IH0gfVxuXG52YXIgVG9rZW5UeXBlID0gZnVuY3Rpb24gVG9rZW5UeXBlKGxhYmVsKSB7XG4gIHZhciBjb25mID0gYXJndW1lbnRzLmxlbmd0aCA8PSAxIHx8IGFyZ3VtZW50c1sxXSA9PT0gdW5kZWZpbmVkID8ge30gOiBhcmd1bWVudHNbMV07XG5cbiAgX2NsYXNzQ2FsbENoZWNrKHRoaXMsIFRva2VuVHlwZSk7XG5cbiAgdGhpcy5sYWJlbCA9IGxhYmVsO1xuICB0aGlzLmtleXdvcmQgPSBjb25mLmtleXdvcmQ7XG4gIHRoaXMuYmVmb3JlRXhwciA9ICEhY29uZi5iZWZvcmVFeHByO1xuICB0aGlzLnN0YXJ0c0V4cHIgPSAhIWNvbmYuc3RhcnRzRXhwcjtcbiAgdGhpcy5pc0xvb3AgPSAhIWNvbmYuaXNMb29wO1xuICB0aGlzLmlzQXNzaWduID0gISFjb25mLmlzQXNzaWduO1xuICB0aGlzLnByZWZpeCA9ICEhY29uZi5wcmVmaXg7XG4gIHRoaXMucG9zdGZpeCA9ICEhY29uZi5wb3N0Zml4O1xuICB0aGlzLmJpbm9wID0gY29uZi5iaW5vcCB8fCBudWxsO1xuICB0aGlzLnVwZGF0ZUNvbnRleHQgPSBudWxsO1xufTtcblxuZXhwb3J0cy5Ub2tlblR5cGUgPSBUb2tlblR5cGU7XG5cbmZ1bmN0aW9uIGJpbm9wKG5hbWUsIHByZWMpIHtcbiAgcmV0dXJuIG5ldyBUb2tlblR5cGUobmFtZSwgeyBiZWZvcmVFeHByOiB0cnVlLCBiaW5vcDogcHJlYyB9KTtcbn1cbnZhciBiZWZvcmVFeHByID0geyBiZWZvcmVFeHByOiB0cnVlIH0sXG4gICAgc3RhcnRzRXhwciA9IHsgc3RhcnRzRXhwcjogdHJ1ZSB9O1xuXG52YXIgdHlwZXMgPSB7XG4gIG51bTogbmV3IFRva2VuVHlwZShcIm51bVwiLCBzdGFydHNFeHByKSxcbiAgcmVnZXhwOiBuZXcgVG9rZW5UeXBlKFwicmVnZXhwXCIsIHN0YXJ0c0V4cHIpLFxuICBzdHJpbmc6IG5ldyBUb2tlblR5cGUoXCJzdHJpbmdcIiwgc3RhcnRzRXhwciksXG4gIG5hbWU6IG5ldyBUb2tlblR5cGUoXCJuYW1lXCIsIHN0YXJ0c0V4cHIpLFxuICBlb2Y6IG5ldyBUb2tlblR5cGUoXCJlb2ZcIiksXG5cbiAgLy8gUHVuY3R1YXRpb24gdG9rZW4gdHlwZXMuXG4gIGJyYWNrZXRMOiBuZXcgVG9rZW5UeXBlKFwiW1wiLCB7IGJlZm9yZUV4cHI6IHRydWUsIHN0YXJ0c0V4cHI6IHRydWUgfSksXG4gIGJyYWNrZXRSOiBuZXcgVG9rZW5UeXBlKFwiXVwiKSxcbiAgYnJhY2VMOiBuZXcgVG9rZW5UeXBlKFwie1wiLCB7IGJlZm9yZUV4cHI6IHRydWUsIHN0YXJ0c0V4cHI6IHRydWUgfSksXG4gIGJyYWNlUjogbmV3IFRva2VuVHlwZShcIn1cIiksXG4gIHBhcmVuTDogbmV3IFRva2VuVHlwZShcIihcIiwgeyBiZWZvcmVFeHByOiB0cnVlLCBzdGFydHNFeHByOiB0cnVlIH0pLFxuICBwYXJlblI6IG5ldyBUb2tlblR5cGUoXCIpXCIpLFxuICBjb21tYTogbmV3IFRva2VuVHlwZShcIixcIiwgYmVmb3JlRXhwciksXG4gIHNlbWk6IG5ldyBUb2tlblR5cGUoXCI7XCIsIGJlZm9yZUV4cHIpLFxuICBjb2xvbjogbmV3IFRva2VuVHlwZShcIjpcIiwgYmVmb3JlRXhwciksXG4gIGRvdDogbmV3IFRva2VuVHlwZShcIi5cIiksXG4gIHF1ZXN0aW9uOiBuZXcgVG9rZW5UeXBlKFwiP1wiLCBiZWZvcmVFeHByKSxcbiAgYXJyb3c6IG5ldyBUb2tlblR5cGUoXCI9PlwiLCBiZWZvcmVFeHByKSxcbiAgdGVtcGxhdGU6IG5ldyBUb2tlblR5cGUoXCJ0ZW1wbGF0ZVwiKSxcbiAgZWxsaXBzaXM6IG5ldyBUb2tlblR5cGUoXCIuLi5cIiwgYmVmb3JlRXhwciksXG4gIGJhY2tRdW90ZTogbmV3IFRva2VuVHlwZShcImBcIiwgc3RhcnRzRXhwciksXG4gIGRvbGxhckJyYWNlTDogbmV3IFRva2VuVHlwZShcIiR7XCIsIHsgYmVmb3JlRXhwcjogdHJ1ZSwgc3RhcnRzRXhwcjogdHJ1ZSB9KSxcblxuICAvLyBPcGVyYXRvcnMuIFRoZXNlIGNhcnJ5IHNldmVyYWwga2luZHMgb2YgcHJvcGVydGllcyB0byBoZWxwIHRoZVxuICAvLyBwYXJzZXIgdXNlIHRoZW0gcHJvcGVybHkgKHRoZSBwcmVzZW5jZSBvZiB0aGVzZSBwcm9wZXJ0aWVzIGlzXG4gIC8vIHdoYXQgY2F0ZWdvcml6ZXMgdGhlbSBhcyBvcGVyYXRvcnMpLlxuICAvL1xuICAvLyBgYmlub3BgLCB3aGVuIHByZXNlbnQsIHNwZWNpZmllcyB0aGF0IHRoaXMgb3BlcmF0b3IgaXMgYSBiaW5hcnlcbiAgLy8gb3BlcmF0b3IsIGFuZCB3aWxsIHJlZmVyIHRvIGl0cyBwcmVjZWRlbmNlLlxuICAvL1xuICAvLyBgcHJlZml4YCBhbmQgYHBvc3RmaXhgIG1hcmsgdGhlIG9wZXJhdG9yIGFzIGEgcHJlZml4IG9yIHBvc3RmaXhcbiAgLy8gdW5hcnkgb3BlcmF0b3IuXG4gIC8vXG4gIC8vIGBpc0Fzc2lnbmAgbWFya3MgYWxsIG9mIGA9YCwgYCs9YCwgYC09YCBldGNldGVyYSwgd2hpY2ggYWN0IGFzXG4gIC8vIGJpbmFyeSBvcGVyYXRvcnMgd2l0aCBhIHZlcnkgbG93IHByZWNlZGVuY2UsIHRoYXQgc2hvdWxkIHJlc3VsdFxuICAvLyBpbiBBc3NpZ25tZW50RXhwcmVzc2lvbiBub2Rlcy5cblxuICBlcTogbmV3IFRva2VuVHlwZShcIj1cIiwgeyBiZWZvcmVFeHByOiB0cnVlLCBpc0Fzc2lnbjogdHJ1ZSB9KSxcbiAgYXNzaWduOiBuZXcgVG9rZW5UeXBlKFwiXz1cIiwgeyBiZWZvcmVFeHByOiB0cnVlLCBpc0Fzc2lnbjogdHJ1ZSB9KSxcbiAgaW5jRGVjOiBuZXcgVG9rZW5UeXBlKFwiKysvLS1cIiwgeyBwcmVmaXg6IHRydWUsIHBvc3RmaXg6IHRydWUsIHN0YXJ0c0V4cHI6IHRydWUgfSksXG4gIHByZWZpeDogbmV3IFRva2VuVHlwZShcInByZWZpeFwiLCB7IGJlZm9yZUV4cHI6IHRydWUsIHByZWZpeDogdHJ1ZSwgc3RhcnRzRXhwcjogdHJ1ZSB9KSxcbiAgbG9naWNhbE9SOiBiaW5vcChcInx8XCIsIDEpLFxuICBsb2dpY2FsQU5EOiBiaW5vcChcIiYmXCIsIDIpLFxuICBiaXR3aXNlT1I6IGJpbm9wKFwifFwiLCAzKSxcbiAgYml0d2lzZVhPUjogYmlub3AoXCJeXCIsIDQpLFxuICBiaXR3aXNlQU5EOiBiaW5vcChcIiZcIiwgNSksXG4gIGVxdWFsaXR5OiBiaW5vcChcIj09LyE9XCIsIDYpLFxuICByZWxhdGlvbmFsOiBiaW5vcChcIjwvPlwiLCA3KSxcbiAgYml0U2hpZnQ6IGJpbm9wKFwiPDwvPj5cIiwgOCksXG4gIHBsdXNNaW46IG5ldyBUb2tlblR5cGUoXCIrLy1cIiwgeyBiZWZvcmVFeHByOiB0cnVlLCBiaW5vcDogOSwgcHJlZml4OiB0cnVlLCBzdGFydHNFeHByOiB0cnVlIH0pLFxuICBtb2R1bG86IGJpbm9wKFwiJVwiLCAxMCksXG4gIHN0YXI6IGJpbm9wKFwiKlwiLCAxMCksXG4gIHNsYXNoOiBiaW5vcChcIi9cIiwgMTApXG59O1xuXG5leHBvcnRzLnR5cGVzID0gdHlwZXM7XG4vLyBNYXAga2V5d29yZCBuYW1lcyB0byB0b2tlbiB0eXBlcy5cblxudmFyIGtleXdvcmRzID0ge307XG5cbmV4cG9ydHMua2V5d29yZHMgPSBrZXl3b3Jkcztcbi8vIFN1Y2NpbmN0IGRlZmluaXRpb25zIG9mIGtleXdvcmQgdG9rZW4gdHlwZXNcbmZ1bmN0aW9uIGt3KG5hbWUpIHtcbiAgdmFyIG9wdGlvbnMgPSBhcmd1bWVudHMubGVuZ3RoIDw9IDEgfHwgYXJndW1lbnRzWzFdID09PSB1bmRlZmluZWQgPyB7fSA6IGFyZ3VtZW50c1sxXTtcblxuICBvcHRpb25zLmtleXdvcmQgPSBuYW1lO1xuICBrZXl3b3Jkc1tuYW1lXSA9IHR5cGVzW1wiX1wiICsgbmFtZV0gPSBuZXcgVG9rZW5UeXBlKG5hbWUsIG9wdGlvbnMpO1xufVxuXG5rdyhcImJyZWFrXCIpO1xua3coXCJjYXNlXCIsIGJlZm9yZUV4cHIpO1xua3coXCJjYXRjaFwiKTtcbmt3KFwiY29udGludWVcIik7XG5rdyhcImRlYnVnZ2VyXCIpO1xua3coXCJkZWZhdWx0XCIsIGJlZm9yZUV4cHIpO1xua3coXCJkb1wiLCB7IGlzTG9vcDogdHJ1ZSB9KTtcbmt3KFwiZWxzZVwiLCBiZWZvcmVFeHByKTtcbmt3KFwiZmluYWxseVwiKTtcbmt3KFwiZm9yXCIsIHsgaXNMb29wOiB0cnVlIH0pO1xua3coXCJmdW5jdGlvblwiLCBzdGFydHNFeHByKTtcbmt3KFwiaWZcIik7XG5rdyhcInJldHVyblwiLCBiZWZvcmVFeHByKTtcbmt3KFwic3dpdGNoXCIpO1xua3coXCJ0aHJvd1wiLCBiZWZvcmVFeHByKTtcbmt3KFwidHJ5XCIpO1xua3coXCJ2YXJcIik7XG5rdyhcImxldFwiKTtcbmt3KFwiY29uc3RcIik7XG5rdyhcIndoaWxlXCIsIHsgaXNMb29wOiB0cnVlIH0pO1xua3coXCJ3aXRoXCIpO1xua3coXCJuZXdcIiwgeyBiZWZvcmVFeHByOiB0cnVlLCBzdGFydHNFeHByOiB0cnVlIH0pO1xua3coXCJ0aGlzXCIsIHN0YXJ0c0V4cHIpO1xua3coXCJzdXBlclwiLCBzdGFydHNFeHByKTtcbmt3KFwiY2xhc3NcIik7XG5rdyhcImV4dGVuZHNcIiwgYmVmb3JlRXhwcik7XG5rdyhcImV4cG9ydFwiKTtcbmt3KFwiaW1wb3J0XCIpO1xua3coXCJ5aWVsZFwiLCB7IGJlZm9yZUV4cHI6IHRydWUsIHN0YXJ0c0V4cHI6IHRydWUgfSk7XG5rdyhcIm51bGxcIiwgc3RhcnRzRXhwcik7XG5rdyhcInRydWVcIiwgc3RhcnRzRXhwcik7XG5rdyhcImZhbHNlXCIsIHN0YXJ0c0V4cHIpO1xua3coXCJpblwiLCB7IGJlZm9yZUV4cHI6IHRydWUsIGJpbm9wOiA3IH0pO1xua3coXCJpbnN0YW5jZW9mXCIsIHsgYmVmb3JlRXhwcjogdHJ1ZSwgYmlub3A6IDcgfSk7XG5rdyhcInR5cGVvZlwiLCB7IGJlZm9yZUV4cHI6IHRydWUsIHByZWZpeDogdHJ1ZSwgc3RhcnRzRXhwcjogdHJ1ZSB9KTtcbmt3KFwidm9pZFwiLCB7IGJlZm9yZUV4cHI6IHRydWUsIHByZWZpeDogdHJ1ZSwgc3RhcnRzRXhwcjogdHJ1ZSB9KTtcbmt3KFwiZGVsZXRlXCIsIHsgYmVmb3JlRXhwcjogdHJ1ZSwgcHJlZml4OiB0cnVlLCBzdGFydHNFeHByOiB0cnVlIH0pO1xuXG59LHt9XSwxNTpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7XG5cInVzZSBzdHJpY3RcIjtcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcbmV4cG9ydHMuaXNBcnJheSA9IGlzQXJyYXk7XG5leHBvcnRzLmhhcyA9IGhhcztcblxuZnVuY3Rpb24gaXNBcnJheShvYmopIHtcbiAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChvYmopID09PSBcIltvYmplY3QgQXJyYXldXCI7XG59XG5cbi8vIENoZWNrcyBpZiBhbiBvYmplY3QgaGFzIGEgcHJvcGVydHkuXG5cbmZ1bmN0aW9uIGhhcyhvYmosIHByb3BOYW1lKSB7XG4gIHJldHVybiBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwob2JqLCBwcm9wTmFtZSk7XG59XG5cbn0se31dLDE2OltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXtcbi8vIE1hdGNoZXMgYSB3aG9sZSBsaW5lIGJyZWFrICh3aGVyZSBDUkxGIGlzIGNvbnNpZGVyZWQgYSBzaW5nbGVcbi8vIGxpbmUgYnJlYWspLiBVc2VkIHRvIGNvdW50IGxpbmVzLlxuXG5cInVzZSBzdHJpY3RcIjtcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcbmV4cG9ydHMuaXNOZXdMaW5lID0gaXNOZXdMaW5lO1xudmFyIGxpbmVCcmVhayA9IC9cXHJcXG4/fFxcbnxcXHUyMDI4fFxcdTIwMjkvO1xuZXhwb3J0cy5saW5lQnJlYWsgPSBsaW5lQnJlYWs7XG52YXIgbGluZUJyZWFrRyA9IG5ldyBSZWdFeHAobGluZUJyZWFrLnNvdXJjZSwgXCJnXCIpO1xuXG5leHBvcnRzLmxpbmVCcmVha0cgPSBsaW5lQnJlYWtHO1xuXG5mdW5jdGlvbiBpc05ld0xpbmUoY29kZSkge1xuICByZXR1cm4gY29kZSA9PT0gMTAgfHwgY29kZSA9PT0gMTMgfHwgY29kZSA9PT0gMHgyMDI4IHx8IGNvZGUgPT0gMHgyMDI5O1xufVxuXG52YXIgbm9uQVNDSUl3aGl0ZXNwYWNlID0gL1tcXHUxNjgwXFx1MTgwZVxcdTIwMDAtXFx1MjAwYVxcdTIwMmZcXHUyMDVmXFx1MzAwMFxcdWZlZmZdLztcbmV4cG9ydHMubm9uQVNDSUl3aGl0ZXNwYWNlID0gbm9uQVNDSUl3aGl0ZXNwYWNlO1xuXG59LHt9XX0se30sWzNdKSgzKVxufSk7IiwiKGZ1bmN0aW9uKGYpe2lmKHR5cGVvZiBleHBvcnRzPT09XCJvYmplY3RcIiYmdHlwZW9mIG1vZHVsZSE9PVwidW5kZWZpbmVkXCIpe21vZHVsZS5leHBvcnRzPWYoKX1lbHNlIGlmKHR5cGVvZiBkZWZpbmU9PT1cImZ1bmN0aW9uXCImJmRlZmluZS5hbWQpe2RlZmluZShbXSxmKX1lbHNle3ZhciBnO2lmKHR5cGVvZiB3aW5kb3chPT1cInVuZGVmaW5lZFwiKXtnPXdpbmRvd31lbHNlIGlmKHR5cGVvZiBnbG9iYWwhPT1cInVuZGVmaW5lZFwiKXtnPWdsb2JhbH1lbHNlIGlmKHR5cGVvZiBzZWxmIT09XCJ1bmRlZmluZWRcIil7Zz1zZWxmfWVsc2V7Zz10aGlzfShnLmFjb3JuIHx8IChnLmFjb3JuID0ge30pKS5sb29zZSA9IGYoKX19KShmdW5jdGlvbigpe3ZhciBkZWZpbmUsbW9kdWxlLGV4cG9ydHM7cmV0dXJuIChmdW5jdGlvbiBlKHQsbixyKXtmdW5jdGlvbiBzKG8sdSl7aWYoIW5bb10pe2lmKCF0W29dKXt2YXIgYT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2lmKCF1JiZhKXJldHVybiBhKG8sITApO2lmKGkpcmV0dXJuIGkobywhMCk7dmFyIGY9bmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitvK1wiJ1wiKTt0aHJvdyBmLmNvZGU9XCJNT0RVTEVfTk9UX0ZPVU5EXCIsZn12YXIgbD1uW29dPXtleHBvcnRzOnt9fTt0W29dWzBdLmNhbGwobC5leHBvcnRzLGZ1bmN0aW9uKGUpe3ZhciBuPXRbb11bMV1bZV07cmV0dXJuIHMobj9uOmUpfSxsLGwuZXhwb3J0cyxlLHQsbixyKX1yZXR1cm4gbltvXS5leHBvcnRzfXZhciBpPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7Zm9yKHZhciBvPTA7bzxyLmxlbmd0aDtvKyspcyhyW29dKTtyZXR1cm4gc30pKHsxOltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXtcbihmdW5jdGlvbiAoZ2xvYmFsKXtcblwidXNlIHN0cmljdFwiOyhmdW5jdGlvbihmKXtpZih0eXBlb2YgZXhwb3J0cyA9PT0gXCJvYmplY3RcIiAmJiB0eXBlb2YgbW9kdWxlICE9PSBcInVuZGVmaW5lZFwiKXttb2R1bGUuZXhwb3J0cyA9IGYoKTt9ZWxzZSBpZih0eXBlb2YgZGVmaW5lID09PSBcImZ1bmN0aW9uXCIgJiYgZGVmaW5lLmFtZCl7ZGVmaW5lKFtdLGYpO31lbHNlIHt2YXIgZztpZih0eXBlb2Ygd2luZG93ICE9PSBcInVuZGVmaW5lZFwiKXtnID0gd2luZG93O31lbHNlIGlmKHR5cGVvZiBnbG9iYWwgIT09IFwidW5kZWZpbmVkXCIpe2cgPSBnbG9iYWw7fWVsc2UgaWYodHlwZW9mIHNlbGYgIT09IFwidW5kZWZpbmVkXCIpe2cgPSBzZWxmO31lbHNlIHtnID0gdGhpczt9Zy5hY29ybiA9IGYoKTt9fSkoZnVuY3Rpb24oKXt2YXIgZGVmaW5lLG1vZHVsZSxleHBvcnRzO3JldHVybiAoZnVuY3Rpb24gZSh0LG4scil7ZnVuY3Rpb24gcyhvLHUpe2lmKCFuW29dKXtpZighdFtvXSl7dmFyIGE9dHlwZW9mIF9kZXJlcV8gPT0gXCJmdW5jdGlvblwiICYmIF9kZXJlcV87aWYoIXUgJiYgYSlyZXR1cm4gYShvLCEwKTtpZihpKXJldHVybiBpKG8sITApO3ZhciBmPW5ldyBFcnJvcihcIkNhbm5vdCBmaW5kIG1vZHVsZSAnXCIgKyBvICsgXCInXCIpO3Rocm93IChmLmNvZGUgPSBcIk1PRFVMRV9OT1RfRk9VTkRcIixmKTt9dmFyIGw9bltvXSA9IHtleHBvcnRzOnt9fTt0W29dWzBdLmNhbGwobC5leHBvcnRzLGZ1bmN0aW9uKGUpe3ZhciBuPXRbb11bMV1bZV07cmV0dXJuIHMobj9uOmUpO30sbCxsLmV4cG9ydHMsZSx0LG4scik7fXJldHVybiBuW29dLmV4cG9ydHM7fXZhciBpPXR5cGVvZiBfZGVyZXFfID09IFwiZnVuY3Rpb25cIiAmJiBfZGVyZXFfO2Zvcih2YXIgbz0wO28gPCByLmxlbmd0aDtvKyspIHMocltvXSk7cmV0dXJuIHM7fSkoezE6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpeyAvLyBBIHJlY3Vyc2l2ZSBkZXNjZW50IHBhcnNlciBvcGVyYXRlcyBieSBkZWZpbmluZyBmdW5jdGlvbnMgZm9yIGFsbFxuLy8gc3ludGFjdGljIGVsZW1lbnRzLCBhbmQgcmVjdXJzaXZlbHkgY2FsbGluZyB0aG9zZSwgZWFjaCBmdW5jdGlvblxuLy8gYWR2YW5jaW5nIHRoZSBpbnB1dCBzdHJlYW0gYW5kIHJldHVybmluZyBhbiBBU1Qgbm9kZS4gUHJlY2VkZW5jZVxuLy8gb2YgY29uc3RydWN0cyAoZm9yIGV4YW1wbGUsIHRoZSBmYWN0IHRoYXQgYCF4WzFdYCBtZWFucyBgISh4WzFdKWBcbi8vIGluc3RlYWQgb2YgYCgheClbMV1gIGlzIGhhbmRsZWQgYnkgdGhlIGZhY3QgdGhhdCB0aGUgcGFyc2VyXG4vLyBmdW5jdGlvbiB0aGF0IHBhcnNlcyB1bmFyeSBwcmVmaXggb3BlcmF0b3JzIGlzIGNhbGxlZCBmaXJzdCwgYW5kXG4vLyBpbiB0dXJuIGNhbGxzIHRoZSBmdW5jdGlvbiB0aGF0IHBhcnNlcyBgW11gIHN1YnNjcmlwdHMg4oCUIHRoYXRcbi8vIHdheSwgaXQnbGwgcmVjZWl2ZSB0aGUgbm9kZSBmb3IgYHhbMV1gIGFscmVhZHkgcGFyc2VkLCBhbmQgd3JhcHNcbi8vICp0aGF0KiBpbiB0aGUgdW5hcnkgb3BlcmF0b3Igbm9kZS5cbi8vXG4vLyBBY29ybiB1c2VzIGFuIFtvcGVyYXRvciBwcmVjZWRlbmNlIHBhcnNlcl1bb3BwXSB0byBoYW5kbGUgYmluYXJ5XG4vLyBvcGVyYXRvciBwcmVjZWRlbmNlLCBiZWNhdXNlIGl0IGlzIG11Y2ggbW9yZSBjb21wYWN0IHRoYW4gdXNpbmdcbi8vIHRoZSB0ZWNobmlxdWUgb3V0bGluZWQgYWJvdmUsIHdoaWNoIHVzZXMgZGlmZmVyZW50LCBuZXN0aW5nXG4vLyBmdW5jdGlvbnMgdG8gc3BlY2lmeSBwcmVjZWRlbmNlLCBmb3IgYWxsIG9mIHRoZSB0ZW4gYmluYXJ5XG4vLyBwcmVjZWRlbmNlIGxldmVscyB0aGF0IEphdmFTY3JpcHQgZGVmaW5lcy5cbi8vXG4vLyBbb3BwXTogaHR0cDovL2VuLndpa2lwZWRpYS5vcmcvd2lraS9PcGVyYXRvci1wcmVjZWRlbmNlX3BhcnNlclxuXCJ1c2Ugc3RyaWN0XCI7dmFyIF90b2tlbnR5cGU9X2RlcmVxXyhcIi4vdG9rZW50eXBlXCIpO3ZhciBfc3RhdGU9X2RlcmVxXyhcIi4vc3RhdGVcIik7dmFyIF9pZGVudGlmaWVyPV9kZXJlcV8oXCIuL2lkZW50aWZpZXJcIik7dmFyIF91dGlsPV9kZXJlcV8oXCIuL3V0aWxcIik7dmFyIHBwPV9zdGF0ZS5QYXJzZXIucHJvdG90eXBlOyAvLyBDaGVjayBpZiBwcm9wZXJ0eSBuYW1lIGNsYXNoZXMgd2l0aCBhbHJlYWR5IGFkZGVkLlxuLy8gT2JqZWN0L2NsYXNzIGdldHRlcnMgYW5kIHNldHRlcnMgYXJlIG5vdCBhbGxvd2VkIHRvIGNsYXNoIOKAlFxuLy8gZWl0aGVyIHdpdGggZWFjaCBvdGhlciBvciB3aXRoIGFuIGluaXQgcHJvcGVydHkg4oCUIGFuZCBpblxuLy8gc3RyaWN0IG1vZGUsIGluaXQgcHJvcGVydGllcyBhcmUgYWxzbyBub3QgYWxsb3dlZCB0byBiZSByZXBlYXRlZC5cbnBwLmNoZWNrUHJvcENsYXNoID0gZnVuY3Rpb24ocHJvcCxwcm9wSGFzaCl7aWYodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYgJiYgKHByb3AuY29tcHV0ZWQgfHwgcHJvcC5tZXRob2QgfHwgcHJvcC5zaG9ydGhhbmQpKXJldHVybjt2YXIga2V5PXByb3Aua2V5LG5hbWU9dW5kZWZpbmVkO3N3aXRjaChrZXkudHlwZSl7Y2FzZSBcIklkZW50aWZpZXJcIjpuYW1lID0ga2V5Lm5hbWU7YnJlYWs7Y2FzZSBcIkxpdGVyYWxcIjpuYW1lID0gU3RyaW5nKGtleS52YWx1ZSk7YnJlYWs7ZGVmYXVsdDpyZXR1cm47fXZhciBraW5kPXByb3Aua2luZDtpZih0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNil7aWYobmFtZSA9PT0gXCJfX3Byb3RvX19cIiAmJiBraW5kID09PSBcImluaXRcIil7aWYocHJvcEhhc2gucHJvdG8pdGhpcy5yYWlzZShrZXkuc3RhcnQsXCJSZWRlZmluaXRpb24gb2YgX19wcm90b19fIHByb3BlcnR5XCIpO3Byb3BIYXNoLnByb3RvID0gdHJ1ZTt9cmV0dXJuO312YXIgb3RoZXI9dW5kZWZpbmVkO2lmKF91dGlsLmhhcyhwcm9wSGFzaCxuYW1lKSl7b3RoZXIgPSBwcm9wSGFzaFtuYW1lXTt2YXIgaXNHZXRTZXQ9a2luZCAhPT0gXCJpbml0XCI7aWYoKHRoaXMuc3RyaWN0IHx8IGlzR2V0U2V0KSAmJiBvdGhlcltraW5kXSB8fCAhKGlzR2V0U2V0IF4gb3RoZXIuaW5pdCkpdGhpcy5yYWlzZShrZXkuc3RhcnQsXCJSZWRlZmluaXRpb24gb2YgcHJvcGVydHlcIik7fWVsc2Uge290aGVyID0gcHJvcEhhc2hbbmFtZV0gPSB7aW5pdDpmYWxzZSxnZXQ6ZmFsc2Usc2V0OmZhbHNlfTt9b3RoZXJba2luZF0gPSB0cnVlO307IC8vICMjIyBFeHByZXNzaW9uIHBhcnNpbmdcbi8vIFRoZXNlIG5lc3QsIGZyb20gdGhlIG1vc3QgZ2VuZXJhbCBleHByZXNzaW9uIHR5cGUgYXQgdGhlIHRvcCB0b1xuLy8gJ2F0b21pYycsIG5vbmRpdmlzaWJsZSBleHByZXNzaW9uIHR5cGVzIGF0IHRoZSBib3R0b20uIE1vc3Qgb2Zcbi8vIHRoZSBmdW5jdGlvbnMgd2lsbCBzaW1wbHkgbGV0IHRoZSBmdW5jdGlvbihzKSBiZWxvdyB0aGVtIHBhcnNlLFxuLy8gYW5kLCAqaWYqIHRoZSBzeW50YWN0aWMgY29uc3RydWN0IHRoZXkgaGFuZGxlIGlzIHByZXNlbnQsIHdyYXBcbi8vIHRoZSBBU1Qgbm9kZSB0aGF0IHRoZSBpbm5lciBwYXJzZXIgZ2F2ZSB0aGVtIGluIGFub3RoZXIgbm9kZS5cbi8vIFBhcnNlIGEgZnVsbCBleHByZXNzaW9uLiBUaGUgb3B0aW9uYWwgYXJndW1lbnRzIGFyZSB1c2VkIHRvXG4vLyBmb3JiaWQgdGhlIGBpbmAgb3BlcmF0b3IgKGluIGZvciBsb29wcyBpbml0YWxpemF0aW9uIGV4cHJlc3Npb25zKVxuLy8gYW5kIHByb3ZpZGUgcmVmZXJlbmNlIGZvciBzdG9yaW5nICc9JyBvcGVyYXRvciBpbnNpZGUgc2hvcnRoYW5kXG4vLyBwcm9wZXJ0eSBhc3NpZ25tZW50IGluIGNvbnRleHRzIHdoZXJlIGJvdGggb2JqZWN0IGV4cHJlc3Npb25cbi8vIGFuZCBvYmplY3QgcGF0dGVybiBtaWdodCBhcHBlYXIgKHNvIGl0J3MgcG9zc2libGUgdG8gcmFpc2Vcbi8vIGRlbGF5ZWQgc3ludGF4IGVycm9yIGF0IGNvcnJlY3QgcG9zaXRpb24pLlxucHAucGFyc2VFeHByZXNzaW9uID0gZnVuY3Rpb24obm9JbixyZWZTaG9ydGhhbmREZWZhdWx0UG9zKXt2YXIgc3RhcnRQb3M9dGhpcy5zdGFydCxzdGFydExvYz10aGlzLnN0YXJ0TG9jO3ZhciBleHByPXRoaXMucGFyc2VNYXliZUFzc2lnbihub0luLHJlZlNob3J0aGFuZERlZmF1bHRQb3MpO2lmKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5jb21tYSl7dmFyIG5vZGU9dGhpcy5zdGFydE5vZGVBdChzdGFydFBvcyxzdGFydExvYyk7bm9kZS5leHByZXNzaW9ucyA9IFtleHByXTt3aGlsZSh0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLmNvbW1hKSkgbm9kZS5leHByZXNzaW9ucy5wdXNoKHRoaXMucGFyc2VNYXliZUFzc2lnbihub0luLHJlZlNob3J0aGFuZERlZmF1bHRQb3MpKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJTZXF1ZW5jZUV4cHJlc3Npb25cIik7fXJldHVybiBleHByO307IC8vIFBhcnNlIGFuIGFzc2lnbm1lbnQgZXhwcmVzc2lvbi4gVGhpcyBpbmNsdWRlcyBhcHBsaWNhdGlvbnMgb2Zcbi8vIG9wZXJhdG9ycyBsaWtlIGArPWAuXG5wcC5wYXJzZU1heWJlQXNzaWduID0gZnVuY3Rpb24obm9JbixyZWZTaG9ydGhhbmREZWZhdWx0UG9zLGFmdGVyTGVmdFBhcnNlKXtpZih0aGlzLnR5cGUgPT0gX3Rva2VudHlwZS50eXBlcy5feWllbGQgJiYgdGhpcy5pbkdlbmVyYXRvcilyZXR1cm4gdGhpcy5wYXJzZVlpZWxkKCk7dmFyIGZhaWxPblNob3J0aGFuZEFzc2lnbj11bmRlZmluZWQ7aWYoIXJlZlNob3J0aGFuZERlZmF1bHRQb3Mpe3JlZlNob3J0aGFuZERlZmF1bHRQb3MgPSB7c3RhcnQ6MH07ZmFpbE9uU2hvcnRoYW5kQXNzaWduID0gdHJ1ZTt9ZWxzZSB7ZmFpbE9uU2hvcnRoYW5kQXNzaWduID0gZmFsc2U7fXZhciBzdGFydFBvcz10aGlzLnN0YXJ0LHN0YXJ0TG9jPXRoaXMuc3RhcnRMb2M7aWYodGhpcy50eXBlID09IF90b2tlbnR5cGUudHlwZXMucGFyZW5MIHx8IHRoaXMudHlwZSA9PSBfdG9rZW50eXBlLnR5cGVzLm5hbWUpdGhpcy5wb3RlbnRpYWxBcnJvd0F0ID0gdGhpcy5zdGFydDt2YXIgbGVmdD10aGlzLnBhcnNlTWF5YmVDb25kaXRpb25hbChub0luLHJlZlNob3J0aGFuZERlZmF1bHRQb3MpO2lmKGFmdGVyTGVmdFBhcnNlKWxlZnQgPSBhZnRlckxlZnRQYXJzZS5jYWxsKHRoaXMsbGVmdCxzdGFydFBvcyxzdGFydExvYyk7aWYodGhpcy50eXBlLmlzQXNzaWduKXt2YXIgbm9kZT10aGlzLnN0YXJ0Tm9kZUF0KHN0YXJ0UG9zLHN0YXJ0TG9jKTtub2RlLm9wZXJhdG9yID0gdGhpcy52YWx1ZTtub2RlLmxlZnQgPSB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuZXE/dGhpcy50b0Fzc2lnbmFibGUobGVmdCk6bGVmdDtyZWZTaG9ydGhhbmREZWZhdWx0UG9zLnN0YXJ0ID0gMDsgLy8gcmVzZXQgYmVjYXVzZSBzaG9ydGhhbmQgZGVmYXVsdCB3YXMgdXNlZCBjb3JyZWN0bHlcbnRoaXMuY2hlY2tMVmFsKGxlZnQpO3RoaXMubmV4dCgpO25vZGUucmlnaHQgPSB0aGlzLnBhcnNlTWF5YmVBc3NpZ24obm9Jbik7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiQXNzaWdubWVudEV4cHJlc3Npb25cIik7fWVsc2UgaWYoZmFpbE9uU2hvcnRoYW5kQXNzaWduICYmIHJlZlNob3J0aGFuZERlZmF1bHRQb3Muc3RhcnQpe3RoaXMudW5leHBlY3RlZChyZWZTaG9ydGhhbmREZWZhdWx0UG9zLnN0YXJ0KTt9cmV0dXJuIGxlZnQ7fTsgLy8gUGFyc2UgYSB0ZXJuYXJ5IGNvbmRpdGlvbmFsIChgPzpgKSBvcGVyYXRvci5cbnBwLnBhcnNlTWF5YmVDb25kaXRpb25hbCA9IGZ1bmN0aW9uKG5vSW4scmVmU2hvcnRoYW5kRGVmYXVsdFBvcyl7dmFyIHN0YXJ0UG9zPXRoaXMuc3RhcnQsc3RhcnRMb2M9dGhpcy5zdGFydExvYzt2YXIgZXhwcj10aGlzLnBhcnNlRXhwck9wcyhub0luLHJlZlNob3J0aGFuZERlZmF1bHRQb3MpO2lmKHJlZlNob3J0aGFuZERlZmF1bHRQb3MgJiYgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcy5zdGFydClyZXR1cm4gZXhwcjtpZih0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLnF1ZXN0aW9uKSl7dmFyIG5vZGU9dGhpcy5zdGFydE5vZGVBdChzdGFydFBvcyxzdGFydExvYyk7bm9kZS50ZXN0ID0gZXhwcjtub2RlLmNvbnNlcXVlbnQgPSB0aGlzLnBhcnNlTWF5YmVBc3NpZ24oKTt0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmNvbG9uKTtub2RlLmFsdGVybmF0ZSA9IHRoaXMucGFyc2VNYXliZUFzc2lnbihub0luKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJDb25kaXRpb25hbEV4cHJlc3Npb25cIik7fXJldHVybiBleHByO307IC8vIFN0YXJ0IHRoZSBwcmVjZWRlbmNlIHBhcnNlci5cbnBwLnBhcnNlRXhwck9wcyA9IGZ1bmN0aW9uKG5vSW4scmVmU2hvcnRoYW5kRGVmYXVsdFBvcyl7dmFyIHN0YXJ0UG9zPXRoaXMuc3RhcnQsc3RhcnRMb2M9dGhpcy5zdGFydExvYzt2YXIgZXhwcj10aGlzLnBhcnNlTWF5YmVVbmFyeShyZWZTaG9ydGhhbmREZWZhdWx0UG9zKTtpZihyZWZTaG9ydGhhbmREZWZhdWx0UG9zICYmIHJlZlNob3J0aGFuZERlZmF1bHRQb3Muc3RhcnQpcmV0dXJuIGV4cHI7cmV0dXJuIHRoaXMucGFyc2VFeHByT3AoZXhwcixzdGFydFBvcyxzdGFydExvYywtMSxub0luKTt9OyAvLyBQYXJzZSBiaW5hcnkgb3BlcmF0b3JzIHdpdGggdGhlIG9wZXJhdG9yIHByZWNlZGVuY2UgcGFyc2luZ1xuLy8gYWxnb3JpdGhtLiBgbGVmdGAgaXMgdGhlIGxlZnQtaGFuZCBzaWRlIG9mIHRoZSBvcGVyYXRvci5cbi8vIGBtaW5QcmVjYCBwcm92aWRlcyBjb250ZXh0IHRoYXQgYWxsb3dzIHRoZSBmdW5jdGlvbiB0byBzdG9wIGFuZFxuLy8gZGVmZXIgZnVydGhlciBwYXJzZXIgdG8gb25lIG9mIGl0cyBjYWxsZXJzIHdoZW4gaXQgZW5jb3VudGVycyBhblxuLy8gb3BlcmF0b3IgdGhhdCBoYXMgYSBsb3dlciBwcmVjZWRlbmNlIHRoYW4gdGhlIHNldCBpdCBpcyBwYXJzaW5nLlxucHAucGFyc2VFeHByT3AgPSBmdW5jdGlvbihsZWZ0LGxlZnRTdGFydFBvcyxsZWZ0U3RhcnRMb2MsbWluUHJlYyxub0luKXt2YXIgcHJlYz10aGlzLnR5cGUuYmlub3A7aWYocHJlYyAhPSBudWxsICYmICghbm9JbiB8fCB0aGlzLnR5cGUgIT09IF90b2tlbnR5cGUudHlwZXMuX2luKSl7aWYocHJlYyA+IG1pblByZWMpe3ZhciBub2RlPXRoaXMuc3RhcnROb2RlQXQobGVmdFN0YXJ0UG9zLGxlZnRTdGFydExvYyk7bm9kZS5sZWZ0ID0gbGVmdDtub2RlLm9wZXJhdG9yID0gdGhpcy52YWx1ZTt2YXIgb3A9dGhpcy50eXBlO3RoaXMubmV4dCgpO3ZhciBzdGFydFBvcz10aGlzLnN0YXJ0LHN0YXJ0TG9jPXRoaXMuc3RhcnRMb2M7bm9kZS5yaWdodCA9IHRoaXMucGFyc2VFeHByT3AodGhpcy5wYXJzZU1heWJlVW5hcnkoKSxzdGFydFBvcyxzdGFydExvYyxwcmVjLG5vSW4pO3RoaXMuZmluaXNoTm9kZShub2RlLG9wID09PSBfdG9rZW50eXBlLnR5cGVzLmxvZ2ljYWxPUiB8fCBvcCA9PT0gX3Rva2VudHlwZS50eXBlcy5sb2dpY2FsQU5EP1wiTG9naWNhbEV4cHJlc3Npb25cIjpcIkJpbmFyeUV4cHJlc3Npb25cIik7cmV0dXJuIHRoaXMucGFyc2VFeHByT3Aobm9kZSxsZWZ0U3RhcnRQb3MsbGVmdFN0YXJ0TG9jLG1pblByZWMsbm9Jbik7fX1yZXR1cm4gbGVmdDt9OyAvLyBQYXJzZSB1bmFyeSBvcGVyYXRvcnMsIGJvdGggcHJlZml4IGFuZCBwb3N0Zml4LlxucHAucGFyc2VNYXliZVVuYXJ5ID0gZnVuY3Rpb24ocmVmU2hvcnRoYW5kRGVmYXVsdFBvcyl7aWYodGhpcy50eXBlLnByZWZpeCl7dmFyIG5vZGU9dGhpcy5zdGFydE5vZGUoKSx1cGRhdGU9dGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmluY0RlYztub2RlLm9wZXJhdG9yID0gdGhpcy52YWx1ZTtub2RlLnByZWZpeCA9IHRydWU7dGhpcy5uZXh0KCk7bm9kZS5hcmd1bWVudCA9IHRoaXMucGFyc2VNYXliZVVuYXJ5KCk7aWYocmVmU2hvcnRoYW5kRGVmYXVsdFBvcyAmJiByZWZTaG9ydGhhbmREZWZhdWx0UG9zLnN0YXJ0KXRoaXMudW5leHBlY3RlZChyZWZTaG9ydGhhbmREZWZhdWx0UG9zLnN0YXJ0KTtpZih1cGRhdGUpdGhpcy5jaGVja0xWYWwobm9kZS5hcmd1bWVudCk7ZWxzZSBpZih0aGlzLnN0cmljdCAmJiBub2RlLm9wZXJhdG9yID09PSBcImRlbGV0ZVwiICYmIG5vZGUuYXJndW1lbnQudHlwZSA9PT0gXCJJZGVudGlmaWVyXCIpdGhpcy5yYWlzZShub2RlLnN0YXJ0LFwiRGVsZXRpbmcgbG9jYWwgdmFyaWFibGUgaW4gc3RyaWN0IG1vZGVcIik7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLHVwZGF0ZT9cIlVwZGF0ZUV4cHJlc3Npb25cIjpcIlVuYXJ5RXhwcmVzc2lvblwiKTt9dmFyIHN0YXJ0UG9zPXRoaXMuc3RhcnQsc3RhcnRMb2M9dGhpcy5zdGFydExvYzt2YXIgZXhwcj10aGlzLnBhcnNlRXhwclN1YnNjcmlwdHMocmVmU2hvcnRoYW5kRGVmYXVsdFBvcyk7aWYocmVmU2hvcnRoYW5kRGVmYXVsdFBvcyAmJiByZWZTaG9ydGhhbmREZWZhdWx0UG9zLnN0YXJ0KXJldHVybiBleHByO3doaWxlKHRoaXMudHlwZS5wb3N0Zml4ICYmICF0aGlzLmNhbkluc2VydFNlbWljb2xvbigpKSB7dmFyIG5vZGU9dGhpcy5zdGFydE5vZGVBdChzdGFydFBvcyxzdGFydExvYyk7bm9kZS5vcGVyYXRvciA9IHRoaXMudmFsdWU7bm9kZS5wcmVmaXggPSBmYWxzZTtub2RlLmFyZ3VtZW50ID0gZXhwcjt0aGlzLmNoZWNrTFZhbChleHByKTt0aGlzLm5leHQoKTtleHByID0gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJVcGRhdGVFeHByZXNzaW9uXCIpO31yZXR1cm4gZXhwcjt9OyAvLyBQYXJzZSBjYWxsLCBkb3QsIGFuZCBgW11gLXN1YnNjcmlwdCBleHByZXNzaW9ucy5cbnBwLnBhcnNlRXhwclN1YnNjcmlwdHMgPSBmdW5jdGlvbihyZWZTaG9ydGhhbmREZWZhdWx0UG9zKXt2YXIgc3RhcnRQb3M9dGhpcy5zdGFydCxzdGFydExvYz10aGlzLnN0YXJ0TG9jO3ZhciBleHByPXRoaXMucGFyc2VFeHByQXRvbShyZWZTaG9ydGhhbmREZWZhdWx0UG9zKTtpZihyZWZTaG9ydGhhbmREZWZhdWx0UG9zICYmIHJlZlNob3J0aGFuZERlZmF1bHRQb3Muc3RhcnQpcmV0dXJuIGV4cHI7cmV0dXJuIHRoaXMucGFyc2VTdWJzY3JpcHRzKGV4cHIsc3RhcnRQb3Msc3RhcnRMb2MpO307cHAucGFyc2VTdWJzY3JpcHRzID0gZnVuY3Rpb24oYmFzZSxzdGFydFBvcyxzdGFydExvYyxub0NhbGxzKXtmb3IoOzspIHtpZih0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLmRvdCkpe3ZhciBub2RlPXRoaXMuc3RhcnROb2RlQXQoc3RhcnRQb3Msc3RhcnRMb2MpO25vZGUub2JqZWN0ID0gYmFzZTtub2RlLnByb3BlcnR5ID0gdGhpcy5wYXJzZUlkZW50KHRydWUpO25vZGUuY29tcHV0ZWQgPSBmYWxzZTtiYXNlID0gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJNZW1iZXJFeHByZXNzaW9uXCIpO31lbHNlIGlmKHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuYnJhY2tldEwpKXt2YXIgbm9kZT10aGlzLnN0YXJ0Tm9kZUF0KHN0YXJ0UG9zLHN0YXJ0TG9jKTtub2RlLm9iamVjdCA9IGJhc2U7bm9kZS5wcm9wZXJ0eSA9IHRoaXMucGFyc2VFeHByZXNzaW9uKCk7bm9kZS5jb21wdXRlZCA9IHRydWU7dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5icmFja2V0Uik7YmFzZSA9IHRoaXMuZmluaXNoTm9kZShub2RlLFwiTWVtYmVyRXhwcmVzc2lvblwiKTt9ZWxzZSBpZighbm9DYWxscyAmJiB0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLnBhcmVuTCkpe3ZhciBub2RlPXRoaXMuc3RhcnROb2RlQXQoc3RhcnRQb3Msc3RhcnRMb2MpO25vZGUuY2FsbGVlID0gYmFzZTtub2RlLmFyZ3VtZW50cyA9IHRoaXMucGFyc2VFeHByTGlzdChfdG9rZW50eXBlLnR5cGVzLnBhcmVuUixmYWxzZSk7YmFzZSA9IHRoaXMuZmluaXNoTm9kZShub2RlLFwiQ2FsbEV4cHJlc3Npb25cIik7fWVsc2UgaWYodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmJhY2tRdW90ZSl7dmFyIG5vZGU9dGhpcy5zdGFydE5vZGVBdChzdGFydFBvcyxzdGFydExvYyk7bm9kZS50YWcgPSBiYXNlO25vZGUucXVhc2kgPSB0aGlzLnBhcnNlVGVtcGxhdGUoKTtiYXNlID0gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJUYWdnZWRUZW1wbGF0ZUV4cHJlc3Npb25cIik7fWVsc2Uge3JldHVybiBiYXNlO319fTsgLy8gUGFyc2UgYW4gYXRvbWljIGV4cHJlc3Npb24g4oCUIGVpdGhlciBhIHNpbmdsZSB0b2tlbiB0aGF0IGlzIGFuXG4vLyBleHByZXNzaW9uLCBhbiBleHByZXNzaW9uIHN0YXJ0ZWQgYnkgYSBrZXl3b3JkIGxpa2UgYGZ1bmN0aW9uYCBvclxuLy8gYG5ld2AsIG9yIGFuIGV4cHJlc3Npb24gd3JhcHBlZCBpbiBwdW5jdHVhdGlvbiBsaWtlIGAoKWAsIGBbXWAsXG4vLyBvciBge31gLlxucHAucGFyc2VFeHByQXRvbSA9IGZ1bmN0aW9uKHJlZlNob3J0aGFuZERlZmF1bHRQb3Mpe3ZhciBub2RlPXVuZGVmaW5lZCxjYW5CZUFycm93PXRoaXMucG90ZW50aWFsQXJyb3dBdCA9PSB0aGlzLnN0YXJ0O3N3aXRjaCh0aGlzLnR5cGUpe2Nhc2UgX3Rva2VudHlwZS50eXBlcy5fc3VwZXI6aWYoIXRoaXMuaW5GdW5jdGlvbil0aGlzLnJhaXNlKHRoaXMuc3RhcnQsXCInc3VwZXInIG91dHNpZGUgb2YgZnVuY3Rpb24gb3IgY2xhc3NcIik7Y2FzZSBfdG9rZW50eXBlLnR5cGVzLl90aGlzOnZhciB0eXBlPXRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fdGhpcz9cIlRoaXNFeHByZXNzaW9uXCI6XCJTdXBlclwiO25vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO3RoaXMubmV4dCgpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSx0eXBlKTtjYXNlIF90b2tlbnR5cGUudHlwZXMuX3lpZWxkOmlmKHRoaXMuaW5HZW5lcmF0b3IpdGhpcy51bmV4cGVjdGVkKCk7Y2FzZSBfdG9rZW50eXBlLnR5cGVzLm5hbWU6dmFyIHN0YXJ0UG9zPXRoaXMuc3RhcnQsc3RhcnRMb2M9dGhpcy5zdGFydExvYzt2YXIgaWQ9dGhpcy5wYXJzZUlkZW50KHRoaXMudHlwZSAhPT0gX3Rva2VudHlwZS50eXBlcy5uYW1lKTtpZihjYW5CZUFycm93ICYmICF0aGlzLmNhbkluc2VydFNlbWljb2xvbigpICYmIHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuYXJyb3cpKXJldHVybiB0aGlzLnBhcnNlQXJyb3dFeHByZXNzaW9uKHRoaXMuc3RhcnROb2RlQXQoc3RhcnRQb3Msc3RhcnRMb2MpLFtpZF0pO3JldHVybiBpZDtjYXNlIF90b2tlbnR5cGUudHlwZXMucmVnZXhwOnZhciB2YWx1ZT10aGlzLnZhbHVlO25vZGUgPSB0aGlzLnBhcnNlTGl0ZXJhbCh2YWx1ZS52YWx1ZSk7bm9kZS5yZWdleCA9IHtwYXR0ZXJuOnZhbHVlLnBhdHRlcm4sZmxhZ3M6dmFsdWUuZmxhZ3N9O3JldHVybiBub2RlO2Nhc2UgX3Rva2VudHlwZS50eXBlcy5udW06Y2FzZSBfdG9rZW50eXBlLnR5cGVzLnN0cmluZzpyZXR1cm4gdGhpcy5wYXJzZUxpdGVyYWwodGhpcy52YWx1ZSk7Y2FzZSBfdG9rZW50eXBlLnR5cGVzLl9udWxsOmNhc2UgX3Rva2VudHlwZS50eXBlcy5fdHJ1ZTpjYXNlIF90b2tlbnR5cGUudHlwZXMuX2ZhbHNlOm5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO25vZGUudmFsdWUgPSB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX251bGw/bnVsbDp0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX3RydWU7bm9kZS5yYXcgPSB0aGlzLnR5cGUua2V5d29yZDt0aGlzLm5leHQoKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJMaXRlcmFsXCIpO2Nhc2UgX3Rva2VudHlwZS50eXBlcy5wYXJlbkw6cmV0dXJuIHRoaXMucGFyc2VQYXJlbkFuZERpc3Rpbmd1aXNoRXhwcmVzc2lvbihjYW5CZUFycm93KTtjYXNlIF90b2tlbnR5cGUudHlwZXMuYnJhY2tldEw6bm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7dGhpcy5uZXh0KCk7IC8vIGNoZWNrIHdoZXRoZXIgdGhpcyBpcyBhcnJheSBjb21wcmVoZW5zaW9uIG9yIHJlZ3VsYXIgYXJyYXlcbmlmKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA3ICYmIHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fZm9yKXtyZXR1cm4gdGhpcy5wYXJzZUNvbXByZWhlbnNpb24obm9kZSxmYWxzZSk7fW5vZGUuZWxlbWVudHMgPSB0aGlzLnBhcnNlRXhwckxpc3QoX3Rva2VudHlwZS50eXBlcy5icmFja2V0Uix0cnVlLHRydWUscmVmU2hvcnRoYW5kRGVmYXVsdFBvcyk7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiQXJyYXlFeHByZXNzaW9uXCIpO2Nhc2UgX3Rva2VudHlwZS50eXBlcy5icmFjZUw6cmV0dXJuIHRoaXMucGFyc2VPYmooZmFsc2UscmVmU2hvcnRoYW5kRGVmYXVsdFBvcyk7Y2FzZSBfdG9rZW50eXBlLnR5cGVzLl9mdW5jdGlvbjpub2RlID0gdGhpcy5zdGFydE5vZGUoKTt0aGlzLm5leHQoKTtyZXR1cm4gdGhpcy5wYXJzZUZ1bmN0aW9uKG5vZGUsZmFsc2UpO2Nhc2UgX3Rva2VudHlwZS50eXBlcy5fY2xhc3M6cmV0dXJuIHRoaXMucGFyc2VDbGFzcyh0aGlzLnN0YXJ0Tm9kZSgpLGZhbHNlKTtjYXNlIF90b2tlbnR5cGUudHlwZXMuX25ldzpyZXR1cm4gdGhpcy5wYXJzZU5ldygpO2Nhc2UgX3Rva2VudHlwZS50eXBlcy5iYWNrUXVvdGU6cmV0dXJuIHRoaXMucGFyc2VUZW1wbGF0ZSgpO2RlZmF1bHQ6dGhpcy51bmV4cGVjdGVkKCk7fX07cHAucGFyc2VMaXRlcmFsID0gZnVuY3Rpb24odmFsdWUpe3ZhciBub2RlPXRoaXMuc3RhcnROb2RlKCk7bm9kZS52YWx1ZSA9IHZhbHVlO25vZGUucmF3ID0gdGhpcy5pbnB1dC5zbGljZSh0aGlzLnN0YXJ0LHRoaXMuZW5kKTt0aGlzLm5leHQoKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJMaXRlcmFsXCIpO307cHAucGFyc2VQYXJlbkV4cHJlc3Npb24gPSBmdW5jdGlvbigpe3RoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMucGFyZW5MKTt2YXIgdmFsPXRoaXMucGFyc2VFeHByZXNzaW9uKCk7dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5wYXJlblIpO3JldHVybiB2YWw7fTtwcC5wYXJzZVBhcmVuQW5kRGlzdGluZ3Vpc2hFeHByZXNzaW9uID0gZnVuY3Rpb24oY2FuQmVBcnJvdyl7dmFyIHN0YXJ0UG9zPXRoaXMuc3RhcnQsc3RhcnRMb2M9dGhpcy5zdGFydExvYyx2YWw9dW5kZWZpbmVkO2lmKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KXt0aGlzLm5leHQoKTtpZih0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNyAmJiB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2Zvcil7cmV0dXJuIHRoaXMucGFyc2VDb21wcmVoZW5zaW9uKHRoaXMuc3RhcnROb2RlQXQoc3RhcnRQb3Msc3RhcnRMb2MpLHRydWUpO312YXIgaW5uZXJTdGFydFBvcz10aGlzLnN0YXJ0LGlubmVyU3RhcnRMb2M9dGhpcy5zdGFydExvYzt2YXIgZXhwckxpc3Q9W10sZmlyc3Q9dHJ1ZTt2YXIgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcz17c3RhcnQ6MH0sc3ByZWFkU3RhcnQ9dW5kZWZpbmVkLGlubmVyUGFyZW5TdGFydD11bmRlZmluZWQ7d2hpbGUodGhpcy50eXBlICE9PSBfdG9rZW50eXBlLnR5cGVzLnBhcmVuUikge2ZpcnN0P2ZpcnN0ID0gZmFsc2U6dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5jb21tYSk7aWYodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmVsbGlwc2lzKXtzcHJlYWRTdGFydCA9IHRoaXMuc3RhcnQ7ZXhwckxpc3QucHVzaCh0aGlzLnBhcnNlUGFyZW5JdGVtKHRoaXMucGFyc2VSZXN0KCkpKTticmVhazt9ZWxzZSB7aWYodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLnBhcmVuTCAmJiAhaW5uZXJQYXJlblN0YXJ0KXtpbm5lclBhcmVuU3RhcnQgPSB0aGlzLnN0YXJ0O31leHByTGlzdC5wdXNoKHRoaXMucGFyc2VNYXliZUFzc2lnbihmYWxzZSxyZWZTaG9ydGhhbmREZWZhdWx0UG9zLHRoaXMucGFyc2VQYXJlbkl0ZW0pKTt9fXZhciBpbm5lckVuZFBvcz10aGlzLnN0YXJ0LGlubmVyRW5kTG9jPXRoaXMuc3RhcnRMb2M7dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5wYXJlblIpO2lmKGNhbkJlQXJyb3cgJiYgIXRoaXMuY2FuSW5zZXJ0U2VtaWNvbG9uKCkgJiYgdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5hcnJvdykpe2lmKGlubmVyUGFyZW5TdGFydCl0aGlzLnVuZXhwZWN0ZWQoaW5uZXJQYXJlblN0YXJ0KTtyZXR1cm4gdGhpcy5wYXJzZVBhcmVuQXJyb3dMaXN0KHN0YXJ0UG9zLHN0YXJ0TG9jLGV4cHJMaXN0KTt9aWYoIWV4cHJMaXN0Lmxlbmd0aCl0aGlzLnVuZXhwZWN0ZWQodGhpcy5sYXN0VG9rU3RhcnQpO2lmKHNwcmVhZFN0YXJ0KXRoaXMudW5leHBlY3RlZChzcHJlYWRTdGFydCk7aWYocmVmU2hvcnRoYW5kRGVmYXVsdFBvcy5zdGFydCl0aGlzLnVuZXhwZWN0ZWQocmVmU2hvcnRoYW5kRGVmYXVsdFBvcy5zdGFydCk7aWYoZXhwckxpc3QubGVuZ3RoID4gMSl7dmFsID0gdGhpcy5zdGFydE5vZGVBdChpbm5lclN0YXJ0UG9zLGlubmVyU3RhcnRMb2MpO3ZhbC5leHByZXNzaW9ucyA9IGV4cHJMaXN0O3RoaXMuZmluaXNoTm9kZUF0KHZhbCxcIlNlcXVlbmNlRXhwcmVzc2lvblwiLGlubmVyRW5kUG9zLGlubmVyRW5kTG9jKTt9ZWxzZSB7dmFsID0gZXhwckxpc3RbMF07fX1lbHNlIHt2YWwgPSB0aGlzLnBhcnNlUGFyZW5FeHByZXNzaW9uKCk7fWlmKHRoaXMub3B0aW9ucy5wcmVzZXJ2ZVBhcmVucyl7dmFyIHBhcj10aGlzLnN0YXJ0Tm9kZUF0KHN0YXJ0UG9zLHN0YXJ0TG9jKTtwYXIuZXhwcmVzc2lvbiA9IHZhbDtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKHBhcixcIlBhcmVudGhlc2l6ZWRFeHByZXNzaW9uXCIpO31lbHNlIHtyZXR1cm4gdmFsO319O3BwLnBhcnNlUGFyZW5JdGVtID0gZnVuY3Rpb24oaXRlbSl7cmV0dXJuIGl0ZW07fTtwcC5wYXJzZVBhcmVuQXJyb3dMaXN0ID0gZnVuY3Rpb24oc3RhcnRQb3Msc3RhcnRMb2MsZXhwckxpc3Qpe3JldHVybiB0aGlzLnBhcnNlQXJyb3dFeHByZXNzaW9uKHRoaXMuc3RhcnROb2RlQXQoc3RhcnRQb3Msc3RhcnRMb2MpLGV4cHJMaXN0KTt9OyAvLyBOZXcncyBwcmVjZWRlbmNlIGlzIHNsaWdodGx5IHRyaWNreS4gSXQgbXVzdCBhbGxvdyBpdHMgYXJndW1lbnRcbi8vIHRvIGJlIGEgYFtdYCBvciBkb3Qgc3Vic2NyaXB0IGV4cHJlc3Npb24sIGJ1dCBub3QgYSBjYWxsIOKAlCBhdFxuLy8gbGVhc3QsIG5vdCB3aXRob3V0IHdyYXBwaW5nIGl0IGluIHBhcmVudGhlc2VzLiBUaHVzLCBpdCB1c2VzIHRoZVxudmFyIGVtcHR5PVtdO3BwLnBhcnNlTmV3ID0gZnVuY3Rpb24oKXt2YXIgbm9kZT10aGlzLnN0YXJ0Tm9kZSgpO3ZhciBtZXRhPXRoaXMucGFyc2VJZGVudCh0cnVlKTtpZih0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNiAmJiB0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLmRvdCkpe25vZGUubWV0YSA9IG1ldGE7bm9kZS5wcm9wZXJ0eSA9IHRoaXMucGFyc2VJZGVudCh0cnVlKTtpZihub2RlLnByb3BlcnR5Lm5hbWUgIT09IFwidGFyZ2V0XCIpdGhpcy5yYWlzZShub2RlLnByb3BlcnR5LnN0YXJ0LFwiVGhlIG9ubHkgdmFsaWQgbWV0YSBwcm9wZXJ0eSBmb3IgbmV3IGlzIG5ldy50YXJnZXRcIik7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiTWV0YVByb3BlcnR5XCIpO312YXIgc3RhcnRQb3M9dGhpcy5zdGFydCxzdGFydExvYz10aGlzLnN0YXJ0TG9jO25vZGUuY2FsbGVlID0gdGhpcy5wYXJzZVN1YnNjcmlwdHModGhpcy5wYXJzZUV4cHJBdG9tKCksc3RhcnRQb3Msc3RhcnRMb2MsdHJ1ZSk7aWYodGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5wYXJlbkwpKW5vZGUuYXJndW1lbnRzID0gdGhpcy5wYXJzZUV4cHJMaXN0KF90b2tlbnR5cGUudHlwZXMucGFyZW5SLGZhbHNlKTtlbHNlIG5vZGUuYXJndW1lbnRzID0gZW1wdHk7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiTmV3RXhwcmVzc2lvblwiKTt9OyAvLyBQYXJzZSB0ZW1wbGF0ZSBleHByZXNzaW9uLlxucHAucGFyc2VUZW1wbGF0ZUVsZW1lbnQgPSBmdW5jdGlvbigpe3ZhciBlbGVtPXRoaXMuc3RhcnROb2RlKCk7ZWxlbS52YWx1ZSA9IHtyYXc6dGhpcy5pbnB1dC5zbGljZSh0aGlzLnN0YXJ0LHRoaXMuZW5kKS5yZXBsYWNlKC9cXHJcXG4/L2csJ1xcbicpLGNvb2tlZDp0aGlzLnZhbHVlfTt0aGlzLm5leHQoKTtlbGVtLnRhaWwgPSB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuYmFja1F1b3RlO3JldHVybiB0aGlzLmZpbmlzaE5vZGUoZWxlbSxcIlRlbXBsYXRlRWxlbWVudFwiKTt9O3BwLnBhcnNlVGVtcGxhdGUgPSBmdW5jdGlvbigpe3ZhciBub2RlPXRoaXMuc3RhcnROb2RlKCk7dGhpcy5uZXh0KCk7bm9kZS5leHByZXNzaW9ucyA9IFtdO3ZhciBjdXJFbHQ9dGhpcy5wYXJzZVRlbXBsYXRlRWxlbWVudCgpO25vZGUucXVhc2lzID0gW2N1ckVsdF07d2hpbGUoIWN1ckVsdC50YWlsKSB7dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5kb2xsYXJCcmFjZUwpO25vZGUuZXhwcmVzc2lvbnMucHVzaCh0aGlzLnBhcnNlRXhwcmVzc2lvbigpKTt0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmJyYWNlUik7bm9kZS5xdWFzaXMucHVzaChjdXJFbHQgPSB0aGlzLnBhcnNlVGVtcGxhdGVFbGVtZW50KCkpO310aGlzLm5leHQoKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJUZW1wbGF0ZUxpdGVyYWxcIik7fTsgLy8gUGFyc2UgYW4gb2JqZWN0IGxpdGVyYWwgb3IgYmluZGluZyBwYXR0ZXJuLlxucHAucGFyc2VPYmogPSBmdW5jdGlvbihpc1BhdHRlcm4scmVmU2hvcnRoYW5kRGVmYXVsdFBvcyl7dmFyIG5vZGU9dGhpcy5zdGFydE5vZGUoKSxmaXJzdD10cnVlLHByb3BIYXNoPXt9O25vZGUucHJvcGVydGllcyA9IFtdO3RoaXMubmV4dCgpO3doaWxlKCF0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLmJyYWNlUikpIHtpZighZmlyc3Qpe3RoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMuY29tbWEpO2lmKHRoaXMuYWZ0ZXJUcmFpbGluZ0NvbW1hKF90b2tlbnR5cGUudHlwZXMuYnJhY2VSKSlicmVhazt9ZWxzZSBmaXJzdCA9IGZhbHNlO3ZhciBwcm9wPXRoaXMuc3RhcnROb2RlKCksaXNHZW5lcmF0b3I9dW5kZWZpbmVkLHN0YXJ0UG9zPXVuZGVmaW5lZCxzdGFydExvYz11bmRlZmluZWQ7aWYodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpe3Byb3AubWV0aG9kID0gZmFsc2U7cHJvcC5zaG9ydGhhbmQgPSBmYWxzZTtpZihpc1BhdHRlcm4gfHwgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcyl7c3RhcnRQb3MgPSB0aGlzLnN0YXJ0O3N0YXJ0TG9jID0gdGhpcy5zdGFydExvYzt9aWYoIWlzUGF0dGVybilpc0dlbmVyYXRvciA9IHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuc3Rhcik7fXRoaXMucGFyc2VQcm9wZXJ0eU5hbWUocHJvcCk7dGhpcy5wYXJzZVByb3BlcnR5VmFsdWUocHJvcCxpc1BhdHRlcm4saXNHZW5lcmF0b3Isc3RhcnRQb3Msc3RhcnRMb2MscmVmU2hvcnRoYW5kRGVmYXVsdFBvcyk7dGhpcy5jaGVja1Byb3BDbGFzaChwcm9wLHByb3BIYXNoKTtub2RlLnByb3BlcnRpZXMucHVzaCh0aGlzLmZpbmlzaE5vZGUocHJvcCxcIlByb3BlcnR5XCIpKTt9cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLGlzUGF0dGVybj9cIk9iamVjdFBhdHRlcm5cIjpcIk9iamVjdEV4cHJlc3Npb25cIik7fTtwcC5wYXJzZVByb3BlcnR5VmFsdWUgPSBmdW5jdGlvbihwcm9wLGlzUGF0dGVybixpc0dlbmVyYXRvcixzdGFydFBvcyxzdGFydExvYyxyZWZTaG9ydGhhbmREZWZhdWx0UG9zKXtpZih0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLmNvbG9uKSl7cHJvcC52YWx1ZSA9IGlzUGF0dGVybj90aGlzLnBhcnNlTWF5YmVEZWZhdWx0KHRoaXMuc3RhcnQsdGhpcy5zdGFydExvYyk6dGhpcy5wYXJzZU1heWJlQXNzaWduKGZhbHNlLHJlZlNob3J0aGFuZERlZmF1bHRQb3MpO3Byb3Aua2luZCA9IFwiaW5pdFwiO31lbHNlIGlmKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2ICYmIHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5wYXJlbkwpe2lmKGlzUGF0dGVybil0aGlzLnVuZXhwZWN0ZWQoKTtwcm9wLmtpbmQgPSBcImluaXRcIjtwcm9wLm1ldGhvZCA9IHRydWU7cHJvcC52YWx1ZSA9IHRoaXMucGFyc2VNZXRob2QoaXNHZW5lcmF0b3IpO31lbHNlIGlmKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA1ICYmICFwcm9wLmNvbXB1dGVkICYmIHByb3Aua2V5LnR5cGUgPT09IFwiSWRlbnRpZmllclwiICYmIChwcm9wLmtleS5uYW1lID09PSBcImdldFwiIHx8IHByb3Aua2V5Lm5hbWUgPT09IFwic2V0XCIpICYmICh0aGlzLnR5cGUgIT0gX3Rva2VudHlwZS50eXBlcy5jb21tYSAmJiB0aGlzLnR5cGUgIT0gX3Rva2VudHlwZS50eXBlcy5icmFjZVIpKXtpZihpc0dlbmVyYXRvciB8fCBpc1BhdHRlcm4pdGhpcy51bmV4cGVjdGVkKCk7cHJvcC5raW5kID0gcHJvcC5rZXkubmFtZTt0aGlzLnBhcnNlUHJvcGVydHlOYW1lKHByb3ApO3Byb3AudmFsdWUgPSB0aGlzLnBhcnNlTWV0aG9kKGZhbHNlKTt2YXIgcGFyYW1Db3VudD1wcm9wLmtpbmQgPT09IFwiZ2V0XCI/MDoxO2lmKHByb3AudmFsdWUucGFyYW1zLmxlbmd0aCAhPT0gcGFyYW1Db3VudCl7dmFyIHN0YXJ0PXByb3AudmFsdWUuc3RhcnQ7aWYocHJvcC5raW5kID09PSBcImdldFwiKXRoaXMucmFpc2Uoc3RhcnQsXCJnZXR0ZXIgc2hvdWxkIGhhdmUgbm8gcGFyYW1zXCIpO2Vsc2UgdGhpcy5yYWlzZShzdGFydCxcInNldHRlciBzaG91bGQgaGF2ZSBleGFjdGx5IG9uZSBwYXJhbVwiKTt9fWVsc2UgaWYodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYgJiYgIXByb3AuY29tcHV0ZWQgJiYgcHJvcC5rZXkudHlwZSA9PT0gXCJJZGVudGlmaWVyXCIpe3Byb3Aua2luZCA9IFwiaW5pdFwiO2lmKGlzUGF0dGVybil7aWYodGhpcy5pc0tleXdvcmQocHJvcC5rZXkubmFtZSkgfHwgdGhpcy5zdHJpY3QgJiYgKF9pZGVudGlmaWVyLnJlc2VydmVkV29yZHMuc3RyaWN0QmluZChwcm9wLmtleS5uYW1lKSB8fCBfaWRlbnRpZmllci5yZXNlcnZlZFdvcmRzLnN0cmljdChwcm9wLmtleS5uYW1lKSkgfHwgIXRoaXMub3B0aW9ucy5hbGxvd1Jlc2VydmVkICYmIHRoaXMuaXNSZXNlcnZlZFdvcmQocHJvcC5rZXkubmFtZSkpdGhpcy5yYWlzZShwcm9wLmtleS5zdGFydCxcIkJpbmRpbmcgXCIgKyBwcm9wLmtleS5uYW1lKTtwcm9wLnZhbHVlID0gdGhpcy5wYXJzZU1heWJlRGVmYXVsdChzdGFydFBvcyxzdGFydExvYyxwcm9wLmtleSk7fWVsc2UgaWYodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmVxICYmIHJlZlNob3J0aGFuZERlZmF1bHRQb3Mpe2lmKCFyZWZTaG9ydGhhbmREZWZhdWx0UG9zLnN0YXJ0KXJlZlNob3J0aGFuZERlZmF1bHRQb3Muc3RhcnQgPSB0aGlzLnN0YXJ0O3Byb3AudmFsdWUgPSB0aGlzLnBhcnNlTWF5YmVEZWZhdWx0KHN0YXJ0UG9zLHN0YXJ0TG9jLHByb3Aua2V5KTt9ZWxzZSB7cHJvcC52YWx1ZSA9IHByb3Aua2V5O31wcm9wLnNob3J0aGFuZCA9IHRydWU7fWVsc2UgdGhpcy51bmV4cGVjdGVkKCk7fTtwcC5wYXJzZVByb3BlcnR5TmFtZSA9IGZ1bmN0aW9uKHByb3Ape2lmKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KXtpZih0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLmJyYWNrZXRMKSl7cHJvcC5jb21wdXRlZCA9IHRydWU7cHJvcC5rZXkgPSB0aGlzLnBhcnNlTWF5YmVBc3NpZ24oKTt0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmJyYWNrZXRSKTtyZXR1cm4gcHJvcC5rZXk7fWVsc2Uge3Byb3AuY29tcHV0ZWQgPSBmYWxzZTt9fXJldHVybiBwcm9wLmtleSA9IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5udW0gfHwgdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLnN0cmluZz90aGlzLnBhcnNlRXhwckF0b20oKTp0aGlzLnBhcnNlSWRlbnQodHJ1ZSk7fTsgLy8gSW5pdGlhbGl6ZSBlbXB0eSBmdW5jdGlvbiBub2RlLlxucHAuaW5pdEZ1bmN0aW9uID0gZnVuY3Rpb24obm9kZSl7bm9kZS5pZCA9IG51bGw7aWYodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpe25vZGUuZ2VuZXJhdG9yID0gZmFsc2U7bm9kZS5leHByZXNzaW9uID0gZmFsc2U7fX07IC8vIFBhcnNlIG9iamVjdCBvciBjbGFzcyBtZXRob2QuXG5wcC5wYXJzZU1ldGhvZCA9IGZ1bmN0aW9uKGlzR2VuZXJhdG9yKXt2YXIgbm9kZT10aGlzLnN0YXJ0Tm9kZSgpO3RoaXMuaW5pdEZ1bmN0aW9uKG5vZGUpO3RoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMucGFyZW5MKTtub2RlLnBhcmFtcyA9IHRoaXMucGFyc2VCaW5kaW5nTGlzdChfdG9rZW50eXBlLnR5cGVzLnBhcmVuUixmYWxzZSxmYWxzZSk7dmFyIGFsbG93RXhwcmVzc2lvbkJvZHk9dW5kZWZpbmVkO2lmKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KXtub2RlLmdlbmVyYXRvciA9IGlzR2VuZXJhdG9yO310aGlzLnBhcnNlRnVuY3Rpb25Cb2R5KG5vZGUsZmFsc2UpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIkZ1bmN0aW9uRXhwcmVzc2lvblwiKTt9OyAvLyBQYXJzZSBhcnJvdyBmdW5jdGlvbiBleHByZXNzaW9uIHdpdGggZ2l2ZW4gcGFyYW1ldGVycy5cbnBwLnBhcnNlQXJyb3dFeHByZXNzaW9uID0gZnVuY3Rpb24obm9kZSxwYXJhbXMpe3RoaXMuaW5pdEZ1bmN0aW9uKG5vZGUpO25vZGUucGFyYW1zID0gdGhpcy50b0Fzc2lnbmFibGVMaXN0KHBhcmFtcyx0cnVlKTt0aGlzLnBhcnNlRnVuY3Rpb25Cb2R5KG5vZGUsdHJ1ZSk7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiQXJyb3dGdW5jdGlvbkV4cHJlc3Npb25cIik7fTsgLy8gUGFyc2UgZnVuY3Rpb24gYm9keSBhbmQgY2hlY2sgcGFyYW1ldGVycy5cbnBwLnBhcnNlRnVuY3Rpb25Cb2R5ID0gZnVuY3Rpb24obm9kZSxhbGxvd0V4cHJlc3Npb24pe3ZhciBpc0V4cHJlc3Npb249YWxsb3dFeHByZXNzaW9uICYmIHRoaXMudHlwZSAhPT0gX3Rva2VudHlwZS50eXBlcy5icmFjZUw7aWYoaXNFeHByZXNzaW9uKXtub2RlLmJvZHkgPSB0aGlzLnBhcnNlTWF5YmVBc3NpZ24oKTtub2RlLmV4cHJlc3Npb24gPSB0cnVlO31lbHNlIHsgLy8gU3RhcnQgYSBuZXcgc2NvcGUgd2l0aCByZWdhcmQgdG8gbGFiZWxzIGFuZCB0aGUgYGluRnVuY3Rpb25gXG4vLyBmbGFnIChyZXN0b3JlIHRoZW0gdG8gdGhlaXIgb2xkIHZhbHVlIGFmdGVyd2FyZHMpLlxudmFyIG9sZEluRnVuYz10aGlzLmluRnVuY3Rpb24sb2xkSW5HZW49dGhpcy5pbkdlbmVyYXRvcixvbGRMYWJlbHM9dGhpcy5sYWJlbHM7dGhpcy5pbkZ1bmN0aW9uID0gdHJ1ZTt0aGlzLmluR2VuZXJhdG9yID0gbm9kZS5nZW5lcmF0b3I7dGhpcy5sYWJlbHMgPSBbXTtub2RlLmJvZHkgPSB0aGlzLnBhcnNlQmxvY2sodHJ1ZSk7bm9kZS5leHByZXNzaW9uID0gZmFsc2U7dGhpcy5pbkZ1bmN0aW9uID0gb2xkSW5GdW5jO3RoaXMuaW5HZW5lcmF0b3IgPSBvbGRJbkdlbjt0aGlzLmxhYmVscyA9IG9sZExhYmVsczt9IC8vIElmIHRoaXMgaXMgYSBzdHJpY3QgbW9kZSBmdW5jdGlvbiwgdmVyaWZ5IHRoYXQgYXJndW1lbnQgbmFtZXNcbi8vIGFyZSBub3QgcmVwZWF0ZWQsIGFuZCBpdCBkb2VzIG5vdCB0cnkgdG8gYmluZCB0aGUgd29yZHMgYGV2YWxgXG4vLyBvciBgYXJndW1lbnRzYC5cbmlmKHRoaXMuc3RyaWN0IHx8ICFpc0V4cHJlc3Npb24gJiYgbm9kZS5ib2R5LmJvZHkubGVuZ3RoICYmIHRoaXMuaXNVc2VTdHJpY3Qobm9kZS5ib2R5LmJvZHlbMF0pKXt2YXIgbmFtZUhhc2g9e30sb2xkU3RyaWN0PXRoaXMuc3RyaWN0O3RoaXMuc3RyaWN0ID0gdHJ1ZTtpZihub2RlLmlkKXRoaXMuY2hlY2tMVmFsKG5vZGUuaWQsdHJ1ZSk7Zm9yKHZhciBpPTA7aSA8IG5vZGUucGFyYW1zLmxlbmd0aDtpKyspIHt0aGlzLmNoZWNrTFZhbChub2RlLnBhcmFtc1tpXSx0cnVlLG5hbWVIYXNoKTt9dGhpcy5zdHJpY3QgPSBvbGRTdHJpY3Q7fX07IC8vIFBhcnNlcyBhIGNvbW1hLXNlcGFyYXRlZCBsaXN0IG9mIGV4cHJlc3Npb25zLCBhbmQgcmV0dXJucyB0aGVtIGFzXG4vLyBhbiBhcnJheS4gYGNsb3NlYCBpcyB0aGUgdG9rZW4gdHlwZSB0aGF0IGVuZHMgdGhlIGxpc3QsIGFuZFxuLy8gYGFsbG93RW1wdHlgIGNhbiBiZSB0dXJuZWQgb24gdG8gYWxsb3cgc3Vic2VxdWVudCBjb21tYXMgd2l0aFxuLy8gbm90aGluZyBpbiBiZXR3ZWVuIHRoZW0gdG8gYmUgcGFyc2VkIGFzIGBudWxsYCAod2hpY2ggaXMgbmVlZGVkXG4vLyBmb3IgYXJyYXkgbGl0ZXJhbHMpLlxucHAucGFyc2VFeHByTGlzdCA9IGZ1bmN0aW9uKGNsb3NlLGFsbG93VHJhaWxpbmdDb21tYSxhbGxvd0VtcHR5LHJlZlNob3J0aGFuZERlZmF1bHRQb3Mpe3ZhciBlbHRzPVtdLGZpcnN0PXRydWU7d2hpbGUoIXRoaXMuZWF0KGNsb3NlKSkge2lmKCFmaXJzdCl7dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5jb21tYSk7aWYoYWxsb3dUcmFpbGluZ0NvbW1hICYmIHRoaXMuYWZ0ZXJUcmFpbGluZ0NvbW1hKGNsb3NlKSlicmVhazt9ZWxzZSBmaXJzdCA9IGZhbHNlO3ZhciBlbHQ9dW5kZWZpbmVkO2lmKGFsbG93RW1wdHkgJiYgdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmNvbW1hKWVsdCA9IG51bGw7ZWxzZSBpZih0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuZWxsaXBzaXMpZWx0ID0gdGhpcy5wYXJzZVNwcmVhZChyZWZTaG9ydGhhbmREZWZhdWx0UG9zKTtlbHNlIGVsdCA9IHRoaXMucGFyc2VNYXliZUFzc2lnbihmYWxzZSxyZWZTaG9ydGhhbmREZWZhdWx0UG9zKTtlbHRzLnB1c2goZWx0KTt9cmV0dXJuIGVsdHM7fTsgLy8gUGFyc2UgdGhlIG5leHQgdG9rZW4gYXMgYW4gaWRlbnRpZmllci4gSWYgYGxpYmVyYWxgIGlzIHRydWUgKHVzZWRcbi8vIHdoZW4gcGFyc2luZyBwcm9wZXJ0aWVzKSwgaXQgd2lsbCBhbHNvIGNvbnZlcnQga2V5d29yZHMgaW50b1xuLy8gaWRlbnRpZmllcnMuXG5wcC5wYXJzZUlkZW50ID0gZnVuY3Rpb24obGliZXJhbCl7dmFyIG5vZGU9dGhpcy5zdGFydE5vZGUoKTtpZihsaWJlcmFsICYmIHRoaXMub3B0aW9ucy5hbGxvd1Jlc2VydmVkID09IFwibmV2ZXJcIilsaWJlcmFsID0gZmFsc2U7aWYodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLm5hbWUpe2lmKCFsaWJlcmFsICYmICghdGhpcy5vcHRpb25zLmFsbG93UmVzZXJ2ZWQgJiYgdGhpcy5pc1Jlc2VydmVkV29yZCh0aGlzLnZhbHVlKSB8fCB0aGlzLnN0cmljdCAmJiBfaWRlbnRpZmllci5yZXNlcnZlZFdvcmRzLnN0cmljdCh0aGlzLnZhbHVlKSAmJiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYgfHwgdGhpcy5pbnB1dC5zbGljZSh0aGlzLnN0YXJ0LHRoaXMuZW5kKS5pbmRleE9mKFwiXFxcXFwiKSA9PSAtMSkpKXRoaXMucmFpc2UodGhpcy5zdGFydCxcIlRoZSBrZXl3b3JkICdcIiArIHRoaXMudmFsdWUgKyBcIicgaXMgcmVzZXJ2ZWRcIik7bm9kZS5uYW1lID0gdGhpcy52YWx1ZTt9ZWxzZSBpZihsaWJlcmFsICYmIHRoaXMudHlwZS5rZXl3b3JkKXtub2RlLm5hbWUgPSB0aGlzLnR5cGUua2V5d29yZDt9ZWxzZSB7dGhpcy51bmV4cGVjdGVkKCk7fXRoaXMubmV4dCgpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIklkZW50aWZpZXJcIik7fTsgLy8gUGFyc2VzIHlpZWxkIGV4cHJlc3Npb24gaW5zaWRlIGdlbmVyYXRvci5cbnBwLnBhcnNlWWllbGQgPSBmdW5jdGlvbigpe3ZhciBub2RlPXRoaXMuc3RhcnROb2RlKCk7dGhpcy5uZXh0KCk7aWYodGhpcy50eXBlID09IF90b2tlbnR5cGUudHlwZXMuc2VtaSB8fCB0aGlzLmNhbkluc2VydFNlbWljb2xvbigpIHx8IHRoaXMudHlwZSAhPSBfdG9rZW50eXBlLnR5cGVzLnN0YXIgJiYgIXRoaXMudHlwZS5zdGFydHNFeHByKXtub2RlLmRlbGVnYXRlID0gZmFsc2U7bm9kZS5hcmd1bWVudCA9IG51bGw7fWVsc2Uge25vZGUuZGVsZWdhdGUgPSB0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLnN0YXIpO25vZGUuYXJndW1lbnQgPSB0aGlzLnBhcnNlTWF5YmVBc3NpZ24oKTt9cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiWWllbGRFeHByZXNzaW9uXCIpO307IC8vIFBhcnNlcyBhcnJheSBhbmQgZ2VuZXJhdG9yIGNvbXByZWhlbnNpb25zLlxucHAucGFyc2VDb21wcmVoZW5zaW9uID0gZnVuY3Rpb24obm9kZSxpc0dlbmVyYXRvcil7bm9kZS5ibG9ja3MgPSBbXTt3aGlsZSh0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2Zvcikge3ZhciBibG9jaz10aGlzLnN0YXJ0Tm9kZSgpO3RoaXMubmV4dCgpO3RoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMucGFyZW5MKTtibG9jay5sZWZ0ID0gdGhpcy5wYXJzZUJpbmRpbmdBdG9tKCk7dGhpcy5jaGVja0xWYWwoYmxvY2subGVmdCx0cnVlKTt0aGlzLmV4cGVjdENvbnRleHR1YWwoXCJvZlwiKTtibG9jay5yaWdodCA9IHRoaXMucGFyc2VFeHByZXNzaW9uKCk7dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5wYXJlblIpO25vZGUuYmxvY2tzLnB1c2godGhpcy5maW5pc2hOb2RlKGJsb2NrLFwiQ29tcHJlaGVuc2lvbkJsb2NrXCIpKTt9bm9kZS5maWx0ZXIgPSB0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLl9pZik/dGhpcy5wYXJzZVBhcmVuRXhwcmVzc2lvbigpOm51bGw7bm9kZS5ib2R5ID0gdGhpcy5wYXJzZUV4cHJlc3Npb24oKTt0aGlzLmV4cGVjdChpc0dlbmVyYXRvcj9fdG9rZW50eXBlLnR5cGVzLnBhcmVuUjpfdG9rZW50eXBlLnR5cGVzLmJyYWNrZXRSKTtub2RlLmdlbmVyYXRvciA9IGlzR2VuZXJhdG9yO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIkNvbXByZWhlbnNpb25FeHByZXNzaW9uXCIpO307fSx7XCIuL2lkZW50aWZpZXJcIjoyLFwiLi9zdGF0ZVwiOjEwLFwiLi90b2tlbnR5cGVcIjoxNCxcIi4vdXRpbFwiOjE1fV0sMjpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7IC8vIFRoaXMgaXMgYSB0cmljayB0YWtlbiBmcm9tIEVzcHJpbWEuIEl0IHR1cm5zIG91dCB0aGF0LCBvblxuLy8gbm9uLUNocm9tZSBicm93c2VycywgdG8gY2hlY2sgd2hldGhlciBhIHN0cmluZyBpcyBpbiBhIHNldCwgYVxuLy8gcHJlZGljYXRlIGNvbnRhaW5pbmcgYSBiaWcgdWdseSBgc3dpdGNoYCBzdGF0ZW1lbnQgaXMgZmFzdGVyIHRoYW5cbi8vIGEgcmVndWxhciBleHByZXNzaW9uLCBhbmQgb24gQ2hyb21lIHRoZSB0d28gYXJlIGFib3V0IG9uIHBhci5cbi8vIFRoaXMgZnVuY3Rpb24gdXNlcyBgZXZhbGAgKG5vbi1sZXhpY2FsKSB0byBwcm9kdWNlIHN1Y2ggYVxuLy8gcHJlZGljYXRlIGZyb20gYSBzcGFjZS1zZXBhcmF0ZWQgc3RyaW5nIG9mIHdvcmRzLlxuLy9cbi8vIEl0IHN0YXJ0cyBieSBzb3J0aW5nIHRoZSB3b3JkcyBieSBsZW5ndGguXG5cInVzZSBzdHJpY3RcIjtleHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO2V4cG9ydHMuaXNJZGVudGlmaWVyU3RhcnQgPSBpc0lkZW50aWZpZXJTdGFydDtleHBvcnRzLmlzSWRlbnRpZmllckNoYXIgPSBpc0lkZW50aWZpZXJDaGFyO2Z1bmN0aW9uIG1ha2VQcmVkaWNhdGUod29yZHMpe3dvcmRzID0gd29yZHMuc3BsaXQoXCIgXCIpO3ZhciBmPVwiXCIsY2F0cz1bXTtvdXQ6IGZvcih2YXIgaT0wO2kgPCB3b3Jkcy5sZW5ndGg7KytpKSB7Zm9yKHZhciBqPTA7aiA8IGNhdHMubGVuZ3RoOysraikge2lmKGNhdHNbal1bMF0ubGVuZ3RoID09IHdvcmRzW2ldLmxlbmd0aCl7Y2F0c1tqXS5wdXNoKHdvcmRzW2ldKTtjb250aW51ZSBvdXQ7fX1jYXRzLnB1c2goW3dvcmRzW2ldXSk7fWZ1bmN0aW9uIGNvbXBhcmVUbyhhcnIpe2lmKGFyci5sZW5ndGggPT0gMSlyZXR1cm4gZiArPSBcInJldHVybiBzdHIgPT09IFwiICsgSlNPTi5zdHJpbmdpZnkoYXJyWzBdKSArIFwiO1wiO2YgKz0gXCJzd2l0Y2goc3RyKXtcIjtmb3IodmFyIGk9MDtpIDwgYXJyLmxlbmd0aDsrK2kpIHtmICs9IFwiY2FzZSBcIiArIEpTT04uc3RyaW5naWZ5KGFycltpXSkgKyBcIjpcIjt9ZiArPSBcInJldHVybiB0cnVlfXJldHVybiBmYWxzZTtcIjt9IC8vIFdoZW4gdGhlcmUgYXJlIG1vcmUgdGhhbiB0aHJlZSBsZW5ndGggY2F0ZWdvcmllcywgYW4gb3V0ZXJcbi8vIHN3aXRjaCBmaXJzdCBkaXNwYXRjaGVzIG9uIHRoZSBsZW5ndGhzLCB0byBzYXZlIG9uIGNvbXBhcmlzb25zLlxuaWYoY2F0cy5sZW5ndGggPiAzKXtjYXRzLnNvcnQoZnVuY3Rpb24oYSxiKXtyZXR1cm4gYi5sZW5ndGggLSBhLmxlbmd0aDt9KTtmICs9IFwic3dpdGNoKHN0ci5sZW5ndGgpe1wiO2Zvcih2YXIgaT0wO2kgPCBjYXRzLmxlbmd0aDsrK2kpIHt2YXIgY2F0PWNhdHNbaV07ZiArPSBcImNhc2UgXCIgKyBjYXRbMF0ubGVuZ3RoICsgXCI6XCI7Y29tcGFyZVRvKGNhdCk7fWYgKz0gXCJ9XCI7IC8vIE90aGVyd2lzZSwgc2ltcGx5IGdlbmVyYXRlIGEgZmxhdCBgc3dpdGNoYCBzdGF0ZW1lbnQuXG59ZWxzZSB7Y29tcGFyZVRvKHdvcmRzKTt9cmV0dXJuIG5ldyBGdW5jdGlvbihcInN0clwiLGYpO30gLy8gUmVzZXJ2ZWQgd29yZCBsaXN0cyBmb3IgdmFyaW91cyBkaWFsZWN0cyBvZiB0aGUgbGFuZ3VhZ2VcbnZhciByZXNlcnZlZFdvcmRzPXszOm1ha2VQcmVkaWNhdGUoXCJhYnN0cmFjdCBib29sZWFuIGJ5dGUgY2hhciBjbGFzcyBkb3VibGUgZW51bSBleHBvcnQgZXh0ZW5kcyBmaW5hbCBmbG9hdCBnb3RvIGltcGxlbWVudHMgaW1wb3J0IGludCBpbnRlcmZhY2UgbG9uZyBuYXRpdmUgcGFja2FnZSBwcml2YXRlIHByb3RlY3RlZCBwdWJsaWMgc2hvcnQgc3RhdGljIHN1cGVyIHN5bmNocm9uaXplZCB0aHJvd3MgdHJhbnNpZW50IHZvbGF0aWxlXCIpLDU6bWFrZVByZWRpY2F0ZShcImNsYXNzIGVudW0gZXh0ZW5kcyBzdXBlciBjb25zdCBleHBvcnQgaW1wb3J0XCIpLDY6bWFrZVByZWRpY2F0ZShcImVudW0gYXdhaXRcIiksc3RyaWN0Om1ha2VQcmVkaWNhdGUoXCJpbXBsZW1lbnRzIGludGVyZmFjZSBsZXQgcGFja2FnZSBwcml2YXRlIHByb3RlY3RlZCBwdWJsaWMgc3RhdGljIHlpZWxkXCIpLHN0cmljdEJpbmQ6bWFrZVByZWRpY2F0ZShcImV2YWwgYXJndW1lbnRzXCIpfTtleHBvcnRzLnJlc2VydmVkV29yZHMgPSByZXNlcnZlZFdvcmRzOyAvLyBBbmQgdGhlIGtleXdvcmRzXG52YXIgZWNtYTVBbmRMZXNzS2V5d29yZHM9XCJicmVhayBjYXNlIGNhdGNoIGNvbnRpbnVlIGRlYnVnZ2VyIGRlZmF1bHQgZG8gZWxzZSBmaW5hbGx5IGZvciBmdW5jdGlvbiBpZiByZXR1cm4gc3dpdGNoIHRocm93IHRyeSB2YXIgd2hpbGUgd2l0aCBudWxsIHRydWUgZmFsc2UgaW5zdGFuY2VvZiB0eXBlb2Ygdm9pZCBkZWxldGUgbmV3IGluIHRoaXNcIjt2YXIga2V5d29yZHM9ezU6bWFrZVByZWRpY2F0ZShlY21hNUFuZExlc3NLZXl3b3JkcyksNjptYWtlUHJlZGljYXRlKGVjbWE1QW5kTGVzc0tleXdvcmRzICsgXCIgbGV0IGNvbnN0IGNsYXNzIGV4dGVuZHMgZXhwb3J0IGltcG9ydCB5aWVsZCBzdXBlclwiKX07ZXhwb3J0cy5rZXl3b3JkcyA9IGtleXdvcmRzOyAvLyAjIyBDaGFyYWN0ZXIgY2F0ZWdvcmllc1xuLy8gQmlnIHVnbHkgcmVndWxhciBleHByZXNzaW9ucyB0aGF0IG1hdGNoIGNoYXJhY3RlcnMgaW4gdGhlXG4vLyB3aGl0ZXNwYWNlLCBpZGVudGlmaWVyLCBhbmQgaWRlbnRpZmllci1zdGFydCBjYXRlZ29yaWVzLiBUaGVzZVxuLy8gYXJlIG9ubHkgYXBwbGllZCB3aGVuIGEgY2hhcmFjdGVyIGlzIGZvdW5kIHRvIGFjdHVhbGx5IGhhdmUgYVxuLy8gY29kZSBwb2ludCBhYm92ZSAxMjguXG4vLyBHZW5lcmF0ZWQgYnkgYHRvb2xzL2dlbmVyYXRlLWlkZW50aWZpZXItcmVnZXguanNgLlxudmFyIG5vbkFTQ0lJaWRlbnRpZmllclN0YXJ0Q2hhcnM9XCLCqsK1wrrDgC3DlsOYLcO2w7gty4HLhi3LkcugLcuky6zLrs2wLc20zbbNt826Lc29zb/Ohs6ILc6KzozOji3Ooc6jLc+1z7ct0oHSii3Ur9SxLdWW1ZnVoS3Wh9eQLdeq17At17LYoC3Zitmu2a/ZsS3bk9uV26Xbptuu26/bui3bvNu/3JDcki3cr92NLd6l3rHfii3fqt+037XfuuCggC3goJXgoJrgoKTgoKjgoYAt4KGY4KKgLeCisuCkhC3gpLngpL3gpZDgpZgt4KWh4KWxLeCmgOCmhS3gpozgpo/gppDgppMt4Kao4KaqLeCmsOCmsuCmti3gprngpr3gp47gp5zgp53gp58t4Keh4Kew4Kex4KiFLeCoiuCoj+CokOCoky3gqKjgqKot4Kiw4Kiy4Kiz4Ki14Ki24Ki44Ki54KmZLeCpnOCpnuCpsi3gqbTgqoUt4KqN4KqPLeCqkeCqky3gqqjgqqot4Kqw4Kqy4Kqz4Kq1LeCqueCqveCrkOCroOCroeCshS3grIzgrI/grJDgrJMt4Kyo4KyqLeCssOCssuCss+CstS3grLngrL3grZzgrZ3grZ8t4K2h4K2x4K6D4K6FLeCuiuCuji3grpDgrpIt4K6V4K6Z4K6a4K6c4K6e4K6f4K6j4K6k4K6oLeCuquCuri3grrngr5DgsIUt4LCM4LCOLeCwkOCwki3gsKjgsKot4LC54LC94LGY4LGZ4LGg4LGh4LKFLeCyjOCyji3gspDgspIt4LKo4LKqLeCys+CytS3gsrngsr3gs57gs6Dgs6Hgs7Hgs7LgtIUt4LSM4LSOLeC0kOC0ki3gtLrgtL3gtY7gtaDgtaHgtbot4LW/4LaFLeC2luC2mi3gtrHgtrMt4La74La94LeALeC3huC4gS3guLDguLLguLPguYAt4LmG4LqB4LqC4LqE4LqH4LqI4LqK4LqN4LqULeC6l+C6mS3gup/guqEt4Lqj4Lql4Lqn4Lqq4Lqr4LqtLeC6sOC6suC6s+C6veC7gC3gu4Tgu4bgu5wt4Luf4LyA4L2ALeC9h+C9iS3gvazgvogt4L6M4YCALeGAquGAv+GBkC3hgZXhgZot4YGd4YGh4YGl4YGm4YGuLeGBsOGBtS3hgoHhgo7hgqAt4YOF4YOH4YON4YOQLeGDuuGDvC3hiYjhiYot4YmN4YmQLeGJluGJmOGJmi3hiZ3hiaAt4YqI4YqKLeGKjeGKkC3hirDhirIt4Yq14Yq4LeGKvuGLgOGLgi3hi4Xhi4gt4YuW4YuYLeGMkOGMki3hjJXhjJgt4Y2a4Y6ALeGOj+GOoC3hj7ThkIEt4Zms4ZmvLeGZv+GagS3hmprhmqAt4Zuq4ZuuLeGbuOGcgC3hnIzhnI4t4ZyR4ZygLeGcseGdgC3hnZHhnaAt4Z2s4Z2uLeGdsOGegC3hnrPhn5fhn5zhoKAt4aG34aKALeGiqOGiquGisC3ho7XhpIAt4aSe4aWQLeGlreGlsC3hpbThpoAt4aar4aeBLeGnh+GogC3hqJbhqKAt4amU4aqn4ayFLeGss+GthS3hrYvhroMt4a6g4a6u4a6v4a66LeGvpeGwgC3hsKPhsY0t4bGP4bGaLeGxveGzqS3hs6zhs64t4bOx4bO14bO24bSALeG2v+G4gC3hvJXhvJgt4byd4bygLeG9heG9iC3hvY3hvZAt4b2X4b2Z4b2b4b2d4b2fLeG9veG+gC3hvrThvrYt4b684b6+4b+CLeG/hOG/hi3hv4zhv5At4b+T4b+WLeG/m+G/oC3hv6zhv7It4b+04b+2LeG/vOKBseKBv+KCkC3igpzihILihIfihIot4oST4oSV4oSYLeKEneKEpOKEpuKEqOKEqi3ihLnihLwt4oS/4oWFLeKFieKFjuKFoC3ihojisIAt4rCu4rCwLeKxnuKxoC3is6Tis6st4rOu4rOy4rOz4rSALeK0peK0p+K0reK0sC3itafita/itoAt4raW4ragLeK2puK2qC3itq7itrAt4ra24ra4LeK2vuK3gC3it4bit4gt4reO4reQLeK3luK3mC3it57jgIUt44CH44ChLeOAqeOAsS3jgLXjgLgt44C844GBLeOCluOCmy3jgp/jgqEt44O644O8LeODv+OEhS3jhK3jhLEt44aO44agLeOGuuOHsC3jh7/jkIAt5La15LiALem/jOqAgC3qkozqk5At6pO96pSALeqYjOqYkC3qmJ/qmKrqmKvqmYAt6pmu6pm/LeqaneqaoC3qm6/qnJct6pyf6pyiLeqeiOqeiy3qno7qnpAt6p6t6p6w6p6x6p+3Leqggeqggy3qoIXqoIct6qCK6qCMLeqgouqhgC3qobPqooIt6qKz6qOyLeqjt+qju+qkii3qpKXqpLAt6qWG6qWgLeqlvOqmhC3qprLqp4/qp6At6qek6qemLeqnr+qnui3qp77qqIAt6qio6qmALeqpguqphC3qqYvqqaAt6qm26qm66qm+Leqqr+qqseqqteqqtuqquS3qqr3qq4Dqq4Lqq5st6qud6qugLeqrquqrsi3qq7TqrIEt6qyG6qyJLeqsjuqskS3qrJbqrKAt6qym6qyoLeqsruqssC3qrZrqrZwt6q2f6q2k6q2l6q+ALeqvouqwgC3tnqPtnrAt7Z+G7Z+LLe2fu++kgC3vqa3vqbAt76uZ76yALe+shu+sky3vrJfvrJ3vrJ8t76yo76yqLe+stu+suC3vrLzvrL7vrYDvrYHvrYPvrYTvrYYt766x76+TLe+0ve+1kC3vto/vtpIt77eH77ewLe+3u++5sC3vubTvubYt77u877yhLe+8uu+9gS3vvZrvvaYt776+77+CLe+/h++/ii3vv4/vv5It77+X77+aLe+/nFwiO3ZhciBub25BU0NJSWlkZW50aWZpZXJDaGFycz1cIuKAjOKAjcK3zIAtza/Oh9KDLdKH1pEt1r3Wv9eB14LXhNeF14fYkC3YmtmLLdmp2bDbli3bnNufLduk26fbqNuqLdut27At27nckdywLd2K3qYt3rDfgC3fid+rLd+z4KCWLeCgmeCgmy3goKPgoKUt4KCn4KCpLeCgreChmS3goZvgo6Qt4KSD4KS6LeCkvOCkvi3gpY/gpZEt4KWX4KWi4KWj4KWmLeClr+CmgS3gpoPgprzgpr4t4KeE4KeH4KeI4KeLLeCnjeCnl+CnouCno+Cnpi3gp6/gqIEt4KiD4Ki84Ki+LeCpguCph+CpiOCpiy3gqY3gqZHgqaYt4Kmx4Km14KqBLeCqg+CqvOCqvi3gq4Xgq4ct4KuJ4KuLLeCrjeCrouCro+Crpi3gq6/grIEt4KyD4Ky84Ky+LeCthOCth+CtiOCtiy3grY3grZbgrZfgraLgraPgraYt4K2v4K6C4K6+LeCvguCvhi3gr4jgr4ot4K+N4K+X4K+mLeCvr+CwgC3gsIPgsL4t4LGE4LGGLeCxiOCxii3gsY3gsZXgsZbgsaLgsaPgsaYt4LGv4LKBLeCyg+CyvOCyvi3gs4Tgs4Yt4LOI4LOKLeCzjeCzleCzluCzouCzo+Czpi3gs6/gtIEt4LSD4LS+LeC1hOC1hi3gtYjgtYot4LWN4LWX4LWi4LWj4LWmLeC1r+C2guC2g+C3iuC3jy3gt5Tgt5bgt5gt4Lef4LemLeC3r+C3suC3s+C4seC4tC3guLrguYct4LmO4LmQLeC5meC6seC6tC3gurngurvgurzgu4gt4LuN4LuQLeC7meC8mOC8meC8oC3gvKngvLXgvLfgvLngvL7gvL/gvbEt4L6E4L6G4L6H4L6NLeC+l+C+mS3gvrzgv4bhgKst4YC+4YGALeGBieGBli3hgZnhgZ4t4YGg4YGiLeGBpOGBpy3hga3hgbEt4YG04YKCLeGCjeGCjy3hgp3hjZ0t4Y2f4Y2pLeGNseGcki3hnJThnLIt4Zy04Z2S4Z2T4Z2y4Z2z4Z60LeGfk+GfneGfoC3hn6nhoIst4aCN4aCQLeGgmeGiqeGkoC3hpKvhpLAt4aS74aWGLeGlj+GmsC3hp4Dhp4jhp4nhp5At4aea4aiXLeGom+GplS3hqZ7hqaAt4am84am/LeGqieGqkC3hqpnhqrAt4aq94ayALeGshOGstC3hrYThrZAt4a2Z4a2rLeGts+GugC3hroLhrqEt4a6t4a6wLeGuueGvpi3hr7PhsKQt4bC34bGALeGxieGxkC3hsZnhs5At4bOS4bOULeGzqOGzreGzsi3hs7Ths7jhs7nht4At4be14be8LeG3v+KAv+KBgOKBlOKDkC3ig5zig6Hig6Ut4oOw4rOvLeKzseK1v+K3oC3it7/jgKot44Cv44KZ44Ka6pigLeqYqeqZr+qZtC3qmb3qmp/qm7Dqm7HqoILqoIbqoIvqoKMt6qCn6qKA6qKB6qK0LeqjhOqjkC3qo5nqo6At6qOx6qSALeqkieqkpi3qpK3qpYct6qWT6qaALeqmg+qmsy3qp4Dqp5At6qeZ6qel6qewLeqnueqoqS3qqLbqqYPqqYzqqY3qqZAt6qmZ6qm7LeqpveqqsOqqsi3qqrTqqrfqqrjqqr7qqr/qq4Hqq6st6quv6qu16qu26q+jLeqvquqvrOqvreqvsC3qr7nvrJ7vuIAt77iP77igLe+4re+4s++4tO+5jS3vuY/vvJAt77yZ77y/XCI7dmFyIG5vbkFTQ0lJaWRlbnRpZmllclN0YXJ0PW5ldyBSZWdFeHAoXCJbXCIgKyBub25BU0NJSWlkZW50aWZpZXJTdGFydENoYXJzICsgXCJdXCIpO3ZhciBub25BU0NJSWlkZW50aWZpZXI9bmV3IFJlZ0V4cChcIltcIiArIG5vbkFTQ0lJaWRlbnRpZmllclN0YXJ0Q2hhcnMgKyBub25BU0NJSWlkZW50aWZpZXJDaGFycyArIFwiXVwiKTtub25BU0NJSWlkZW50aWZpZXJTdGFydENoYXJzID0gbm9uQVNDSUlpZGVudGlmaWVyQ2hhcnMgPSBudWxsOyAvLyBUaGVzZSBhcmUgYSBydW4tbGVuZ3RoIGFuZCBvZmZzZXQgZW5jb2RlZCByZXByZXNlbnRhdGlvbiBvZiB0aGVcbi8vID4weGZmZmYgY29kZSBwb2ludHMgdGhhdCBhcmUgYSB2YWxpZCBwYXJ0IG9mIGlkZW50aWZpZXJzLiBUaGVcbi8vIG9mZnNldCBzdGFydHMgYXQgMHgxMDAwMCwgYW5kIGVhY2ggcGFpciBvZiBudW1iZXJzIHJlcHJlc2VudHMgYW5cbi8vIG9mZnNldCB0byB0aGUgbmV4dCByYW5nZSwgYW5kIHRoZW4gYSBzaXplIG9mIHRoZSByYW5nZS4gVGhleSB3ZXJlXG4vLyBnZW5lcmF0ZWQgYnkgdG9vbHMvZ2VuZXJhdGUtaWRlbnRpZmllci1yZWdleC5qc1xudmFyIGFzdHJhbElkZW50aWZpZXJTdGFydENvZGVzPVswLDExLDIsMjUsMiwxOCwyLDEsMiwxNCwzLDEzLDM1LDEyMiw3MCw1MiwyNjgsMjgsNCw0OCw0OCwzMSwxNywyNiw2LDM3LDExLDI5LDMsMzUsNSw3LDIsNCw0MywxNTcsOTksMzksOSw1MSwxNTcsMzEwLDEwLDIxLDExLDcsMTUzLDUsMywwLDIsNDMsMiwxLDQsMCwzLDIyLDExLDIyLDEwLDMwLDk4LDIxLDExLDI1LDcxLDU1LDcsMSw2NSwwLDE2LDMsMiwyLDIsMjYsNDUsMjgsNCwyOCwzNiw3LDIsMjcsMjgsNTMsMTEsMjEsMTEsMTgsMTQsMTcsMTExLDcyLDk1NSw1Miw3Niw0NCwzMywyNCwyNywzNSw0MiwzNCw0LDAsMTMsNDcsMTUsMywyMiwwLDM4LDE3LDIsMjQsMTMzLDQ2LDM5LDcsMywxLDMsMjEsMiw2LDIsMSwyLDQsNCwwLDMyLDQsMjg3LDQ3LDIxLDEsMiwwLDE4NSw0Niw4Miw0NywyMSwwLDYwLDQyLDUwMiw2MywzMiwwLDQ0OSw1NiwxMjg4LDkyMCwxMDQsMTEwLDI5NjIsMTA3MCwxMzI2Niw1NjgsOCwzMCwxMTQsMjksMTksNDcsMTcsMywzMiwyMCw2LDE4LDg4MSw2OCwxMiwwLDY3LDEyLDE2NDgxLDEsMzA3MSwxMDYsNiwxMiw0LDgsOCw5LDU5OTEsODQsMiw3MCwyLDEsMywwLDMsMSwzLDMsMiwxMSwyLDAsMiw2LDIsNjQsMiwzLDMsNywyLDYsMiwyNywyLDMsMiw0LDIsMCw0LDYsMiwzMzksMywyNCwyLDI0LDIsMzAsMiwyNCwyLDMwLDIsMjQsMiwzMCwyLDI0LDIsMzAsMiwyNCwyLDcsNDE0OSwxOTYsMTM0MCwzLDIsMjYsMiwxLDIsMCwzLDAsMiw5LDIsMywyLDAsMiwwLDcsMCw1LDAsMiwwLDIsMCwyLDIsMiwxLDIsMCwzLDAsMiwwLDIsMCwyLDAsMiwwLDIsMSwyLDAsMywzLDIsNiwyLDMsMiwzLDIsMCwyLDksMiwxNiw2LDIsMiw0LDIsMTYsNDQyMSw0MjcxMCw0Miw0MTQ4LDEyLDIyMSwxNjM1NSw1NDFdO3ZhciBhc3RyYWxJZGVudGlmaWVyQ29kZXM9WzUwOSwwLDIyNywwLDE1MCw0LDI5NCw5LDEzNjgsMiwyLDEsNiwzLDQxLDIsNSwwLDE2NiwxLDEzMDYsMiw1NCwxNCwzMiw5LDE2LDMsNDYsMTAsNTQsOSw3LDIsMzcsMTMsMiw5LDUyLDAsMTMsMiw0OSwxMywxNiw5LDgzLDExLDE2OCwxMSw2LDksOCwyLDU3LDAsMiw2LDMsMSwzLDIsMTAsMCwxMSwxLDMsNiw0LDQsMzE2LDE5LDEzLDksMjE0LDYsMyw4LDExMiwxNiwxNiw5LDgyLDEyLDksOSw1MzUsOSwyMDg1NSw5LDEzNSw0LDYwLDYsMjYsOSwxMDE2LDQ1LDE3LDMsMTk3MjMsMSw1MzE5LDQsNCw1LDksNywzLDYsMzEsMywxNDksMiwxNDE4LDQ5LDQzMDUsNiw3OTI2MTgsMjM5XTsgLy8gVGhpcyBoYXMgYSBjb21wbGV4aXR5IGxpbmVhciB0byB0aGUgdmFsdWUgb2YgdGhlIGNvZGUuIFRoZVxuLy8gYXNzdW1wdGlvbiBpcyB0aGF0IGxvb2tpbmcgdXAgYXN0cmFsIGlkZW50aWZpZXIgY2hhcmFjdGVycyBpc1xuLy8gcmFyZS5cbmZ1bmN0aW9uIGlzSW5Bc3RyYWxTZXQoY29kZSxzZXQpe3ZhciBwb3M9MHgxMDAwMDtmb3IodmFyIGk9MDtpIDwgc2V0Lmxlbmd0aDtpICs9IDIpIHtwb3MgKz0gc2V0W2ldO2lmKHBvcyA+IGNvZGUpcmV0dXJuIGZhbHNlO3BvcyArPSBzZXRbaSArIDFdO2lmKHBvcyA+PSBjb2RlKXJldHVybiB0cnVlO319IC8vIFRlc3Qgd2hldGhlciBhIGdpdmVuIGNoYXJhY3RlciBjb2RlIHN0YXJ0cyBhbiBpZGVudGlmaWVyLlxuZnVuY3Rpb24gaXNJZGVudGlmaWVyU3RhcnQoY29kZSxhc3RyYWwpe2lmKGNvZGUgPCA2NSlyZXR1cm4gY29kZSA9PT0gMzY7aWYoY29kZSA8IDkxKXJldHVybiB0cnVlO2lmKGNvZGUgPCA5NylyZXR1cm4gY29kZSA9PT0gOTU7aWYoY29kZSA8IDEyMylyZXR1cm4gdHJ1ZTtpZihjb2RlIDw9IDB4ZmZmZilyZXR1cm4gY29kZSA+PSAweGFhICYmIG5vbkFTQ0lJaWRlbnRpZmllclN0YXJ0LnRlc3QoU3RyaW5nLmZyb21DaGFyQ29kZShjb2RlKSk7aWYoYXN0cmFsID09PSBmYWxzZSlyZXR1cm4gZmFsc2U7cmV0dXJuIGlzSW5Bc3RyYWxTZXQoY29kZSxhc3RyYWxJZGVudGlmaWVyU3RhcnRDb2Rlcyk7fSAvLyBUZXN0IHdoZXRoZXIgYSBnaXZlbiBjaGFyYWN0ZXIgaXMgcGFydCBvZiBhbiBpZGVudGlmaWVyLlxuZnVuY3Rpb24gaXNJZGVudGlmaWVyQ2hhcihjb2RlLGFzdHJhbCl7aWYoY29kZSA8IDQ4KXJldHVybiBjb2RlID09PSAzNjtpZihjb2RlIDwgNTgpcmV0dXJuIHRydWU7aWYoY29kZSA8IDY1KXJldHVybiBmYWxzZTtpZihjb2RlIDwgOTEpcmV0dXJuIHRydWU7aWYoY29kZSA8IDk3KXJldHVybiBjb2RlID09PSA5NTtpZihjb2RlIDwgMTIzKXJldHVybiB0cnVlO2lmKGNvZGUgPD0gMHhmZmZmKXJldHVybiBjb2RlID49IDB4YWEgJiYgbm9uQVNDSUlpZGVudGlmaWVyLnRlc3QoU3RyaW5nLmZyb21DaGFyQ29kZShjb2RlKSk7aWYoYXN0cmFsID09PSBmYWxzZSlyZXR1cm4gZmFsc2U7cmV0dXJuIGlzSW5Bc3RyYWxTZXQoY29kZSxhc3RyYWxJZGVudGlmaWVyU3RhcnRDb2RlcykgfHwgaXNJbkFzdHJhbFNldChjb2RlLGFzdHJhbElkZW50aWZpZXJDb2Rlcyk7fX0se31dLDM6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpeyAvLyBBY29ybiBpcyBhIHRpbnksIGZhc3QgSmF2YVNjcmlwdCBwYXJzZXIgd3JpdHRlbiBpbiBKYXZhU2NyaXB0LlxuLy9cbi8vIEFjb3JuIHdhcyB3cml0dGVuIGJ5IE1hcmlqbiBIYXZlcmJla2UsIEluZ3ZhciBTdGVwYW55YW4sIGFuZFxuLy8gdmFyaW91cyBjb250cmlidXRvcnMgYW5kIHJlbGVhc2VkIHVuZGVyIGFuIE1JVCBsaWNlbnNlLlxuLy9cbi8vIEdpdCByZXBvc2l0b3JpZXMgZm9yIEFjb3JuIGFyZSBhdmFpbGFibGUgYXRcbi8vXG4vLyAgICAgaHR0cDovL21hcmlqbmhhdmVyYmVrZS5ubC9naXQvYWNvcm5cbi8vICAgICBodHRwczovL2dpdGh1Yi5jb20vbWFyaWpuaC9hY29ybi5naXRcbi8vXG4vLyBQbGVhc2UgdXNlIHRoZSBbZ2l0aHViIGJ1ZyB0cmFja2VyXVtnaGJ0XSB0byByZXBvcnQgaXNzdWVzLlxuLy9cbi8vIFtnaGJ0XTogaHR0cHM6Ly9naXRodWIuY29tL21hcmlqbmgvYWNvcm4vaXNzdWVzXG4vL1xuLy8gVGhpcyBmaWxlIGRlZmluZXMgdGhlIG1haW4gcGFyc2VyIGludGVyZmFjZS4gVGhlIGxpYnJhcnkgYWxzbyBjb21lc1xuLy8gd2l0aCBhIFtlcnJvci10b2xlcmFudCBwYXJzZXJdW2RhbW1pdF0gYW5kIGFuXG4vLyBbYWJzdHJhY3Qgc3ludGF4IHRyZWUgd2Fsa2VyXVt3YWxrXSwgZGVmaW5lZCBpbiBvdGhlciBmaWxlcy5cbi8vXG4vLyBbZGFtbWl0XTogYWNvcm5fbG9vc2UuanNcbi8vIFt3YWxrXTogdXRpbC93YWxrLmpzXG5cInVzZSBzdHJpY3RcIjtleHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO2V4cG9ydHMucGFyc2UgPSBwYXJzZTtleHBvcnRzLnBhcnNlRXhwcmVzc2lvbkF0ID0gcGFyc2VFeHByZXNzaW9uQXQ7ZXhwb3J0cy50b2tlbml6ZXIgPSB0b2tlbml6ZXI7dmFyIF9zdGF0ZT1fZGVyZXFfKFwiLi9zdGF0ZVwiKTt2YXIgX29wdGlvbnM9X2RlcmVxXyhcIi4vb3B0aW9uc1wiKTtfZGVyZXFfKFwiLi9wYXJzZXV0aWxcIik7X2RlcmVxXyhcIi4vc3RhdGVtZW50XCIpO19kZXJlcV8oXCIuL2x2YWxcIik7X2RlcmVxXyhcIi4vZXhwcmVzc2lvblwiKTtfZGVyZXFfKFwiLi9sb2NhdGlvblwiKTtleHBvcnRzLlBhcnNlciA9IF9zdGF0ZS5QYXJzZXI7ZXhwb3J0cy5wbHVnaW5zID0gX3N0YXRlLnBsdWdpbnM7ZXhwb3J0cy5kZWZhdWx0T3B0aW9ucyA9IF9vcHRpb25zLmRlZmF1bHRPcHRpb25zO3ZhciBfbG9jdXRpbD1fZGVyZXFfKFwiLi9sb2N1dGlsXCIpO2V4cG9ydHMuUG9zaXRpb24gPSBfbG9jdXRpbC5Qb3NpdGlvbjtleHBvcnRzLlNvdXJjZUxvY2F0aW9uID0gX2xvY3V0aWwuU291cmNlTG9jYXRpb247ZXhwb3J0cy5nZXRMaW5lSW5mbyA9IF9sb2N1dGlsLmdldExpbmVJbmZvO3ZhciBfbm9kZT1fZGVyZXFfKFwiLi9ub2RlXCIpO2V4cG9ydHMuTm9kZSA9IF9ub2RlLk5vZGU7dmFyIF90b2tlbnR5cGU9X2RlcmVxXyhcIi4vdG9rZW50eXBlXCIpO2V4cG9ydHMuVG9rZW5UeXBlID0gX3Rva2VudHlwZS5Ub2tlblR5cGU7ZXhwb3J0cy50b2tUeXBlcyA9IF90b2tlbnR5cGUudHlwZXM7dmFyIF90b2tlbmNvbnRleHQ9X2RlcmVxXyhcIi4vdG9rZW5jb250ZXh0XCIpO2V4cG9ydHMuVG9rQ29udGV4dCA9IF90b2tlbmNvbnRleHQuVG9rQ29udGV4dDtleHBvcnRzLnRva0NvbnRleHRzID0gX3Rva2VuY29udGV4dC50eXBlczt2YXIgX2lkZW50aWZpZXI9X2RlcmVxXyhcIi4vaWRlbnRpZmllclwiKTtleHBvcnRzLmlzSWRlbnRpZmllckNoYXIgPSBfaWRlbnRpZmllci5pc0lkZW50aWZpZXJDaGFyO2V4cG9ydHMuaXNJZGVudGlmaWVyU3RhcnQgPSBfaWRlbnRpZmllci5pc0lkZW50aWZpZXJTdGFydDt2YXIgX3Rva2VuaXplPV9kZXJlcV8oXCIuL3Rva2VuaXplXCIpO2V4cG9ydHMuVG9rZW4gPSBfdG9rZW5pemUuVG9rZW47dmFyIF93aGl0ZXNwYWNlPV9kZXJlcV8oXCIuL3doaXRlc3BhY2VcIik7ZXhwb3J0cy5pc05ld0xpbmUgPSBfd2hpdGVzcGFjZS5pc05ld0xpbmU7ZXhwb3J0cy5saW5lQnJlYWsgPSBfd2hpdGVzcGFjZS5saW5lQnJlYWs7ZXhwb3J0cy5saW5lQnJlYWtHID0gX3doaXRlc3BhY2UubGluZUJyZWFrRzt2YXIgdmVyc2lvbj1cIjIuMi4wXCI7ZXhwb3J0cy52ZXJzaW9uID0gdmVyc2lvbjsgLy8gVGhlIG1haW4gZXhwb3J0ZWQgaW50ZXJmYWNlICh1bmRlciBgc2VsZi5hY29ybmAgd2hlbiBpbiB0aGVcbi8vIGJyb3dzZXIpIGlzIGEgYHBhcnNlYCBmdW5jdGlvbiB0aGF0IHRha2VzIGEgY29kZSBzdHJpbmcgYW5kXG4vLyByZXR1cm5zIGFuIGFic3RyYWN0IHN5bnRheCB0cmVlIGFzIHNwZWNpZmllZCBieSBbTW96aWxsYSBwYXJzZXJcbi8vIEFQSV1bYXBpXS5cbi8vXG4vLyBbYXBpXTogaHR0cHM6Ly9kZXZlbG9wZXIubW96aWxsYS5vcmcvZW4tVVMvZG9jcy9TcGlkZXJNb25rZXkvUGFyc2VyX0FQSVxuZnVuY3Rpb24gcGFyc2UoaW5wdXQsb3B0aW9ucyl7cmV0dXJuIG5ldyBfc3RhdGUuUGFyc2VyKG9wdGlvbnMsaW5wdXQpLnBhcnNlKCk7fSAvLyBUaGlzIGZ1bmN0aW9uIHRyaWVzIHRvIHBhcnNlIGEgc2luZ2xlIGV4cHJlc3Npb24gYXQgYSBnaXZlblxuLy8gb2Zmc2V0IGluIGEgc3RyaW5nLiBVc2VmdWwgZm9yIHBhcnNpbmcgbWl4ZWQtbGFuZ3VhZ2UgZm9ybWF0c1xuLy8gdGhhdCBlbWJlZCBKYXZhU2NyaXB0IGV4cHJlc3Npb25zLlxuZnVuY3Rpb24gcGFyc2VFeHByZXNzaW9uQXQoaW5wdXQscG9zLG9wdGlvbnMpe3ZhciBwPW5ldyBfc3RhdGUuUGFyc2VyKG9wdGlvbnMsaW5wdXQscG9zKTtwLm5leHRUb2tlbigpO3JldHVybiBwLnBhcnNlRXhwcmVzc2lvbigpO30gLy8gQWNvcm4gaXMgb3JnYW5pemVkIGFzIGEgdG9rZW5pemVyIGFuZCBhIHJlY3Vyc2l2ZS1kZXNjZW50IHBhcnNlci5cbi8vIFRoZSBgdG9rZW5pemVgIGV4cG9ydCBwcm92aWRlcyBhbiBpbnRlcmZhY2UgdG8gdGhlIHRva2VuaXplci5cbmZ1bmN0aW9uIHRva2VuaXplcihpbnB1dCxvcHRpb25zKXtyZXR1cm4gbmV3IF9zdGF0ZS5QYXJzZXIob3B0aW9ucyxpbnB1dCk7fX0se1wiLi9leHByZXNzaW9uXCI6MSxcIi4vaWRlbnRpZmllclwiOjIsXCIuL2xvY2F0aW9uXCI6NCxcIi4vbG9jdXRpbFwiOjUsXCIuL2x2YWxcIjo2LFwiLi9ub2RlXCI6NyxcIi4vb3B0aW9uc1wiOjgsXCIuL3BhcnNldXRpbFwiOjksXCIuL3N0YXRlXCI6MTAsXCIuL3N0YXRlbWVudFwiOjExLFwiLi90b2tlbmNvbnRleHRcIjoxMixcIi4vdG9rZW5pemVcIjoxMyxcIi4vdG9rZW50eXBlXCI6MTQsXCIuL3doaXRlc3BhY2VcIjoxNn1dLDQ6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1widXNlIHN0cmljdFwiO3ZhciBfc3RhdGU9X2RlcmVxXyhcIi4vc3RhdGVcIik7dmFyIF9sb2N1dGlsPV9kZXJlcV8oXCIuL2xvY3V0aWxcIik7dmFyIHBwPV9zdGF0ZS5QYXJzZXIucHJvdG90eXBlOyAvLyBUaGlzIGZ1bmN0aW9uIGlzIHVzZWQgdG8gcmFpc2UgZXhjZXB0aW9ucyBvbiBwYXJzZSBlcnJvcnMuIEl0XG4vLyB0YWtlcyBhbiBvZmZzZXQgaW50ZWdlciAoaW50byB0aGUgY3VycmVudCBgaW5wdXRgKSB0byBpbmRpY2F0ZVxuLy8gdGhlIGxvY2F0aW9uIG9mIHRoZSBlcnJvciwgYXR0YWNoZXMgdGhlIHBvc2l0aW9uIHRvIHRoZSBlbmRcbi8vIG9mIHRoZSBlcnJvciBtZXNzYWdlLCBhbmQgdGhlbiByYWlzZXMgYSBgU3ludGF4RXJyb3JgIHdpdGggdGhhdFxuLy8gbWVzc2FnZS5cbnBwLnJhaXNlID0gZnVuY3Rpb24ocG9zLG1lc3NhZ2Upe3ZhciBsb2M9X2xvY3V0aWwuZ2V0TGluZUluZm8odGhpcy5pbnB1dCxwb3MpO21lc3NhZ2UgKz0gXCIgKFwiICsgbG9jLmxpbmUgKyBcIjpcIiArIGxvYy5jb2x1bW4gKyBcIilcIjt2YXIgZXJyPW5ldyBTeW50YXhFcnJvcihtZXNzYWdlKTtlcnIucG9zID0gcG9zO2Vyci5sb2MgPSBsb2M7ZXJyLnJhaXNlZEF0ID0gdGhpcy5wb3M7dGhyb3cgZXJyO307cHAuY3VyUG9zaXRpb24gPSBmdW5jdGlvbigpe2lmKHRoaXMub3B0aW9ucy5sb2NhdGlvbnMpe3JldHVybiBuZXcgX2xvY3V0aWwuUG9zaXRpb24odGhpcy5jdXJMaW5lLHRoaXMucG9zIC0gdGhpcy5saW5lU3RhcnQpO319O30se1wiLi9sb2N1dGlsXCI6NSxcIi4vc3RhdGVcIjoxMH1dLDU6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1widXNlIHN0cmljdFwiO2V4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7ZXhwb3J0cy5nZXRMaW5lSW5mbyA9IGdldExpbmVJbmZvO2Z1bmN0aW9uIF9jbGFzc0NhbGxDaGVjayhpbnN0YW5jZSxDb25zdHJ1Y3Rvcil7aWYoIShpbnN0YW5jZSBpbnN0YW5jZW9mIENvbnN0cnVjdG9yKSl7dGhyb3cgbmV3IFR5cGVFcnJvcihcIkNhbm5vdCBjYWxsIGEgY2xhc3MgYXMgYSBmdW5jdGlvblwiKTt9fXZhciBfd2hpdGVzcGFjZT1fZGVyZXFfKFwiLi93aGl0ZXNwYWNlXCIpOyAvLyBUaGVzZSBhcmUgdXNlZCB3aGVuIGBvcHRpb25zLmxvY2F0aW9uc2AgaXMgb24sIGZvciB0aGVcbi8vIGBzdGFydExvY2AgYW5kIGBlbmRMb2NgIHByb3BlcnRpZXMuXG52YXIgUG9zaXRpb249KGZ1bmN0aW9uKCl7ZnVuY3Rpb24gUG9zaXRpb24obGluZSxjb2wpe19jbGFzc0NhbGxDaGVjayh0aGlzLFBvc2l0aW9uKTt0aGlzLmxpbmUgPSBsaW5lO3RoaXMuY29sdW1uID0gY29sO31Qb3NpdGlvbi5wcm90b3R5cGUub2Zmc2V0ID0gZnVuY3Rpb24gb2Zmc2V0KG4pe3JldHVybiBuZXcgUG9zaXRpb24odGhpcy5saW5lLHRoaXMuY29sdW1uICsgbik7fTtyZXR1cm4gUG9zaXRpb247fSkoKTtleHBvcnRzLlBvc2l0aW9uID0gUG9zaXRpb247dmFyIFNvdXJjZUxvY2F0aW9uPWZ1bmN0aW9uIFNvdXJjZUxvY2F0aW9uKHAsc3RhcnQsZW5kKXtfY2xhc3NDYWxsQ2hlY2sodGhpcyxTb3VyY2VMb2NhdGlvbik7dGhpcy5zdGFydCA9IHN0YXJ0O3RoaXMuZW5kID0gZW5kO2lmKHAuc291cmNlRmlsZSAhPT0gbnVsbCl0aGlzLnNvdXJjZSA9IHAuc291cmNlRmlsZTt9IC8vIFRoZSBgZ2V0TGluZUluZm9gIGZ1bmN0aW9uIGlzIG1vc3RseSB1c2VmdWwgd2hlbiB0aGVcbi8vIGBsb2NhdGlvbnNgIG9wdGlvbiBpcyBvZmYgKGZvciBwZXJmb3JtYW5jZSByZWFzb25zKSBhbmQgeW91XG4vLyB3YW50IHRvIGZpbmQgdGhlIGxpbmUvY29sdW1uIHBvc2l0aW9uIGZvciBhIGdpdmVuIGNoYXJhY3RlclxuLy8gb2Zmc2V0LiBgaW5wdXRgIHNob3VsZCBiZSB0aGUgY29kZSBzdHJpbmcgdGhhdCB0aGUgb2Zmc2V0IHJlZmVyc1xuLy8gaW50by5cbjtleHBvcnRzLlNvdXJjZUxvY2F0aW9uID0gU291cmNlTG9jYXRpb247ZnVuY3Rpb24gZ2V0TGluZUluZm8oaW5wdXQsb2Zmc2V0KXtmb3IodmFyIGxpbmU9MSxjdXI9MDs7KSB7X3doaXRlc3BhY2UubGluZUJyZWFrRy5sYXN0SW5kZXggPSBjdXI7dmFyIG1hdGNoPV93aGl0ZXNwYWNlLmxpbmVCcmVha0cuZXhlYyhpbnB1dCk7aWYobWF0Y2ggJiYgbWF0Y2guaW5kZXggPCBvZmZzZXQpeysrbGluZTtjdXIgPSBtYXRjaC5pbmRleCArIG1hdGNoWzBdLmxlbmd0aDt9ZWxzZSB7cmV0dXJuIG5ldyBQb3NpdGlvbihsaW5lLG9mZnNldCAtIGN1cik7fX19fSx7XCIuL3doaXRlc3BhY2VcIjoxNn1dLDY6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1widXNlIHN0cmljdFwiO3ZhciBfdG9rZW50eXBlPV9kZXJlcV8oXCIuL3Rva2VudHlwZVwiKTt2YXIgX3N0YXRlPV9kZXJlcV8oXCIuL3N0YXRlXCIpO3ZhciBfaWRlbnRpZmllcj1fZGVyZXFfKFwiLi9pZGVudGlmaWVyXCIpO3ZhciBfdXRpbD1fZGVyZXFfKFwiLi91dGlsXCIpO3ZhciBwcD1fc3RhdGUuUGFyc2VyLnByb3RvdHlwZTsgLy8gQ29udmVydCBleGlzdGluZyBleHByZXNzaW9uIGF0b20gdG8gYXNzaWduYWJsZSBwYXR0ZXJuXG4vLyBpZiBwb3NzaWJsZS5cbnBwLnRvQXNzaWduYWJsZSA9IGZ1bmN0aW9uKG5vZGUsaXNCaW5kaW5nKXtpZih0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNiAmJiBub2RlKXtzd2l0Y2gobm9kZS50eXBlKXtjYXNlIFwiSWRlbnRpZmllclwiOmNhc2UgXCJPYmplY3RQYXR0ZXJuXCI6Y2FzZSBcIkFycmF5UGF0dGVyblwiOmNhc2UgXCJBc3NpZ25tZW50UGF0dGVyblwiOmJyZWFrO2Nhc2UgXCJPYmplY3RFeHByZXNzaW9uXCI6bm9kZS50eXBlID0gXCJPYmplY3RQYXR0ZXJuXCI7Zm9yKHZhciBpPTA7aSA8IG5vZGUucHJvcGVydGllcy5sZW5ndGg7aSsrKSB7dmFyIHByb3A9bm9kZS5wcm9wZXJ0aWVzW2ldO2lmKHByb3Aua2luZCAhPT0gXCJpbml0XCIpdGhpcy5yYWlzZShwcm9wLmtleS5zdGFydCxcIk9iamVjdCBwYXR0ZXJuIGNhbid0IGNvbnRhaW4gZ2V0dGVyIG9yIHNldHRlclwiKTt0aGlzLnRvQXNzaWduYWJsZShwcm9wLnZhbHVlLGlzQmluZGluZyk7fWJyZWFrO2Nhc2UgXCJBcnJheUV4cHJlc3Npb25cIjpub2RlLnR5cGUgPSBcIkFycmF5UGF0dGVyblwiO3RoaXMudG9Bc3NpZ25hYmxlTGlzdChub2RlLmVsZW1lbnRzLGlzQmluZGluZyk7YnJlYWs7Y2FzZSBcIkFzc2lnbm1lbnRFeHByZXNzaW9uXCI6aWYobm9kZS5vcGVyYXRvciA9PT0gXCI9XCIpe25vZGUudHlwZSA9IFwiQXNzaWdubWVudFBhdHRlcm5cIjtkZWxldGUgbm9kZS5vcGVyYXRvcjt9ZWxzZSB7dGhpcy5yYWlzZShub2RlLmxlZnQuZW5kLFwiT25seSAnPScgb3BlcmF0b3IgY2FuIGJlIHVzZWQgZm9yIHNwZWNpZnlpbmcgZGVmYXVsdCB2YWx1ZS5cIik7fWJyZWFrO2Nhc2UgXCJQYXJlbnRoZXNpemVkRXhwcmVzc2lvblwiOm5vZGUuZXhwcmVzc2lvbiA9IHRoaXMudG9Bc3NpZ25hYmxlKG5vZGUuZXhwcmVzc2lvbixpc0JpbmRpbmcpO2JyZWFrO2Nhc2UgXCJNZW1iZXJFeHByZXNzaW9uXCI6aWYoIWlzQmluZGluZylicmVhaztkZWZhdWx0OnRoaXMucmFpc2Uobm9kZS5zdGFydCxcIkFzc2lnbmluZyB0byBydmFsdWVcIik7fX1yZXR1cm4gbm9kZTt9OyAvLyBDb252ZXJ0IGxpc3Qgb2YgZXhwcmVzc2lvbiBhdG9tcyB0byBiaW5kaW5nIGxpc3QuXG5wcC50b0Fzc2lnbmFibGVMaXN0ID0gZnVuY3Rpb24oZXhwckxpc3QsaXNCaW5kaW5nKXt2YXIgZW5kPWV4cHJMaXN0Lmxlbmd0aDtpZihlbmQpe3ZhciBsYXN0PWV4cHJMaXN0W2VuZCAtIDFdO2lmKGxhc3QgJiYgbGFzdC50eXBlID09IFwiUmVzdEVsZW1lbnRcIil7LS1lbmQ7fWVsc2UgaWYobGFzdCAmJiBsYXN0LnR5cGUgPT0gXCJTcHJlYWRFbGVtZW50XCIpe2xhc3QudHlwZSA9IFwiUmVzdEVsZW1lbnRcIjt2YXIgYXJnPWxhc3QuYXJndW1lbnQ7dGhpcy50b0Fzc2lnbmFibGUoYXJnLGlzQmluZGluZyk7aWYoYXJnLnR5cGUgIT09IFwiSWRlbnRpZmllclwiICYmIGFyZy50eXBlICE9PSBcIk1lbWJlckV4cHJlc3Npb25cIiAmJiBhcmcudHlwZSAhPT0gXCJBcnJheVBhdHRlcm5cIil0aGlzLnVuZXhwZWN0ZWQoYXJnLnN0YXJ0KTstLWVuZDt9fWZvcih2YXIgaT0wO2kgPCBlbmQ7aSsrKSB7dmFyIGVsdD1leHByTGlzdFtpXTtpZihlbHQpdGhpcy50b0Fzc2lnbmFibGUoZWx0LGlzQmluZGluZyk7fXJldHVybiBleHByTGlzdDt9OyAvLyBQYXJzZXMgc3ByZWFkIGVsZW1lbnQuXG5wcC5wYXJzZVNwcmVhZCA9IGZ1bmN0aW9uKHJlZlNob3J0aGFuZERlZmF1bHRQb3Mpe3ZhciBub2RlPXRoaXMuc3RhcnROb2RlKCk7dGhpcy5uZXh0KCk7bm9kZS5hcmd1bWVudCA9IHRoaXMucGFyc2VNYXliZUFzc2lnbihyZWZTaG9ydGhhbmREZWZhdWx0UG9zKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJTcHJlYWRFbGVtZW50XCIpO307cHAucGFyc2VSZXN0ID0gZnVuY3Rpb24oKXt2YXIgbm9kZT10aGlzLnN0YXJ0Tm9kZSgpO3RoaXMubmV4dCgpO25vZGUuYXJndW1lbnQgPSB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMubmFtZSB8fCB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuYnJhY2tldEw/dGhpcy5wYXJzZUJpbmRpbmdBdG9tKCk6dGhpcy51bmV4cGVjdGVkKCk7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiUmVzdEVsZW1lbnRcIik7fTsgLy8gUGFyc2VzIGx2YWx1ZSAoYXNzaWduYWJsZSkgYXRvbS5cbnBwLnBhcnNlQmluZGluZ0F0b20gPSBmdW5jdGlvbigpe2lmKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA8IDYpcmV0dXJuIHRoaXMucGFyc2VJZGVudCgpO3N3aXRjaCh0aGlzLnR5cGUpe2Nhc2UgX3Rva2VudHlwZS50eXBlcy5uYW1lOnJldHVybiB0aGlzLnBhcnNlSWRlbnQoKTtjYXNlIF90b2tlbnR5cGUudHlwZXMuYnJhY2tldEw6dmFyIG5vZGU9dGhpcy5zdGFydE5vZGUoKTt0aGlzLm5leHQoKTtub2RlLmVsZW1lbnRzID0gdGhpcy5wYXJzZUJpbmRpbmdMaXN0KF90b2tlbnR5cGUudHlwZXMuYnJhY2tldFIsdHJ1ZSx0cnVlKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJBcnJheVBhdHRlcm5cIik7Y2FzZSBfdG9rZW50eXBlLnR5cGVzLmJyYWNlTDpyZXR1cm4gdGhpcy5wYXJzZU9iaih0cnVlKTtkZWZhdWx0OnRoaXMudW5leHBlY3RlZCgpO319O3BwLnBhcnNlQmluZGluZ0xpc3QgPSBmdW5jdGlvbihjbG9zZSxhbGxvd0VtcHR5LGFsbG93VHJhaWxpbmdDb21tYSl7dmFyIGVsdHM9W10sZmlyc3Q9dHJ1ZTt3aGlsZSghdGhpcy5lYXQoY2xvc2UpKSB7aWYoZmlyc3QpZmlyc3QgPSBmYWxzZTtlbHNlIHRoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMuY29tbWEpO2lmKGFsbG93RW1wdHkgJiYgdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmNvbW1hKXtlbHRzLnB1c2gobnVsbCk7fWVsc2UgaWYoYWxsb3dUcmFpbGluZ0NvbW1hICYmIHRoaXMuYWZ0ZXJUcmFpbGluZ0NvbW1hKGNsb3NlKSl7YnJlYWs7fWVsc2UgaWYodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmVsbGlwc2lzKXt2YXIgcmVzdD10aGlzLnBhcnNlUmVzdCgpO3RoaXMucGFyc2VCaW5kaW5nTGlzdEl0ZW0ocmVzdCk7ZWx0cy5wdXNoKHJlc3QpO3RoaXMuZXhwZWN0KGNsb3NlKTticmVhazt9ZWxzZSB7dmFyIGVsZW09dGhpcy5wYXJzZU1heWJlRGVmYXVsdCh0aGlzLnN0YXJ0LHRoaXMuc3RhcnRMb2MpO3RoaXMucGFyc2VCaW5kaW5nTGlzdEl0ZW0oZWxlbSk7ZWx0cy5wdXNoKGVsZW0pO319cmV0dXJuIGVsdHM7fTtwcC5wYXJzZUJpbmRpbmdMaXN0SXRlbSA9IGZ1bmN0aW9uKHBhcmFtKXtyZXR1cm4gcGFyYW07fTsgLy8gUGFyc2VzIGFzc2lnbm1lbnQgcGF0dGVybiBhcm91bmQgZ2l2ZW4gYXRvbSBpZiBwb3NzaWJsZS5cbnBwLnBhcnNlTWF5YmVEZWZhdWx0ID0gZnVuY3Rpb24oc3RhcnRQb3Msc3RhcnRMb2MsbGVmdCl7bGVmdCA9IGxlZnQgfHwgdGhpcy5wYXJzZUJpbmRpbmdBdG9tKCk7aWYoIXRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuZXEpKXJldHVybiBsZWZ0O3ZhciBub2RlPXRoaXMuc3RhcnROb2RlQXQoc3RhcnRQb3Msc3RhcnRMb2MpO25vZGUubGVmdCA9IGxlZnQ7bm9kZS5yaWdodCA9IHRoaXMucGFyc2VNYXliZUFzc2lnbigpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIkFzc2lnbm1lbnRQYXR0ZXJuXCIpO307IC8vIFZlcmlmeSB0aGF0IGEgbm9kZSBpcyBhbiBsdmFsIOKAlCBzb21ldGhpbmcgdGhhdCBjYW4gYmUgYXNzaWduZWRcbi8vIHRvLlxucHAuY2hlY2tMVmFsID0gZnVuY3Rpb24oZXhwcixpc0JpbmRpbmcsY2hlY2tDbGFzaGVzKXtzd2l0Y2goZXhwci50eXBlKXtjYXNlIFwiSWRlbnRpZmllclwiOmlmKHRoaXMuc3RyaWN0ICYmIChfaWRlbnRpZmllci5yZXNlcnZlZFdvcmRzLnN0cmljdEJpbmQoZXhwci5uYW1lKSB8fCBfaWRlbnRpZmllci5yZXNlcnZlZFdvcmRzLnN0cmljdChleHByLm5hbWUpKSl0aGlzLnJhaXNlKGV4cHIuc3RhcnQsKGlzQmluZGluZz9cIkJpbmRpbmcgXCI6XCJBc3NpZ25pbmcgdG8gXCIpICsgZXhwci5uYW1lICsgXCIgaW4gc3RyaWN0IG1vZGVcIik7aWYoY2hlY2tDbGFzaGVzKXtpZihfdXRpbC5oYXMoY2hlY2tDbGFzaGVzLGV4cHIubmFtZSkpdGhpcy5yYWlzZShleHByLnN0YXJ0LFwiQXJndW1lbnQgbmFtZSBjbGFzaCBpbiBzdHJpY3QgbW9kZVwiKTtjaGVja0NsYXNoZXNbZXhwci5uYW1lXSA9IHRydWU7fWJyZWFrO2Nhc2UgXCJNZW1iZXJFeHByZXNzaW9uXCI6aWYoaXNCaW5kaW5nKXRoaXMucmFpc2UoZXhwci5zdGFydCwoaXNCaW5kaW5nP1wiQmluZGluZ1wiOlwiQXNzaWduaW5nIHRvXCIpICsgXCIgbWVtYmVyIGV4cHJlc3Npb25cIik7YnJlYWs7Y2FzZSBcIk9iamVjdFBhdHRlcm5cIjpmb3IodmFyIGk9MDtpIDwgZXhwci5wcm9wZXJ0aWVzLmxlbmd0aDtpKyspIHt0aGlzLmNoZWNrTFZhbChleHByLnByb3BlcnRpZXNbaV0udmFsdWUsaXNCaW5kaW5nLGNoZWNrQ2xhc2hlcyk7fWJyZWFrO2Nhc2UgXCJBcnJheVBhdHRlcm5cIjpmb3IodmFyIGk9MDtpIDwgZXhwci5lbGVtZW50cy5sZW5ndGg7aSsrKSB7dmFyIGVsZW09ZXhwci5lbGVtZW50c1tpXTtpZihlbGVtKXRoaXMuY2hlY2tMVmFsKGVsZW0saXNCaW5kaW5nLGNoZWNrQ2xhc2hlcyk7fWJyZWFrO2Nhc2UgXCJBc3NpZ25tZW50UGF0dGVyblwiOnRoaXMuY2hlY2tMVmFsKGV4cHIubGVmdCxpc0JpbmRpbmcsY2hlY2tDbGFzaGVzKTticmVhaztjYXNlIFwiUmVzdEVsZW1lbnRcIjp0aGlzLmNoZWNrTFZhbChleHByLmFyZ3VtZW50LGlzQmluZGluZyxjaGVja0NsYXNoZXMpO2JyZWFrO2Nhc2UgXCJQYXJlbnRoZXNpemVkRXhwcmVzc2lvblwiOnRoaXMuY2hlY2tMVmFsKGV4cHIuZXhwcmVzc2lvbixpc0JpbmRpbmcsY2hlY2tDbGFzaGVzKTticmVhaztkZWZhdWx0OnRoaXMucmFpc2UoZXhwci5zdGFydCwoaXNCaW5kaW5nP1wiQmluZGluZ1wiOlwiQXNzaWduaW5nIHRvXCIpICsgXCIgcnZhbHVlXCIpO319O30se1wiLi9pZGVudGlmaWVyXCI6MixcIi4vc3RhdGVcIjoxMCxcIi4vdG9rZW50eXBlXCI6MTQsXCIuL3V0aWxcIjoxNX1dLDc6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1widXNlIHN0cmljdFwiO2V4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7ZnVuY3Rpb24gX2NsYXNzQ2FsbENoZWNrKGluc3RhbmNlLENvbnN0cnVjdG9yKXtpZighKGluc3RhbmNlIGluc3RhbmNlb2YgQ29uc3RydWN0b3IpKXt0aHJvdyBuZXcgVHlwZUVycm9yKFwiQ2Fubm90IGNhbGwgYSBjbGFzcyBhcyBhIGZ1bmN0aW9uXCIpO319dmFyIF9zdGF0ZT1fZGVyZXFfKFwiLi9zdGF0ZVwiKTt2YXIgX2xvY3V0aWw9X2RlcmVxXyhcIi4vbG9jdXRpbFwiKTt2YXIgTm9kZT1mdW5jdGlvbiBOb2RlKHBhcnNlcixwb3MsbG9jKXtfY2xhc3NDYWxsQ2hlY2sodGhpcyxOb2RlKTt0aGlzLnR5cGUgPSBcIlwiO3RoaXMuc3RhcnQgPSBwb3M7dGhpcy5lbmQgPSAwO2lmKHBhcnNlci5vcHRpb25zLmxvY2F0aW9ucyl0aGlzLmxvYyA9IG5ldyBfbG9jdXRpbC5Tb3VyY2VMb2NhdGlvbihwYXJzZXIsbG9jKTtpZihwYXJzZXIub3B0aW9ucy5kaXJlY3RTb3VyY2VGaWxlKXRoaXMuc291cmNlRmlsZSA9IHBhcnNlci5vcHRpb25zLmRpcmVjdFNvdXJjZUZpbGU7aWYocGFyc2VyLm9wdGlvbnMucmFuZ2VzKXRoaXMucmFuZ2UgPSBbcG9zLDBdO30gLy8gU3RhcnQgYW4gQVNUIG5vZGUsIGF0dGFjaGluZyBhIHN0YXJ0IG9mZnNldC5cbjtleHBvcnRzLk5vZGUgPSBOb2RlO3ZhciBwcD1fc3RhdGUuUGFyc2VyLnByb3RvdHlwZTtwcC5zdGFydE5vZGUgPSBmdW5jdGlvbigpe3JldHVybiBuZXcgTm9kZSh0aGlzLHRoaXMuc3RhcnQsdGhpcy5zdGFydExvYyk7fTtwcC5zdGFydE5vZGVBdCA9IGZ1bmN0aW9uKHBvcyxsb2Mpe3JldHVybiBuZXcgTm9kZSh0aGlzLHBvcyxsb2MpO307IC8vIEZpbmlzaCBhbiBBU1Qgbm9kZSwgYWRkaW5nIGB0eXBlYCBhbmQgYGVuZGAgcHJvcGVydGllcy5cbmZ1bmN0aW9uIGZpbmlzaE5vZGVBdChub2RlLHR5cGUscG9zLGxvYyl7bm9kZS50eXBlID0gdHlwZTtub2RlLmVuZCA9IHBvcztpZih0aGlzLm9wdGlvbnMubG9jYXRpb25zKW5vZGUubG9jLmVuZCA9IGxvYztpZih0aGlzLm9wdGlvbnMucmFuZ2VzKW5vZGUucmFuZ2VbMV0gPSBwb3M7cmV0dXJuIG5vZGU7fXBwLmZpbmlzaE5vZGUgPSBmdW5jdGlvbihub2RlLHR5cGUpe3JldHVybiBmaW5pc2hOb2RlQXQuY2FsbCh0aGlzLG5vZGUsdHlwZSx0aGlzLmxhc3RUb2tFbmQsdGhpcy5sYXN0VG9rRW5kTG9jKTt9OyAvLyBGaW5pc2ggbm9kZSBhdCBnaXZlbiBwb3NpdGlvblxucHAuZmluaXNoTm9kZUF0ID0gZnVuY3Rpb24obm9kZSx0eXBlLHBvcyxsb2Mpe3JldHVybiBmaW5pc2hOb2RlQXQuY2FsbCh0aGlzLG5vZGUsdHlwZSxwb3MsbG9jKTt9O30se1wiLi9sb2N1dGlsXCI6NSxcIi4vc3RhdGVcIjoxMH1dLDg6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1widXNlIHN0cmljdFwiO2V4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7ZXhwb3J0cy5nZXRPcHRpb25zID0gZ2V0T3B0aW9uczt2YXIgX3V0aWw9X2RlcmVxXyhcIi4vdXRpbFwiKTt2YXIgX2xvY3V0aWw9X2RlcmVxXyhcIi4vbG9jdXRpbFwiKTsgLy8gQSBzZWNvbmQgb3B0aW9uYWwgYXJndW1lbnQgY2FuIGJlIGdpdmVuIHRvIGZ1cnRoZXIgY29uZmlndXJlXG4vLyB0aGUgcGFyc2VyIHByb2Nlc3MuIFRoZXNlIG9wdGlvbnMgYXJlIHJlY29nbml6ZWQ6XG52YXIgZGVmYXVsdE9wdGlvbnM9eyAvLyBgZWNtYVZlcnNpb25gIGluZGljYXRlcyB0aGUgRUNNQVNjcmlwdCB2ZXJzaW9uIHRvIHBhcnNlLiBNdXN0XG4vLyBiZSBlaXRoZXIgMywgb3IgNSwgb3IgNi4gVGhpcyBpbmZsdWVuY2VzIHN1cHBvcnQgZm9yIHN0cmljdFxuLy8gbW9kZSwgdGhlIHNldCBvZiByZXNlcnZlZCB3b3Jkcywgc3VwcG9ydCBmb3IgZ2V0dGVycyBhbmRcbi8vIHNldHRlcnMgYW5kIG90aGVyIGZlYXR1cmVzLlxuZWNtYVZlcnNpb246NSwgLy8gU291cmNlIHR5cGUgKFwic2NyaXB0XCIgb3IgXCJtb2R1bGVcIikgZm9yIGRpZmZlcmVudCBzZW1hbnRpY3NcbnNvdXJjZVR5cGU6XCJzY3JpcHRcIiwgLy8gYG9uSW5zZXJ0ZWRTZW1pY29sb25gIGNhbiBiZSBhIGNhbGxiYWNrIHRoYXQgd2lsbCBiZSBjYWxsZWRcbi8vIHdoZW4gYSBzZW1pY29sb24gaXMgYXV0b21hdGljYWxseSBpbnNlcnRlZC4gSXQgd2lsbCBiZSBwYXNzZWRcbi8vIHRoIHBvc2l0aW9uIG9mIHRoZSBjb21tYSBhcyBhbiBvZmZzZXQsIGFuZCBpZiBgbG9jYXRpb25zYCBpc1xuLy8gZW5hYmxlZCwgaXQgaXMgZ2l2ZW4gdGhlIGxvY2F0aW9uIGFzIGEgYHtsaW5lLCBjb2x1bW59YCBvYmplY3Rcbi8vIGFzIHNlY29uZCBhcmd1bWVudC5cbm9uSW5zZXJ0ZWRTZW1pY29sb246bnVsbCwgLy8gYG9uVHJhaWxpbmdDb21tYWAgaXMgc2ltaWxhciB0byBgb25JbnNlcnRlZFNlbWljb2xvbmAsIGJ1dCBmb3Jcbi8vIHRyYWlsaW5nIGNvbW1hcy5cbm9uVHJhaWxpbmdDb21tYTpudWxsLCAvLyBCeSBkZWZhdWx0LCByZXNlcnZlZCB3b3JkcyBhcmUgbm90IGVuZm9yY2VkLiBEaXNhYmxlXG4vLyBgYWxsb3dSZXNlcnZlZGAgdG8gZW5mb3JjZSB0aGVtLiBXaGVuIHRoaXMgb3B0aW9uIGhhcyB0aGVcbi8vIHZhbHVlIFwibmV2ZXJcIiwgcmVzZXJ2ZWQgd29yZHMgYW5kIGtleXdvcmRzIGNhbiBhbHNvIG5vdCBiZVxuLy8gdXNlZCBhcyBwcm9wZXJ0eSBuYW1lcy5cbmFsbG93UmVzZXJ2ZWQ6dHJ1ZSwgLy8gV2hlbiBlbmFibGVkLCBhIHJldHVybiBhdCB0aGUgdG9wIGxldmVsIGlzIG5vdCBjb25zaWRlcmVkIGFuXG4vLyBlcnJvci5cbmFsbG93UmV0dXJuT3V0c2lkZUZ1bmN0aW9uOmZhbHNlLCAvLyBXaGVuIGVuYWJsZWQsIGltcG9ydC9leHBvcnQgc3RhdGVtZW50cyBhcmUgbm90IGNvbnN0cmFpbmVkIHRvXG4vLyBhcHBlYXJpbmcgYXQgdGhlIHRvcCBvZiB0aGUgcHJvZ3JhbS5cbmFsbG93SW1wb3J0RXhwb3J0RXZlcnl3aGVyZTpmYWxzZSwgLy8gV2hlbiBlbmFibGVkLCBoYXNoYmFuZyBkaXJlY3RpdmUgaW4gdGhlIGJlZ2lubmluZyBvZiBmaWxlXG4vLyBpcyBhbGxvd2VkIGFuZCB0cmVhdGVkIGFzIGEgbGluZSBjb21tZW50LlxuYWxsb3dIYXNoQmFuZzpmYWxzZSwgLy8gV2hlbiBgbG9jYXRpb25zYCBpcyBvbiwgYGxvY2AgcHJvcGVydGllcyBob2xkaW5nIG9iamVjdHMgd2l0aFxuLy8gYHN0YXJ0YCBhbmQgYGVuZGAgcHJvcGVydGllcyBpbiBge2xpbmUsIGNvbHVtbn1gIGZvcm0gKHdpdGhcbi8vIGxpbmUgYmVpbmcgMS1iYXNlZCBhbmQgY29sdW1uIDAtYmFzZWQpIHdpbGwgYmUgYXR0YWNoZWQgdG8gdGhlXG4vLyBub2Rlcy5cbmxvY2F0aW9uczpmYWxzZSwgLy8gQSBmdW5jdGlvbiBjYW4gYmUgcGFzc2VkIGFzIGBvblRva2VuYCBvcHRpb24sIHdoaWNoIHdpbGxcbi8vIGNhdXNlIEFjb3JuIHRvIGNhbGwgdGhhdCBmdW5jdGlvbiB3aXRoIG9iamVjdCBpbiB0aGUgc2FtZVxuLy8gZm9ybWF0IGFzIHRva2VuaXplKCkgcmV0dXJucy4gTm90ZSB0aGF0IHlvdSBhcmUgbm90XG4vLyBhbGxvd2VkIHRvIGNhbGwgdGhlIHBhcnNlciBmcm9tIHRoZSBjYWxsYmFja+KAlHRoYXQgd2lsbFxuLy8gY29ycnVwdCBpdHMgaW50ZXJuYWwgc3RhdGUuXG5vblRva2VuOm51bGwsIC8vIEEgZnVuY3Rpb24gY2FuIGJlIHBhc3NlZCBhcyBgb25Db21tZW50YCBvcHRpb24sIHdoaWNoIHdpbGxcbi8vIGNhdXNlIEFjb3JuIHRvIGNhbGwgdGhhdCBmdW5jdGlvbiB3aXRoIGAoYmxvY2ssIHRleHQsIHN0YXJ0LFxuLy8gZW5kKWAgcGFyYW1ldGVycyB3aGVuZXZlciBhIGNvbW1lbnQgaXMgc2tpcHBlZC4gYGJsb2NrYCBpcyBhXG4vLyBib29sZWFuIGluZGljYXRpbmcgd2hldGhlciB0aGlzIGlzIGEgYmxvY2sgKGAvKiAqL2ApIGNvbW1lbnQsXG4vLyBgdGV4dGAgaXMgdGhlIGNvbnRlbnQgb2YgdGhlIGNvbW1lbnQsIGFuZCBgc3RhcnRgIGFuZCBgZW5kYCBhcmVcbi8vIGNoYXJhY3RlciBvZmZzZXRzIHRoYXQgZGVub3RlIHRoZSBzdGFydCBhbmQgZW5kIG9mIHRoZSBjb21tZW50LlxuLy8gV2hlbiB0aGUgYGxvY2F0aW9uc2Agb3B0aW9uIGlzIG9uLCB0d28gbW9yZSBwYXJhbWV0ZXJzIGFyZVxuLy8gcGFzc2VkLCB0aGUgZnVsbCBge2xpbmUsIGNvbHVtbn1gIGxvY2F0aW9ucyBvZiB0aGUgc3RhcnQgYW5kXG4vLyBlbmQgb2YgdGhlIGNvbW1lbnRzLiBOb3RlIHRoYXQgeW91IGFyZSBub3QgYWxsb3dlZCB0byBjYWxsIHRoZVxuLy8gcGFyc2VyIGZyb20gdGhlIGNhbGxiYWNr4oCUdGhhdCB3aWxsIGNvcnJ1cHQgaXRzIGludGVybmFsIHN0YXRlLlxub25Db21tZW50Om51bGwsIC8vIE5vZGVzIGhhdmUgdGhlaXIgc3RhcnQgYW5kIGVuZCBjaGFyYWN0ZXJzIG9mZnNldHMgcmVjb3JkZWQgaW5cbi8vIGBzdGFydGAgYW5kIGBlbmRgIHByb3BlcnRpZXMgKGRpcmVjdGx5IG9uIHRoZSBub2RlLCByYXRoZXIgdGhhblxuLy8gdGhlIGBsb2NgIG9iamVjdCwgd2hpY2ggaG9sZHMgbGluZS9jb2x1bW4gZGF0YS4gVG8gYWxzbyBhZGQgYVxuLy8gW3NlbWktc3RhbmRhcmRpemVkXVtyYW5nZV0gYHJhbmdlYCBwcm9wZXJ0eSBob2xkaW5nIGEgYFtzdGFydCxcbi8vIGVuZF1gIGFycmF5IHdpdGggdGhlIHNhbWUgbnVtYmVycywgc2V0IHRoZSBgcmFuZ2VzYCBvcHRpb24gdG9cbi8vIGB0cnVlYC5cbi8vXG4vLyBbcmFuZ2VdOiBodHRwczovL2J1Z3ppbGxhLm1vemlsbGEub3JnL3Nob3dfYnVnLmNnaT9pZD03NDU2NzhcbnJhbmdlczpmYWxzZSwgLy8gSXQgaXMgcG9zc2libGUgdG8gcGFyc2UgbXVsdGlwbGUgZmlsZXMgaW50byBhIHNpbmdsZSBBU1QgYnlcbi8vIHBhc3NpbmcgdGhlIHRyZWUgcHJvZHVjZWQgYnkgcGFyc2luZyB0aGUgZmlyc3QgZmlsZSBhc1xuLy8gYHByb2dyYW1gIG9wdGlvbiBpbiBzdWJzZXF1ZW50IHBhcnNlcy4gVGhpcyB3aWxsIGFkZCB0aGVcbi8vIHRvcGxldmVsIGZvcm1zIG9mIHRoZSBwYXJzZWQgZmlsZSB0byB0aGUgYFByb2dyYW1gICh0b3ApIG5vZGVcbi8vIG9mIGFuIGV4aXN0aW5nIHBhcnNlIHRyZWUuXG5wcm9ncmFtOm51bGwsIC8vIFdoZW4gYGxvY2F0aW9uc2AgaXMgb24sIHlvdSBjYW4gcGFzcyB0aGlzIHRvIHJlY29yZCB0aGUgc291cmNlXG4vLyBmaWxlIGluIGV2ZXJ5IG5vZGUncyBgbG9jYCBvYmplY3QuXG5zb3VyY2VGaWxlOm51bGwsIC8vIFRoaXMgdmFsdWUsIGlmIGdpdmVuLCBpcyBzdG9yZWQgaW4gZXZlcnkgbm9kZSwgd2hldGhlclxuLy8gYGxvY2F0aW9uc2AgaXMgb24gb3Igb2ZmLlxuZGlyZWN0U291cmNlRmlsZTpudWxsLCAvLyBXaGVuIGVuYWJsZWQsIHBhcmVudGhlc2l6ZWQgZXhwcmVzc2lvbnMgYXJlIHJlcHJlc2VudGVkIGJ5XG4vLyAobm9uLXN0YW5kYXJkKSBQYXJlbnRoZXNpemVkRXhwcmVzc2lvbiBub2Rlc1xucHJlc2VydmVQYXJlbnM6ZmFsc2UscGx1Z2luczp7fX07ZXhwb3J0cy5kZWZhdWx0T3B0aW9ucyA9IGRlZmF1bHRPcHRpb25zOyAvLyBJbnRlcnByZXQgYW5kIGRlZmF1bHQgYW4gb3B0aW9ucyBvYmplY3RcbmZ1bmN0aW9uIGdldE9wdGlvbnMob3B0cyl7dmFyIG9wdGlvbnM9e307Zm9yKHZhciBvcHQgaW4gZGVmYXVsdE9wdGlvbnMpIHtvcHRpb25zW29wdF0gPSBvcHRzICYmIF91dGlsLmhhcyhvcHRzLG9wdCk/b3B0c1tvcHRdOmRlZmF1bHRPcHRpb25zW29wdF07fWlmKF91dGlsLmlzQXJyYXkob3B0aW9ucy5vblRva2VuKSl7KGZ1bmN0aW9uKCl7dmFyIHRva2Vucz1vcHRpb25zLm9uVG9rZW47b3B0aW9ucy5vblRva2VuID0gZnVuY3Rpb24odG9rZW4pe3JldHVybiB0b2tlbnMucHVzaCh0b2tlbik7fTt9KSgpO31pZihfdXRpbC5pc0FycmF5KG9wdGlvbnMub25Db21tZW50KSlvcHRpb25zLm9uQ29tbWVudCA9IHB1c2hDb21tZW50KG9wdGlvbnMsb3B0aW9ucy5vbkNvbW1lbnQpO3JldHVybiBvcHRpb25zO31mdW5jdGlvbiBwdXNoQ29tbWVudChvcHRpb25zLGFycmF5KXtyZXR1cm4gZnVuY3Rpb24oYmxvY2ssdGV4dCxzdGFydCxlbmQsc3RhcnRMb2MsZW5kTG9jKXt2YXIgY29tbWVudD17dHlwZTpibG9jaz8nQmxvY2snOidMaW5lJyx2YWx1ZTp0ZXh0LHN0YXJ0OnN0YXJ0LGVuZDplbmR9O2lmKG9wdGlvbnMubG9jYXRpb25zKWNvbW1lbnQubG9jID0gbmV3IF9sb2N1dGlsLlNvdXJjZUxvY2F0aW9uKHRoaXMsc3RhcnRMb2MsZW5kTG9jKTtpZihvcHRpb25zLnJhbmdlcyljb21tZW50LnJhbmdlID0gW3N0YXJ0LGVuZF07YXJyYXkucHVzaChjb21tZW50KTt9O319LHtcIi4vbG9jdXRpbFwiOjUsXCIuL3V0aWxcIjoxNX1dLDk6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1widXNlIHN0cmljdFwiO3ZhciBfdG9rZW50eXBlPV9kZXJlcV8oXCIuL3Rva2VudHlwZVwiKTt2YXIgX3N0YXRlPV9kZXJlcV8oXCIuL3N0YXRlXCIpO3ZhciBfd2hpdGVzcGFjZT1fZGVyZXFfKFwiLi93aGl0ZXNwYWNlXCIpO3ZhciBwcD1fc3RhdGUuUGFyc2VyLnByb3RvdHlwZTsgLy8gIyMgUGFyc2VyIHV0aWxpdGllc1xuLy8gVGVzdCB3aGV0aGVyIGEgc3RhdGVtZW50IG5vZGUgaXMgdGhlIHN0cmluZyBsaXRlcmFsIGBcInVzZSBzdHJpY3RcImAuXG5wcC5pc1VzZVN0cmljdCA9IGZ1bmN0aW9uKHN0bXQpe3JldHVybiB0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNSAmJiBzdG10LnR5cGUgPT09IFwiRXhwcmVzc2lvblN0YXRlbWVudFwiICYmIHN0bXQuZXhwcmVzc2lvbi50eXBlID09PSBcIkxpdGVyYWxcIiAmJiBzdG10LmV4cHJlc3Npb24ucmF3LnNsaWNlKDEsLTEpID09PSBcInVzZSBzdHJpY3RcIjt9OyAvLyBQcmVkaWNhdGUgdGhhdCB0ZXN0cyB3aGV0aGVyIHRoZSBuZXh0IHRva2VuIGlzIG9mIHRoZSBnaXZlblxuLy8gdHlwZSwgYW5kIGlmIHllcywgY29uc3VtZXMgaXQgYXMgYSBzaWRlIGVmZmVjdC5cbnBwLmVhdCA9IGZ1bmN0aW9uKHR5cGUpe2lmKHRoaXMudHlwZSA9PT0gdHlwZSl7dGhpcy5uZXh0KCk7cmV0dXJuIHRydWU7fWVsc2Uge3JldHVybiBmYWxzZTt9fTsgLy8gVGVzdHMgd2hldGhlciBwYXJzZWQgdG9rZW4gaXMgYSBjb250ZXh0dWFsIGtleXdvcmQuXG5wcC5pc0NvbnRleHR1YWwgPSBmdW5jdGlvbihuYW1lKXtyZXR1cm4gdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLm5hbWUgJiYgdGhpcy52YWx1ZSA9PT0gbmFtZTt9OyAvLyBDb25zdW1lcyBjb250ZXh0dWFsIGtleXdvcmQgaWYgcG9zc2libGUuXG5wcC5lYXRDb250ZXh0dWFsID0gZnVuY3Rpb24obmFtZSl7cmV0dXJuIHRoaXMudmFsdWUgPT09IG5hbWUgJiYgdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5uYW1lKTt9OyAvLyBBc3NlcnRzIHRoYXQgZm9sbG93aW5nIHRva2VuIGlzIGdpdmVuIGNvbnRleHR1YWwga2V5d29yZC5cbnBwLmV4cGVjdENvbnRleHR1YWwgPSBmdW5jdGlvbihuYW1lKXtpZighdGhpcy5lYXRDb250ZXh0dWFsKG5hbWUpKXRoaXMudW5leHBlY3RlZCgpO307IC8vIFRlc3Qgd2hldGhlciBhIHNlbWljb2xvbiBjYW4gYmUgaW5zZXJ0ZWQgYXQgdGhlIGN1cnJlbnQgcG9zaXRpb24uXG5wcC5jYW5JbnNlcnRTZW1pY29sb24gPSBmdW5jdGlvbigpe3JldHVybiB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuZW9mIHx8IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5icmFjZVIgfHwgX3doaXRlc3BhY2UubGluZUJyZWFrLnRlc3QodGhpcy5pbnB1dC5zbGljZSh0aGlzLmxhc3RUb2tFbmQsdGhpcy5zdGFydCkpO307cHAuaW5zZXJ0U2VtaWNvbG9uID0gZnVuY3Rpb24oKXtpZih0aGlzLmNhbkluc2VydFNlbWljb2xvbigpKXtpZih0aGlzLm9wdGlvbnMub25JbnNlcnRlZFNlbWljb2xvbil0aGlzLm9wdGlvbnMub25JbnNlcnRlZFNlbWljb2xvbih0aGlzLmxhc3RUb2tFbmQsdGhpcy5sYXN0VG9rRW5kTG9jKTtyZXR1cm4gdHJ1ZTt9fTsgLy8gQ29uc3VtZSBhIHNlbWljb2xvbiwgb3IsIGZhaWxpbmcgdGhhdCwgc2VlIGlmIHdlIGFyZSBhbGxvd2VkIHRvXG4vLyBwcmV0ZW5kIHRoYXQgdGhlcmUgaXMgYSBzZW1pY29sb24gYXQgdGhpcyBwb3NpdGlvbi5cbnBwLnNlbWljb2xvbiA9IGZ1bmN0aW9uKCl7aWYoIXRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuc2VtaSkgJiYgIXRoaXMuaW5zZXJ0U2VtaWNvbG9uKCkpdGhpcy51bmV4cGVjdGVkKCk7fTtwcC5hZnRlclRyYWlsaW5nQ29tbWEgPSBmdW5jdGlvbih0b2tUeXBlKXtpZih0aGlzLnR5cGUgPT0gdG9rVHlwZSl7aWYodGhpcy5vcHRpb25zLm9uVHJhaWxpbmdDb21tYSl0aGlzLm9wdGlvbnMub25UcmFpbGluZ0NvbW1hKHRoaXMubGFzdFRva1N0YXJ0LHRoaXMubGFzdFRva1N0YXJ0TG9jKTt0aGlzLm5leHQoKTtyZXR1cm4gdHJ1ZTt9fTsgLy8gRXhwZWN0IGEgdG9rZW4gb2YgYSBnaXZlbiB0eXBlLiBJZiBmb3VuZCwgY29uc3VtZSBpdCwgb3RoZXJ3aXNlLFxuLy8gcmFpc2UgYW4gdW5leHBlY3RlZCB0b2tlbiBlcnJvci5cbnBwLmV4cGVjdCA9IGZ1bmN0aW9uKHR5cGUpe3RoaXMuZWF0KHR5cGUpIHx8IHRoaXMudW5leHBlY3RlZCgpO307IC8vIFJhaXNlIGFuIHVuZXhwZWN0ZWQgdG9rZW4gZXJyb3IuXG5wcC51bmV4cGVjdGVkID0gZnVuY3Rpb24ocG9zKXt0aGlzLnJhaXNlKHBvcyAhPSBudWxsP3Bvczp0aGlzLnN0YXJ0LFwiVW5leHBlY3RlZCB0b2tlblwiKTt9O30se1wiLi9zdGF0ZVwiOjEwLFwiLi90b2tlbnR5cGVcIjoxNCxcIi4vd2hpdGVzcGFjZVwiOjE2fV0sMTA6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1widXNlIHN0cmljdFwiO2V4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7ZnVuY3Rpb24gX2NsYXNzQ2FsbENoZWNrKGluc3RhbmNlLENvbnN0cnVjdG9yKXtpZighKGluc3RhbmNlIGluc3RhbmNlb2YgQ29uc3RydWN0b3IpKXt0aHJvdyBuZXcgVHlwZUVycm9yKFwiQ2Fubm90IGNhbGwgYSBjbGFzcyBhcyBhIGZ1bmN0aW9uXCIpO319dmFyIF9pZGVudGlmaWVyPV9kZXJlcV8oXCIuL2lkZW50aWZpZXJcIik7dmFyIF90b2tlbnR5cGU9X2RlcmVxXyhcIi4vdG9rZW50eXBlXCIpO3ZhciBfd2hpdGVzcGFjZT1fZGVyZXFfKFwiLi93aGl0ZXNwYWNlXCIpO3ZhciBfb3B0aW9ucz1fZGVyZXFfKFwiLi9vcHRpb25zXCIpOyAvLyBSZWdpc3RlcmVkIHBsdWdpbnNcbnZhciBwbHVnaW5zPXt9O2V4cG9ydHMucGx1Z2lucyA9IHBsdWdpbnM7dmFyIFBhcnNlcj0oZnVuY3Rpb24oKXtmdW5jdGlvbiBQYXJzZXIob3B0aW9ucyxpbnB1dCxzdGFydFBvcyl7X2NsYXNzQ2FsbENoZWNrKHRoaXMsUGFyc2VyKTt0aGlzLm9wdGlvbnMgPSBfb3B0aW9ucy5nZXRPcHRpb25zKG9wdGlvbnMpO3RoaXMuc291cmNlRmlsZSA9IHRoaXMub3B0aW9ucy5zb3VyY2VGaWxlO3RoaXMuaXNLZXl3b3JkID0gX2lkZW50aWZpZXIua2V5d29yZHNbdGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDY/Njo1XTt0aGlzLmlzUmVzZXJ2ZWRXb3JkID0gX2lkZW50aWZpZXIucmVzZXJ2ZWRXb3Jkc1t0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb25dO3RoaXMuaW5wdXQgPSBTdHJpbmcoaW5wdXQpOyAvLyBVc2VkIHRvIHNpZ25hbCB0byBjYWxsZXJzIG9mIGByZWFkV29yZDFgIHdoZXRoZXIgdGhlIHdvcmRcbi8vIGNvbnRhaW5lZCBhbnkgZXNjYXBlIHNlcXVlbmNlcy4gVGhpcyBpcyBuZWVkZWQgYmVjYXVzZSB3b3JkcyB3aXRoXG4vLyBlc2NhcGUgc2VxdWVuY2VzIG11c3Qgbm90IGJlIGludGVycHJldGVkIGFzIGtleXdvcmRzLlxudGhpcy5jb250YWluc0VzYyA9IGZhbHNlOyAvLyBMb2FkIHBsdWdpbnNcbnRoaXMubG9hZFBsdWdpbnModGhpcy5vcHRpb25zLnBsdWdpbnMpOyAvLyBTZXQgdXAgdG9rZW4gc3RhdGVcbi8vIFRoZSBjdXJyZW50IHBvc2l0aW9uIG9mIHRoZSB0b2tlbml6ZXIgaW4gdGhlIGlucHV0LlxuaWYoc3RhcnRQb3Mpe3RoaXMucG9zID0gc3RhcnRQb3M7dGhpcy5saW5lU3RhcnQgPSBNYXRoLm1heCgwLHRoaXMuaW5wdXQubGFzdEluZGV4T2YoXCJcXG5cIixzdGFydFBvcykpO3RoaXMuY3VyTGluZSA9IHRoaXMuaW5wdXQuc2xpY2UoMCx0aGlzLmxpbmVTdGFydCkuc3BsaXQoX3doaXRlc3BhY2UubGluZUJyZWFrKS5sZW5ndGg7fWVsc2Uge3RoaXMucG9zID0gdGhpcy5saW5lU3RhcnQgPSAwO3RoaXMuY3VyTGluZSA9IDE7fSAvLyBQcm9wZXJ0aWVzIG9mIHRoZSBjdXJyZW50IHRva2VuOlxuLy8gSXRzIHR5cGVcbnRoaXMudHlwZSA9IF90b2tlbnR5cGUudHlwZXMuZW9mOyAvLyBGb3IgdG9rZW5zIHRoYXQgaW5jbHVkZSBtb3JlIGluZm9ybWF0aW9uIHRoYW4gdGhlaXIgdHlwZSwgdGhlIHZhbHVlXG50aGlzLnZhbHVlID0gbnVsbDsgLy8gSXRzIHN0YXJ0IGFuZCBlbmQgb2Zmc2V0XG50aGlzLnN0YXJ0ID0gdGhpcy5lbmQgPSB0aGlzLnBvczsgLy8gQW5kLCBpZiBsb2NhdGlvbnMgYXJlIHVzZWQsIHRoZSB7bGluZSwgY29sdW1ufSBvYmplY3Rcbi8vIGNvcnJlc3BvbmRpbmcgdG8gdGhvc2Ugb2Zmc2V0c1xudGhpcy5zdGFydExvYyA9IHRoaXMuZW5kTG9jID0gdGhpcy5jdXJQb3NpdGlvbigpOyAvLyBQb3NpdGlvbiBpbmZvcm1hdGlvbiBmb3IgdGhlIHByZXZpb3VzIHRva2VuXG50aGlzLmxhc3RUb2tFbmRMb2MgPSB0aGlzLmxhc3RUb2tTdGFydExvYyA9IG51bGw7dGhpcy5sYXN0VG9rU3RhcnQgPSB0aGlzLmxhc3RUb2tFbmQgPSB0aGlzLnBvczsgLy8gVGhlIGNvbnRleHQgc3RhY2sgaXMgdXNlZCB0byBzdXBlcmZpY2lhbGx5IHRyYWNrIHN5bnRhY3RpY1xuLy8gY29udGV4dCB0byBwcmVkaWN0IHdoZXRoZXIgYSByZWd1bGFyIGV4cHJlc3Npb24gaXMgYWxsb3dlZCBpbiBhXG4vLyBnaXZlbiBwb3NpdGlvbi5cbnRoaXMuY29udGV4dCA9IHRoaXMuaW5pdGlhbENvbnRleHQoKTt0aGlzLmV4cHJBbGxvd2VkID0gdHJ1ZTsgLy8gRmlndXJlIG91dCBpZiBpdCdzIGEgbW9kdWxlIGNvZGUuXG50aGlzLnN0cmljdCA9IHRoaXMuaW5Nb2R1bGUgPSB0aGlzLm9wdGlvbnMuc291cmNlVHlwZSA9PT0gXCJtb2R1bGVcIjsgLy8gVXNlZCB0byBzaWduaWZ5IHRoZSBzdGFydCBvZiBhIHBvdGVudGlhbCBhcnJvdyBmdW5jdGlvblxudGhpcy5wb3RlbnRpYWxBcnJvd0F0ID0gLTE7IC8vIEZsYWdzIHRvIHRyYWNrIHdoZXRoZXIgd2UgYXJlIGluIGEgZnVuY3Rpb24sIGEgZ2VuZXJhdG9yLlxudGhpcy5pbkZ1bmN0aW9uID0gdGhpcy5pbkdlbmVyYXRvciA9IGZhbHNlOyAvLyBMYWJlbHMgaW4gc2NvcGUuXG50aGlzLmxhYmVscyA9IFtdOyAvLyBJZiBlbmFibGVkLCBza2lwIGxlYWRpbmcgaGFzaGJhbmcgbGluZS5cbmlmKHRoaXMucG9zID09PSAwICYmIHRoaXMub3B0aW9ucy5hbGxvd0hhc2hCYW5nICYmIHRoaXMuaW5wdXQuc2xpY2UoMCwyKSA9PT0gJyMhJyl0aGlzLnNraXBMaW5lQ29tbWVudCgyKTt9UGFyc2VyLnByb3RvdHlwZS5leHRlbmQgPSBmdW5jdGlvbiBleHRlbmQobmFtZSxmKXt0aGlzW25hbWVdID0gZih0aGlzW25hbWVdKTt9O1BhcnNlci5wcm90b3R5cGUubG9hZFBsdWdpbnMgPSBmdW5jdGlvbiBsb2FkUGx1Z2lucyhwbHVnaW5Db25maWdzKXtmb3IodmFyIF9uYW1lIGluIHBsdWdpbkNvbmZpZ3MpIHt2YXIgcGx1Z2luPXBsdWdpbnNbX25hbWVdO2lmKCFwbHVnaW4pdGhyb3cgbmV3IEVycm9yKFwiUGx1Z2luICdcIiArIF9uYW1lICsgXCInIG5vdCBmb3VuZFwiKTtwbHVnaW4odGhpcyxwbHVnaW5Db25maWdzW19uYW1lXSk7fX07UGFyc2VyLnByb3RvdHlwZS5wYXJzZSA9IGZ1bmN0aW9uIHBhcnNlKCl7dmFyIG5vZGU9dGhpcy5vcHRpb25zLnByb2dyYW0gfHwgdGhpcy5zdGFydE5vZGUoKTt0aGlzLm5leHRUb2tlbigpO3JldHVybiB0aGlzLnBhcnNlVG9wTGV2ZWwobm9kZSk7fTtyZXR1cm4gUGFyc2VyO30pKCk7ZXhwb3J0cy5QYXJzZXIgPSBQYXJzZXI7fSx7XCIuL2lkZW50aWZpZXJcIjoyLFwiLi9vcHRpb25zXCI6OCxcIi4vdG9rZW50eXBlXCI6MTQsXCIuL3doaXRlc3BhY2VcIjoxNn1dLDExOltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXtcInVzZSBzdHJpY3RcIjt2YXIgX3Rva2VudHlwZT1fZGVyZXFfKFwiLi90b2tlbnR5cGVcIik7dmFyIF9zdGF0ZT1fZGVyZXFfKFwiLi9zdGF0ZVwiKTt2YXIgX3doaXRlc3BhY2U9X2RlcmVxXyhcIi4vd2hpdGVzcGFjZVwiKTt2YXIgcHA9X3N0YXRlLlBhcnNlci5wcm90b3R5cGU7IC8vICMjIyBTdGF0ZW1lbnQgcGFyc2luZ1xuLy8gUGFyc2UgYSBwcm9ncmFtLiBJbml0aWFsaXplcyB0aGUgcGFyc2VyLCByZWFkcyBhbnkgbnVtYmVyIG9mXG4vLyBzdGF0ZW1lbnRzLCBhbmQgd3JhcHMgdGhlbSBpbiBhIFByb2dyYW0gbm9kZS4gIE9wdGlvbmFsbHkgdGFrZXMgYVxuLy8gYHByb2dyYW1gIGFyZ3VtZW50LiAgSWYgcHJlc2VudCwgdGhlIHN0YXRlbWVudHMgd2lsbCBiZSBhcHBlbmRlZFxuLy8gdG8gaXRzIGJvZHkgaW5zdGVhZCBvZiBjcmVhdGluZyBhIG5ldyBub2RlLlxucHAucGFyc2VUb3BMZXZlbCA9IGZ1bmN0aW9uKG5vZGUpe3ZhciBmaXJzdD10cnVlO2lmKCFub2RlLmJvZHkpbm9kZS5ib2R5ID0gW107d2hpbGUodGhpcy50eXBlICE9PSBfdG9rZW50eXBlLnR5cGVzLmVvZikge3ZhciBzdG10PXRoaXMucGFyc2VTdGF0ZW1lbnQodHJ1ZSx0cnVlKTtub2RlLmJvZHkucHVzaChzdG10KTtpZihmaXJzdCl7aWYodGhpcy5pc1VzZVN0cmljdChzdG10KSl0aGlzLnNldFN0cmljdCh0cnVlKTtmaXJzdCA9IGZhbHNlO319dGhpcy5uZXh0KCk7aWYodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpe25vZGUuc291cmNlVHlwZSA9IHRoaXMub3B0aW9ucy5zb3VyY2VUeXBlO31yZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJQcm9ncmFtXCIpO307dmFyIGxvb3BMYWJlbD17a2luZDpcImxvb3BcIn0sc3dpdGNoTGFiZWw9e2tpbmQ6XCJzd2l0Y2hcIn07IC8vIFBhcnNlIGEgc2luZ2xlIHN0YXRlbWVudC5cbi8vXG4vLyBJZiBleHBlY3RpbmcgYSBzdGF0ZW1lbnQgYW5kIGZpbmRpbmcgYSBzbGFzaCBvcGVyYXRvciwgcGFyc2UgYVxuLy8gcmVndWxhciBleHByZXNzaW9uIGxpdGVyYWwuIFRoaXMgaXMgdG8gaGFuZGxlIGNhc2VzIGxpa2Vcbi8vIGBpZiAoZm9vKSAvYmxhaC8uZXhlYyhmb28pYCwgd2hlcmUgbG9va2luZyBhdCB0aGUgcHJldmlvdXMgdG9rZW5cbi8vIGRvZXMgbm90IGhlbHAuXG5wcC5wYXJzZVN0YXRlbWVudCA9IGZ1bmN0aW9uKGRlY2xhcmF0aW9uLHRvcExldmVsKXt2YXIgc3RhcnR0eXBlPXRoaXMudHlwZSxub2RlPXRoaXMuc3RhcnROb2RlKCk7IC8vIE1vc3QgdHlwZXMgb2Ygc3RhdGVtZW50cyBhcmUgcmVjb2duaXplZCBieSB0aGUga2V5d29yZCB0aGV5XG4vLyBzdGFydCB3aXRoLiBNYW55IGFyZSB0cml2aWFsIHRvIHBhcnNlLCBzb21lIHJlcXVpcmUgYSBiaXQgb2Zcbi8vIGNvbXBsZXhpdHkuXG5zd2l0Y2goc3RhcnR0eXBlKXtjYXNlIF90b2tlbnR5cGUudHlwZXMuX2JyZWFrOmNhc2UgX3Rva2VudHlwZS50eXBlcy5fY29udGludWU6cmV0dXJuIHRoaXMucGFyc2VCcmVha0NvbnRpbnVlU3RhdGVtZW50KG5vZGUsc3RhcnR0eXBlLmtleXdvcmQpO2Nhc2UgX3Rva2VudHlwZS50eXBlcy5fZGVidWdnZXI6cmV0dXJuIHRoaXMucGFyc2VEZWJ1Z2dlclN0YXRlbWVudChub2RlKTtjYXNlIF90b2tlbnR5cGUudHlwZXMuX2RvOnJldHVybiB0aGlzLnBhcnNlRG9TdGF0ZW1lbnQobm9kZSk7Y2FzZSBfdG9rZW50eXBlLnR5cGVzLl9mb3I6cmV0dXJuIHRoaXMucGFyc2VGb3JTdGF0ZW1lbnQobm9kZSk7Y2FzZSBfdG9rZW50eXBlLnR5cGVzLl9mdW5jdGlvbjppZighZGVjbGFyYXRpb24gJiYgdGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpdGhpcy51bmV4cGVjdGVkKCk7cmV0dXJuIHRoaXMucGFyc2VGdW5jdGlvblN0YXRlbWVudChub2RlKTtjYXNlIF90b2tlbnR5cGUudHlwZXMuX2NsYXNzOmlmKCFkZWNsYXJhdGlvbil0aGlzLnVuZXhwZWN0ZWQoKTtyZXR1cm4gdGhpcy5wYXJzZUNsYXNzKG5vZGUsdHJ1ZSk7Y2FzZSBfdG9rZW50eXBlLnR5cGVzLl9pZjpyZXR1cm4gdGhpcy5wYXJzZUlmU3RhdGVtZW50KG5vZGUpO2Nhc2UgX3Rva2VudHlwZS50eXBlcy5fcmV0dXJuOnJldHVybiB0aGlzLnBhcnNlUmV0dXJuU3RhdGVtZW50KG5vZGUpO2Nhc2UgX3Rva2VudHlwZS50eXBlcy5fc3dpdGNoOnJldHVybiB0aGlzLnBhcnNlU3dpdGNoU3RhdGVtZW50KG5vZGUpO2Nhc2UgX3Rva2VudHlwZS50eXBlcy5fdGhyb3c6cmV0dXJuIHRoaXMucGFyc2VUaHJvd1N0YXRlbWVudChub2RlKTtjYXNlIF90b2tlbnR5cGUudHlwZXMuX3RyeTpyZXR1cm4gdGhpcy5wYXJzZVRyeVN0YXRlbWVudChub2RlKTtjYXNlIF90b2tlbnR5cGUudHlwZXMuX2xldDpjYXNlIF90b2tlbnR5cGUudHlwZXMuX2NvbnN0OmlmKCFkZWNsYXJhdGlvbil0aGlzLnVuZXhwZWN0ZWQoKTsgLy8gTk9URTogZmFsbHMgdGhyb3VnaCB0byBfdmFyXG5jYXNlIF90b2tlbnR5cGUudHlwZXMuX3ZhcjpyZXR1cm4gdGhpcy5wYXJzZVZhclN0YXRlbWVudChub2RlLHN0YXJ0dHlwZSk7Y2FzZSBfdG9rZW50eXBlLnR5cGVzLl93aGlsZTpyZXR1cm4gdGhpcy5wYXJzZVdoaWxlU3RhdGVtZW50KG5vZGUpO2Nhc2UgX3Rva2VudHlwZS50eXBlcy5fd2l0aDpyZXR1cm4gdGhpcy5wYXJzZVdpdGhTdGF0ZW1lbnQobm9kZSk7Y2FzZSBfdG9rZW50eXBlLnR5cGVzLmJyYWNlTDpyZXR1cm4gdGhpcy5wYXJzZUJsb2NrKCk7Y2FzZSBfdG9rZW50eXBlLnR5cGVzLnNlbWk6cmV0dXJuIHRoaXMucGFyc2VFbXB0eVN0YXRlbWVudChub2RlKTtjYXNlIF90b2tlbnR5cGUudHlwZXMuX2V4cG9ydDpjYXNlIF90b2tlbnR5cGUudHlwZXMuX2ltcG9ydDppZighdGhpcy5vcHRpb25zLmFsbG93SW1wb3J0RXhwb3J0RXZlcnl3aGVyZSl7aWYoIXRvcExldmVsKXRoaXMucmFpc2UodGhpcy5zdGFydCxcIidpbXBvcnQnIGFuZCAnZXhwb3J0JyBtYXkgb25seSBhcHBlYXIgYXQgdGhlIHRvcCBsZXZlbFwiKTtpZighdGhpcy5pbk1vZHVsZSl0aGlzLnJhaXNlKHRoaXMuc3RhcnQsXCInaW1wb3J0JyBhbmQgJ2V4cG9ydCcgbWF5IGFwcGVhciBvbmx5IHdpdGggJ3NvdXJjZVR5cGU6IG1vZHVsZSdcIik7fXJldHVybiBzdGFydHR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2ltcG9ydD90aGlzLnBhcnNlSW1wb3J0KG5vZGUpOnRoaXMucGFyc2VFeHBvcnQobm9kZSk7IC8vIElmIHRoZSBzdGF0ZW1lbnQgZG9lcyBub3Qgc3RhcnQgd2l0aCBhIHN0YXRlbWVudCBrZXl3b3JkIG9yIGFcbi8vIGJyYWNlLCBpdCdzIGFuIEV4cHJlc3Npb25TdGF0ZW1lbnQgb3IgTGFiZWxlZFN0YXRlbWVudC4gV2Vcbi8vIHNpbXBseSBzdGFydCBwYXJzaW5nIGFuIGV4cHJlc3Npb24sIGFuZCBhZnRlcndhcmRzLCBpZiB0aGVcbi8vIG5leHQgdG9rZW4gaXMgYSBjb2xvbiBhbmQgdGhlIGV4cHJlc3Npb24gd2FzIGEgc2ltcGxlXG4vLyBJZGVudGlmaWVyIG5vZGUsIHdlIHN3aXRjaCB0byBpbnRlcnByZXRpbmcgaXQgYXMgYSBsYWJlbC5cbmRlZmF1bHQ6dmFyIG1heWJlTmFtZT10aGlzLnZhbHVlLGV4cHI9dGhpcy5wYXJzZUV4cHJlc3Npb24oKTtpZihzdGFydHR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMubmFtZSAmJiBleHByLnR5cGUgPT09IFwiSWRlbnRpZmllclwiICYmIHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuY29sb24pKXJldHVybiB0aGlzLnBhcnNlTGFiZWxlZFN0YXRlbWVudChub2RlLG1heWJlTmFtZSxleHByKTtlbHNlIHJldHVybiB0aGlzLnBhcnNlRXhwcmVzc2lvblN0YXRlbWVudChub2RlLGV4cHIpO319O3BwLnBhcnNlQnJlYWtDb250aW51ZVN0YXRlbWVudCA9IGZ1bmN0aW9uKG5vZGUsa2V5d29yZCl7dmFyIGlzQnJlYWs9a2V5d29yZCA9PSBcImJyZWFrXCI7dGhpcy5uZXh0KCk7aWYodGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5zZW1pKSB8fCB0aGlzLmluc2VydFNlbWljb2xvbigpKW5vZGUubGFiZWwgPSBudWxsO2Vsc2UgaWYodGhpcy50eXBlICE9PSBfdG9rZW50eXBlLnR5cGVzLm5hbWUpdGhpcy51bmV4cGVjdGVkKCk7ZWxzZSB7bm9kZS5sYWJlbCA9IHRoaXMucGFyc2VJZGVudCgpO3RoaXMuc2VtaWNvbG9uKCk7fSAvLyBWZXJpZnkgdGhhdCB0aGVyZSBpcyBhbiBhY3R1YWwgZGVzdGluYXRpb24gdG8gYnJlYWsgb3Jcbi8vIGNvbnRpbnVlIHRvLlxuZm9yKHZhciBpPTA7aSA8IHRoaXMubGFiZWxzLmxlbmd0aDsrK2kpIHt2YXIgbGFiPXRoaXMubGFiZWxzW2ldO2lmKG5vZGUubGFiZWwgPT0gbnVsbCB8fCBsYWIubmFtZSA9PT0gbm9kZS5sYWJlbC5uYW1lKXtpZihsYWIua2luZCAhPSBudWxsICYmIChpc0JyZWFrIHx8IGxhYi5raW5kID09PSBcImxvb3BcIikpYnJlYWs7aWYobm9kZS5sYWJlbCAmJiBpc0JyZWFrKWJyZWFrO319aWYoaSA9PT0gdGhpcy5sYWJlbHMubGVuZ3RoKXRoaXMucmFpc2Uobm9kZS5zdGFydCxcIlVuc3ludGFjdGljIFwiICsga2V5d29yZCk7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLGlzQnJlYWs/XCJCcmVha1N0YXRlbWVudFwiOlwiQ29udGludWVTdGF0ZW1lbnRcIik7fTtwcC5wYXJzZURlYnVnZ2VyU3RhdGVtZW50ID0gZnVuY3Rpb24obm9kZSl7dGhpcy5uZXh0KCk7dGhpcy5zZW1pY29sb24oKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJEZWJ1Z2dlclN0YXRlbWVudFwiKTt9O3BwLnBhcnNlRG9TdGF0ZW1lbnQgPSBmdW5jdGlvbihub2RlKXt0aGlzLm5leHQoKTt0aGlzLmxhYmVscy5wdXNoKGxvb3BMYWJlbCk7bm9kZS5ib2R5ID0gdGhpcy5wYXJzZVN0YXRlbWVudChmYWxzZSk7dGhpcy5sYWJlbHMucG9wKCk7dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5fd2hpbGUpO25vZGUudGVzdCA9IHRoaXMucGFyc2VQYXJlbkV4cHJlc3Npb24oKTtpZih0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNil0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLnNlbWkpO2Vsc2UgdGhpcy5zZW1pY29sb24oKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJEb1doaWxlU3RhdGVtZW50XCIpO307IC8vIERpc2FtYmlndWF0aW5nIGJldHdlZW4gYSBgZm9yYCBhbmQgYSBgZm9yYC9gaW5gIG9yIGBmb3JgL2BvZmBcbi8vIGxvb3AgaXMgbm9uLXRyaXZpYWwuIEJhc2ljYWxseSwgd2UgaGF2ZSB0byBwYXJzZSB0aGUgaW5pdCBgdmFyYFxuLy8gc3RhdGVtZW50IG9yIGV4cHJlc3Npb24sIGRpc2FsbG93aW5nIHRoZSBgaW5gIG9wZXJhdG9yIChzZWVcbi8vIHRoZSBzZWNvbmQgcGFyYW1ldGVyIHRvIGBwYXJzZUV4cHJlc3Npb25gKSwgYW5kIHRoZW4gY2hlY2tcbi8vIHdoZXRoZXIgdGhlIG5leHQgdG9rZW4gaXMgYGluYCBvciBgb2ZgLiBXaGVuIHRoZXJlIGlzIG5vIGluaXRcbi8vIHBhcnQgKHNlbWljb2xvbiBpbW1lZGlhdGVseSBhZnRlciB0aGUgb3BlbmluZyBwYXJlbnRoZXNpcyksIGl0XG4vLyBpcyBhIHJlZ3VsYXIgYGZvcmAgbG9vcC5cbnBwLnBhcnNlRm9yU3RhdGVtZW50ID0gZnVuY3Rpb24obm9kZSl7dGhpcy5uZXh0KCk7dGhpcy5sYWJlbHMucHVzaChsb29wTGFiZWwpO3RoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMucGFyZW5MKTtpZih0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuc2VtaSlyZXR1cm4gdGhpcy5wYXJzZUZvcihub2RlLG51bGwpO2lmKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fdmFyIHx8IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fbGV0IHx8IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fY29uc3Qpe3ZhciBfaW5pdD10aGlzLnN0YXJ0Tm9kZSgpLHZhcktpbmQ9dGhpcy50eXBlO3RoaXMubmV4dCgpO3RoaXMucGFyc2VWYXIoX2luaXQsdHJ1ZSx2YXJLaW5kKTt0aGlzLmZpbmlzaE5vZGUoX2luaXQsXCJWYXJpYWJsZURlY2xhcmF0aW9uXCIpO2lmKCh0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2luIHx8IHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2ICYmIHRoaXMuaXNDb250ZXh0dWFsKFwib2ZcIikpICYmIF9pbml0LmRlY2xhcmF0aW9ucy5sZW5ndGggPT09IDEgJiYgISh2YXJLaW5kICE9PSBfdG9rZW50eXBlLnR5cGVzLl92YXIgJiYgX2luaXQuZGVjbGFyYXRpb25zWzBdLmluaXQpKXJldHVybiB0aGlzLnBhcnNlRm9ySW4obm9kZSxfaW5pdCk7cmV0dXJuIHRoaXMucGFyc2VGb3Iobm9kZSxfaW5pdCk7fXZhciByZWZTaG9ydGhhbmREZWZhdWx0UG9zPXtzdGFydDowfTt2YXIgaW5pdD10aGlzLnBhcnNlRXhwcmVzc2lvbih0cnVlLHJlZlNob3J0aGFuZERlZmF1bHRQb3MpO2lmKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5faW4gfHwgdGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYgJiYgdGhpcy5pc0NvbnRleHR1YWwoXCJvZlwiKSl7dGhpcy50b0Fzc2lnbmFibGUoaW5pdCk7dGhpcy5jaGVja0xWYWwoaW5pdCk7cmV0dXJuIHRoaXMucGFyc2VGb3JJbihub2RlLGluaXQpO31lbHNlIGlmKHJlZlNob3J0aGFuZERlZmF1bHRQb3Muc3RhcnQpe3RoaXMudW5leHBlY3RlZChyZWZTaG9ydGhhbmREZWZhdWx0UG9zLnN0YXJ0KTt9cmV0dXJuIHRoaXMucGFyc2VGb3Iobm9kZSxpbml0KTt9O3BwLnBhcnNlRnVuY3Rpb25TdGF0ZW1lbnQgPSBmdW5jdGlvbihub2RlKXt0aGlzLm5leHQoKTtyZXR1cm4gdGhpcy5wYXJzZUZ1bmN0aW9uKG5vZGUsdHJ1ZSk7fTtwcC5wYXJzZUlmU3RhdGVtZW50ID0gZnVuY3Rpb24obm9kZSl7dGhpcy5uZXh0KCk7bm9kZS50ZXN0ID0gdGhpcy5wYXJzZVBhcmVuRXhwcmVzc2lvbigpO25vZGUuY29uc2VxdWVudCA9IHRoaXMucGFyc2VTdGF0ZW1lbnQoZmFsc2UpO25vZGUuYWx0ZXJuYXRlID0gdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5fZWxzZSk/dGhpcy5wYXJzZVN0YXRlbWVudChmYWxzZSk6bnVsbDtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJJZlN0YXRlbWVudFwiKTt9O3BwLnBhcnNlUmV0dXJuU3RhdGVtZW50ID0gZnVuY3Rpb24obm9kZSl7aWYoIXRoaXMuaW5GdW5jdGlvbiAmJiAhdGhpcy5vcHRpb25zLmFsbG93UmV0dXJuT3V0c2lkZUZ1bmN0aW9uKXRoaXMucmFpc2UodGhpcy5zdGFydCxcIidyZXR1cm4nIG91dHNpZGUgb2YgZnVuY3Rpb25cIik7dGhpcy5uZXh0KCk7IC8vIEluIGByZXR1cm5gIChhbmQgYGJyZWFrYC9gY29udGludWVgKSwgdGhlIGtleXdvcmRzIHdpdGhcbi8vIG9wdGlvbmFsIGFyZ3VtZW50cywgd2UgZWFnZXJseSBsb29rIGZvciBhIHNlbWljb2xvbiBvciB0aGVcbi8vIHBvc3NpYmlsaXR5IHRvIGluc2VydCBvbmUuXG5pZih0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLnNlbWkpIHx8IHRoaXMuaW5zZXJ0U2VtaWNvbG9uKCkpbm9kZS5hcmd1bWVudCA9IG51bGw7ZWxzZSB7bm9kZS5hcmd1bWVudCA9IHRoaXMucGFyc2VFeHByZXNzaW9uKCk7dGhpcy5zZW1pY29sb24oKTt9cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiUmV0dXJuU3RhdGVtZW50XCIpO307cHAucGFyc2VTd2l0Y2hTdGF0ZW1lbnQgPSBmdW5jdGlvbihub2RlKXt0aGlzLm5leHQoKTtub2RlLmRpc2NyaW1pbmFudCA9IHRoaXMucGFyc2VQYXJlbkV4cHJlc3Npb24oKTtub2RlLmNhc2VzID0gW107dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5icmFjZUwpO3RoaXMubGFiZWxzLnB1c2goc3dpdGNoTGFiZWwpOyAvLyBTdGF0ZW1lbnRzIHVuZGVyIG11c3QgYmUgZ3JvdXBlZCAoYnkgbGFiZWwpIGluIFN3aXRjaENhc2Vcbi8vIG5vZGVzLiBgY3VyYCBpcyB1c2VkIHRvIGtlZXAgdGhlIG5vZGUgdGhhdCB3ZSBhcmUgY3VycmVudGx5XG4vLyBhZGRpbmcgc3RhdGVtZW50cyB0by5cbmZvcih2YXIgY3VyLHNhd0RlZmF1bHQ9ZmFsc2U7dGhpcy50eXBlICE9IF90b2tlbnR5cGUudHlwZXMuYnJhY2VSOykge2lmKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fY2FzZSB8fCB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2RlZmF1bHQpe3ZhciBpc0Nhc2U9dGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9jYXNlO2lmKGN1cil0aGlzLmZpbmlzaE5vZGUoY3VyLFwiU3dpdGNoQ2FzZVwiKTtub2RlLmNhc2VzLnB1c2goY3VyID0gdGhpcy5zdGFydE5vZGUoKSk7Y3VyLmNvbnNlcXVlbnQgPSBbXTt0aGlzLm5leHQoKTtpZihpc0Nhc2Upe2N1ci50ZXN0ID0gdGhpcy5wYXJzZUV4cHJlc3Npb24oKTt9ZWxzZSB7aWYoc2F3RGVmYXVsdCl0aGlzLnJhaXNlKHRoaXMubGFzdFRva1N0YXJ0LFwiTXVsdGlwbGUgZGVmYXVsdCBjbGF1c2VzXCIpO3Nhd0RlZmF1bHQgPSB0cnVlO2N1ci50ZXN0ID0gbnVsbDt9dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5jb2xvbik7fWVsc2Uge2lmKCFjdXIpdGhpcy51bmV4cGVjdGVkKCk7Y3VyLmNvbnNlcXVlbnQucHVzaCh0aGlzLnBhcnNlU3RhdGVtZW50KHRydWUpKTt9fWlmKGN1cil0aGlzLmZpbmlzaE5vZGUoY3VyLFwiU3dpdGNoQ2FzZVwiKTt0aGlzLm5leHQoKTsgLy8gQ2xvc2luZyBicmFjZVxudGhpcy5sYWJlbHMucG9wKCk7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiU3dpdGNoU3RhdGVtZW50XCIpO307cHAucGFyc2VUaHJvd1N0YXRlbWVudCA9IGZ1bmN0aW9uKG5vZGUpe3RoaXMubmV4dCgpO2lmKF93aGl0ZXNwYWNlLmxpbmVCcmVhay50ZXN0KHRoaXMuaW5wdXQuc2xpY2UodGhpcy5sYXN0VG9rRW5kLHRoaXMuc3RhcnQpKSl0aGlzLnJhaXNlKHRoaXMubGFzdFRva0VuZCxcIklsbGVnYWwgbmV3bGluZSBhZnRlciB0aHJvd1wiKTtub2RlLmFyZ3VtZW50ID0gdGhpcy5wYXJzZUV4cHJlc3Npb24oKTt0aGlzLnNlbWljb2xvbigpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIlRocm93U3RhdGVtZW50XCIpO307IC8vIFJldXNlZCBlbXB0eSBhcnJheSBhZGRlZCBmb3Igbm9kZSBmaWVsZHMgdGhhdCBhcmUgYWx3YXlzIGVtcHR5LlxudmFyIGVtcHR5PVtdO3BwLnBhcnNlVHJ5U3RhdGVtZW50ID0gZnVuY3Rpb24obm9kZSl7dGhpcy5uZXh0KCk7bm9kZS5ibG9jayA9IHRoaXMucGFyc2VCbG9jaygpO25vZGUuaGFuZGxlciA9IG51bGw7aWYodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9jYXRjaCl7dmFyIGNsYXVzZT10aGlzLnN0YXJ0Tm9kZSgpO3RoaXMubmV4dCgpO3RoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMucGFyZW5MKTtjbGF1c2UucGFyYW0gPSB0aGlzLnBhcnNlQmluZGluZ0F0b20oKTt0aGlzLmNoZWNrTFZhbChjbGF1c2UucGFyYW0sdHJ1ZSk7dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5wYXJlblIpO2NsYXVzZS5ndWFyZCA9IG51bGw7Y2xhdXNlLmJvZHkgPSB0aGlzLnBhcnNlQmxvY2soKTtub2RlLmhhbmRsZXIgPSB0aGlzLmZpbmlzaE5vZGUoY2xhdXNlLFwiQ2F0Y2hDbGF1c2VcIik7fW5vZGUuZ3VhcmRlZEhhbmRsZXJzID0gZW1wdHk7bm9kZS5maW5hbGl6ZXIgPSB0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLl9maW5hbGx5KT90aGlzLnBhcnNlQmxvY2soKTpudWxsO2lmKCFub2RlLmhhbmRsZXIgJiYgIW5vZGUuZmluYWxpemVyKXRoaXMucmFpc2Uobm9kZS5zdGFydCxcIk1pc3NpbmcgY2F0Y2ggb3IgZmluYWxseSBjbGF1c2VcIik7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiVHJ5U3RhdGVtZW50XCIpO307cHAucGFyc2VWYXJTdGF0ZW1lbnQgPSBmdW5jdGlvbihub2RlLGtpbmQpe3RoaXMubmV4dCgpO3RoaXMucGFyc2VWYXIobm9kZSxmYWxzZSxraW5kKTt0aGlzLnNlbWljb2xvbigpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIlZhcmlhYmxlRGVjbGFyYXRpb25cIik7fTtwcC5wYXJzZVdoaWxlU3RhdGVtZW50ID0gZnVuY3Rpb24obm9kZSl7dGhpcy5uZXh0KCk7bm9kZS50ZXN0ID0gdGhpcy5wYXJzZVBhcmVuRXhwcmVzc2lvbigpO3RoaXMubGFiZWxzLnB1c2gobG9vcExhYmVsKTtub2RlLmJvZHkgPSB0aGlzLnBhcnNlU3RhdGVtZW50KGZhbHNlKTt0aGlzLmxhYmVscy5wb3AoKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJXaGlsZVN0YXRlbWVudFwiKTt9O3BwLnBhcnNlV2l0aFN0YXRlbWVudCA9IGZ1bmN0aW9uKG5vZGUpe2lmKHRoaXMuc3RyaWN0KXRoaXMucmFpc2UodGhpcy5zdGFydCxcIid3aXRoJyBpbiBzdHJpY3QgbW9kZVwiKTt0aGlzLm5leHQoKTtub2RlLm9iamVjdCA9IHRoaXMucGFyc2VQYXJlbkV4cHJlc3Npb24oKTtub2RlLmJvZHkgPSB0aGlzLnBhcnNlU3RhdGVtZW50KGZhbHNlKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJXaXRoU3RhdGVtZW50XCIpO307cHAucGFyc2VFbXB0eVN0YXRlbWVudCA9IGZ1bmN0aW9uKG5vZGUpe3RoaXMubmV4dCgpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIkVtcHR5U3RhdGVtZW50XCIpO307cHAucGFyc2VMYWJlbGVkU3RhdGVtZW50ID0gZnVuY3Rpb24obm9kZSxtYXliZU5hbWUsZXhwcil7Zm9yKHZhciBpPTA7aSA8IHRoaXMubGFiZWxzLmxlbmd0aDsrK2kpIHtpZih0aGlzLmxhYmVsc1tpXS5uYW1lID09PSBtYXliZU5hbWUpdGhpcy5yYWlzZShleHByLnN0YXJ0LFwiTGFiZWwgJ1wiICsgbWF5YmVOYW1lICsgXCInIGlzIGFscmVhZHkgZGVjbGFyZWRcIik7fXZhciBraW5kPXRoaXMudHlwZS5pc0xvb3A/XCJsb29wXCI6dGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9zd2l0Y2g/XCJzd2l0Y2hcIjpudWxsO2Zvcih2YXIgaT10aGlzLmxhYmVscy5sZW5ndGggLSAxO2kgPj0gMDtpLS0pIHt2YXIgbGFiZWw9dGhpcy5sYWJlbHNbaV07aWYobGFiZWwuc3RhdGVtZW50U3RhcnQgPT0gbm9kZS5zdGFydCl7bGFiZWwuc3RhdGVtZW50U3RhcnQgPSB0aGlzLnN0YXJ0O2xhYmVsLmtpbmQgPSBraW5kO31lbHNlIGJyZWFrO310aGlzLmxhYmVscy5wdXNoKHtuYW1lOm1heWJlTmFtZSxraW5kOmtpbmQsc3RhdGVtZW50U3RhcnQ6dGhpcy5zdGFydH0pO25vZGUuYm9keSA9IHRoaXMucGFyc2VTdGF0ZW1lbnQodHJ1ZSk7dGhpcy5sYWJlbHMucG9wKCk7bm9kZS5sYWJlbCA9IGV4cHI7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiTGFiZWxlZFN0YXRlbWVudFwiKTt9O3BwLnBhcnNlRXhwcmVzc2lvblN0YXRlbWVudCA9IGZ1bmN0aW9uKG5vZGUsZXhwcil7bm9kZS5leHByZXNzaW9uID0gZXhwcjt0aGlzLnNlbWljb2xvbigpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIkV4cHJlc3Npb25TdGF0ZW1lbnRcIik7fTsgLy8gUGFyc2UgYSBzZW1pY29sb24tZW5jbG9zZWQgYmxvY2sgb2Ygc3RhdGVtZW50cywgaGFuZGxpbmcgYFwidXNlXG4vLyBzdHJpY3RcImAgZGVjbGFyYXRpb25zIHdoZW4gYGFsbG93U3RyaWN0YCBpcyB0cnVlICh1c2VkIGZvclxuLy8gZnVuY3Rpb24gYm9kaWVzKS5cbnBwLnBhcnNlQmxvY2sgPSBmdW5jdGlvbihhbGxvd1N0cmljdCl7dmFyIG5vZGU9dGhpcy5zdGFydE5vZGUoKSxmaXJzdD10cnVlLG9sZFN0cmljdD11bmRlZmluZWQ7bm9kZS5ib2R5ID0gW107dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5icmFjZUwpO3doaWxlKCF0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLmJyYWNlUikpIHt2YXIgc3RtdD10aGlzLnBhcnNlU3RhdGVtZW50KHRydWUpO25vZGUuYm9keS5wdXNoKHN0bXQpO2lmKGZpcnN0ICYmIGFsbG93U3RyaWN0ICYmIHRoaXMuaXNVc2VTdHJpY3Qoc3RtdCkpe29sZFN0cmljdCA9IHRoaXMuc3RyaWN0O3RoaXMuc2V0U3RyaWN0KHRoaXMuc3RyaWN0ID0gdHJ1ZSk7fWZpcnN0ID0gZmFsc2U7fWlmKG9sZFN0cmljdCA9PT0gZmFsc2UpdGhpcy5zZXRTdHJpY3QoZmFsc2UpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIkJsb2NrU3RhdGVtZW50XCIpO307IC8vIFBhcnNlIGEgcmVndWxhciBgZm9yYCBsb29wLiBUaGUgZGlzYW1iaWd1YXRpb24gY29kZSBpblxuLy8gYHBhcnNlU3RhdGVtZW50YCB3aWxsIGFscmVhZHkgaGF2ZSBwYXJzZWQgdGhlIGluaXQgc3RhdGVtZW50IG9yXG4vLyBleHByZXNzaW9uLlxucHAucGFyc2VGb3IgPSBmdW5jdGlvbihub2RlLGluaXQpe25vZGUuaW5pdCA9IGluaXQ7dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5zZW1pKTtub2RlLnRlc3QgPSB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuc2VtaT9udWxsOnRoaXMucGFyc2VFeHByZXNzaW9uKCk7dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5zZW1pKTtub2RlLnVwZGF0ZSA9IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5wYXJlblI/bnVsbDp0aGlzLnBhcnNlRXhwcmVzc2lvbigpO3RoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMucGFyZW5SKTtub2RlLmJvZHkgPSB0aGlzLnBhcnNlU3RhdGVtZW50KGZhbHNlKTt0aGlzLmxhYmVscy5wb3AoKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJGb3JTdGF0ZW1lbnRcIik7fTsgLy8gUGFyc2UgYSBgZm9yYC9gaW5gIGFuZCBgZm9yYC9gb2ZgIGxvb3AsIHdoaWNoIGFyZSBhbG1vc3Rcbi8vIHNhbWUgZnJvbSBwYXJzZXIncyBwZXJzcGVjdGl2ZS5cbnBwLnBhcnNlRm9ySW4gPSBmdW5jdGlvbihub2RlLGluaXQpe3ZhciB0eXBlPXRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5faW4/XCJGb3JJblN0YXRlbWVudFwiOlwiRm9yT2ZTdGF0ZW1lbnRcIjt0aGlzLm5leHQoKTtub2RlLmxlZnQgPSBpbml0O25vZGUucmlnaHQgPSB0aGlzLnBhcnNlRXhwcmVzc2lvbigpO3RoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMucGFyZW5SKTtub2RlLmJvZHkgPSB0aGlzLnBhcnNlU3RhdGVtZW50KGZhbHNlKTt0aGlzLmxhYmVscy5wb3AoKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsdHlwZSk7fTsgLy8gUGFyc2UgYSBsaXN0IG9mIHZhcmlhYmxlIGRlY2xhcmF0aW9ucy5cbnBwLnBhcnNlVmFyID0gZnVuY3Rpb24obm9kZSxpc0ZvcixraW5kKXtub2RlLmRlY2xhcmF0aW9ucyA9IFtdO25vZGUua2luZCA9IGtpbmQua2V5d29yZDtmb3IoOzspIHt2YXIgZGVjbD10aGlzLnN0YXJ0Tm9kZSgpO3RoaXMucGFyc2VWYXJJZChkZWNsKTtpZih0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLmVxKSl7ZGVjbC5pbml0ID0gdGhpcy5wYXJzZU1heWJlQXNzaWduKGlzRm9yKTt9ZWxzZSBpZihraW5kID09PSBfdG9rZW50eXBlLnR5cGVzLl9jb25zdCAmJiAhKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5faW4gfHwgdGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYgJiYgdGhpcy5pc0NvbnRleHR1YWwoXCJvZlwiKSkpe3RoaXMudW5leHBlY3RlZCgpO31lbHNlIGlmKGRlY2wuaWQudHlwZSAhPSBcIklkZW50aWZpZXJcIiAmJiAhKGlzRm9yICYmICh0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2luIHx8IHRoaXMuaXNDb250ZXh0dWFsKFwib2ZcIikpKSl7dGhpcy5yYWlzZSh0aGlzLmxhc3RUb2tFbmQsXCJDb21wbGV4IGJpbmRpbmcgcGF0dGVybnMgcmVxdWlyZSBhbiBpbml0aWFsaXphdGlvbiB2YWx1ZVwiKTt9ZWxzZSB7ZGVjbC5pbml0ID0gbnVsbDt9bm9kZS5kZWNsYXJhdGlvbnMucHVzaCh0aGlzLmZpbmlzaE5vZGUoZGVjbCxcIlZhcmlhYmxlRGVjbGFyYXRvclwiKSk7aWYoIXRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuY29tbWEpKWJyZWFrO31yZXR1cm4gbm9kZTt9O3BwLnBhcnNlVmFySWQgPSBmdW5jdGlvbihkZWNsKXtkZWNsLmlkID0gdGhpcy5wYXJzZUJpbmRpbmdBdG9tKCk7dGhpcy5jaGVja0xWYWwoZGVjbC5pZCx0cnVlKTt9OyAvLyBQYXJzZSBhIGZ1bmN0aW9uIGRlY2xhcmF0aW9uIG9yIGxpdGVyYWwgKGRlcGVuZGluZyBvbiB0aGVcbi8vIGBpc1N0YXRlbWVudGAgcGFyYW1ldGVyKS5cbnBwLnBhcnNlRnVuY3Rpb24gPSBmdW5jdGlvbihub2RlLGlzU3RhdGVtZW50LGFsbG93RXhwcmVzc2lvbkJvZHkpe3RoaXMuaW5pdEZ1bmN0aW9uKG5vZGUpO2lmKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KW5vZGUuZ2VuZXJhdG9yID0gdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5zdGFyKTtpZihpc1N0YXRlbWVudCB8fCB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMubmFtZSlub2RlLmlkID0gdGhpcy5wYXJzZUlkZW50KCk7dGhpcy5wYXJzZUZ1bmN0aW9uUGFyYW1zKG5vZGUpO3RoaXMucGFyc2VGdW5jdGlvbkJvZHkobm9kZSxhbGxvd0V4cHJlc3Npb25Cb2R5KTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsaXNTdGF0ZW1lbnQ/XCJGdW5jdGlvbkRlY2xhcmF0aW9uXCI6XCJGdW5jdGlvbkV4cHJlc3Npb25cIik7fTtwcC5wYXJzZUZ1bmN0aW9uUGFyYW1zID0gZnVuY3Rpb24obm9kZSl7dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5wYXJlbkwpO25vZGUucGFyYW1zID0gdGhpcy5wYXJzZUJpbmRpbmdMaXN0KF90b2tlbnR5cGUudHlwZXMucGFyZW5SLGZhbHNlLGZhbHNlKTt9OyAvLyBQYXJzZSBhIGNsYXNzIGRlY2xhcmF0aW9uIG9yIGxpdGVyYWwgKGRlcGVuZGluZyBvbiB0aGVcbi8vIGBpc1N0YXRlbWVudGAgcGFyYW1ldGVyKS5cbnBwLnBhcnNlQ2xhc3MgPSBmdW5jdGlvbihub2RlLGlzU3RhdGVtZW50KXt0aGlzLm5leHQoKTt0aGlzLnBhcnNlQ2xhc3NJZChub2RlLGlzU3RhdGVtZW50KTt0aGlzLnBhcnNlQ2xhc3NTdXBlcihub2RlKTt2YXIgY2xhc3NCb2R5PXRoaXMuc3RhcnROb2RlKCk7dmFyIGhhZENvbnN0cnVjdG9yPWZhbHNlO2NsYXNzQm9keS5ib2R5ID0gW107dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5icmFjZUwpO3doaWxlKCF0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLmJyYWNlUikpIHtpZih0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLnNlbWkpKWNvbnRpbnVlO3ZhciBtZXRob2Q9dGhpcy5zdGFydE5vZGUoKTt2YXIgaXNHZW5lcmF0b3I9dGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5zdGFyKTt2YXIgaXNNYXliZVN0YXRpYz10aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMubmFtZSAmJiB0aGlzLnZhbHVlID09PSBcInN0YXRpY1wiO3RoaXMucGFyc2VQcm9wZXJ0eU5hbWUobWV0aG9kKTttZXRob2RbXCJzdGF0aWNcIl0gPSBpc01heWJlU3RhdGljICYmIHRoaXMudHlwZSAhPT0gX3Rva2VudHlwZS50eXBlcy5wYXJlbkw7aWYobWV0aG9kW1wic3RhdGljXCJdKXtpZihpc0dlbmVyYXRvcil0aGlzLnVuZXhwZWN0ZWQoKTtpc0dlbmVyYXRvciA9IHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuc3Rhcik7dGhpcy5wYXJzZVByb3BlcnR5TmFtZShtZXRob2QpO31tZXRob2Qua2luZCA9IFwibWV0aG9kXCI7dmFyIGlzR2V0U2V0PWZhbHNlO2lmKCFtZXRob2QuY29tcHV0ZWQpe3ZhciBrZXk9bWV0aG9kLmtleTtpZighaXNHZW5lcmF0b3IgJiYga2V5LnR5cGUgPT09IFwiSWRlbnRpZmllclwiICYmIHRoaXMudHlwZSAhPT0gX3Rva2VudHlwZS50eXBlcy5wYXJlbkwgJiYgKGtleS5uYW1lID09PSBcImdldFwiIHx8IGtleS5uYW1lID09PSBcInNldFwiKSl7aXNHZXRTZXQgPSB0cnVlO21ldGhvZC5raW5kID0ga2V5Lm5hbWU7a2V5ID0gdGhpcy5wYXJzZVByb3BlcnR5TmFtZShtZXRob2QpO31pZighbWV0aG9kW1wic3RhdGljXCJdICYmIChrZXkudHlwZSA9PT0gXCJJZGVudGlmaWVyXCIgJiYga2V5Lm5hbWUgPT09IFwiY29uc3RydWN0b3JcIiB8fCBrZXkudHlwZSA9PT0gXCJMaXRlcmFsXCIgJiYga2V5LnZhbHVlID09PSBcImNvbnN0cnVjdG9yXCIpKXtpZihoYWRDb25zdHJ1Y3Rvcil0aGlzLnJhaXNlKGtleS5zdGFydCxcIkR1cGxpY2F0ZSBjb25zdHJ1Y3RvciBpbiB0aGUgc2FtZSBjbGFzc1wiKTtpZihpc0dldFNldCl0aGlzLnJhaXNlKGtleS5zdGFydCxcIkNvbnN0cnVjdG9yIGNhbid0IGhhdmUgZ2V0L3NldCBtb2RpZmllclwiKTtpZihpc0dlbmVyYXRvcil0aGlzLnJhaXNlKGtleS5zdGFydCxcIkNvbnN0cnVjdG9yIGNhbid0IGJlIGEgZ2VuZXJhdG9yXCIpO21ldGhvZC5raW5kID0gXCJjb25zdHJ1Y3RvclwiO2hhZENvbnN0cnVjdG9yID0gdHJ1ZTt9fXRoaXMucGFyc2VDbGFzc01ldGhvZChjbGFzc0JvZHksbWV0aG9kLGlzR2VuZXJhdG9yKTtpZihpc0dldFNldCl7dmFyIHBhcmFtQ291bnQ9bWV0aG9kLmtpbmQgPT09IFwiZ2V0XCI/MDoxO2lmKG1ldGhvZC52YWx1ZS5wYXJhbXMubGVuZ3RoICE9PSBwYXJhbUNvdW50KXt2YXIgc3RhcnQ9bWV0aG9kLnZhbHVlLnN0YXJ0O2lmKG1ldGhvZC5raW5kID09PSBcImdldFwiKXRoaXMucmFpc2Uoc3RhcnQsXCJnZXR0ZXIgc2hvdWxkIGhhdmUgbm8gcGFyYW1zXCIpO2Vsc2UgdGhpcy5yYWlzZShzdGFydCxcInNldHRlciBzaG91bGQgaGF2ZSBleGFjdGx5IG9uZSBwYXJhbVwiKTt9fX1ub2RlLmJvZHkgPSB0aGlzLmZpbmlzaE5vZGUoY2xhc3NCb2R5LFwiQ2xhc3NCb2R5XCIpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxpc1N0YXRlbWVudD9cIkNsYXNzRGVjbGFyYXRpb25cIjpcIkNsYXNzRXhwcmVzc2lvblwiKTt9O3BwLnBhcnNlQ2xhc3NNZXRob2QgPSBmdW5jdGlvbihjbGFzc0JvZHksbWV0aG9kLGlzR2VuZXJhdG9yKXttZXRob2QudmFsdWUgPSB0aGlzLnBhcnNlTWV0aG9kKGlzR2VuZXJhdG9yKTtjbGFzc0JvZHkuYm9keS5wdXNoKHRoaXMuZmluaXNoTm9kZShtZXRob2QsXCJNZXRob2REZWZpbml0aW9uXCIpKTt9O3BwLnBhcnNlQ2xhc3NJZCA9IGZ1bmN0aW9uKG5vZGUsaXNTdGF0ZW1lbnQpe25vZGUuaWQgPSB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMubmFtZT90aGlzLnBhcnNlSWRlbnQoKTppc1N0YXRlbWVudD90aGlzLnVuZXhwZWN0ZWQoKTpudWxsO307cHAucGFyc2VDbGFzc1N1cGVyID0gZnVuY3Rpb24obm9kZSl7bm9kZS5zdXBlckNsYXNzID0gdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5fZXh0ZW5kcyk/dGhpcy5wYXJzZUV4cHJTdWJzY3JpcHRzKCk6bnVsbDt9OyAvLyBQYXJzZXMgbW9kdWxlIGV4cG9ydCBkZWNsYXJhdGlvbi5cbnBwLnBhcnNlRXhwb3J0ID0gZnVuY3Rpb24obm9kZSl7dGhpcy5uZXh0KCk7IC8vIGV4cG9ydCAqIGZyb20gJy4uLidcbmlmKHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuc3Rhcikpe3RoaXMuZXhwZWN0Q29udGV4dHVhbChcImZyb21cIik7bm9kZS5zb3VyY2UgPSB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuc3RyaW5nP3RoaXMucGFyc2VFeHByQXRvbSgpOnRoaXMudW5leHBlY3RlZCgpO3RoaXMuc2VtaWNvbG9uKCk7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiRXhwb3J0QWxsRGVjbGFyYXRpb25cIik7fWlmKHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuX2RlZmF1bHQpKXsgLy8gZXhwb3J0IGRlZmF1bHQgLi4uXG52YXIgZXhwcj10aGlzLnBhcnNlTWF5YmVBc3NpZ24oKTt2YXIgbmVlZHNTZW1pPXRydWU7aWYoZXhwci50eXBlID09IFwiRnVuY3Rpb25FeHByZXNzaW9uXCIgfHwgZXhwci50eXBlID09IFwiQ2xhc3NFeHByZXNzaW9uXCIpe25lZWRzU2VtaSA9IGZhbHNlO2lmKGV4cHIuaWQpe2V4cHIudHlwZSA9IGV4cHIudHlwZSA9PSBcIkZ1bmN0aW9uRXhwcmVzc2lvblwiP1wiRnVuY3Rpb25EZWNsYXJhdGlvblwiOlwiQ2xhc3NEZWNsYXJhdGlvblwiO319bm9kZS5kZWNsYXJhdGlvbiA9IGV4cHI7aWYobmVlZHNTZW1pKXRoaXMuc2VtaWNvbG9uKCk7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiRXhwb3J0RGVmYXVsdERlY2xhcmF0aW9uXCIpO30gLy8gZXhwb3J0IHZhcnxjb25zdHxsZXR8ZnVuY3Rpb258Y2xhc3MgLi4uXG5pZih0aGlzLnNob3VsZFBhcnNlRXhwb3J0U3RhdGVtZW50KCkpe25vZGUuZGVjbGFyYXRpb24gPSB0aGlzLnBhcnNlU3RhdGVtZW50KHRydWUpO25vZGUuc3BlY2lmaWVycyA9IFtdO25vZGUuc291cmNlID0gbnVsbDt9ZWxzZSB7IC8vIGV4cG9ydCB7IHgsIHkgYXMgeiB9IFtmcm9tICcuLi4nXVxubm9kZS5kZWNsYXJhdGlvbiA9IG51bGw7bm9kZS5zcGVjaWZpZXJzID0gdGhpcy5wYXJzZUV4cG9ydFNwZWNpZmllcnMoKTtpZih0aGlzLmVhdENvbnRleHR1YWwoXCJmcm9tXCIpKXtub2RlLnNvdXJjZSA9IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5zdHJpbmc/dGhpcy5wYXJzZUV4cHJBdG9tKCk6dGhpcy51bmV4cGVjdGVkKCk7fWVsc2Uge25vZGUuc291cmNlID0gbnVsbDt9dGhpcy5zZW1pY29sb24oKTt9cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiRXhwb3J0TmFtZWREZWNsYXJhdGlvblwiKTt9O3BwLnNob3VsZFBhcnNlRXhwb3J0U3RhdGVtZW50ID0gZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy50eXBlLmtleXdvcmQ7fTsgLy8gUGFyc2VzIGEgY29tbWEtc2VwYXJhdGVkIGxpc3Qgb2YgbW9kdWxlIGV4cG9ydHMuXG5wcC5wYXJzZUV4cG9ydFNwZWNpZmllcnMgPSBmdW5jdGlvbigpe3ZhciBub2Rlcz1bXSxmaXJzdD10cnVlOyAvLyBleHBvcnQgeyB4LCB5IGFzIHogfSBbZnJvbSAnLi4uJ11cbnRoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMuYnJhY2VMKTt3aGlsZSghdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5icmFjZVIpKSB7aWYoIWZpcnN0KXt0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmNvbW1hKTtpZih0aGlzLmFmdGVyVHJhaWxpbmdDb21tYShfdG9rZW50eXBlLnR5cGVzLmJyYWNlUikpYnJlYWs7fWVsc2UgZmlyc3QgPSBmYWxzZTt2YXIgbm9kZT10aGlzLnN0YXJ0Tm9kZSgpO25vZGUubG9jYWwgPSB0aGlzLnBhcnNlSWRlbnQodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9kZWZhdWx0KTtub2RlLmV4cG9ydGVkID0gdGhpcy5lYXRDb250ZXh0dWFsKFwiYXNcIik/dGhpcy5wYXJzZUlkZW50KHRydWUpOm5vZGUubG9jYWw7bm9kZXMucHVzaCh0aGlzLmZpbmlzaE5vZGUobm9kZSxcIkV4cG9ydFNwZWNpZmllclwiKSk7fXJldHVybiBub2Rlczt9OyAvLyBQYXJzZXMgaW1wb3J0IGRlY2xhcmF0aW9uLlxucHAucGFyc2VJbXBvcnQgPSBmdW5jdGlvbihub2RlKXt0aGlzLm5leHQoKTsgLy8gaW1wb3J0ICcuLi4nXG5pZih0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuc3RyaW5nKXtub2RlLnNwZWNpZmllcnMgPSBlbXB0eTtub2RlLnNvdXJjZSA9IHRoaXMucGFyc2VFeHByQXRvbSgpO31lbHNlIHtub2RlLnNwZWNpZmllcnMgPSB0aGlzLnBhcnNlSW1wb3J0U3BlY2lmaWVycygpO3RoaXMuZXhwZWN0Q29udGV4dHVhbChcImZyb21cIik7bm9kZS5zb3VyY2UgPSB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuc3RyaW5nP3RoaXMucGFyc2VFeHByQXRvbSgpOnRoaXMudW5leHBlY3RlZCgpO310aGlzLnNlbWljb2xvbigpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIkltcG9ydERlY2xhcmF0aW9uXCIpO307IC8vIFBhcnNlcyBhIGNvbW1hLXNlcGFyYXRlZCBsaXN0IG9mIG1vZHVsZSBpbXBvcnRzLlxucHAucGFyc2VJbXBvcnRTcGVjaWZpZXJzID0gZnVuY3Rpb24oKXt2YXIgbm9kZXM9W10sZmlyc3Q9dHJ1ZTtpZih0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMubmFtZSl7IC8vIGltcG9ydCBkZWZhdWx0T2JqLCB7IHgsIHkgYXMgeiB9IGZyb20gJy4uLidcbnZhciBub2RlPXRoaXMuc3RhcnROb2RlKCk7bm9kZS5sb2NhbCA9IHRoaXMucGFyc2VJZGVudCgpO3RoaXMuY2hlY2tMVmFsKG5vZGUubG9jYWwsdHJ1ZSk7bm9kZXMucHVzaCh0aGlzLmZpbmlzaE5vZGUobm9kZSxcIkltcG9ydERlZmF1bHRTcGVjaWZpZXJcIikpO2lmKCF0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLmNvbW1hKSlyZXR1cm4gbm9kZXM7fWlmKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5zdGFyKXt2YXIgbm9kZT10aGlzLnN0YXJ0Tm9kZSgpO3RoaXMubmV4dCgpO3RoaXMuZXhwZWN0Q29udGV4dHVhbChcImFzXCIpO25vZGUubG9jYWwgPSB0aGlzLnBhcnNlSWRlbnQoKTt0aGlzLmNoZWNrTFZhbChub2RlLmxvY2FsLHRydWUpO25vZGVzLnB1c2godGhpcy5maW5pc2hOb2RlKG5vZGUsXCJJbXBvcnROYW1lc3BhY2VTcGVjaWZpZXJcIikpO3JldHVybiBub2Rlczt9dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5icmFjZUwpO3doaWxlKCF0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLmJyYWNlUikpIHtpZighZmlyc3Qpe3RoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMuY29tbWEpO2lmKHRoaXMuYWZ0ZXJUcmFpbGluZ0NvbW1hKF90b2tlbnR5cGUudHlwZXMuYnJhY2VSKSlicmVhazt9ZWxzZSBmaXJzdCA9IGZhbHNlO3ZhciBub2RlPXRoaXMuc3RhcnROb2RlKCk7bm9kZS5pbXBvcnRlZCA9IHRoaXMucGFyc2VJZGVudCh0cnVlKTtub2RlLmxvY2FsID0gdGhpcy5lYXRDb250ZXh0dWFsKFwiYXNcIik/dGhpcy5wYXJzZUlkZW50KCk6bm9kZS5pbXBvcnRlZDt0aGlzLmNoZWNrTFZhbChub2RlLmxvY2FsLHRydWUpO25vZGVzLnB1c2godGhpcy5maW5pc2hOb2RlKG5vZGUsXCJJbXBvcnRTcGVjaWZpZXJcIikpO31yZXR1cm4gbm9kZXM7fTt9LHtcIi4vc3RhdGVcIjoxMCxcIi4vdG9rZW50eXBlXCI6MTQsXCIuL3doaXRlc3BhY2VcIjoxNn1dLDEyOltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXsgLy8gVGhlIGFsZ29yaXRobSB1c2VkIHRvIGRldGVybWluZSB3aGV0aGVyIGEgcmVnZXhwIGNhbiBhcHBlYXIgYXQgYVxuLy8gZ2l2ZW4gcG9pbnQgaW4gdGhlIHByb2dyYW0gaXMgbG9vc2VseSBiYXNlZCBvbiBzd2VldC5qcycgYXBwcm9hY2guXG4vLyBTZWUgaHR0cHM6Ly9naXRodWIuY29tL21vemlsbGEvc3dlZXQuanMvd2lraS9kZXNpZ25cblwidXNlIHN0cmljdFwiO2V4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7ZnVuY3Rpb24gX2NsYXNzQ2FsbENoZWNrKGluc3RhbmNlLENvbnN0cnVjdG9yKXtpZighKGluc3RhbmNlIGluc3RhbmNlb2YgQ29uc3RydWN0b3IpKXt0aHJvdyBuZXcgVHlwZUVycm9yKFwiQ2Fubm90IGNhbGwgYSBjbGFzcyBhcyBhIGZ1bmN0aW9uXCIpO319dmFyIF9zdGF0ZT1fZGVyZXFfKFwiLi9zdGF0ZVwiKTt2YXIgX3Rva2VudHlwZT1fZGVyZXFfKFwiLi90b2tlbnR5cGVcIik7dmFyIF93aGl0ZXNwYWNlPV9kZXJlcV8oXCIuL3doaXRlc3BhY2VcIik7dmFyIFRva0NvbnRleHQ9ZnVuY3Rpb24gVG9rQ29udGV4dCh0b2tlbixpc0V4cHIscHJlc2VydmVTcGFjZSxvdmVycmlkZSl7X2NsYXNzQ2FsbENoZWNrKHRoaXMsVG9rQ29udGV4dCk7dGhpcy50b2tlbiA9IHRva2VuO3RoaXMuaXNFeHByID0gISFpc0V4cHI7dGhpcy5wcmVzZXJ2ZVNwYWNlID0gISFwcmVzZXJ2ZVNwYWNlO3RoaXMub3ZlcnJpZGUgPSBvdmVycmlkZTt9O2V4cG9ydHMuVG9rQ29udGV4dCA9IFRva0NvbnRleHQ7dmFyIHR5cGVzPXtiX3N0YXQ6bmV3IFRva0NvbnRleHQoXCJ7XCIsZmFsc2UpLGJfZXhwcjpuZXcgVG9rQ29udGV4dChcIntcIix0cnVlKSxiX3RtcGw6bmV3IFRva0NvbnRleHQoXCIke1wiLHRydWUpLHBfc3RhdDpuZXcgVG9rQ29udGV4dChcIihcIixmYWxzZSkscF9leHByOm5ldyBUb2tDb250ZXh0KFwiKFwiLHRydWUpLHFfdG1wbDpuZXcgVG9rQ29udGV4dChcImBcIix0cnVlLHRydWUsZnVuY3Rpb24ocCl7cmV0dXJuIHAucmVhZFRtcGxUb2tlbigpO30pLGZfZXhwcjpuZXcgVG9rQ29udGV4dChcImZ1bmN0aW9uXCIsdHJ1ZSl9O2V4cG9ydHMudHlwZXMgPSB0eXBlczt2YXIgcHA9X3N0YXRlLlBhcnNlci5wcm90b3R5cGU7cHAuaW5pdGlhbENvbnRleHQgPSBmdW5jdGlvbigpe3JldHVybiBbdHlwZXMuYl9zdGF0XTt9O3BwLmJyYWNlSXNCbG9jayA9IGZ1bmN0aW9uKHByZXZUeXBlKXtpZihwcmV2VHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5jb2xvbil7dmFyIF9wYXJlbnQ9dGhpcy5jdXJDb250ZXh0KCk7aWYoX3BhcmVudCA9PT0gdHlwZXMuYl9zdGF0IHx8IF9wYXJlbnQgPT09IHR5cGVzLmJfZXhwcilyZXR1cm4gIV9wYXJlbnQuaXNFeHByO31pZihwcmV2VHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fcmV0dXJuKXJldHVybiBfd2hpdGVzcGFjZS5saW5lQnJlYWsudGVzdCh0aGlzLmlucHV0LnNsaWNlKHRoaXMubGFzdFRva0VuZCx0aGlzLnN0YXJ0KSk7aWYocHJldlR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2Vsc2UgfHwgcHJldlR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuc2VtaSB8fCBwcmV2VHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5lb2YgfHwgcHJldlR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMucGFyZW5SKXJldHVybiB0cnVlO2lmKHByZXZUeXBlID09IF90b2tlbnR5cGUudHlwZXMuYnJhY2VMKXJldHVybiB0aGlzLmN1ckNvbnRleHQoKSA9PT0gdHlwZXMuYl9zdGF0O3JldHVybiAhdGhpcy5leHByQWxsb3dlZDt9O3BwLnVwZGF0ZUNvbnRleHQgPSBmdW5jdGlvbihwcmV2VHlwZSl7dmFyIHVwZGF0ZT11bmRlZmluZWQsdHlwZT10aGlzLnR5cGU7aWYodHlwZS5rZXl3b3JkICYmIHByZXZUeXBlID09IF90b2tlbnR5cGUudHlwZXMuZG90KXRoaXMuZXhwckFsbG93ZWQgPSBmYWxzZTtlbHNlIGlmKHVwZGF0ZSA9IHR5cGUudXBkYXRlQ29udGV4dCl1cGRhdGUuY2FsbCh0aGlzLHByZXZUeXBlKTtlbHNlIHRoaXMuZXhwckFsbG93ZWQgPSB0eXBlLmJlZm9yZUV4cHI7fTsgLy8gVG9rZW4tc3BlY2lmaWMgY29udGV4dCB1cGRhdGUgY29kZVxuX3Rva2VudHlwZS50eXBlcy5wYXJlblIudXBkYXRlQ29udGV4dCA9IF90b2tlbnR5cGUudHlwZXMuYnJhY2VSLnVwZGF0ZUNvbnRleHQgPSBmdW5jdGlvbigpe2lmKHRoaXMuY29udGV4dC5sZW5ndGggPT0gMSl7dGhpcy5leHByQWxsb3dlZCA9IHRydWU7cmV0dXJuO312YXIgb3V0PXRoaXMuY29udGV4dC5wb3AoKTtpZihvdXQgPT09IHR5cGVzLmJfc3RhdCAmJiB0aGlzLmN1ckNvbnRleHQoKSA9PT0gdHlwZXMuZl9leHByKXt0aGlzLmNvbnRleHQucG9wKCk7dGhpcy5leHByQWxsb3dlZCA9IGZhbHNlO31lbHNlIGlmKG91dCA9PT0gdHlwZXMuYl90bXBsKXt0aGlzLmV4cHJBbGxvd2VkID0gdHJ1ZTt9ZWxzZSB7dGhpcy5leHByQWxsb3dlZCA9ICFvdXQuaXNFeHByO319O190b2tlbnR5cGUudHlwZXMuYnJhY2VMLnVwZGF0ZUNvbnRleHQgPSBmdW5jdGlvbihwcmV2VHlwZSl7dGhpcy5jb250ZXh0LnB1c2godGhpcy5icmFjZUlzQmxvY2socHJldlR5cGUpP3R5cGVzLmJfc3RhdDp0eXBlcy5iX2V4cHIpO3RoaXMuZXhwckFsbG93ZWQgPSB0cnVlO307X3Rva2VudHlwZS50eXBlcy5kb2xsYXJCcmFjZUwudXBkYXRlQ29udGV4dCA9IGZ1bmN0aW9uKCl7dGhpcy5jb250ZXh0LnB1c2godHlwZXMuYl90bXBsKTt0aGlzLmV4cHJBbGxvd2VkID0gdHJ1ZTt9O190b2tlbnR5cGUudHlwZXMucGFyZW5MLnVwZGF0ZUNvbnRleHQgPSBmdW5jdGlvbihwcmV2VHlwZSl7dmFyIHN0YXRlbWVudFBhcmVucz1wcmV2VHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5faWYgfHwgcHJldlR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2ZvciB8fCBwcmV2VHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fd2l0aCB8fCBwcmV2VHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fd2hpbGU7dGhpcy5jb250ZXh0LnB1c2goc3RhdGVtZW50UGFyZW5zP3R5cGVzLnBfc3RhdDp0eXBlcy5wX2V4cHIpO3RoaXMuZXhwckFsbG93ZWQgPSB0cnVlO307X3Rva2VudHlwZS50eXBlcy5pbmNEZWMudXBkYXRlQ29udGV4dCA9IGZ1bmN0aW9uKCl7IC8vIHRva0V4cHJBbGxvd2VkIHN0YXlzIHVuY2hhbmdlZFxufTtfdG9rZW50eXBlLnR5cGVzLl9mdW5jdGlvbi51cGRhdGVDb250ZXh0ID0gZnVuY3Rpb24oKXtpZih0aGlzLmN1ckNvbnRleHQoKSAhPT0gdHlwZXMuYl9zdGF0KXRoaXMuY29udGV4dC5wdXNoKHR5cGVzLmZfZXhwcik7dGhpcy5leHByQWxsb3dlZCA9IGZhbHNlO307X3Rva2VudHlwZS50eXBlcy5iYWNrUXVvdGUudXBkYXRlQ29udGV4dCA9IGZ1bmN0aW9uKCl7aWYodGhpcy5jdXJDb250ZXh0KCkgPT09IHR5cGVzLnFfdG1wbCl0aGlzLmNvbnRleHQucG9wKCk7ZWxzZSB0aGlzLmNvbnRleHQucHVzaCh0eXBlcy5xX3RtcGwpO3RoaXMuZXhwckFsbG93ZWQgPSBmYWxzZTt9O30se1wiLi9zdGF0ZVwiOjEwLFwiLi90b2tlbnR5cGVcIjoxNCxcIi4vd2hpdGVzcGFjZVwiOjE2fV0sMTM6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1widXNlIHN0cmljdFwiO2V4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7ZnVuY3Rpb24gX2NsYXNzQ2FsbENoZWNrKGluc3RhbmNlLENvbnN0cnVjdG9yKXtpZighKGluc3RhbmNlIGluc3RhbmNlb2YgQ29uc3RydWN0b3IpKXt0aHJvdyBuZXcgVHlwZUVycm9yKFwiQ2Fubm90IGNhbGwgYSBjbGFzcyBhcyBhIGZ1bmN0aW9uXCIpO319dmFyIF9pZGVudGlmaWVyPV9kZXJlcV8oXCIuL2lkZW50aWZpZXJcIik7dmFyIF90b2tlbnR5cGU9X2RlcmVxXyhcIi4vdG9rZW50eXBlXCIpO3ZhciBfc3RhdGU9X2RlcmVxXyhcIi4vc3RhdGVcIik7dmFyIF9sb2N1dGlsPV9kZXJlcV8oXCIuL2xvY3V0aWxcIik7dmFyIF93aGl0ZXNwYWNlPV9kZXJlcV8oXCIuL3doaXRlc3BhY2VcIik7IC8vIE9iamVjdCB0eXBlIHVzZWQgdG8gcmVwcmVzZW50IHRva2Vucy4gTm90ZSB0aGF0IG5vcm1hbGx5LCB0b2tlbnNcbi8vIHNpbXBseSBleGlzdCBhcyBwcm9wZXJ0aWVzIG9uIHRoZSBwYXJzZXIgb2JqZWN0LiBUaGlzIGlzIG9ubHlcbi8vIHVzZWQgZm9yIHRoZSBvblRva2VuIGNhbGxiYWNrIGFuZCB0aGUgZXh0ZXJuYWwgdG9rZW5pemVyLlxudmFyIFRva2VuPWZ1bmN0aW9uIFRva2VuKHApe19jbGFzc0NhbGxDaGVjayh0aGlzLFRva2VuKTt0aGlzLnR5cGUgPSBwLnR5cGU7dGhpcy52YWx1ZSA9IHAudmFsdWU7dGhpcy5zdGFydCA9IHAuc3RhcnQ7dGhpcy5lbmQgPSBwLmVuZDtpZihwLm9wdGlvbnMubG9jYXRpb25zKXRoaXMubG9jID0gbmV3IF9sb2N1dGlsLlNvdXJjZUxvY2F0aW9uKHAscC5zdGFydExvYyxwLmVuZExvYyk7aWYocC5vcHRpb25zLnJhbmdlcyl0aGlzLnJhbmdlID0gW3Auc3RhcnQscC5lbmRdO30gLy8gIyMgVG9rZW5pemVyXG47ZXhwb3J0cy5Ub2tlbiA9IFRva2VuO3ZhciBwcD1fc3RhdGUuUGFyc2VyLnByb3RvdHlwZTsgLy8gQXJlIHdlIHJ1bm5pbmcgdW5kZXIgUmhpbm8/XG52YXIgaXNSaGlubz10eXBlb2YgUGFja2FnZXMgPT0gXCJvYmplY3RcIiAmJiBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwoUGFja2FnZXMpID09IFwiW29iamVjdCBKYXZhUGFja2FnZV1cIjsgLy8gTW92ZSB0byB0aGUgbmV4dCB0b2tlblxucHAubmV4dCA9IGZ1bmN0aW9uKCl7aWYodGhpcy5vcHRpb25zLm9uVG9rZW4pdGhpcy5vcHRpb25zLm9uVG9rZW4obmV3IFRva2VuKHRoaXMpKTt0aGlzLmxhc3RUb2tFbmQgPSB0aGlzLmVuZDt0aGlzLmxhc3RUb2tTdGFydCA9IHRoaXMuc3RhcnQ7dGhpcy5sYXN0VG9rRW5kTG9jID0gdGhpcy5lbmRMb2M7dGhpcy5sYXN0VG9rU3RhcnRMb2MgPSB0aGlzLnN0YXJ0TG9jO3RoaXMubmV4dFRva2VuKCk7fTtwcC5nZXRUb2tlbiA9IGZ1bmN0aW9uKCl7dGhpcy5uZXh0KCk7cmV0dXJuIG5ldyBUb2tlbih0aGlzKTt9OyAvLyBJZiB3ZSdyZSBpbiBhbiBFUzYgZW52aXJvbm1lbnQsIG1ha2UgcGFyc2VycyBpdGVyYWJsZVxuaWYodHlwZW9mIFN5bWJvbCAhPT0gXCJ1bmRlZmluZWRcIilwcFtTeW1ib2wuaXRlcmF0b3JdID0gZnVuY3Rpb24oKXt2YXIgc2VsZj10aGlzO3JldHVybiB7bmV4dDpmdW5jdGlvbiBuZXh0KCl7dmFyIHRva2VuPXNlbGYuZ2V0VG9rZW4oKTtyZXR1cm4ge2RvbmU6dG9rZW4udHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5lb2YsdmFsdWU6dG9rZW59O319O307IC8vIFRvZ2dsZSBzdHJpY3QgbW9kZS4gUmUtcmVhZHMgdGhlIG5leHQgbnVtYmVyIG9yIHN0cmluZyB0byBwbGVhc2Vcbi8vIHBlZGFudGljIHRlc3RzIChgXCJ1c2Ugc3RyaWN0XCI7IDAxMDtgIHNob3VsZCBmYWlsKS5cbnBwLnNldFN0cmljdCA9IGZ1bmN0aW9uKHN0cmljdCl7dGhpcy5zdHJpY3QgPSBzdHJpY3Q7aWYodGhpcy50eXBlICE9PSBfdG9rZW50eXBlLnR5cGVzLm51bSAmJiB0aGlzLnR5cGUgIT09IF90b2tlbnR5cGUudHlwZXMuc3RyaW5nKXJldHVybjt0aGlzLnBvcyA9IHRoaXMuc3RhcnQ7aWYodGhpcy5vcHRpb25zLmxvY2F0aW9ucyl7d2hpbGUodGhpcy5wb3MgPCB0aGlzLmxpbmVTdGFydCkge3RoaXMubGluZVN0YXJ0ID0gdGhpcy5pbnB1dC5sYXN0SW5kZXhPZihcIlxcblwiLHRoaXMubGluZVN0YXJ0IC0gMikgKyAxOy0tdGhpcy5jdXJMaW5lO319dGhpcy5uZXh0VG9rZW4oKTt9O3BwLmN1ckNvbnRleHQgPSBmdW5jdGlvbigpe3JldHVybiB0aGlzLmNvbnRleHRbdGhpcy5jb250ZXh0Lmxlbmd0aCAtIDFdO307IC8vIFJlYWQgYSBzaW5nbGUgdG9rZW4sIHVwZGF0aW5nIHRoZSBwYXJzZXIgb2JqZWN0J3MgdG9rZW4tcmVsYXRlZFxuLy8gcHJvcGVydGllcy5cbnBwLm5leHRUb2tlbiA9IGZ1bmN0aW9uKCl7dmFyIGN1ckNvbnRleHQ9dGhpcy5jdXJDb250ZXh0KCk7aWYoIWN1ckNvbnRleHQgfHwgIWN1ckNvbnRleHQucHJlc2VydmVTcGFjZSl0aGlzLnNraXBTcGFjZSgpO3RoaXMuc3RhcnQgPSB0aGlzLnBvcztpZih0aGlzLm9wdGlvbnMubG9jYXRpb25zKXRoaXMuc3RhcnRMb2MgPSB0aGlzLmN1clBvc2l0aW9uKCk7aWYodGhpcy5wb3MgPj0gdGhpcy5pbnB1dC5sZW5ndGgpcmV0dXJuIHRoaXMuZmluaXNoVG9rZW4oX3Rva2VudHlwZS50eXBlcy5lb2YpO2lmKGN1ckNvbnRleHQub3ZlcnJpZGUpcmV0dXJuIGN1ckNvbnRleHQub3ZlcnJpZGUodGhpcyk7ZWxzZSB0aGlzLnJlYWRUb2tlbih0aGlzLmZ1bGxDaGFyQ29kZUF0UG9zKCkpO307cHAucmVhZFRva2VuID0gZnVuY3Rpb24oY29kZSl7IC8vIElkZW50aWZpZXIgb3Iga2V5d29yZC4gJ1xcdVhYWFgnIHNlcXVlbmNlcyBhcmUgYWxsb3dlZCBpblxuLy8gaWRlbnRpZmllcnMsIHNvICdcXCcgYWxzbyBkaXNwYXRjaGVzIHRvIHRoYXQuXG5pZihfaWRlbnRpZmllci5pc0lkZW50aWZpZXJTdGFydChjb2RlLHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KSB8fCBjb2RlID09PSA5MiAvKiAnXFwnICovKXJldHVybiB0aGlzLnJlYWRXb3JkKCk7cmV0dXJuIHRoaXMuZ2V0VG9rZW5Gcm9tQ29kZShjb2RlKTt9O3BwLmZ1bGxDaGFyQ29kZUF0UG9zID0gZnVuY3Rpb24oKXt2YXIgY29kZT10aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MpO2lmKGNvZGUgPD0gMHhkN2ZmIHx8IGNvZGUgPj0gMHhlMDAwKXJldHVybiBjb2RlO3ZhciBuZXh0PXRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDEpO3JldHVybiAoY29kZSA8PCAxMCkgKyBuZXh0IC0gMHgzNWZkYzAwO307cHAuc2tpcEJsb2NrQ29tbWVudCA9IGZ1bmN0aW9uKCl7dmFyIHN0YXJ0TG9jPXRoaXMub3B0aW9ucy5vbkNvbW1lbnQgJiYgdGhpcy5jdXJQb3NpdGlvbigpO3ZhciBzdGFydD10aGlzLnBvcyxlbmQ9dGhpcy5pbnB1dC5pbmRleE9mKFwiKi9cIix0aGlzLnBvcyArPSAyKTtpZihlbmQgPT09IC0xKXRoaXMucmFpc2UodGhpcy5wb3MgLSAyLFwiVW50ZXJtaW5hdGVkIGNvbW1lbnRcIik7dGhpcy5wb3MgPSBlbmQgKyAyO2lmKHRoaXMub3B0aW9ucy5sb2NhdGlvbnMpe193aGl0ZXNwYWNlLmxpbmVCcmVha0cubGFzdEluZGV4ID0gc3RhcnQ7dmFyIG1hdGNoPXVuZGVmaW5lZDt3aGlsZSgobWF0Y2ggPSBfd2hpdGVzcGFjZS5saW5lQnJlYWtHLmV4ZWModGhpcy5pbnB1dCkpICYmIG1hdGNoLmluZGV4IDwgdGhpcy5wb3MpIHsrK3RoaXMuY3VyTGluZTt0aGlzLmxpbmVTdGFydCA9IG1hdGNoLmluZGV4ICsgbWF0Y2hbMF0ubGVuZ3RoO319aWYodGhpcy5vcHRpb25zLm9uQ29tbWVudCl0aGlzLm9wdGlvbnMub25Db21tZW50KHRydWUsdGhpcy5pbnB1dC5zbGljZShzdGFydCArIDIsZW5kKSxzdGFydCx0aGlzLnBvcyxzdGFydExvYyx0aGlzLmN1clBvc2l0aW9uKCkpO307cHAuc2tpcExpbmVDb21tZW50ID0gZnVuY3Rpb24oc3RhcnRTa2lwKXt2YXIgc3RhcnQ9dGhpcy5wb3M7dmFyIHN0YXJ0TG9jPXRoaXMub3B0aW9ucy5vbkNvbW1lbnQgJiYgdGhpcy5jdXJQb3NpdGlvbigpO3ZhciBjaD10aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKz0gc3RhcnRTa2lwKTt3aGlsZSh0aGlzLnBvcyA8IHRoaXMuaW5wdXQubGVuZ3RoICYmIGNoICE9PSAxMCAmJiBjaCAhPT0gMTMgJiYgY2ggIT09IDgyMzIgJiYgY2ggIT09IDgyMzMpIHsrK3RoaXMucG9zO2NoID0gdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zKTt9aWYodGhpcy5vcHRpb25zLm9uQ29tbWVudCl0aGlzLm9wdGlvbnMub25Db21tZW50KGZhbHNlLHRoaXMuaW5wdXQuc2xpY2Uoc3RhcnQgKyBzdGFydFNraXAsdGhpcy5wb3MpLHN0YXJ0LHRoaXMucG9zLHN0YXJ0TG9jLHRoaXMuY3VyUG9zaXRpb24oKSk7fTsgLy8gQ2FsbGVkIGF0IHRoZSBzdGFydCBvZiB0aGUgcGFyc2UgYW5kIGFmdGVyIGV2ZXJ5IHRva2VuLiBTa2lwc1xuLy8gd2hpdGVzcGFjZSBhbmQgY29tbWVudHMsIGFuZC5cbnBwLnNraXBTcGFjZSA9IGZ1bmN0aW9uKCl7bG9vcDogd2hpbGUodGhpcy5wb3MgPCB0aGlzLmlucHV0Lmxlbmd0aCkge3ZhciBjaD10aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MpO3N3aXRjaChjaCl7Y2FzZSAzMjpjYXNlIDE2MDogLy8gJyAnXG4rK3RoaXMucG9zO2JyZWFrO2Nhc2UgMTM6aWYodGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMSkgPT09IDEwKXsrK3RoaXMucG9zO31jYXNlIDEwOmNhc2UgODIzMjpjYXNlIDgyMzM6Kyt0aGlzLnBvcztpZih0aGlzLm9wdGlvbnMubG9jYXRpb25zKXsrK3RoaXMuY3VyTGluZTt0aGlzLmxpbmVTdGFydCA9IHRoaXMucG9zO31icmVhaztjYXNlIDQ3OiAvLyAnLydcbnN3aXRjaCh0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAxKSl7Y2FzZSA0MjogLy8gJyonXG50aGlzLnNraXBCbG9ja0NvbW1lbnQoKTticmVhaztjYXNlIDQ3OnRoaXMuc2tpcExpbmVDb21tZW50KDIpO2JyZWFrO2RlZmF1bHQ6YnJlYWsgbG9vcDt9YnJlYWs7ZGVmYXVsdDppZihjaCA+IDggJiYgY2ggPCAxNCB8fCBjaCA+PSA1NzYwICYmIF93aGl0ZXNwYWNlLm5vbkFTQ0lJd2hpdGVzcGFjZS50ZXN0KFN0cmluZy5mcm9tQ2hhckNvZGUoY2gpKSl7Kyt0aGlzLnBvczt9ZWxzZSB7YnJlYWsgbG9vcDt9fX19OyAvLyBDYWxsZWQgYXQgdGhlIGVuZCBvZiBldmVyeSB0b2tlbi4gU2V0cyBgZW5kYCwgYHZhbGAsIGFuZFxuLy8gbWFpbnRhaW5zIGBjb250ZXh0YCBhbmQgYGV4cHJBbGxvd2VkYCwgYW5kIHNraXBzIHRoZSBzcGFjZSBhZnRlclxuLy8gdGhlIHRva2VuLCBzbyB0aGF0IHRoZSBuZXh0IG9uZSdzIGBzdGFydGAgd2lsbCBwb2ludCBhdCB0aGVcbi8vIHJpZ2h0IHBvc2l0aW9uLlxucHAuZmluaXNoVG9rZW4gPSBmdW5jdGlvbih0eXBlLHZhbCl7dGhpcy5lbmQgPSB0aGlzLnBvcztpZih0aGlzLm9wdGlvbnMubG9jYXRpb25zKXRoaXMuZW5kTG9jID0gdGhpcy5jdXJQb3NpdGlvbigpO3ZhciBwcmV2VHlwZT10aGlzLnR5cGU7dGhpcy50eXBlID0gdHlwZTt0aGlzLnZhbHVlID0gdmFsO3RoaXMudXBkYXRlQ29udGV4dChwcmV2VHlwZSk7fTsgLy8gIyMjIFRva2VuIHJlYWRpbmdcbi8vIFRoaXMgaXMgdGhlIGZ1bmN0aW9uIHRoYXQgaXMgY2FsbGVkIHRvIGZldGNoIHRoZSBuZXh0IHRva2VuLiBJdFxuLy8gaXMgc29tZXdoYXQgb2JzY3VyZSwgYmVjYXVzZSBpdCB3b3JrcyBpbiBjaGFyYWN0ZXIgY29kZXMgcmF0aGVyXG4vLyB0aGFuIGNoYXJhY3RlcnMsIGFuZCBiZWNhdXNlIG9wZXJhdG9yIHBhcnNpbmcgaGFzIGJlZW4gaW5saW5lZFxuLy8gaW50byBpdC5cbi8vXG4vLyBBbGwgaW4gdGhlIG5hbWUgb2Ygc3BlZWQuXG4vL1xucHAucmVhZFRva2VuX2RvdCA9IGZ1bmN0aW9uKCl7dmFyIG5leHQ9dGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMSk7aWYobmV4dCA+PSA0OCAmJiBuZXh0IDw9IDU3KXJldHVybiB0aGlzLnJlYWROdW1iZXIodHJ1ZSk7dmFyIG5leHQyPXRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDIpO2lmKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2ICYmIG5leHQgPT09IDQ2ICYmIG5leHQyID09PSA0Nil7IC8vIDQ2ID0gZG90ICcuJ1xudGhpcy5wb3MgKz0gMztyZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLmVsbGlwc2lzKTt9ZWxzZSB7Kyt0aGlzLnBvcztyZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLmRvdCk7fX07cHAucmVhZFRva2VuX3NsYXNoID0gZnVuY3Rpb24oKXsgLy8gJy8nXG52YXIgbmV4dD10aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAxKTtpZih0aGlzLmV4cHJBbGxvd2VkKXsrK3RoaXMucG9zO3JldHVybiB0aGlzLnJlYWRSZWdleHAoKTt9aWYobmV4dCA9PT0gNjEpcmV0dXJuIHRoaXMuZmluaXNoT3AoX3Rva2VudHlwZS50eXBlcy5hc3NpZ24sMik7cmV0dXJuIHRoaXMuZmluaXNoT3AoX3Rva2VudHlwZS50eXBlcy5zbGFzaCwxKTt9O3BwLnJlYWRUb2tlbl9tdWx0X21vZHVsbyA9IGZ1bmN0aW9uKGNvZGUpeyAvLyAnJSonXG52YXIgbmV4dD10aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAxKTtpZihuZXh0ID09PSA2MSlyZXR1cm4gdGhpcy5maW5pc2hPcChfdG9rZW50eXBlLnR5cGVzLmFzc2lnbiwyKTtyZXR1cm4gdGhpcy5maW5pc2hPcChjb2RlID09PSA0Mj9fdG9rZW50eXBlLnR5cGVzLnN0YXI6X3Rva2VudHlwZS50eXBlcy5tb2R1bG8sMSk7fTtwcC5yZWFkVG9rZW5fcGlwZV9hbXAgPSBmdW5jdGlvbihjb2RlKXsgLy8gJ3wmJ1xudmFyIG5leHQ9dGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMSk7aWYobmV4dCA9PT0gY29kZSlyZXR1cm4gdGhpcy5maW5pc2hPcChjb2RlID09PSAxMjQ/X3Rva2VudHlwZS50eXBlcy5sb2dpY2FsT1I6X3Rva2VudHlwZS50eXBlcy5sb2dpY2FsQU5ELDIpO2lmKG5leHQgPT09IDYxKXJldHVybiB0aGlzLmZpbmlzaE9wKF90b2tlbnR5cGUudHlwZXMuYXNzaWduLDIpO3JldHVybiB0aGlzLmZpbmlzaE9wKGNvZGUgPT09IDEyND9fdG9rZW50eXBlLnR5cGVzLmJpdHdpc2VPUjpfdG9rZW50eXBlLnR5cGVzLmJpdHdpc2VBTkQsMSk7fTtwcC5yZWFkVG9rZW5fY2FyZXQgPSBmdW5jdGlvbigpeyAvLyAnXidcbnZhciBuZXh0PXRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDEpO2lmKG5leHQgPT09IDYxKXJldHVybiB0aGlzLmZpbmlzaE9wKF90b2tlbnR5cGUudHlwZXMuYXNzaWduLDIpO3JldHVybiB0aGlzLmZpbmlzaE9wKF90b2tlbnR5cGUudHlwZXMuYml0d2lzZVhPUiwxKTt9O3BwLnJlYWRUb2tlbl9wbHVzX21pbiA9IGZ1bmN0aW9uKGNvZGUpeyAvLyAnKy0nXG52YXIgbmV4dD10aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAxKTtpZihuZXh0ID09PSBjb2RlKXtpZihuZXh0ID09IDQ1ICYmIHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDIpID09IDYyICYmIF93aGl0ZXNwYWNlLmxpbmVCcmVhay50ZXN0KHRoaXMuaW5wdXQuc2xpY2UodGhpcy5sYXN0VG9rRW5kLHRoaXMucG9zKSkpeyAvLyBBIGAtLT5gIGxpbmUgY29tbWVudFxudGhpcy5za2lwTGluZUNvbW1lbnQoMyk7dGhpcy5za2lwU3BhY2UoKTtyZXR1cm4gdGhpcy5uZXh0VG9rZW4oKTt9cmV0dXJuIHRoaXMuZmluaXNoT3AoX3Rva2VudHlwZS50eXBlcy5pbmNEZWMsMik7fWlmKG5leHQgPT09IDYxKXJldHVybiB0aGlzLmZpbmlzaE9wKF90b2tlbnR5cGUudHlwZXMuYXNzaWduLDIpO3JldHVybiB0aGlzLmZpbmlzaE9wKF90b2tlbnR5cGUudHlwZXMucGx1c01pbiwxKTt9O3BwLnJlYWRUb2tlbl9sdF9ndCA9IGZ1bmN0aW9uKGNvZGUpeyAvLyAnPD4nXG52YXIgbmV4dD10aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAxKTt2YXIgc2l6ZT0xO2lmKG5leHQgPT09IGNvZGUpe3NpemUgPSBjb2RlID09PSA2MiAmJiB0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAyKSA9PT0gNjI/MzoyO2lmKHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIHNpemUpID09PSA2MSlyZXR1cm4gdGhpcy5maW5pc2hPcChfdG9rZW50eXBlLnR5cGVzLmFzc2lnbixzaXplICsgMSk7cmV0dXJuIHRoaXMuZmluaXNoT3AoX3Rva2VudHlwZS50eXBlcy5iaXRTaGlmdCxzaXplKTt9aWYobmV4dCA9PSAzMyAmJiBjb2RlID09IDYwICYmIHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDIpID09IDQ1ICYmIHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDMpID09IDQ1KXtpZih0aGlzLmluTW9kdWxlKXRoaXMudW5leHBlY3RlZCgpOyAvLyBgPCEtLWAsIGFuIFhNTC1zdHlsZSBjb21tZW50IHRoYXQgc2hvdWxkIGJlIGludGVycHJldGVkIGFzIGEgbGluZSBjb21tZW50XG50aGlzLnNraXBMaW5lQ29tbWVudCg0KTt0aGlzLnNraXBTcGFjZSgpO3JldHVybiB0aGlzLm5leHRUb2tlbigpO31pZihuZXh0ID09PSA2MSlzaXplID0gdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMikgPT09IDYxPzM6MjtyZXR1cm4gdGhpcy5maW5pc2hPcChfdG9rZW50eXBlLnR5cGVzLnJlbGF0aW9uYWwsc2l6ZSk7fTtwcC5yZWFkVG9rZW5fZXFfZXhjbCA9IGZ1bmN0aW9uKGNvZGUpeyAvLyAnPSEnXG52YXIgbmV4dD10aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAxKTtpZihuZXh0ID09PSA2MSlyZXR1cm4gdGhpcy5maW5pc2hPcChfdG9rZW50eXBlLnR5cGVzLmVxdWFsaXR5LHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDIpID09PSA2MT8zOjIpO2lmKGNvZGUgPT09IDYxICYmIG5leHQgPT09IDYyICYmIHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KXsgLy8gJz0+J1xudGhpcy5wb3MgKz0gMjtyZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLmFycm93KTt9cmV0dXJuIHRoaXMuZmluaXNoT3AoY29kZSA9PT0gNjE/X3Rva2VudHlwZS50eXBlcy5lcTpfdG9rZW50eXBlLnR5cGVzLnByZWZpeCwxKTt9O3BwLmdldFRva2VuRnJvbUNvZGUgPSBmdW5jdGlvbihjb2RlKXtzd2l0Y2goY29kZSl7IC8vIFRoZSBpbnRlcnByZXRhdGlvbiBvZiBhIGRvdCBkZXBlbmRzIG9uIHdoZXRoZXIgaXQgaXMgZm9sbG93ZWRcbi8vIGJ5IGEgZGlnaXQgb3IgYW5vdGhlciB0d28gZG90cy5cbmNhc2UgNDY6IC8vICcuJ1xucmV0dXJuIHRoaXMucmVhZFRva2VuX2RvdCgpOyAvLyBQdW5jdHVhdGlvbiB0b2tlbnMuXG5jYXNlIDQwOisrdGhpcy5wb3M7cmV0dXJuIHRoaXMuZmluaXNoVG9rZW4oX3Rva2VudHlwZS50eXBlcy5wYXJlbkwpO2Nhc2UgNDE6Kyt0aGlzLnBvcztyZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLnBhcmVuUik7Y2FzZSA1OTorK3RoaXMucG9zO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuc2VtaSk7Y2FzZSA0NDorK3RoaXMucG9zO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuY29tbWEpO2Nhc2UgOTE6Kyt0aGlzLnBvcztyZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLmJyYWNrZXRMKTtjYXNlIDkzOisrdGhpcy5wb3M7cmV0dXJuIHRoaXMuZmluaXNoVG9rZW4oX3Rva2VudHlwZS50eXBlcy5icmFja2V0Uik7Y2FzZSAxMjM6Kyt0aGlzLnBvcztyZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLmJyYWNlTCk7Y2FzZSAxMjU6Kyt0aGlzLnBvcztyZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLmJyYWNlUik7Y2FzZSA1ODorK3RoaXMucG9zO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuY29sb24pO2Nhc2UgNjM6Kyt0aGlzLnBvcztyZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLnF1ZXN0aW9uKTtjYXNlIDk2OiAvLyAnYCdcbmlmKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA8IDYpYnJlYWs7Kyt0aGlzLnBvcztyZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLmJhY2tRdW90ZSk7Y2FzZSA0ODogLy8gJzAnXG52YXIgbmV4dD10aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAxKTtpZihuZXh0ID09PSAxMjAgfHwgbmV4dCA9PT0gODgpcmV0dXJuIHRoaXMucmVhZFJhZGl4TnVtYmVyKDE2KTsgLy8gJzB4JywgJzBYJyAtIGhleCBudW1iZXJcbmlmKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KXtpZihuZXh0ID09PSAxMTEgfHwgbmV4dCA9PT0gNzkpcmV0dXJuIHRoaXMucmVhZFJhZGl4TnVtYmVyKDgpOyAvLyAnMG8nLCAnME8nIC0gb2N0YWwgbnVtYmVyXG5pZihuZXh0ID09PSA5OCB8fCBuZXh0ID09PSA2NilyZXR1cm4gdGhpcy5yZWFkUmFkaXhOdW1iZXIoMik7IC8vICcwYicsICcwQicgLSBiaW5hcnkgbnVtYmVyXG59IC8vIEFueXRoaW5nIGVsc2UgYmVnaW5uaW5nIHdpdGggYSBkaWdpdCBpcyBhbiBpbnRlZ2VyLCBvY3RhbFxuLy8gbnVtYmVyLCBvciBmbG9hdC5cbmNhc2UgNDk6Y2FzZSA1MDpjYXNlIDUxOmNhc2UgNTI6Y2FzZSA1MzpjYXNlIDU0OmNhc2UgNTU6Y2FzZSA1NjpjYXNlIDU3OiAvLyAxLTlcbnJldHVybiB0aGlzLnJlYWROdW1iZXIoZmFsc2UpOyAvLyBRdW90ZXMgcHJvZHVjZSBzdHJpbmdzLlxuY2FzZSAzNDpjYXNlIDM5OiAvLyAnXCInLCBcIidcIlxucmV0dXJuIHRoaXMucmVhZFN0cmluZyhjb2RlKTsgLy8gT3BlcmF0b3JzIGFyZSBwYXJzZWQgaW5saW5lIGluIHRpbnkgc3RhdGUgbWFjaGluZXMuICc9JyAoNjEpIGlzXG4vLyBvZnRlbiByZWZlcnJlZCB0by4gYGZpbmlzaE9wYCBzaW1wbHkgc2tpcHMgdGhlIGFtb3VudCBvZlxuLy8gY2hhcmFjdGVycyBpdCBpcyBnaXZlbiBhcyBzZWNvbmQgYXJndW1lbnQsIGFuZCByZXR1cm5zIGEgdG9rZW5cbi8vIG9mIHRoZSB0eXBlIGdpdmVuIGJ5IGl0cyBmaXJzdCBhcmd1bWVudC5cbmNhc2UgNDc6IC8vICcvJ1xucmV0dXJuIHRoaXMucmVhZFRva2VuX3NsYXNoKCk7Y2FzZSAzNzpjYXNlIDQyOiAvLyAnJSonXG5yZXR1cm4gdGhpcy5yZWFkVG9rZW5fbXVsdF9tb2R1bG8oY29kZSk7Y2FzZSAxMjQ6Y2FzZSAzODogLy8gJ3wmJ1xucmV0dXJuIHRoaXMucmVhZFRva2VuX3BpcGVfYW1wKGNvZGUpO2Nhc2UgOTQ6IC8vICdeJ1xucmV0dXJuIHRoaXMucmVhZFRva2VuX2NhcmV0KCk7Y2FzZSA0MzpjYXNlIDQ1OiAvLyAnKy0nXG5yZXR1cm4gdGhpcy5yZWFkVG9rZW5fcGx1c19taW4oY29kZSk7Y2FzZSA2MDpjYXNlIDYyOiAvLyAnPD4nXG5yZXR1cm4gdGhpcy5yZWFkVG9rZW5fbHRfZ3QoY29kZSk7Y2FzZSA2MTpjYXNlIDMzOiAvLyAnPSEnXG5yZXR1cm4gdGhpcy5yZWFkVG9rZW5fZXFfZXhjbChjb2RlKTtjYXNlIDEyNjogLy8gJ34nXG5yZXR1cm4gdGhpcy5maW5pc2hPcChfdG9rZW50eXBlLnR5cGVzLnByZWZpeCwxKTt9dGhpcy5yYWlzZSh0aGlzLnBvcyxcIlVuZXhwZWN0ZWQgY2hhcmFjdGVyICdcIiArIGNvZGVQb2ludFRvU3RyaW5nKGNvZGUpICsgXCInXCIpO307cHAuZmluaXNoT3AgPSBmdW5jdGlvbih0eXBlLHNpemUpe3ZhciBzdHI9dGhpcy5pbnB1dC5zbGljZSh0aGlzLnBvcyx0aGlzLnBvcyArIHNpemUpO3RoaXMucG9zICs9IHNpemU7cmV0dXJuIHRoaXMuZmluaXNoVG9rZW4odHlwZSxzdHIpO307IC8vIFBhcnNlIGEgcmVndWxhciBleHByZXNzaW9uLiBTb21lIGNvbnRleHQtYXdhcmVuZXNzIGlzIG5lY2Vzc2FyeSxcbi8vIHNpbmNlIGEgJy8nIGluc2lkZSBhICdbXScgc2V0IGRvZXMgbm90IGVuZCB0aGUgZXhwcmVzc2lvbi5cbmZ1bmN0aW9uIHRyeUNyZWF0ZVJlZ2V4cChzcmMsZmxhZ3MsdGhyb3dFcnJvckF0KXt0cnl7cmV0dXJuIG5ldyBSZWdFeHAoc3JjLGZsYWdzKTt9Y2F0Y2goZSkge2lmKHRocm93RXJyb3JBdCAhPT0gdW5kZWZpbmVkKXtpZihlIGluc3RhbmNlb2YgU3ludGF4RXJyb3IpdGhpcy5yYWlzZSh0aHJvd0Vycm9yQXQsXCJFcnJvciBwYXJzaW5nIHJlZ3VsYXIgZXhwcmVzc2lvbjogXCIgKyBlLm1lc3NhZ2UpO3RoaXMucmFpc2UoZSk7fX19dmFyIHJlZ2V4cFVuaWNvZGVTdXBwb3J0PSEhdHJ5Q3JlYXRlUmVnZXhwKFwi77+/XCIsXCJ1XCIpO3BwLnJlYWRSZWdleHAgPSBmdW5jdGlvbigpe3ZhciBfdGhpcz10aGlzO3ZhciBlc2NhcGVkPXVuZGVmaW5lZCxpbkNsYXNzPXVuZGVmaW5lZCxzdGFydD10aGlzLnBvcztmb3IoOzspIHtpZih0aGlzLnBvcyA+PSB0aGlzLmlucHV0Lmxlbmd0aCl0aGlzLnJhaXNlKHN0YXJ0LFwiVW50ZXJtaW5hdGVkIHJlZ3VsYXIgZXhwcmVzc2lvblwiKTt2YXIgY2g9dGhpcy5pbnB1dC5jaGFyQXQodGhpcy5wb3MpO2lmKF93aGl0ZXNwYWNlLmxpbmVCcmVhay50ZXN0KGNoKSl0aGlzLnJhaXNlKHN0YXJ0LFwiVW50ZXJtaW5hdGVkIHJlZ3VsYXIgZXhwcmVzc2lvblwiKTtpZighZXNjYXBlZCl7aWYoY2ggPT09IFwiW1wiKWluQ2xhc3MgPSB0cnVlO2Vsc2UgaWYoY2ggPT09IFwiXVwiICYmIGluQ2xhc3MpaW5DbGFzcyA9IGZhbHNlO2Vsc2UgaWYoY2ggPT09IFwiL1wiICYmICFpbkNsYXNzKWJyZWFrO2VzY2FwZWQgPSBjaCA9PT0gXCJcXFxcXCI7fWVsc2UgZXNjYXBlZCA9IGZhbHNlOysrdGhpcy5wb3M7fXZhciBjb250ZW50PXRoaXMuaW5wdXQuc2xpY2Uoc3RhcnQsdGhpcy5wb3MpOysrdGhpcy5wb3M7IC8vIE5lZWQgdG8gdXNlIGByZWFkV29yZDFgIGJlY2F1c2UgJ1xcdVhYWFgnIHNlcXVlbmNlcyBhcmUgYWxsb3dlZFxuLy8gaGVyZSAoZG9uJ3QgYXNrKS5cbnZhciBtb2RzPXRoaXMucmVhZFdvcmQxKCk7dmFyIHRtcD1jb250ZW50O2lmKG1vZHMpe3ZhciB2YWxpZEZsYWdzPS9eW2dtc2l5XSokLztpZih0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNil2YWxpZEZsYWdzID0gL15bZ21zaXl1XSokLztpZighdmFsaWRGbGFncy50ZXN0KG1vZHMpKXRoaXMucmFpc2Uoc3RhcnQsXCJJbnZhbGlkIHJlZ3VsYXIgZXhwcmVzc2lvbiBmbGFnXCIpO2lmKG1vZHMuaW5kZXhPZigndScpID49IDAgJiYgIXJlZ2V4cFVuaWNvZGVTdXBwb3J0KXsgLy8gUmVwbGFjZSBlYWNoIGFzdHJhbCBzeW1ib2wgYW5kIGV2ZXJ5IFVuaWNvZGUgZXNjYXBlIHNlcXVlbmNlIHRoYXRcbi8vIHBvc3NpYmx5IHJlcHJlc2VudHMgYW4gYXN0cmFsIHN5bWJvbCBvciBhIHBhaXJlZCBzdXJyb2dhdGUgd2l0aCBhXG4vLyBzaW5nbGUgQVNDSUkgc3ltYm9sIHRvIGF2b2lkIHRocm93aW5nIG9uIHJlZ3VsYXIgZXhwcmVzc2lvbnMgdGhhdFxuLy8gYXJlIG9ubHkgdmFsaWQgaW4gY29tYmluYXRpb24gd2l0aCB0aGUgYC91YCBmbGFnLlxuLy8gTm90ZTogcmVwbGFjaW5nIHdpdGggdGhlIEFTQ0lJIHN5bWJvbCBgeGAgbWlnaHQgY2F1c2UgZmFsc2Vcbi8vIG5lZ2F0aXZlcyBpbiB1bmxpa2VseSBzY2VuYXJpb3MuIEZvciBleGFtcGxlLCBgW1xcdXs2MX0tYl1gIGlzIGFcbi8vIHBlcmZlY3RseSB2YWxpZCBwYXR0ZXJuIHRoYXQgaXMgZXF1aXZhbGVudCB0byBgW2EtYl1gLCBidXQgaXQgd291bGRcbi8vIGJlIHJlcGxhY2VkIGJ5IGBbeC1iXWAgd2hpY2ggdGhyb3dzIGFuIGVycm9yLlxudG1wID0gdG1wLnJlcGxhY2UoL1xcXFx1XFx7KFswLTlhLWZBLUZdKylcXH0vZyxmdW5jdGlvbihtYXRjaCxjb2RlLG9mZnNldCl7Y29kZSA9IE51bWJlcihcIjB4XCIgKyBjb2RlKTtpZihjb2RlID4gMHgxMEZGRkYpX3RoaXMucmFpc2Uoc3RhcnQgKyBvZmZzZXQgKyAzLFwiQ29kZSBwb2ludCBvdXQgb2YgYm91bmRzXCIpO3JldHVybiBcInhcIjt9KTt0bXAgPSB0bXAucmVwbGFjZSgvXFxcXHUoW2EtZkEtRjAtOV17NH0pfFtcXHVEODAwLVxcdURCRkZdW1xcdURDMDAtXFx1REZGRl0vZyxcInhcIik7fX0gLy8gRGV0ZWN0IGludmFsaWQgcmVndWxhciBleHByZXNzaW9ucy5cbnZhciB2YWx1ZT1udWxsOyAvLyBSaGlubydzIHJlZ3VsYXIgZXhwcmVzc2lvbiBwYXJzZXIgaXMgZmxha3kgYW5kIHRocm93cyB1bmNhdGNoYWJsZSBleGNlcHRpb25zLFxuLy8gc28gZG9uJ3QgZG8gZGV0ZWN0aW9uIGlmIHdlIGFyZSBydW5uaW5nIHVuZGVyIFJoaW5vXG5pZighaXNSaGlubyl7dHJ5Q3JlYXRlUmVnZXhwKHRtcCx1bmRlZmluZWQsc3RhcnQpOyAvLyBHZXQgYSByZWd1bGFyIGV4cHJlc3Npb24gb2JqZWN0IGZvciB0aGlzIHBhdHRlcm4tZmxhZyBwYWlyLCBvciBgbnVsbGAgaW5cbi8vIGNhc2UgdGhlIGN1cnJlbnQgZW52aXJvbm1lbnQgZG9lc24ndCBzdXBwb3J0IHRoZSBmbGFncyBpdCB1c2VzLlxudmFsdWUgPSB0cnlDcmVhdGVSZWdleHAoY29udGVudCxtb2RzKTt9cmV0dXJuIHRoaXMuZmluaXNoVG9rZW4oX3Rva2VudHlwZS50eXBlcy5yZWdleHAse3BhdHRlcm46Y29udGVudCxmbGFnczptb2RzLHZhbHVlOnZhbHVlfSk7fTsgLy8gUmVhZCBhbiBpbnRlZ2VyIGluIHRoZSBnaXZlbiByYWRpeC4gUmV0dXJuIG51bGwgaWYgemVybyBkaWdpdHNcbi8vIHdlcmUgcmVhZCwgdGhlIGludGVnZXIgdmFsdWUgb3RoZXJ3aXNlLiBXaGVuIGBsZW5gIGlzIGdpdmVuLCB0aGlzXG4vLyB3aWxsIHJldHVybiBgbnVsbGAgdW5sZXNzIHRoZSBpbnRlZ2VyIGhhcyBleGFjdGx5IGBsZW5gIGRpZ2l0cy5cbnBwLnJlYWRJbnQgPSBmdW5jdGlvbihyYWRpeCxsZW4pe3ZhciBzdGFydD10aGlzLnBvcyx0b3RhbD0wO2Zvcih2YXIgaT0wLGU9bGVuID09IG51bGw/SW5maW5pdHk6bGVuO2kgPCBlOysraSkge3ZhciBjb2RlPXRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyksdmFsPXVuZGVmaW5lZDtpZihjb2RlID49IDk3KXZhbCA9IGNvZGUgLSA5NyArIDEwOyAvLyBhXG5lbHNlIGlmKGNvZGUgPj0gNjUpdmFsID0gY29kZSAtIDY1ICsgMTA7IC8vIEFcbmVsc2UgaWYoY29kZSA+PSA0OCAmJiBjb2RlIDw9IDU3KXZhbCA9IGNvZGUgLSA0ODsgLy8gMC05XG5lbHNlIHZhbCA9IEluZmluaXR5O2lmKHZhbCA+PSByYWRpeClicmVhazsrK3RoaXMucG9zO3RvdGFsID0gdG90YWwgKiByYWRpeCArIHZhbDt9aWYodGhpcy5wb3MgPT09IHN0YXJ0IHx8IGxlbiAhPSBudWxsICYmIHRoaXMucG9zIC0gc3RhcnQgIT09IGxlbilyZXR1cm4gbnVsbDtyZXR1cm4gdG90YWw7fTtwcC5yZWFkUmFkaXhOdW1iZXIgPSBmdW5jdGlvbihyYWRpeCl7dGhpcy5wb3MgKz0gMjsgLy8gMHhcbnZhciB2YWw9dGhpcy5yZWFkSW50KHJhZGl4KTtpZih2YWwgPT0gbnVsbCl0aGlzLnJhaXNlKHRoaXMuc3RhcnQgKyAyLFwiRXhwZWN0ZWQgbnVtYmVyIGluIHJhZGl4IFwiICsgcmFkaXgpO2lmKF9pZGVudGlmaWVyLmlzSWRlbnRpZmllclN0YXJ0KHRoaXMuZnVsbENoYXJDb2RlQXRQb3MoKSkpdGhpcy5yYWlzZSh0aGlzLnBvcyxcIklkZW50aWZpZXIgZGlyZWN0bHkgYWZ0ZXIgbnVtYmVyXCIpO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMubnVtLHZhbCk7fTsgLy8gUmVhZCBhbiBpbnRlZ2VyLCBvY3RhbCBpbnRlZ2VyLCBvciBmbG9hdGluZy1wb2ludCBudW1iZXIuXG5wcC5yZWFkTnVtYmVyID0gZnVuY3Rpb24oc3RhcnRzV2l0aERvdCl7dmFyIHN0YXJ0PXRoaXMucG9zLGlzRmxvYXQ9ZmFsc2Usb2N0YWw9dGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zKSA9PT0gNDg7aWYoIXN0YXJ0c1dpdGhEb3QgJiYgdGhpcy5yZWFkSW50KDEwKSA9PT0gbnVsbCl0aGlzLnJhaXNlKHN0YXJ0LFwiSW52YWxpZCBudW1iZXJcIik7dmFyIG5leHQ9dGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zKTtpZihuZXh0ID09PSA0Nil7IC8vICcuJ1xuKyt0aGlzLnBvczt0aGlzLnJlYWRJbnQoMTApO2lzRmxvYXQgPSB0cnVlO25leHQgPSB0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MpO31pZihuZXh0ID09PSA2OSB8fCBuZXh0ID09PSAxMDEpeyAvLyAnZUUnXG5uZXh0ID0gdGhpcy5pbnB1dC5jaGFyQ29kZUF0KCsrdGhpcy5wb3MpO2lmKG5leHQgPT09IDQzIHx8IG5leHQgPT09IDQ1KSsrdGhpcy5wb3M7IC8vICcrLSdcbmlmKHRoaXMucmVhZEludCgxMCkgPT09IG51bGwpdGhpcy5yYWlzZShzdGFydCxcIkludmFsaWQgbnVtYmVyXCIpO2lzRmxvYXQgPSB0cnVlO31pZihfaWRlbnRpZmllci5pc0lkZW50aWZpZXJTdGFydCh0aGlzLmZ1bGxDaGFyQ29kZUF0UG9zKCkpKXRoaXMucmFpc2UodGhpcy5wb3MsXCJJZGVudGlmaWVyIGRpcmVjdGx5IGFmdGVyIG51bWJlclwiKTt2YXIgc3RyPXRoaXMuaW5wdXQuc2xpY2Uoc3RhcnQsdGhpcy5wb3MpLHZhbD11bmRlZmluZWQ7aWYoaXNGbG9hdCl2YWwgPSBwYXJzZUZsb2F0KHN0cik7ZWxzZSBpZighb2N0YWwgfHwgc3RyLmxlbmd0aCA9PT0gMSl2YWwgPSBwYXJzZUludChzdHIsMTApO2Vsc2UgaWYoL1s4OV0vLnRlc3Qoc3RyKSB8fCB0aGlzLnN0cmljdCl0aGlzLnJhaXNlKHN0YXJ0LFwiSW52YWxpZCBudW1iZXJcIik7ZWxzZSB2YWwgPSBwYXJzZUludChzdHIsOCk7cmV0dXJuIHRoaXMuZmluaXNoVG9rZW4oX3Rva2VudHlwZS50eXBlcy5udW0sdmFsKTt9OyAvLyBSZWFkIGEgc3RyaW5nIHZhbHVlLCBpbnRlcnByZXRpbmcgYmFja3NsYXNoLWVzY2FwZXMuXG5wcC5yZWFkQ29kZVBvaW50ID0gZnVuY3Rpb24oKXt2YXIgY2g9dGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zKSxjb2RlPXVuZGVmaW5lZDtpZihjaCA9PT0gMTIzKXtpZih0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPCA2KXRoaXMudW5leHBlY3RlZCgpO3ZhciBjb2RlUG9zPSsrdGhpcy5wb3M7Y29kZSA9IHRoaXMucmVhZEhleENoYXIodGhpcy5pbnB1dC5pbmRleE9mKCd9Jyx0aGlzLnBvcykgLSB0aGlzLnBvcyk7Kyt0aGlzLnBvcztpZihjb2RlID4gMHgxMEZGRkYpdGhpcy5yYWlzZShjb2RlUG9zLFwiQ29kZSBwb2ludCBvdXQgb2YgYm91bmRzXCIpO31lbHNlIHtjb2RlID0gdGhpcy5yZWFkSGV4Q2hhcig0KTt9cmV0dXJuIGNvZGU7fTtmdW5jdGlvbiBjb2RlUG9pbnRUb1N0cmluZyhjb2RlKXsgLy8gVVRGLTE2IERlY29kaW5nXG5pZihjb2RlIDw9IDB4RkZGRilyZXR1cm4gU3RyaW5nLmZyb21DaGFyQ29kZShjb2RlKTtjb2RlIC09IDB4MTAwMDA7cmV0dXJuIFN0cmluZy5mcm9tQ2hhckNvZGUoKGNvZGUgPj4gMTApICsgMHhEODAwLChjb2RlICYgMTAyMykgKyAweERDMDApO31wcC5yZWFkU3RyaW5nID0gZnVuY3Rpb24ocXVvdGUpe3ZhciBvdXQ9XCJcIixjaHVua1N0YXJ0PSsrdGhpcy5wb3M7Zm9yKDs7KSB7aWYodGhpcy5wb3MgPj0gdGhpcy5pbnB1dC5sZW5ndGgpdGhpcy5yYWlzZSh0aGlzLnN0YXJ0LFwiVW50ZXJtaW5hdGVkIHN0cmluZyBjb25zdGFudFwiKTt2YXIgY2g9dGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zKTtpZihjaCA9PT0gcXVvdGUpYnJlYWs7aWYoY2ggPT09IDkyKXsgLy8gJ1xcJ1xub3V0ICs9IHRoaXMuaW5wdXQuc2xpY2UoY2h1bmtTdGFydCx0aGlzLnBvcyk7b3V0ICs9IHRoaXMucmVhZEVzY2FwZWRDaGFyKGZhbHNlKTtjaHVua1N0YXJ0ID0gdGhpcy5wb3M7fWVsc2Uge2lmKF93aGl0ZXNwYWNlLmlzTmV3TGluZShjaCkpdGhpcy5yYWlzZSh0aGlzLnN0YXJ0LFwiVW50ZXJtaW5hdGVkIHN0cmluZyBjb25zdGFudFwiKTsrK3RoaXMucG9zO319b3V0ICs9IHRoaXMuaW5wdXQuc2xpY2UoY2h1bmtTdGFydCx0aGlzLnBvcysrKTtyZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLnN0cmluZyxvdXQpO307IC8vIFJlYWRzIHRlbXBsYXRlIHN0cmluZyB0b2tlbnMuXG5wcC5yZWFkVG1wbFRva2VuID0gZnVuY3Rpb24oKXt2YXIgb3V0PVwiXCIsY2h1bmtTdGFydD10aGlzLnBvcztmb3IoOzspIHtpZih0aGlzLnBvcyA+PSB0aGlzLmlucHV0Lmxlbmd0aCl0aGlzLnJhaXNlKHRoaXMuc3RhcnQsXCJVbnRlcm1pbmF0ZWQgdGVtcGxhdGVcIik7dmFyIGNoPXRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyk7aWYoY2ggPT09IDk2IHx8IGNoID09PSAzNiAmJiB0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAxKSA9PT0gMTIzKXsgLy8gJ2AnLCAnJHsnXG5pZih0aGlzLnBvcyA9PT0gdGhpcy5zdGFydCAmJiB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMudGVtcGxhdGUpe2lmKGNoID09PSAzNil7dGhpcy5wb3MgKz0gMjtyZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLmRvbGxhckJyYWNlTCk7fWVsc2UgeysrdGhpcy5wb3M7cmV0dXJuIHRoaXMuZmluaXNoVG9rZW4oX3Rva2VudHlwZS50eXBlcy5iYWNrUXVvdGUpO319b3V0ICs9IHRoaXMuaW5wdXQuc2xpY2UoY2h1bmtTdGFydCx0aGlzLnBvcyk7cmV0dXJuIHRoaXMuZmluaXNoVG9rZW4oX3Rva2VudHlwZS50eXBlcy50ZW1wbGF0ZSxvdXQpO31pZihjaCA9PT0gOTIpeyAvLyAnXFwnXG5vdXQgKz0gdGhpcy5pbnB1dC5zbGljZShjaHVua1N0YXJ0LHRoaXMucG9zKTtvdXQgKz0gdGhpcy5yZWFkRXNjYXBlZENoYXIodHJ1ZSk7Y2h1bmtTdGFydCA9IHRoaXMucG9zO31lbHNlIGlmKF93aGl0ZXNwYWNlLmlzTmV3TGluZShjaCkpe291dCArPSB0aGlzLmlucHV0LnNsaWNlKGNodW5rU3RhcnQsdGhpcy5wb3MpOysrdGhpcy5wb3M7c3dpdGNoKGNoKXtjYXNlIDEzOmlmKHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcykgPT09IDEwKSsrdGhpcy5wb3M7Y2FzZSAxMDpvdXQgKz0gXCJcXG5cIjticmVhaztkZWZhdWx0Om91dCArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKGNoKTticmVhazt9aWYodGhpcy5vcHRpb25zLmxvY2F0aW9ucyl7Kyt0aGlzLmN1ckxpbmU7dGhpcy5saW5lU3RhcnQgPSB0aGlzLnBvczt9Y2h1bmtTdGFydCA9IHRoaXMucG9zO31lbHNlIHsrK3RoaXMucG9zO319fTsgLy8gVXNlZCB0byByZWFkIGVzY2FwZWQgY2hhcmFjdGVyc1xucHAucmVhZEVzY2FwZWRDaGFyID0gZnVuY3Rpb24oaW5UZW1wbGF0ZSl7dmFyIGNoPXRoaXMuaW5wdXQuY2hhckNvZGVBdCgrK3RoaXMucG9zKTsrK3RoaXMucG9zO3N3aXRjaChjaCl7Y2FzZSAxMTA6cmV0dXJuIFwiXFxuXCI7IC8vICduJyAtPiAnXFxuJ1xuY2FzZSAxMTQ6cmV0dXJuIFwiXFxyXCI7IC8vICdyJyAtPiAnXFxyJ1xuY2FzZSAxMjA6cmV0dXJuIFN0cmluZy5mcm9tQ2hhckNvZGUodGhpcy5yZWFkSGV4Q2hhcigyKSk7IC8vICd4J1xuY2FzZSAxMTc6cmV0dXJuIGNvZGVQb2ludFRvU3RyaW5nKHRoaXMucmVhZENvZGVQb2ludCgpKTsgLy8gJ3UnXG5jYXNlIDExNjpyZXR1cm4gXCJcXHRcIjsgLy8gJ3QnIC0+ICdcXHQnXG5jYXNlIDk4OnJldHVybiBcIlxcYlwiOyAvLyAnYicgLT4gJ1xcYidcbmNhc2UgMTE4OnJldHVybiBcIlxcdTAwMGJcIjsgLy8gJ3YnIC0+ICdcXHUwMDBiJ1xuY2FzZSAxMDI6cmV0dXJuIFwiXFxmXCI7IC8vICdmJyAtPiAnXFxmJ1xuY2FzZSAxMzppZih0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MpID09PSAxMCkrK3RoaXMucG9zOyAvLyAnXFxyXFxuJ1xuY2FzZSAxMDogLy8gJyBcXG4nXG5pZih0aGlzLm9wdGlvbnMubG9jYXRpb25zKXt0aGlzLmxpbmVTdGFydCA9IHRoaXMucG9zOysrdGhpcy5jdXJMaW5lO31yZXR1cm4gXCJcIjtkZWZhdWx0OmlmKGNoID49IDQ4ICYmIGNoIDw9IDU1KXt2YXIgb2N0YWxTdHI9dGhpcy5pbnB1dC5zdWJzdHIodGhpcy5wb3MgLSAxLDMpLm1hdGNoKC9eWzAtN10rLylbMF07dmFyIG9jdGFsPXBhcnNlSW50KG9jdGFsU3RyLDgpO2lmKG9jdGFsID4gMjU1KXtvY3RhbFN0ciA9IG9jdGFsU3RyLnNsaWNlKDAsLTEpO29jdGFsID0gcGFyc2VJbnQob2N0YWxTdHIsOCk7fWlmKG9jdGFsID4gMCAmJiAodGhpcy5zdHJpY3QgfHwgaW5UZW1wbGF0ZSkpe3RoaXMucmFpc2UodGhpcy5wb3MgLSAyLFwiT2N0YWwgbGl0ZXJhbCBpbiBzdHJpY3QgbW9kZVwiKTt9dGhpcy5wb3MgKz0gb2N0YWxTdHIubGVuZ3RoIC0gMTtyZXR1cm4gU3RyaW5nLmZyb21DaGFyQ29kZShvY3RhbCk7fXJldHVybiBTdHJpbmcuZnJvbUNoYXJDb2RlKGNoKTt9fTsgLy8gVXNlZCB0byByZWFkIGNoYXJhY3RlciBlc2NhcGUgc2VxdWVuY2VzICgnXFx4JywgJ1xcdScsICdcXFUnKS5cbnBwLnJlYWRIZXhDaGFyID0gZnVuY3Rpb24obGVuKXt2YXIgY29kZVBvcz10aGlzLnBvczt2YXIgbj10aGlzLnJlYWRJbnQoMTYsbGVuKTtpZihuID09PSBudWxsKXRoaXMucmFpc2UoY29kZVBvcyxcIkJhZCBjaGFyYWN0ZXIgZXNjYXBlIHNlcXVlbmNlXCIpO3JldHVybiBuO307IC8vIFJlYWQgYW4gaWRlbnRpZmllciwgYW5kIHJldHVybiBpdCBhcyBhIHN0cmluZy4gU2V0cyBgdGhpcy5jb250YWluc0VzY2Bcbi8vIHRvIHdoZXRoZXIgdGhlIHdvcmQgY29udGFpbmVkIGEgJ1xcdScgZXNjYXBlLlxuLy9cbi8vIEluY3JlbWVudGFsbHkgYWRkcyBvbmx5IGVzY2FwZWQgY2hhcnMsIGFkZGluZyBvdGhlciBjaHVua3MgYXMtaXNcbi8vIGFzIGEgbWljcm8tb3B0aW1pemF0aW9uLlxucHAucmVhZFdvcmQxID0gZnVuY3Rpb24oKXt0aGlzLmNvbnRhaW5zRXNjID0gZmFsc2U7dmFyIHdvcmQ9XCJcIixmaXJzdD10cnVlLGNodW5rU3RhcnQ9dGhpcy5wb3M7dmFyIGFzdHJhbD10aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNjt3aGlsZSh0aGlzLnBvcyA8IHRoaXMuaW5wdXQubGVuZ3RoKSB7dmFyIGNoPXRoaXMuZnVsbENoYXJDb2RlQXRQb3MoKTtpZihfaWRlbnRpZmllci5pc0lkZW50aWZpZXJDaGFyKGNoLGFzdHJhbCkpe3RoaXMucG9zICs9IGNoIDw9IDB4ZmZmZj8xOjI7fWVsc2UgaWYoY2ggPT09IDkyKXsgLy8gXCJcXFwiXG50aGlzLmNvbnRhaW5zRXNjID0gdHJ1ZTt3b3JkICs9IHRoaXMuaW5wdXQuc2xpY2UoY2h1bmtTdGFydCx0aGlzLnBvcyk7dmFyIGVzY1N0YXJ0PXRoaXMucG9zO2lmKHRoaXMuaW5wdXQuY2hhckNvZGVBdCgrK3RoaXMucG9zKSAhPSAxMTcpIC8vIFwidVwiXG50aGlzLnJhaXNlKHRoaXMucG9zLFwiRXhwZWN0aW5nIFVuaWNvZGUgZXNjYXBlIHNlcXVlbmNlIFxcXFx1WFhYWFwiKTsrK3RoaXMucG9zO3ZhciBlc2M9dGhpcy5yZWFkQ29kZVBvaW50KCk7aWYoIShmaXJzdD9faWRlbnRpZmllci5pc0lkZW50aWZpZXJTdGFydDpfaWRlbnRpZmllci5pc0lkZW50aWZpZXJDaGFyKShlc2MsYXN0cmFsKSl0aGlzLnJhaXNlKGVzY1N0YXJ0LFwiSW52YWxpZCBVbmljb2RlIGVzY2FwZVwiKTt3b3JkICs9IGNvZGVQb2ludFRvU3RyaW5nKGVzYyk7Y2h1bmtTdGFydCA9IHRoaXMucG9zO31lbHNlIHticmVhazt9Zmlyc3QgPSBmYWxzZTt9cmV0dXJuIHdvcmQgKyB0aGlzLmlucHV0LnNsaWNlKGNodW5rU3RhcnQsdGhpcy5wb3MpO307IC8vIFJlYWQgYW4gaWRlbnRpZmllciBvciBrZXl3b3JkIHRva2VuLiBXaWxsIGNoZWNrIGZvciByZXNlcnZlZFxuLy8gd29yZHMgd2hlbiBuZWNlc3NhcnkuXG5wcC5yZWFkV29yZCA9IGZ1bmN0aW9uKCl7dmFyIHdvcmQ9dGhpcy5yZWFkV29yZDEoKTt2YXIgdHlwZT1fdG9rZW50eXBlLnR5cGVzLm5hbWU7aWYoKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2IHx8ICF0aGlzLmNvbnRhaW5zRXNjKSAmJiB0aGlzLmlzS2V5d29yZCh3b3JkKSl0eXBlID0gX3Rva2VudHlwZS5rZXl3b3Jkc1t3b3JkXTtyZXR1cm4gdGhpcy5maW5pc2hUb2tlbih0eXBlLHdvcmQpO307fSx7XCIuL2lkZW50aWZpZXJcIjoyLFwiLi9sb2N1dGlsXCI6NSxcIi4vc3RhdGVcIjoxMCxcIi4vdG9rZW50eXBlXCI6MTQsXCIuL3doaXRlc3BhY2VcIjoxNn1dLDE0OltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXsgLy8gIyMgVG9rZW4gdHlwZXNcbi8vIFRoZSBhc3NpZ25tZW50IG9mIGZpbmUtZ3JhaW5lZCwgaW5mb3JtYXRpb24tY2FycnlpbmcgdHlwZSBvYmplY3RzXG4vLyBhbGxvd3MgdGhlIHRva2VuaXplciB0byBzdG9yZSB0aGUgaW5mb3JtYXRpb24gaXQgaGFzIGFib3V0IGFcbi8vIHRva2VuIGluIGEgd2F5IHRoYXQgaXMgdmVyeSBjaGVhcCBmb3IgdGhlIHBhcnNlciB0byBsb29rIHVwLlxuLy8gQWxsIHRva2VuIHR5cGUgdmFyaWFibGVzIHN0YXJ0IHdpdGggYW4gdW5kZXJzY29yZSwgdG8gbWFrZSB0aGVtXG4vLyBlYXN5IHRvIHJlY29nbml6ZS5cbi8vIFRoZSBgYmVmb3JlRXhwcmAgcHJvcGVydHkgaXMgdXNlZCB0byBkaXNhbWJpZ3VhdGUgYmV0d2VlbiByZWd1bGFyXG4vLyBleHByZXNzaW9ucyBhbmQgZGl2aXNpb25zLiBJdCBpcyBzZXQgb24gYWxsIHRva2VuIHR5cGVzIHRoYXQgY2FuXG4vLyBiZSBmb2xsb3dlZCBieSBhbiBleHByZXNzaW9uICh0aHVzLCBhIHNsYXNoIGFmdGVyIHRoZW0gd291bGQgYmUgYVxuLy8gcmVndWxhciBleHByZXNzaW9uKS5cbi8vXG4vLyBgaXNMb29wYCBtYXJrcyBhIGtleXdvcmQgYXMgc3RhcnRpbmcgYSBsb29wLCB3aGljaCBpcyBpbXBvcnRhbnRcbi8vIHRvIGtub3cgd2hlbiBwYXJzaW5nIGEgbGFiZWwsIGluIG9yZGVyIHRvIGFsbG93IG9yIGRpc2FsbG93XG4vLyBjb250aW51ZSBqdW1wcyB0byB0aGF0IGxhYmVsLlxuXCJ1c2Ugc3RyaWN0XCI7ZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtmdW5jdGlvbiBfY2xhc3NDYWxsQ2hlY2soaW5zdGFuY2UsQ29uc3RydWN0b3Ipe2lmKCEoaW5zdGFuY2UgaW5zdGFuY2VvZiBDb25zdHJ1Y3Rvcikpe3Rocm93IG5ldyBUeXBlRXJyb3IoXCJDYW5ub3QgY2FsbCBhIGNsYXNzIGFzIGEgZnVuY3Rpb25cIik7fX12YXIgVG9rZW5UeXBlPWZ1bmN0aW9uIFRva2VuVHlwZShsYWJlbCl7dmFyIGNvbmY9YXJndW1lbnRzLmxlbmd0aCA8PSAxIHx8IGFyZ3VtZW50c1sxXSA9PT0gdW5kZWZpbmVkP3t9OmFyZ3VtZW50c1sxXTtfY2xhc3NDYWxsQ2hlY2sodGhpcyxUb2tlblR5cGUpO3RoaXMubGFiZWwgPSBsYWJlbDt0aGlzLmtleXdvcmQgPSBjb25mLmtleXdvcmQ7dGhpcy5iZWZvcmVFeHByID0gISFjb25mLmJlZm9yZUV4cHI7dGhpcy5zdGFydHNFeHByID0gISFjb25mLnN0YXJ0c0V4cHI7dGhpcy5pc0xvb3AgPSAhIWNvbmYuaXNMb29wO3RoaXMuaXNBc3NpZ24gPSAhIWNvbmYuaXNBc3NpZ247dGhpcy5wcmVmaXggPSAhIWNvbmYucHJlZml4O3RoaXMucG9zdGZpeCA9ICEhY29uZi5wb3N0Zml4O3RoaXMuYmlub3AgPSBjb25mLmJpbm9wIHx8IG51bGw7dGhpcy51cGRhdGVDb250ZXh0ID0gbnVsbDt9O2V4cG9ydHMuVG9rZW5UeXBlID0gVG9rZW5UeXBlO2Z1bmN0aW9uIGJpbm9wKG5hbWUscHJlYyl7cmV0dXJuIG5ldyBUb2tlblR5cGUobmFtZSx7YmVmb3JlRXhwcjp0cnVlLGJpbm9wOnByZWN9KTt9dmFyIGJlZm9yZUV4cHI9e2JlZm9yZUV4cHI6dHJ1ZX0sc3RhcnRzRXhwcj17c3RhcnRzRXhwcjp0cnVlfTt2YXIgdHlwZXM9e251bTpuZXcgVG9rZW5UeXBlKFwibnVtXCIsc3RhcnRzRXhwcikscmVnZXhwOm5ldyBUb2tlblR5cGUoXCJyZWdleHBcIixzdGFydHNFeHByKSxzdHJpbmc6bmV3IFRva2VuVHlwZShcInN0cmluZ1wiLHN0YXJ0c0V4cHIpLG5hbWU6bmV3IFRva2VuVHlwZShcIm5hbWVcIixzdGFydHNFeHByKSxlb2Y6bmV3IFRva2VuVHlwZShcImVvZlwiKSwgLy8gUHVuY3R1YXRpb24gdG9rZW4gdHlwZXMuXG5icmFja2V0TDpuZXcgVG9rZW5UeXBlKFwiW1wiLHtiZWZvcmVFeHByOnRydWUsc3RhcnRzRXhwcjp0cnVlfSksYnJhY2tldFI6bmV3IFRva2VuVHlwZShcIl1cIiksYnJhY2VMOm5ldyBUb2tlblR5cGUoXCJ7XCIse2JlZm9yZUV4cHI6dHJ1ZSxzdGFydHNFeHByOnRydWV9KSxicmFjZVI6bmV3IFRva2VuVHlwZShcIn1cIikscGFyZW5MOm5ldyBUb2tlblR5cGUoXCIoXCIse2JlZm9yZUV4cHI6dHJ1ZSxzdGFydHNFeHByOnRydWV9KSxwYXJlblI6bmV3IFRva2VuVHlwZShcIilcIiksY29tbWE6bmV3IFRva2VuVHlwZShcIixcIixiZWZvcmVFeHByKSxzZW1pOm5ldyBUb2tlblR5cGUoXCI7XCIsYmVmb3JlRXhwciksY29sb246bmV3IFRva2VuVHlwZShcIjpcIixiZWZvcmVFeHByKSxkb3Q6bmV3IFRva2VuVHlwZShcIi5cIikscXVlc3Rpb246bmV3IFRva2VuVHlwZShcIj9cIixiZWZvcmVFeHByKSxhcnJvdzpuZXcgVG9rZW5UeXBlKFwiPT5cIixiZWZvcmVFeHByKSx0ZW1wbGF0ZTpuZXcgVG9rZW5UeXBlKFwidGVtcGxhdGVcIiksZWxsaXBzaXM6bmV3IFRva2VuVHlwZShcIi4uLlwiLGJlZm9yZUV4cHIpLGJhY2tRdW90ZTpuZXcgVG9rZW5UeXBlKFwiYFwiLHN0YXJ0c0V4cHIpLGRvbGxhckJyYWNlTDpuZXcgVG9rZW5UeXBlKFwiJHtcIix7YmVmb3JlRXhwcjp0cnVlLHN0YXJ0c0V4cHI6dHJ1ZX0pLCAvLyBPcGVyYXRvcnMuIFRoZXNlIGNhcnJ5IHNldmVyYWwga2luZHMgb2YgcHJvcGVydGllcyB0byBoZWxwIHRoZVxuLy8gcGFyc2VyIHVzZSB0aGVtIHByb3Blcmx5ICh0aGUgcHJlc2VuY2Ugb2YgdGhlc2UgcHJvcGVydGllcyBpc1xuLy8gd2hhdCBjYXRlZ29yaXplcyB0aGVtIGFzIG9wZXJhdG9ycykuXG4vL1xuLy8gYGJpbm9wYCwgd2hlbiBwcmVzZW50LCBzcGVjaWZpZXMgdGhhdCB0aGlzIG9wZXJhdG9yIGlzIGEgYmluYXJ5XG4vLyBvcGVyYXRvciwgYW5kIHdpbGwgcmVmZXIgdG8gaXRzIHByZWNlZGVuY2UuXG4vL1xuLy8gYHByZWZpeGAgYW5kIGBwb3N0Zml4YCBtYXJrIHRoZSBvcGVyYXRvciBhcyBhIHByZWZpeCBvciBwb3N0Zml4XG4vLyB1bmFyeSBvcGVyYXRvci5cbi8vXG4vLyBgaXNBc3NpZ25gIG1hcmtzIGFsbCBvZiBgPWAsIGArPWAsIGAtPWAgZXRjZXRlcmEsIHdoaWNoIGFjdCBhc1xuLy8gYmluYXJ5IG9wZXJhdG9ycyB3aXRoIGEgdmVyeSBsb3cgcHJlY2VkZW5jZSwgdGhhdCBzaG91bGQgcmVzdWx0XG4vLyBpbiBBc3NpZ25tZW50RXhwcmVzc2lvbiBub2Rlcy5cbmVxOm5ldyBUb2tlblR5cGUoXCI9XCIse2JlZm9yZUV4cHI6dHJ1ZSxpc0Fzc2lnbjp0cnVlfSksYXNzaWduOm5ldyBUb2tlblR5cGUoXCJfPVwiLHtiZWZvcmVFeHByOnRydWUsaXNBc3NpZ246dHJ1ZX0pLGluY0RlYzpuZXcgVG9rZW5UeXBlKFwiKysvLS1cIix7cHJlZml4OnRydWUscG9zdGZpeDp0cnVlLHN0YXJ0c0V4cHI6dHJ1ZX0pLHByZWZpeDpuZXcgVG9rZW5UeXBlKFwicHJlZml4XCIse2JlZm9yZUV4cHI6dHJ1ZSxwcmVmaXg6dHJ1ZSxzdGFydHNFeHByOnRydWV9KSxsb2dpY2FsT1I6Ymlub3AoXCJ8fFwiLDEpLGxvZ2ljYWxBTkQ6Ymlub3AoXCImJlwiLDIpLGJpdHdpc2VPUjpiaW5vcChcInxcIiwzKSxiaXR3aXNlWE9SOmJpbm9wKFwiXlwiLDQpLGJpdHdpc2VBTkQ6Ymlub3AoXCImXCIsNSksZXF1YWxpdHk6Ymlub3AoXCI9PS8hPVwiLDYpLHJlbGF0aW9uYWw6Ymlub3AoXCI8Lz5cIiw3KSxiaXRTaGlmdDpiaW5vcChcIjw8Lz4+XCIsOCkscGx1c01pbjpuZXcgVG9rZW5UeXBlKFwiKy8tXCIse2JlZm9yZUV4cHI6dHJ1ZSxiaW5vcDo5LHByZWZpeDp0cnVlLHN0YXJ0c0V4cHI6dHJ1ZX0pLG1vZHVsbzpiaW5vcChcIiVcIiwxMCksc3RhcjpiaW5vcChcIipcIiwxMCksc2xhc2g6Ymlub3AoXCIvXCIsMTApfTtleHBvcnRzLnR5cGVzID0gdHlwZXM7IC8vIE1hcCBrZXl3b3JkIG5hbWVzIHRvIHRva2VuIHR5cGVzLlxudmFyIGtleXdvcmRzPXt9O2V4cG9ydHMua2V5d29yZHMgPSBrZXl3b3JkczsgLy8gU3VjY2luY3QgZGVmaW5pdGlvbnMgb2Yga2V5d29yZCB0b2tlbiB0eXBlc1xuZnVuY3Rpb24ga3cobmFtZSl7dmFyIG9wdGlvbnM9YXJndW1lbnRzLmxlbmd0aCA8PSAxIHx8IGFyZ3VtZW50c1sxXSA9PT0gdW5kZWZpbmVkP3t9OmFyZ3VtZW50c1sxXTtvcHRpb25zLmtleXdvcmQgPSBuYW1lO2tleXdvcmRzW25hbWVdID0gdHlwZXNbXCJfXCIgKyBuYW1lXSA9IG5ldyBUb2tlblR5cGUobmFtZSxvcHRpb25zKTt9a3coXCJicmVha1wiKTtrdyhcImNhc2VcIixiZWZvcmVFeHByKTtrdyhcImNhdGNoXCIpO2t3KFwiY29udGludWVcIik7a3coXCJkZWJ1Z2dlclwiKTtrdyhcImRlZmF1bHRcIixiZWZvcmVFeHByKTtrdyhcImRvXCIse2lzTG9vcDp0cnVlfSk7a3coXCJlbHNlXCIsYmVmb3JlRXhwcik7a3coXCJmaW5hbGx5XCIpO2t3KFwiZm9yXCIse2lzTG9vcDp0cnVlfSk7a3coXCJmdW5jdGlvblwiLHN0YXJ0c0V4cHIpO2t3KFwiaWZcIik7a3coXCJyZXR1cm5cIixiZWZvcmVFeHByKTtrdyhcInN3aXRjaFwiKTtrdyhcInRocm93XCIsYmVmb3JlRXhwcik7a3coXCJ0cnlcIik7a3coXCJ2YXJcIik7a3coXCJsZXRcIik7a3coXCJjb25zdFwiKTtrdyhcIndoaWxlXCIse2lzTG9vcDp0cnVlfSk7a3coXCJ3aXRoXCIpO2t3KFwibmV3XCIse2JlZm9yZUV4cHI6dHJ1ZSxzdGFydHNFeHByOnRydWV9KTtrdyhcInRoaXNcIixzdGFydHNFeHByKTtrdyhcInN1cGVyXCIsc3RhcnRzRXhwcik7a3coXCJjbGFzc1wiKTtrdyhcImV4dGVuZHNcIixiZWZvcmVFeHByKTtrdyhcImV4cG9ydFwiKTtrdyhcImltcG9ydFwiKTtrdyhcInlpZWxkXCIse2JlZm9yZUV4cHI6dHJ1ZSxzdGFydHNFeHByOnRydWV9KTtrdyhcIm51bGxcIixzdGFydHNFeHByKTtrdyhcInRydWVcIixzdGFydHNFeHByKTtrdyhcImZhbHNlXCIsc3RhcnRzRXhwcik7a3coXCJpblwiLHtiZWZvcmVFeHByOnRydWUsYmlub3A6N30pO2t3KFwiaW5zdGFuY2VvZlwiLHtiZWZvcmVFeHByOnRydWUsYmlub3A6N30pO2t3KFwidHlwZW9mXCIse2JlZm9yZUV4cHI6dHJ1ZSxwcmVmaXg6dHJ1ZSxzdGFydHNFeHByOnRydWV9KTtrdyhcInZvaWRcIix7YmVmb3JlRXhwcjp0cnVlLHByZWZpeDp0cnVlLHN0YXJ0c0V4cHI6dHJ1ZX0pO2t3KFwiZGVsZXRlXCIse2JlZm9yZUV4cHI6dHJ1ZSxwcmVmaXg6dHJ1ZSxzdGFydHNFeHByOnRydWV9KTt9LHt9XSwxNTpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7XCJ1c2Ugc3RyaWN0XCI7ZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtleHBvcnRzLmlzQXJyYXkgPSBpc0FycmF5O2V4cG9ydHMuaGFzID0gaGFzO2Z1bmN0aW9uIGlzQXJyYXkob2JqKXtyZXR1cm4gT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKG9iaikgPT09IFwiW29iamVjdCBBcnJheV1cIjt9IC8vIENoZWNrcyBpZiBhbiBvYmplY3QgaGFzIGEgcHJvcGVydHkuXG5mdW5jdGlvbiBoYXMob2JqLHByb3BOYW1lKXtyZXR1cm4gT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKG9iaixwcm9wTmFtZSk7fX0se31dLDE2OltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXsgLy8gTWF0Y2hlcyBhIHdob2xlIGxpbmUgYnJlYWsgKHdoZXJlIENSTEYgaXMgY29uc2lkZXJlZCBhIHNpbmdsZVxuLy8gbGluZSBicmVhaykuIFVzZWQgdG8gY291bnQgbGluZXMuXG5cInVzZSBzdHJpY3RcIjtleHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO2V4cG9ydHMuaXNOZXdMaW5lID0gaXNOZXdMaW5lO3ZhciBsaW5lQnJlYWs9L1xcclxcbj98XFxufFxcdTIwMjh8XFx1MjAyOS87ZXhwb3J0cy5saW5lQnJlYWsgPSBsaW5lQnJlYWs7dmFyIGxpbmVCcmVha0c9bmV3IFJlZ0V4cChsaW5lQnJlYWsuc291cmNlLFwiZ1wiKTtleHBvcnRzLmxpbmVCcmVha0cgPSBsaW5lQnJlYWtHO2Z1bmN0aW9uIGlzTmV3TGluZShjb2RlKXtyZXR1cm4gY29kZSA9PT0gMTAgfHwgY29kZSA9PT0gMTMgfHwgY29kZSA9PT0gMHgyMDI4IHx8IGNvZGUgPT0gMHgyMDI5O312YXIgbm9uQVNDSUl3aGl0ZXNwYWNlPS9bXFx1MTY4MFxcdTE4MGVcXHUyMDAwLVxcdTIwMGFcXHUyMDJmXFx1MjA1ZlxcdTMwMDBcXHVmZWZmXS87ZXhwb3J0cy5ub25BU0NJSXdoaXRlc3BhY2UgPSBub25BU0NJSXdoaXRlc3BhY2U7fSx7fV19LHt9LFszXSkoMyk7fSk7XG5cbn0pLmNhbGwodGhpcyx0eXBlb2YgZ2xvYmFsICE9PSBcInVuZGVmaW5lZFwiID8gZ2xvYmFsIDogdHlwZW9mIHNlbGYgIT09IFwidW5kZWZpbmVkXCIgPyBzZWxmIDogdHlwZW9mIHdpbmRvdyAhPT0gXCJ1bmRlZmluZWRcIiA/IHdpbmRvdyA6IHt9KVxufSx7fV0sMjpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7XG5cInVzZSBzdHJpY3RcIjtcblxubW9kdWxlLmV4cG9ydHMgPSB0eXBlb2YgYWNvcm4gIT0gJ3VuZGVmaW5lZCcgPyBhY29ybiA6IF9kZXJlcV8oXCJhY29yblwiKTtcblxufSx7XCJhY29yblwiOjF9XSwzOltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXtcblwidXNlIHN0cmljdFwiO1xuXG52YXIgX3N0YXRlID0gX2RlcmVxXyhcIi4vc3RhdGVcIik7XG5cbnZhciBfcGFyc2V1dGlsID0gX2RlcmVxXyhcIi4vcGFyc2V1dGlsXCIpO1xuXG52YXIgXyA9IF9kZXJlcV8oXCIuLlwiKTtcblxudmFyIGxwID0gX3N0YXRlLkxvb3NlUGFyc2VyLnByb3RvdHlwZTtcblxubHAuY2hlY2tMVmFsID0gZnVuY3Rpb24gKGV4cHIsIGJpbmRpbmcpIHtcbiAgaWYgKCFleHByKSByZXR1cm4gZXhwcjtcbiAgc3dpdGNoIChleHByLnR5cGUpIHtcbiAgICBjYXNlIFwiSWRlbnRpZmllclwiOlxuICAgICAgcmV0dXJuIGV4cHI7XG5cbiAgICBjYXNlIFwiTWVtYmVyRXhwcmVzc2lvblwiOlxuICAgICAgcmV0dXJuIGJpbmRpbmcgPyB0aGlzLmR1bW15SWRlbnQoKSA6IGV4cHI7XG5cbiAgICBjYXNlIFwiUGFyZW50aGVzaXplZEV4cHJlc3Npb25cIjpcbiAgICAgIGV4cHIuZXhwcmVzc2lvbiA9IHRoaXMuY2hlY2tMVmFsKGV4cHIuZXhwcmVzc2lvbiwgYmluZGluZyk7XG4gICAgICByZXR1cm4gZXhwcjtcblxuICAgIC8vIEZJWE1FIHJlY3Vyc2l2ZWx5IGNoZWNrIGNvbnRlbnRzXG4gICAgY2FzZSBcIk9iamVjdFBhdHRlcm5cIjpcbiAgICBjYXNlIFwiQXJyYXlQYXR0ZXJuXCI6XG4gICAgY2FzZSBcIlJlc3RFbGVtZW50XCI6XG4gICAgY2FzZSBcIkFzc2lnbm1lbnRQYXR0ZXJuXCI6XG4gICAgICBpZiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpIHJldHVybiBleHByO1xuXG4gICAgZGVmYXVsdDpcbiAgICAgIHJldHVybiB0aGlzLmR1bW15SWRlbnQoKTtcbiAgfVxufTtcblxubHAucGFyc2VFeHByZXNzaW9uID0gZnVuY3Rpb24gKG5vSW4pIHtcbiAgdmFyIHN0YXJ0ID0gdGhpcy5zdG9yZUN1cnJlbnRQb3MoKTtcbiAgdmFyIGV4cHIgPSB0aGlzLnBhcnNlTWF5YmVBc3NpZ24obm9Jbik7XG4gIGlmICh0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLmNvbW1hKSB7XG4gICAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZUF0KHN0YXJ0KTtcbiAgICBub2RlLmV4cHJlc3Npb25zID0gW2V4cHJdO1xuICAgIHdoaWxlICh0aGlzLmVhdChfLnRva1R5cGVzLmNvbW1hKSkgbm9kZS5leHByZXNzaW9ucy5wdXNoKHRoaXMucGFyc2VNYXliZUFzc2lnbihub0luKSk7XG4gICAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIlNlcXVlbmNlRXhwcmVzc2lvblwiKTtcbiAgfVxuICByZXR1cm4gZXhwcjtcbn07XG5cbmxwLnBhcnNlUGFyZW5FeHByZXNzaW9uID0gZnVuY3Rpb24gKCkge1xuICB0aGlzLnB1c2hDeCgpO1xuICB0aGlzLmV4cGVjdChfLnRva1R5cGVzLnBhcmVuTCk7XG4gIHZhciB2YWwgPSB0aGlzLnBhcnNlRXhwcmVzc2lvbigpO1xuICB0aGlzLnBvcEN4KCk7XG4gIHRoaXMuZXhwZWN0KF8udG9rVHlwZXMucGFyZW5SKTtcbiAgcmV0dXJuIHZhbDtcbn07XG5cbmxwLnBhcnNlTWF5YmVBc3NpZ24gPSBmdW5jdGlvbiAobm9Jbikge1xuICB2YXIgc3RhcnQgPSB0aGlzLnN0b3JlQ3VycmVudFBvcygpO1xuICB2YXIgbGVmdCA9IHRoaXMucGFyc2VNYXliZUNvbmRpdGlvbmFsKG5vSW4pO1xuICBpZiAodGhpcy50b2sudHlwZS5pc0Fzc2lnbikge1xuICAgIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGVBdChzdGFydCk7XG4gICAgbm9kZS5vcGVyYXRvciA9IHRoaXMudG9rLnZhbHVlO1xuICAgIG5vZGUubGVmdCA9IHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMuZXEgPyB0aGlzLnRvQXNzaWduYWJsZShsZWZ0KSA6IHRoaXMuY2hlY2tMVmFsKGxlZnQpO1xuICAgIHRoaXMubmV4dCgpO1xuICAgIG5vZGUucmlnaHQgPSB0aGlzLnBhcnNlTWF5YmVBc3NpZ24obm9Jbik7XG4gICAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkFzc2lnbm1lbnRFeHByZXNzaW9uXCIpO1xuICB9XG4gIHJldHVybiBsZWZ0O1xufTtcblxubHAucGFyc2VNYXliZUNvbmRpdGlvbmFsID0gZnVuY3Rpb24gKG5vSW4pIHtcbiAgdmFyIHN0YXJ0ID0gdGhpcy5zdG9yZUN1cnJlbnRQb3MoKTtcbiAgdmFyIGV4cHIgPSB0aGlzLnBhcnNlRXhwck9wcyhub0luKTtcbiAgaWYgKHRoaXMuZWF0KF8udG9rVHlwZXMucXVlc3Rpb24pKSB7XG4gICAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZUF0KHN0YXJ0KTtcbiAgICBub2RlLnRlc3QgPSBleHByO1xuICAgIG5vZGUuY29uc2VxdWVudCA9IHRoaXMucGFyc2VNYXliZUFzc2lnbigpO1xuICAgIG5vZGUuYWx0ZXJuYXRlID0gdGhpcy5leHBlY3QoXy50b2tUeXBlcy5jb2xvbikgPyB0aGlzLnBhcnNlTWF5YmVBc3NpZ24obm9JbikgOiB0aGlzLmR1bW15SWRlbnQoKTtcbiAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiQ29uZGl0aW9uYWxFeHByZXNzaW9uXCIpO1xuICB9XG4gIHJldHVybiBleHByO1xufTtcblxubHAucGFyc2VFeHByT3BzID0gZnVuY3Rpb24gKG5vSW4pIHtcbiAgdmFyIHN0YXJ0ID0gdGhpcy5zdG9yZUN1cnJlbnRQb3MoKTtcbiAgdmFyIGluZGVudCA9IHRoaXMuY3VySW5kZW50LFxuICAgICAgbGluZSA9IHRoaXMuY3VyTGluZVN0YXJ0O1xuICByZXR1cm4gdGhpcy5wYXJzZUV4cHJPcCh0aGlzLnBhcnNlTWF5YmVVbmFyeShub0luKSwgc3RhcnQsIC0xLCBub0luLCBpbmRlbnQsIGxpbmUpO1xufTtcblxubHAucGFyc2VFeHByT3AgPSBmdW5jdGlvbiAobGVmdCwgc3RhcnQsIG1pblByZWMsIG5vSW4sIGluZGVudCwgbGluZSkge1xuICBpZiAodGhpcy5jdXJMaW5lU3RhcnQgIT0gbGluZSAmJiB0aGlzLmN1ckluZGVudCA8IGluZGVudCAmJiB0aGlzLnRva2VuU3RhcnRzTGluZSgpKSByZXR1cm4gbGVmdDtcbiAgdmFyIHByZWMgPSB0aGlzLnRvay50eXBlLmJpbm9wO1xuICBpZiAocHJlYyAhPSBudWxsICYmICghbm9JbiB8fCB0aGlzLnRvay50eXBlICE9PSBfLnRva1R5cGVzLl9pbikpIHtcbiAgICBpZiAocHJlYyA+IG1pblByZWMpIHtcbiAgICAgIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGVBdChzdGFydCk7XG4gICAgICBub2RlLmxlZnQgPSBsZWZ0O1xuICAgICAgbm9kZS5vcGVyYXRvciA9IHRoaXMudG9rLnZhbHVlO1xuICAgICAgdGhpcy5uZXh0KCk7XG4gICAgICBpZiAodGhpcy5jdXJMaW5lU3RhcnQgIT0gbGluZSAmJiB0aGlzLmN1ckluZGVudCA8IGluZGVudCAmJiB0aGlzLnRva2VuU3RhcnRzTGluZSgpKSB7XG4gICAgICAgIG5vZGUucmlnaHQgPSB0aGlzLmR1bW15SWRlbnQoKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHZhciByaWdodFN0YXJ0ID0gdGhpcy5zdG9yZUN1cnJlbnRQb3MoKTtcbiAgICAgICAgbm9kZS5yaWdodCA9IHRoaXMucGFyc2VFeHByT3AodGhpcy5wYXJzZU1heWJlVW5hcnkobm9JbiksIHJpZ2h0U3RhcnQsIHByZWMsIG5vSW4sIGluZGVudCwgbGluZSk7XG4gICAgICB9XG4gICAgICB0aGlzLmZpbmlzaE5vZGUobm9kZSwgLyYmfFxcfFxcfC8udGVzdChub2RlLm9wZXJhdG9yKSA/IFwiTG9naWNhbEV4cHJlc3Npb25cIiA6IFwiQmluYXJ5RXhwcmVzc2lvblwiKTtcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlRXhwck9wKG5vZGUsIHN0YXJ0LCBtaW5QcmVjLCBub0luLCBpbmRlbnQsIGxpbmUpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gbGVmdDtcbn07XG5cbmxwLnBhcnNlTWF5YmVVbmFyeSA9IGZ1bmN0aW9uIChub0luKSB7XG4gIGlmICh0aGlzLnRvay50eXBlLnByZWZpeCkge1xuICAgIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGUoKSxcbiAgICAgICAgdXBkYXRlID0gdGhpcy50b2sudHlwZSA9PT0gXy50b2tUeXBlcy5pbmNEZWM7XG4gICAgbm9kZS5vcGVyYXRvciA9IHRoaXMudG9rLnZhbHVlO1xuICAgIG5vZGUucHJlZml4ID0gdHJ1ZTtcbiAgICB0aGlzLm5leHQoKTtcbiAgICBub2RlLmFyZ3VtZW50ID0gdGhpcy5wYXJzZU1heWJlVW5hcnkobm9Jbik7XG4gICAgaWYgKHVwZGF0ZSkgbm9kZS5hcmd1bWVudCA9IHRoaXMuY2hlY2tMVmFsKG5vZGUuYXJndW1lbnQpO1xuICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgdXBkYXRlID8gXCJVcGRhdGVFeHByZXNzaW9uXCIgOiBcIlVuYXJ5RXhwcmVzc2lvblwiKTtcbiAgfSBlbHNlIGlmICh0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLmVsbGlwc2lzKSB7XG4gICAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICAgIHRoaXMubmV4dCgpO1xuICAgIG5vZGUuYXJndW1lbnQgPSB0aGlzLnBhcnNlTWF5YmVVbmFyeShub0luKTtcbiAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiU3ByZWFkRWxlbWVudFwiKTtcbiAgfVxuICB2YXIgc3RhcnQgPSB0aGlzLnN0b3JlQ3VycmVudFBvcygpO1xuICB2YXIgZXhwciA9IHRoaXMucGFyc2VFeHByU3Vic2NyaXB0cygpO1xuICB3aGlsZSAodGhpcy50b2sudHlwZS5wb3N0Zml4ICYmICF0aGlzLmNhbkluc2VydFNlbWljb2xvbigpKSB7XG4gICAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZUF0KHN0YXJ0KTtcbiAgICBub2RlLm9wZXJhdG9yID0gdGhpcy50b2sudmFsdWU7XG4gICAgbm9kZS5wcmVmaXggPSBmYWxzZTtcbiAgICBub2RlLmFyZ3VtZW50ID0gdGhpcy5jaGVja0xWYWwoZXhwcik7XG4gICAgdGhpcy5uZXh0KCk7XG4gICAgZXhwciA9IHRoaXMuZmluaXNoTm9kZShub2RlLCBcIlVwZGF0ZUV4cHJlc3Npb25cIik7XG4gIH1cbiAgcmV0dXJuIGV4cHI7XG59O1xuXG5scC5wYXJzZUV4cHJTdWJzY3JpcHRzID0gZnVuY3Rpb24gKCkge1xuICB2YXIgc3RhcnQgPSB0aGlzLnN0b3JlQ3VycmVudFBvcygpO1xuICByZXR1cm4gdGhpcy5wYXJzZVN1YnNjcmlwdHModGhpcy5wYXJzZUV4cHJBdG9tKCksIHN0YXJ0LCBmYWxzZSwgdGhpcy5jdXJJbmRlbnQsIHRoaXMuY3VyTGluZVN0YXJ0KTtcbn07XG5cbmxwLnBhcnNlU3Vic2NyaXB0cyA9IGZ1bmN0aW9uIChiYXNlLCBzdGFydCwgbm9DYWxscywgc3RhcnRJbmRlbnQsIGxpbmUpIHtcbiAgZm9yICg7Oykge1xuICAgIGlmICh0aGlzLmN1ckxpbmVTdGFydCAhPSBsaW5lICYmIHRoaXMuY3VySW5kZW50IDw9IHN0YXJ0SW5kZW50ICYmIHRoaXMudG9rZW5TdGFydHNMaW5lKCkpIHtcbiAgICAgIGlmICh0aGlzLnRvay50eXBlID09IF8udG9rVHlwZXMuZG90ICYmIHRoaXMuY3VySW5kZW50ID09IHN0YXJ0SW5kZW50KSAtLXN0YXJ0SW5kZW50O2Vsc2UgcmV0dXJuIGJhc2U7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuZWF0KF8udG9rVHlwZXMuZG90KSkge1xuICAgICAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZUF0KHN0YXJ0KTtcbiAgICAgIG5vZGUub2JqZWN0ID0gYmFzZTtcbiAgICAgIGlmICh0aGlzLmN1ckxpbmVTdGFydCAhPSBsaW5lICYmIHRoaXMuY3VySW5kZW50IDw9IHN0YXJ0SW5kZW50ICYmIHRoaXMudG9rZW5TdGFydHNMaW5lKCkpIG5vZGUucHJvcGVydHkgPSB0aGlzLmR1bW15SWRlbnQoKTtlbHNlIG5vZGUucHJvcGVydHkgPSB0aGlzLnBhcnNlUHJvcGVydHlBY2Nlc3NvcigpIHx8IHRoaXMuZHVtbXlJZGVudCgpO1xuICAgICAgbm9kZS5jb21wdXRlZCA9IGZhbHNlO1xuICAgICAgYmFzZSA9IHRoaXMuZmluaXNoTm9kZShub2RlLCBcIk1lbWJlckV4cHJlc3Npb25cIik7XG4gICAgfSBlbHNlIGlmICh0aGlzLnRvay50eXBlID09IF8udG9rVHlwZXMuYnJhY2tldEwpIHtcbiAgICAgIHRoaXMucHVzaEN4KCk7XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGVBdChzdGFydCk7XG4gICAgICBub2RlLm9iamVjdCA9IGJhc2U7XG4gICAgICBub2RlLnByb3BlcnR5ID0gdGhpcy5wYXJzZUV4cHJlc3Npb24oKTtcbiAgICAgIG5vZGUuY29tcHV0ZWQgPSB0cnVlO1xuICAgICAgdGhpcy5wb3BDeCgpO1xuICAgICAgdGhpcy5leHBlY3QoXy50b2tUeXBlcy5icmFja2V0Uik7XG4gICAgICBiYXNlID0gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiTWVtYmVyRXhwcmVzc2lvblwiKTtcbiAgICB9IGVsc2UgaWYgKCFub0NhbGxzICYmIHRoaXMudG9rLnR5cGUgPT0gXy50b2tUeXBlcy5wYXJlbkwpIHtcbiAgICAgIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGVBdChzdGFydCk7XG4gICAgICBub2RlLmNhbGxlZSA9IGJhc2U7XG4gICAgICBub2RlLmFyZ3VtZW50cyA9IHRoaXMucGFyc2VFeHByTGlzdChfLnRva1R5cGVzLnBhcmVuUik7XG4gICAgICBiYXNlID0gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiQ2FsbEV4cHJlc3Npb25cIik7XG4gICAgfSBlbHNlIGlmICh0aGlzLnRvay50eXBlID09IF8udG9rVHlwZXMuYmFja1F1b3RlKSB7XG4gICAgICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlQXQoc3RhcnQpO1xuICAgICAgbm9kZS50YWcgPSBiYXNlO1xuICAgICAgbm9kZS5xdWFzaSA9IHRoaXMucGFyc2VUZW1wbGF0ZSgpO1xuICAgICAgYmFzZSA9IHRoaXMuZmluaXNoTm9kZShub2RlLCBcIlRhZ2dlZFRlbXBsYXRlRXhwcmVzc2lvblwiKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIGJhc2U7XG4gICAgfVxuICB9XG59O1xuXG5scC5wYXJzZUV4cHJBdG9tID0gZnVuY3Rpb24gKCkge1xuICB2YXIgbm9kZSA9IHVuZGVmaW5lZDtcbiAgc3dpdGNoICh0aGlzLnRvay50eXBlKSB7XG4gICAgY2FzZSBfLnRva1R5cGVzLl90aGlzOlxuICAgIGNhc2UgXy50b2tUeXBlcy5fc3VwZXI6XG4gICAgICB2YXIgdHlwZSA9IHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMuX3RoaXMgPyBcIlRoaXNFeHByZXNzaW9uXCIgOiBcIlN1cGVyXCI7XG4gICAgICBub2RlID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgICAgIHRoaXMubmV4dCgpO1xuICAgICAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCB0eXBlKTtcblxuICAgIGNhc2UgXy50b2tUeXBlcy5uYW1lOlxuICAgICAgdmFyIHN0YXJ0ID0gdGhpcy5zdG9yZUN1cnJlbnRQb3MoKTtcbiAgICAgIHZhciBpZCA9IHRoaXMucGFyc2VJZGVudCgpO1xuICAgICAgcmV0dXJuIHRoaXMuZWF0KF8udG9rVHlwZXMuYXJyb3cpID8gdGhpcy5wYXJzZUFycm93RXhwcmVzc2lvbih0aGlzLnN0YXJ0Tm9kZUF0KHN0YXJ0KSwgW2lkXSkgOiBpZDtcblxuICAgIGNhc2UgXy50b2tUeXBlcy5yZWdleHA6XG4gICAgICBub2RlID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgICAgIHZhciB2YWwgPSB0aGlzLnRvay52YWx1ZTtcbiAgICAgIG5vZGUucmVnZXggPSB7IHBhdHRlcm46IHZhbC5wYXR0ZXJuLCBmbGFnczogdmFsLmZsYWdzIH07XG4gICAgICBub2RlLnZhbHVlID0gdmFsLnZhbHVlO1xuICAgICAgbm9kZS5yYXcgPSB0aGlzLmlucHV0LnNsaWNlKHRoaXMudG9rLnN0YXJ0LCB0aGlzLnRvay5lbmQpO1xuICAgICAgdGhpcy5uZXh0KCk7XG4gICAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiTGl0ZXJhbFwiKTtcblxuICAgIGNhc2UgXy50b2tUeXBlcy5udW06Y2FzZSBfLnRva1R5cGVzLnN0cmluZzpcbiAgICAgIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICAgICAgbm9kZS52YWx1ZSA9IHRoaXMudG9rLnZhbHVlO1xuICAgICAgbm9kZS5yYXcgPSB0aGlzLmlucHV0LnNsaWNlKHRoaXMudG9rLnN0YXJ0LCB0aGlzLnRvay5lbmQpO1xuICAgICAgdGhpcy5uZXh0KCk7XG4gICAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiTGl0ZXJhbFwiKTtcblxuICAgIGNhc2UgXy50b2tUeXBlcy5fbnVsbDpjYXNlIF8udG9rVHlwZXMuX3RydWU6Y2FzZSBfLnRva1R5cGVzLl9mYWxzZTpcbiAgICAgIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICAgICAgbm9kZS52YWx1ZSA9IHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMuX251bGwgPyBudWxsIDogdGhpcy50b2sudHlwZSA9PT0gXy50b2tUeXBlcy5fdHJ1ZTtcbiAgICAgIG5vZGUucmF3ID0gdGhpcy50b2sudHlwZS5rZXl3b3JkO1xuICAgICAgdGhpcy5uZXh0KCk7XG4gICAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiTGl0ZXJhbFwiKTtcblxuICAgIGNhc2UgXy50b2tUeXBlcy5wYXJlbkw6XG4gICAgICB2YXIgcGFyZW5TdGFydCA9IHRoaXMuc3RvcmVDdXJyZW50UG9zKCk7XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIHZhciBpbm5lciA9IHRoaXMucGFyc2VFeHByZXNzaW9uKCk7XG4gICAgICB0aGlzLmV4cGVjdChfLnRva1R5cGVzLnBhcmVuUik7XG4gICAgICBpZiAodGhpcy5lYXQoXy50b2tUeXBlcy5hcnJvdykpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMucGFyc2VBcnJvd0V4cHJlc3Npb24odGhpcy5zdGFydE5vZGVBdChwYXJlblN0YXJ0KSwgaW5uZXIuZXhwcmVzc2lvbnMgfHwgKF9wYXJzZXV0aWwuaXNEdW1teShpbm5lcikgPyBbXSA6IFtpbm5lcl0pKTtcbiAgICAgIH1cbiAgICAgIGlmICh0aGlzLm9wdGlvbnMucHJlc2VydmVQYXJlbnMpIHtcbiAgICAgICAgdmFyIHBhciA9IHRoaXMuc3RhcnROb2RlQXQocGFyZW5TdGFydCk7XG4gICAgICAgIHBhci5leHByZXNzaW9uID0gaW5uZXI7XG4gICAgICAgIGlubmVyID0gdGhpcy5maW5pc2hOb2RlKHBhciwgXCJQYXJlbnRoZXNpemVkRXhwcmVzc2lvblwiKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBpbm5lcjtcblxuICAgIGNhc2UgXy50b2tUeXBlcy5icmFja2V0TDpcbiAgICAgIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICAgICAgbm9kZS5lbGVtZW50cyA9IHRoaXMucGFyc2VFeHByTGlzdChfLnRva1R5cGVzLmJyYWNrZXRSLCB0cnVlKTtcbiAgICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJBcnJheUV4cHJlc3Npb25cIik7XG5cbiAgICBjYXNlIF8udG9rVHlwZXMuYnJhY2VMOlxuICAgICAgcmV0dXJuIHRoaXMucGFyc2VPYmooKTtcblxuICAgIGNhc2UgXy50b2tUeXBlcy5fY2xhc3M6XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZUNsYXNzKCk7XG5cbiAgICBjYXNlIF8udG9rVHlwZXMuX2Z1bmN0aW9uOlxuICAgICAgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlRnVuY3Rpb24obm9kZSwgZmFsc2UpO1xuXG4gICAgY2FzZSBfLnRva1R5cGVzLl9uZXc6XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZU5ldygpO1xuXG4gICAgY2FzZSBfLnRva1R5cGVzLl95aWVsZDpcbiAgICAgIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICAgICAgdGhpcy5uZXh0KCk7XG4gICAgICBpZiAodGhpcy5zZW1pY29sb24oKSB8fCB0aGlzLmNhbkluc2VydFNlbWljb2xvbigpIHx8IHRoaXMudG9rLnR5cGUgIT0gXy50b2tUeXBlcy5zdGFyICYmICF0aGlzLnRvay50eXBlLnN0YXJ0c0V4cHIpIHtcbiAgICAgICAgbm9kZS5kZWxlZ2F0ZSA9IGZhbHNlO1xuICAgICAgICBub2RlLmFyZ3VtZW50ID0gbnVsbDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG5vZGUuZGVsZWdhdGUgPSB0aGlzLmVhdChfLnRva1R5cGVzLnN0YXIpO1xuICAgICAgICBub2RlLmFyZ3VtZW50ID0gdGhpcy5wYXJzZU1heWJlQXNzaWduKCk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiWWllbGRFeHByZXNzaW9uXCIpO1xuXG4gICAgY2FzZSBfLnRva1R5cGVzLmJhY2tRdW90ZTpcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlVGVtcGxhdGUoKTtcblxuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4gdGhpcy5kdW1teUlkZW50KCk7XG4gIH1cbn07XG5cbmxwLnBhcnNlTmV3ID0gZnVuY3Rpb24gKCkge1xuICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCksXG4gICAgICBzdGFydEluZGVudCA9IHRoaXMuY3VySW5kZW50LFxuICAgICAgbGluZSA9IHRoaXMuY3VyTGluZVN0YXJ0O1xuICB2YXIgbWV0YSA9IHRoaXMucGFyc2VJZGVudCh0cnVlKTtcbiAgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2ICYmIHRoaXMuZWF0KF8udG9rVHlwZXMuZG90KSkge1xuICAgIG5vZGUubWV0YSA9IG1ldGE7XG4gICAgbm9kZS5wcm9wZXJ0eSA9IHRoaXMucGFyc2VJZGVudCh0cnVlKTtcbiAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiTWV0YVByb3BlcnR5XCIpO1xuICB9XG4gIHZhciBzdGFydCA9IHRoaXMuc3RvcmVDdXJyZW50UG9zKCk7XG4gIG5vZGUuY2FsbGVlID0gdGhpcy5wYXJzZVN1YnNjcmlwdHModGhpcy5wYXJzZUV4cHJBdG9tKCksIHN0YXJ0LCB0cnVlLCBzdGFydEluZGVudCwgbGluZSk7XG4gIGlmICh0aGlzLnRvay50eXBlID09IF8udG9rVHlwZXMucGFyZW5MKSB7XG4gICAgbm9kZS5hcmd1bWVudHMgPSB0aGlzLnBhcnNlRXhwckxpc3QoXy50b2tUeXBlcy5wYXJlblIpO1xuICB9IGVsc2Uge1xuICAgIG5vZGUuYXJndW1lbnRzID0gW107XG4gIH1cbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIk5ld0V4cHJlc3Npb25cIik7XG59O1xuXG5scC5wYXJzZVRlbXBsYXRlRWxlbWVudCA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIGVsZW0gPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICBlbGVtLnZhbHVlID0ge1xuICAgIHJhdzogdGhpcy5pbnB1dC5zbGljZSh0aGlzLnRvay5zdGFydCwgdGhpcy50b2suZW5kKS5yZXBsYWNlKC9cXHJcXG4/L2csICdcXG4nKSxcbiAgICBjb29rZWQ6IHRoaXMudG9rLnZhbHVlXG4gIH07XG4gIHRoaXMubmV4dCgpO1xuICBlbGVtLnRhaWwgPSB0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLmJhY2tRdW90ZTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShlbGVtLCBcIlRlbXBsYXRlRWxlbWVudFwiKTtcbn07XG5cbmxwLnBhcnNlVGVtcGxhdGUgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgdGhpcy5uZXh0KCk7XG4gIG5vZGUuZXhwcmVzc2lvbnMgPSBbXTtcbiAgdmFyIGN1ckVsdCA9IHRoaXMucGFyc2VUZW1wbGF0ZUVsZW1lbnQoKTtcbiAgbm9kZS5xdWFzaXMgPSBbY3VyRWx0XTtcbiAgd2hpbGUgKCFjdXJFbHQudGFpbCkge1xuICAgIHRoaXMubmV4dCgpO1xuICAgIG5vZGUuZXhwcmVzc2lvbnMucHVzaCh0aGlzLnBhcnNlRXhwcmVzc2lvbigpKTtcbiAgICBpZiAodGhpcy5leHBlY3QoXy50b2tUeXBlcy5icmFjZVIpKSB7XG4gICAgICBjdXJFbHQgPSB0aGlzLnBhcnNlVGVtcGxhdGVFbGVtZW50KCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGN1ckVsdCA9IHRoaXMuc3RhcnROb2RlKCk7XG4gICAgICBjdXJFbHQudmFsdWUgPSB7IGNvb2tlZDogJycsIHJhdzogJycgfTtcbiAgICAgIGN1ckVsdC50YWlsID0gdHJ1ZTtcbiAgICB9XG4gICAgbm9kZS5xdWFzaXMucHVzaChjdXJFbHQpO1xuICB9XG4gIHRoaXMuZXhwZWN0KF8udG9rVHlwZXMuYmFja1F1b3RlKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIlRlbXBsYXRlTGl0ZXJhbFwiKTtcbn07XG5cbmxwLnBhcnNlT2JqID0gZnVuY3Rpb24gKCkge1xuICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gIG5vZGUucHJvcGVydGllcyA9IFtdO1xuICB0aGlzLnB1c2hDeCgpO1xuICB2YXIgaW5kZW50ID0gdGhpcy5jdXJJbmRlbnQgKyAxLFxuICAgICAgbGluZSA9IHRoaXMuY3VyTGluZVN0YXJ0O1xuICB0aGlzLmVhdChfLnRva1R5cGVzLmJyYWNlTCk7XG4gIGlmICh0aGlzLmN1ckluZGVudCArIDEgPCBpbmRlbnQpIHtcbiAgICBpbmRlbnQgPSB0aGlzLmN1ckluZGVudDtsaW5lID0gdGhpcy5jdXJMaW5lU3RhcnQ7XG4gIH1cbiAgd2hpbGUgKCF0aGlzLmNsb3NlcyhfLnRva1R5cGVzLmJyYWNlUiwgaW5kZW50LCBsaW5lKSkge1xuICAgIHZhciBwcm9wID0gdGhpcy5zdGFydE5vZGUoKSxcbiAgICAgICAgaXNHZW5lcmF0b3IgPSB1bmRlZmluZWQsXG4gICAgICAgIHN0YXJ0ID0gdW5kZWZpbmVkO1xuICAgIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNikge1xuICAgICAgc3RhcnQgPSB0aGlzLnN0b3JlQ3VycmVudFBvcygpO1xuICAgICAgcHJvcC5tZXRob2QgPSBmYWxzZTtcbiAgICAgIHByb3Auc2hvcnRoYW5kID0gZmFsc2U7XG4gICAgICBpc0dlbmVyYXRvciA9IHRoaXMuZWF0KF8udG9rVHlwZXMuc3Rhcik7XG4gICAgfVxuICAgIHRoaXMucGFyc2VQcm9wZXJ0eU5hbWUocHJvcCk7XG4gICAgaWYgKF9wYXJzZXV0aWwuaXNEdW1teShwcm9wLmtleSkpIHtcbiAgICAgIGlmIChfcGFyc2V1dGlsLmlzRHVtbXkodGhpcy5wYXJzZU1heWJlQXNzaWduKCkpKSB0aGlzLm5leHQoKTt0aGlzLmVhdChfLnRva1R5cGVzLmNvbW1hKTtjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHRoaXMuZWF0KF8udG9rVHlwZXMuY29sb24pKSB7XG4gICAgICBwcm9wLmtpbmQgPSBcImluaXRcIjtcbiAgICAgIHByb3AudmFsdWUgPSB0aGlzLnBhcnNlTWF5YmVBc3NpZ24oKTtcbiAgICB9IGVsc2UgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2ICYmICh0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLnBhcmVuTCB8fCB0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLmJyYWNlTCkpIHtcbiAgICAgIHByb3Aua2luZCA9IFwiaW5pdFwiO1xuICAgICAgcHJvcC5tZXRob2QgPSB0cnVlO1xuICAgICAgcHJvcC52YWx1ZSA9IHRoaXMucGFyc2VNZXRob2QoaXNHZW5lcmF0b3IpO1xuICAgIH0gZWxzZSBpZiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDUgJiYgcHJvcC5rZXkudHlwZSA9PT0gXCJJZGVudGlmaWVyXCIgJiYgIXByb3AuY29tcHV0ZWQgJiYgKHByb3Aua2V5Lm5hbWUgPT09IFwiZ2V0XCIgfHwgcHJvcC5rZXkubmFtZSA9PT0gXCJzZXRcIikgJiYgKHRoaXMudG9rLnR5cGUgIT0gXy50b2tUeXBlcy5jb21tYSAmJiB0aGlzLnRvay50eXBlICE9IF8udG9rVHlwZXMuYnJhY2VSKSkge1xuICAgICAgcHJvcC5raW5kID0gcHJvcC5rZXkubmFtZTtcbiAgICAgIHRoaXMucGFyc2VQcm9wZXJ0eU5hbWUocHJvcCk7XG4gICAgICBwcm9wLnZhbHVlID0gdGhpcy5wYXJzZU1ldGhvZChmYWxzZSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHByb3Aua2luZCA9IFwiaW5pdFwiO1xuICAgICAgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KSB7XG4gICAgICAgIGlmICh0aGlzLmVhdChfLnRva1R5cGVzLmVxKSkge1xuICAgICAgICAgIHZhciBhc3NpZ24gPSB0aGlzLnN0YXJ0Tm9kZUF0KHN0YXJ0KTtcbiAgICAgICAgICBhc3NpZ24ub3BlcmF0b3IgPSBcIj1cIjtcbiAgICAgICAgICBhc3NpZ24ubGVmdCA9IHByb3Aua2V5O1xuICAgICAgICAgIGFzc2lnbi5yaWdodCA9IHRoaXMucGFyc2VNYXliZUFzc2lnbigpO1xuICAgICAgICAgIHByb3AudmFsdWUgPSB0aGlzLmZpbmlzaE5vZGUoYXNzaWduLCBcIkFzc2lnbm1lbnRFeHByZXNzaW9uXCIpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHByb3AudmFsdWUgPSBwcm9wLmtleTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcHJvcC52YWx1ZSA9IHRoaXMuZHVtbXlJZGVudCgpO1xuICAgICAgfVxuICAgICAgcHJvcC5zaG9ydGhhbmQgPSB0cnVlO1xuICAgIH1cbiAgICBub2RlLnByb3BlcnRpZXMucHVzaCh0aGlzLmZpbmlzaE5vZGUocHJvcCwgXCJQcm9wZXJ0eVwiKSk7XG4gICAgdGhpcy5lYXQoXy50b2tUeXBlcy5jb21tYSk7XG4gIH1cbiAgdGhpcy5wb3BDeCgpO1xuICBpZiAoIXRoaXMuZWF0KF8udG9rVHlwZXMuYnJhY2VSKSkge1xuICAgIC8vIElmIHRoZXJlIGlzIG5vIGNsb3NpbmcgYnJhY2UsIG1ha2UgdGhlIG5vZGUgc3BhbiB0byB0aGUgc3RhcnRcbiAgICAvLyBvZiB0aGUgbmV4dCB0b2tlbiAodGhpcyBpcyB1c2VmdWwgZm9yIFRlcm4pXG4gICAgdGhpcy5sYXN0LmVuZCA9IHRoaXMudG9rLnN0YXJ0O1xuICAgIGlmICh0aGlzLm9wdGlvbnMubG9jYXRpb25zKSB0aGlzLmxhc3QubG9jLmVuZCA9IHRoaXMudG9rLmxvYy5zdGFydDtcbiAgfVxuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiT2JqZWN0RXhwcmVzc2lvblwiKTtcbn07XG5cbmxwLnBhcnNlUHJvcGVydHlOYW1lID0gZnVuY3Rpb24gKHByb3ApIHtcbiAgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KSB7XG4gICAgaWYgKHRoaXMuZWF0KF8udG9rVHlwZXMuYnJhY2tldEwpKSB7XG4gICAgICBwcm9wLmNvbXB1dGVkID0gdHJ1ZTtcbiAgICAgIHByb3Aua2V5ID0gdGhpcy5wYXJzZUV4cHJlc3Npb24oKTtcbiAgICAgIHRoaXMuZXhwZWN0KF8udG9rVHlwZXMuYnJhY2tldFIpO1xuICAgICAgcmV0dXJuO1xuICAgIH0gZWxzZSB7XG4gICAgICBwcm9wLmNvbXB1dGVkID0gZmFsc2U7XG4gICAgfVxuICB9XG4gIHZhciBrZXkgPSB0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLm51bSB8fCB0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLnN0cmluZyA/IHRoaXMucGFyc2VFeHByQXRvbSgpIDogdGhpcy5wYXJzZUlkZW50KCk7XG4gIHByb3Aua2V5ID0ga2V5IHx8IHRoaXMuZHVtbXlJZGVudCgpO1xufTtcblxubHAucGFyc2VQcm9wZXJ0eUFjY2Vzc29yID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy50b2sudHlwZSA9PT0gXy50b2tUeXBlcy5uYW1lIHx8IHRoaXMudG9rLnR5cGUua2V5d29yZCkgcmV0dXJuIHRoaXMucGFyc2VJZGVudCgpO1xufTtcblxubHAucGFyc2VJZGVudCA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIG5hbWUgPSB0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLm5hbWUgPyB0aGlzLnRvay52YWx1ZSA6IHRoaXMudG9rLnR5cGUua2V5d29yZDtcbiAgaWYgKCFuYW1lKSByZXR1cm4gdGhpcy5kdW1teUlkZW50KCk7XG4gIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgdGhpcy5uZXh0KCk7XG4gIG5vZGUubmFtZSA9IG5hbWU7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJJZGVudGlmaWVyXCIpO1xufTtcblxubHAuaW5pdEZ1bmN0aW9uID0gZnVuY3Rpb24gKG5vZGUpIHtcbiAgbm9kZS5pZCA9IG51bGw7XG4gIG5vZGUucGFyYW1zID0gW107XG4gIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNikge1xuICAgIG5vZGUuZ2VuZXJhdG9yID0gZmFsc2U7XG4gICAgbm9kZS5leHByZXNzaW9uID0gZmFsc2U7XG4gIH1cbn07XG5cbi8vIENvbnZlcnQgZXhpc3RpbmcgZXhwcmVzc2lvbiBhdG9tIHRvIGFzc2lnbmFibGUgcGF0dGVyblxuLy8gaWYgcG9zc2libGUuXG5cbmxwLnRvQXNzaWduYWJsZSA9IGZ1bmN0aW9uIChub2RlLCBiaW5kaW5nKSB7XG4gIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNiAmJiBub2RlKSB7XG4gICAgc3dpdGNoIChub2RlLnR5cGUpIHtcbiAgICAgIGNhc2UgXCJPYmplY3RFeHByZXNzaW9uXCI6XG4gICAgICAgIG5vZGUudHlwZSA9IFwiT2JqZWN0UGF0dGVyblwiO1xuICAgICAgICB2YXIgcHJvcHMgPSBub2RlLnByb3BlcnRpZXM7XG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgcHJvcHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICB0aGlzLnRvQXNzaWduYWJsZShwcm9wc1tpXS52YWx1ZSwgYmluZGluZyk7XG4gICAgICAgIH1icmVhaztcblxuICAgICAgY2FzZSBcIkFycmF5RXhwcmVzc2lvblwiOlxuICAgICAgICBub2RlLnR5cGUgPSBcIkFycmF5UGF0dGVyblwiO1xuICAgICAgICB0aGlzLnRvQXNzaWduYWJsZUxpc3Qobm9kZS5lbGVtZW50cywgYmluZGluZyk7XG4gICAgICAgIGJyZWFrO1xuXG4gICAgICBjYXNlIFwiU3ByZWFkRWxlbWVudFwiOlxuICAgICAgICBub2RlLnR5cGUgPSBcIlJlc3RFbGVtZW50XCI7XG4gICAgICAgIG5vZGUuYXJndW1lbnQgPSB0aGlzLnRvQXNzaWduYWJsZShub2RlLmFyZ3VtZW50LCBiaW5kaW5nKTtcbiAgICAgICAgYnJlYWs7XG5cbiAgICAgIGNhc2UgXCJBc3NpZ25tZW50RXhwcmVzc2lvblwiOlxuICAgICAgICBub2RlLnR5cGUgPSBcIkFzc2lnbm1lbnRQYXR0ZXJuXCI7XG4gICAgICAgIGRlbGV0ZSBub2RlLm9wZXJhdG9yO1xuICAgICAgICBicmVhaztcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHRoaXMuY2hlY2tMVmFsKG5vZGUsIGJpbmRpbmcpO1xufTtcblxubHAudG9Bc3NpZ25hYmxlTGlzdCA9IGZ1bmN0aW9uIChleHByTGlzdCwgYmluZGluZykge1xuICBmb3IgKHZhciBpID0gMDsgaSA8IGV4cHJMaXN0Lmxlbmd0aDsgaSsrKSB7XG4gICAgZXhwckxpc3RbaV0gPSB0aGlzLnRvQXNzaWduYWJsZShleHByTGlzdFtpXSwgYmluZGluZyk7XG4gIH1yZXR1cm4gZXhwckxpc3Q7XG59O1xuXG5scC5wYXJzZUZ1bmN0aW9uUGFyYW1zID0gZnVuY3Rpb24gKHBhcmFtcykge1xuICBwYXJhbXMgPSB0aGlzLnBhcnNlRXhwckxpc3QoXy50b2tUeXBlcy5wYXJlblIpO1xuICByZXR1cm4gdGhpcy50b0Fzc2lnbmFibGVMaXN0KHBhcmFtcywgdHJ1ZSk7XG59O1xuXG5scC5wYXJzZU1ldGhvZCA9IGZ1bmN0aW9uIChpc0dlbmVyYXRvcikge1xuICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gIHRoaXMuaW5pdEZ1bmN0aW9uKG5vZGUpO1xuICBub2RlLnBhcmFtcyA9IHRoaXMucGFyc2VGdW5jdGlvblBhcmFtcygpO1xuICBub2RlLmdlbmVyYXRvciA9IGlzR2VuZXJhdG9yIHx8IGZhbHNlO1xuICBub2RlLmV4cHJlc3Npb24gPSB0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNiAmJiB0aGlzLnRvay50eXBlICE9PSBfLnRva1R5cGVzLmJyYWNlTDtcbiAgbm9kZS5ib2R5ID0gbm9kZS5leHByZXNzaW9uID8gdGhpcy5wYXJzZU1heWJlQXNzaWduKCkgOiB0aGlzLnBhcnNlQmxvY2soKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkZ1bmN0aW9uRXhwcmVzc2lvblwiKTtcbn07XG5cbmxwLnBhcnNlQXJyb3dFeHByZXNzaW9uID0gZnVuY3Rpb24gKG5vZGUsIHBhcmFtcykge1xuICB0aGlzLmluaXRGdW5jdGlvbihub2RlKTtcbiAgbm9kZS5wYXJhbXMgPSB0aGlzLnRvQXNzaWduYWJsZUxpc3QocGFyYW1zLCB0cnVlKTtcbiAgbm9kZS5leHByZXNzaW9uID0gdGhpcy50b2sudHlwZSAhPT0gXy50b2tUeXBlcy5icmFjZUw7XG4gIG5vZGUuYm9keSA9IG5vZGUuZXhwcmVzc2lvbiA/IHRoaXMucGFyc2VNYXliZUFzc2lnbigpIDogdGhpcy5wYXJzZUJsb2NrKCk7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJBcnJvd0Z1bmN0aW9uRXhwcmVzc2lvblwiKTtcbn07XG5cbmxwLnBhcnNlRXhwckxpc3QgPSBmdW5jdGlvbiAoY2xvc2UsIGFsbG93RW1wdHkpIHtcbiAgdGhpcy5wdXNoQ3goKTtcbiAgdmFyIGluZGVudCA9IHRoaXMuY3VySW5kZW50LFxuICAgICAgbGluZSA9IHRoaXMuY3VyTGluZVN0YXJ0LFxuICAgICAgZWx0cyA9IFtdO1xuICB0aGlzLm5leHQoKTsgLy8gT3BlbmluZyBicmFja2V0XG4gIHdoaWxlICghdGhpcy5jbG9zZXMoY2xvc2UsIGluZGVudCArIDEsIGxpbmUpKSB7XG4gICAgaWYgKHRoaXMuZWF0KF8udG9rVHlwZXMuY29tbWEpKSB7XG4gICAgICBlbHRzLnB1c2goYWxsb3dFbXB0eSA/IG51bGwgOiB0aGlzLmR1bW15SWRlbnQoKSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgdmFyIGVsdCA9IHRoaXMucGFyc2VNYXliZUFzc2lnbigpO1xuICAgIGlmIChfcGFyc2V1dGlsLmlzRHVtbXkoZWx0KSkge1xuICAgICAgaWYgKHRoaXMuY2xvc2VzKGNsb3NlLCBpbmRlbnQsIGxpbmUpKSBicmVhaztcbiAgICAgIHRoaXMubmV4dCgpO1xuICAgIH0gZWxzZSB7XG4gICAgICBlbHRzLnB1c2goZWx0KTtcbiAgICB9XG4gICAgdGhpcy5lYXQoXy50b2tUeXBlcy5jb21tYSk7XG4gIH1cbiAgdGhpcy5wb3BDeCgpO1xuICBpZiAoIXRoaXMuZWF0KGNsb3NlKSkge1xuICAgIC8vIElmIHRoZXJlIGlzIG5vIGNsb3NpbmcgYnJhY2UsIG1ha2UgdGhlIG5vZGUgc3BhbiB0byB0aGUgc3RhcnRcbiAgICAvLyBvZiB0aGUgbmV4dCB0b2tlbiAodGhpcyBpcyB1c2VmdWwgZm9yIFRlcm4pXG4gICAgdGhpcy5sYXN0LmVuZCA9IHRoaXMudG9rLnN0YXJ0O1xuICAgIGlmICh0aGlzLm9wdGlvbnMubG9jYXRpb25zKSB0aGlzLmxhc3QubG9jLmVuZCA9IHRoaXMudG9rLmxvYy5zdGFydDtcbiAgfVxuICByZXR1cm4gZWx0cztcbn07XG5cbn0se1wiLi5cIjoyLFwiLi9wYXJzZXV0aWxcIjo1LFwiLi9zdGF0ZVwiOjZ9XSw0OltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXtcbi8vIEFjb3JuOiBMb29zZSBwYXJzZXJcbi8vXG4vLyBUaGlzIG1vZHVsZSBwcm92aWRlcyBhbiBhbHRlcm5hdGl2ZSBwYXJzZXIgKGBwYXJzZV9kYW1taXRgKSB0aGF0XG4vLyBleHBvc2VzIHRoYXQgc2FtZSBpbnRlcmZhY2UgYXMgYHBhcnNlYCwgYnV0IHdpbGwgdHJ5IHRvIHBhcnNlXG4vLyBhbnl0aGluZyBhcyBKYXZhU2NyaXB0LCByZXBhaXJpbmcgc3ludGF4IGVycm9yIHRoZSBiZXN0IGl0IGNhbi5cbi8vIFRoZXJlIGFyZSBjaXJjdW1zdGFuY2VzIGluIHdoaWNoIGl0IHdpbGwgcmFpc2UgYW4gZXJyb3IgYW5kIGdpdmVcbi8vIHVwLCBidXQgdGhleSBhcmUgdmVyeSByYXJlLiBUaGUgcmVzdWx0aW5nIEFTVCB3aWxsIGJlIGEgbW9zdGx5XG4vLyB2YWxpZCBKYXZhU2NyaXB0IEFTVCAoYXMgcGVyIHRoZSBbTW96aWxsYSBwYXJzZXIgQVBJXVthcGldLCBleGNlcHRcbi8vIHRoYXQ6XG4vL1xuLy8gLSBSZXR1cm4gb3V0c2lkZSBmdW5jdGlvbnMgaXMgYWxsb3dlZFxuLy9cbi8vIC0gTGFiZWwgY29uc2lzdGVuY3kgKG5vIGNvbmZsaWN0cywgYnJlYWsgb25seSB0byBleGlzdGluZyBsYWJlbHMpXG4vLyAgIGlzIG5vdCBlbmZvcmNlZC5cbi8vXG4vLyAtIEJvZ3VzIElkZW50aWZpZXIgbm9kZXMgd2l0aCBhIG5hbWUgb2YgYFwi4pyWXCJgIGFyZSBpbnNlcnRlZCB3aGVuZXZlclxuLy8gICB0aGUgcGFyc2VyIGdvdCB0b28gY29uZnVzZWQgdG8gcmV0dXJuIGFueXRoaW5nIG1lYW5pbmdmdWwuXG4vL1xuLy8gW2FwaV06IGh0dHBzOi8vZGV2ZWxvcGVyLm1vemlsbGEub3JnL2VuLVVTL2RvY3MvU3BpZGVyTW9ua2V5L1BhcnNlcl9BUElcbi8vXG4vLyBUaGUgZXhwZWN0ZWQgdXNlIGZvciB0aGlzIGlzIHRvICpmaXJzdCogdHJ5IGBhY29ybi5wYXJzZWAsIGFuZCBvbmx5XG4vLyBpZiB0aGF0IGZhaWxzIHN3aXRjaCB0byBgcGFyc2VfZGFtbWl0YC4gVGhlIGxvb3NlIHBhcnNlciBtaWdodFxuLy8gcGFyc2UgYmFkbHkgaW5kZW50ZWQgY29kZSBpbmNvcnJlY3RseSwgc28gKipkb24ndCoqIHVzZSBpdCBhc1xuLy8geW91ciBkZWZhdWx0IHBhcnNlci5cbi8vXG4vLyBRdWl0ZSBhIGxvdCBvZiBhY29ybi5qcyBpcyBkdXBsaWNhdGVkIGhlcmUuIFRoZSBhbHRlcm5hdGl2ZSB3YXMgdG9cbi8vIGFkZCBhICpsb3QqIG9mIGV4dHJhIGNydWZ0IHRvIHRoYXQgZmlsZSwgbWFraW5nIGl0IGxlc3MgcmVhZGFibGVcbi8vIGFuZCBzbG93ZXIuIENvcHlpbmcgYW5kIGVkaXRpbmcgdGhlIGNvZGUgYWxsb3dlZCBtZSB0byBtYWtlXG4vLyBpbnZhc2l2ZSBjaGFuZ2VzIGFuZCBzaW1wbGlmaWNhdGlvbnMgd2l0aG91dCBjcmVhdGluZyBhIGNvbXBsaWNhdGVkXG4vLyB0YW5nbGUuXG5cblwidXNlIHN0cmljdFwiO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuZXhwb3J0cy5wYXJzZV9kYW1taXQgPSBwYXJzZV9kYW1taXQ7XG5cbmZ1bmN0aW9uIF9pbnRlcm9wUmVxdWlyZVdpbGRjYXJkKG9iaikgeyBpZiAob2JqICYmIG9iai5fX2VzTW9kdWxlKSB7IHJldHVybiBvYmo7IH0gZWxzZSB7IHZhciBuZXdPYmogPSB7fTsgaWYgKG9iaiAhPSBudWxsKSB7IGZvciAodmFyIGtleSBpbiBvYmopIHsgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChvYmosIGtleSkpIG5ld09ialtrZXldID0gb2JqW2tleV07IH0gfSBuZXdPYmpbXCJkZWZhdWx0XCJdID0gb2JqOyByZXR1cm4gbmV3T2JqOyB9IH1cblxudmFyIF8gPSBfZGVyZXFfKFwiLi5cIik7XG5cbnZhciBhY29ybiA9IF9pbnRlcm9wUmVxdWlyZVdpbGRjYXJkKF8pO1xuXG52YXIgX3N0YXRlID0gX2RlcmVxXyhcIi4vc3RhdGVcIik7XG5cbl9kZXJlcV8oXCIuL3Rva2VuaXplXCIpO1xuXG5fZGVyZXFfKFwiLi9zdGF0ZW1lbnRcIik7XG5cbl9kZXJlcV8oXCIuL2V4cHJlc3Npb25cIik7XG5cbmV4cG9ydHMuTG9vc2VQYXJzZXIgPSBfc3RhdGUuTG9vc2VQYXJzZXI7XG5cbmFjb3JuLmRlZmF1bHRPcHRpb25zLnRhYlNpemUgPSA0O1xuXG5mdW5jdGlvbiBwYXJzZV9kYW1taXQoaW5wdXQsIG9wdGlvbnMpIHtcbiAgdmFyIHAgPSBuZXcgX3N0YXRlLkxvb3NlUGFyc2VyKGlucHV0LCBvcHRpb25zKTtcbiAgcC5uZXh0KCk7XG4gIHJldHVybiBwLnBhcnNlVG9wTGV2ZWwoKTtcbn1cblxuYWNvcm4ucGFyc2VfZGFtbWl0ID0gcGFyc2VfZGFtbWl0O1xuYWNvcm4uTG9vc2VQYXJzZXIgPSBfc3RhdGUuTG9vc2VQYXJzZXI7XG5cbn0se1wiLi5cIjoyLFwiLi9leHByZXNzaW9uXCI6MyxcIi4vc3RhdGVcIjo2LFwiLi9zdGF0ZW1lbnRcIjo3LFwiLi90b2tlbml6ZVwiOjh9XSw1OltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXtcblwidXNlIHN0cmljdFwiO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuZXhwb3J0cy5pc0R1bW15ID0gaXNEdW1teTtcblxuZnVuY3Rpb24gaXNEdW1teShub2RlKSB7XG4gIHJldHVybiBub2RlLm5hbWUgPT0gXCLinJZcIjtcbn1cblxufSx7fV0sNjpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7XG5cInVzZSBzdHJpY3RcIjtcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcblxuZnVuY3Rpb24gX2NsYXNzQ2FsbENoZWNrKGluc3RhbmNlLCBDb25zdHJ1Y3RvcikgeyBpZiAoIShpbnN0YW5jZSBpbnN0YW5jZW9mIENvbnN0cnVjdG9yKSkgeyB0aHJvdyBuZXcgVHlwZUVycm9yKFwiQ2Fubm90IGNhbGwgYSBjbGFzcyBhcyBhIGZ1bmN0aW9uXCIpOyB9IH1cblxudmFyIF8gPSBfZGVyZXFfKFwiLi5cIik7XG5cbnZhciBMb29zZVBhcnNlciA9IChmdW5jdGlvbiAoKSB7XG4gIGZ1bmN0aW9uIExvb3NlUGFyc2VyKGlucHV0LCBvcHRpb25zKSB7XG4gICAgX2NsYXNzQ2FsbENoZWNrKHRoaXMsIExvb3NlUGFyc2VyKTtcblxuICAgIHRoaXMudG9rcyA9IF8udG9rZW5pemVyKGlucHV0LCBvcHRpb25zKTtcbiAgICB0aGlzLm9wdGlvbnMgPSB0aGlzLnRva3Mub3B0aW9ucztcbiAgICB0aGlzLmlucHV0ID0gdGhpcy50b2tzLmlucHV0O1xuICAgIHRoaXMudG9rID0gdGhpcy5sYXN0ID0geyB0eXBlOiBfLnRva1R5cGVzLmVvZiwgc3RhcnQ6IDAsIGVuZDogMCB9O1xuICAgIGlmICh0aGlzLm9wdGlvbnMubG9jYXRpb25zKSB7XG4gICAgICB2YXIgaGVyZSA9IHRoaXMudG9rcy5jdXJQb3NpdGlvbigpO1xuICAgICAgdGhpcy50b2subG9jID0gbmV3IF8uU291cmNlTG9jYXRpb24odGhpcy50b2tzLCBoZXJlLCBoZXJlKTtcbiAgICB9XG4gICAgdGhpcy5haGVhZCA9IFtdOyAvLyBUb2tlbnMgYWhlYWRcbiAgICB0aGlzLmNvbnRleHQgPSBbXTsgLy8gSW5kZW50YXRpb24gY29udGV4dGVkXG4gICAgdGhpcy5jdXJJbmRlbnQgPSAwO1xuICAgIHRoaXMuY3VyTGluZVN0YXJ0ID0gMDtcbiAgICB0aGlzLm5leHRMaW5lU3RhcnQgPSB0aGlzLmxpbmVFbmQodGhpcy5jdXJMaW5lU3RhcnQpICsgMTtcbiAgfVxuXG4gIExvb3NlUGFyc2VyLnByb3RvdHlwZS5zdGFydE5vZGUgPSBmdW5jdGlvbiBzdGFydE5vZGUoKSB7XG4gICAgcmV0dXJuIG5ldyBfLk5vZGUodGhpcy50b2tzLCB0aGlzLnRvay5zdGFydCwgdGhpcy5vcHRpb25zLmxvY2F0aW9ucyA/IHRoaXMudG9rLmxvYy5zdGFydCA6IG51bGwpO1xuICB9O1xuXG4gIExvb3NlUGFyc2VyLnByb3RvdHlwZS5zdG9yZUN1cnJlbnRQb3MgPSBmdW5jdGlvbiBzdG9yZUN1cnJlbnRQb3MoKSB7XG4gICAgcmV0dXJuIHRoaXMub3B0aW9ucy5sb2NhdGlvbnMgPyBbdGhpcy50b2suc3RhcnQsIHRoaXMudG9rLmxvYy5zdGFydF0gOiB0aGlzLnRvay5zdGFydDtcbiAgfTtcblxuICBMb29zZVBhcnNlci5wcm90b3R5cGUuc3RhcnROb2RlQXQgPSBmdW5jdGlvbiBzdGFydE5vZGVBdChwb3MpIHtcbiAgICBpZiAodGhpcy5vcHRpb25zLmxvY2F0aW9ucykge1xuICAgICAgcmV0dXJuIG5ldyBfLk5vZGUodGhpcy50b2tzLCBwb3NbMF0sIHBvc1sxXSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiBuZXcgXy5Ob2RlKHRoaXMudG9rcywgcG9zKTtcbiAgICB9XG4gIH07XG5cbiAgTG9vc2VQYXJzZXIucHJvdG90eXBlLmZpbmlzaE5vZGUgPSBmdW5jdGlvbiBmaW5pc2hOb2RlKG5vZGUsIHR5cGUpIHtcbiAgICBub2RlLnR5cGUgPSB0eXBlO1xuICAgIG5vZGUuZW5kID0gdGhpcy5sYXN0LmVuZDtcbiAgICBpZiAodGhpcy5vcHRpb25zLmxvY2F0aW9ucykgbm9kZS5sb2MuZW5kID0gdGhpcy5sYXN0LmxvYy5lbmQ7XG4gICAgaWYgKHRoaXMub3B0aW9ucy5yYW5nZXMpIG5vZGUucmFuZ2VbMV0gPSB0aGlzLmxhc3QuZW5kO1xuICAgIHJldHVybiBub2RlO1xuICB9O1xuXG4gIExvb3NlUGFyc2VyLnByb3RvdHlwZS5kdW1teUlkZW50ID0gZnVuY3Rpb24gZHVtbXlJZGVudCgpIHtcbiAgICB2YXIgZHVtbXkgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICAgIGR1bW15Lm5hbWUgPSBcIuKcllwiO1xuICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUoZHVtbXksIFwiSWRlbnRpZmllclwiKTtcbiAgfTtcblxuICBMb29zZVBhcnNlci5wcm90b3R5cGUuZWF0ID0gZnVuY3Rpb24gZWF0KHR5cGUpIHtcbiAgICBpZiAodGhpcy50b2sudHlwZSA9PT0gdHlwZSkge1xuICAgICAgdGhpcy5uZXh0KCk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfTtcblxuICBMb29zZVBhcnNlci5wcm90b3R5cGUuaXNDb250ZXh0dWFsID0gZnVuY3Rpb24gaXNDb250ZXh0dWFsKG5hbWUpIHtcbiAgICByZXR1cm4gdGhpcy50b2sudHlwZSA9PT0gXy50b2tUeXBlcy5uYW1lICYmIHRoaXMudG9rLnZhbHVlID09PSBuYW1lO1xuICB9O1xuXG4gIExvb3NlUGFyc2VyLnByb3RvdHlwZS5lYXRDb250ZXh0dWFsID0gZnVuY3Rpb24gZWF0Q29udGV4dHVhbChuYW1lKSB7XG4gICAgcmV0dXJuIHRoaXMudG9rLnZhbHVlID09PSBuYW1lICYmIHRoaXMuZWF0KF8udG9rVHlwZXMubmFtZSk7XG4gIH07XG5cbiAgTG9vc2VQYXJzZXIucHJvdG90eXBlLmNhbkluc2VydFNlbWljb2xvbiA9IGZ1bmN0aW9uIGNhbkluc2VydFNlbWljb2xvbigpIHtcbiAgICByZXR1cm4gdGhpcy50b2sudHlwZSA9PT0gXy50b2tUeXBlcy5lb2YgfHwgdGhpcy50b2sudHlwZSA9PT0gXy50b2tUeXBlcy5icmFjZVIgfHwgXy5saW5lQnJlYWsudGVzdCh0aGlzLmlucHV0LnNsaWNlKHRoaXMubGFzdC5lbmQsIHRoaXMudG9rLnN0YXJ0KSk7XG4gIH07XG5cbiAgTG9vc2VQYXJzZXIucHJvdG90eXBlLnNlbWljb2xvbiA9IGZ1bmN0aW9uIHNlbWljb2xvbigpIHtcbiAgICByZXR1cm4gdGhpcy5lYXQoXy50b2tUeXBlcy5zZW1pKTtcbiAgfTtcblxuICBMb29zZVBhcnNlci5wcm90b3R5cGUuZXhwZWN0ID0gZnVuY3Rpb24gZXhwZWN0KHR5cGUpIHtcbiAgICBpZiAodGhpcy5lYXQodHlwZSkpIHJldHVybiB0cnVlO1xuICAgIGZvciAodmFyIGkgPSAxOyBpIDw9IDI7IGkrKykge1xuICAgICAgaWYgKHRoaXMubG9va0FoZWFkKGkpLnR5cGUgPT0gdHlwZSkge1xuICAgICAgICBmb3IgKHZhciBqID0gMDsgaiA8IGk7IGorKykge1xuICAgICAgICAgIHRoaXMubmV4dCgpO1xuICAgICAgICB9cmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgfVxuICB9O1xuXG4gIExvb3NlUGFyc2VyLnByb3RvdHlwZS5wdXNoQ3ggPSBmdW5jdGlvbiBwdXNoQ3goKSB7XG4gICAgdGhpcy5jb250ZXh0LnB1c2godGhpcy5jdXJJbmRlbnQpO1xuICB9O1xuXG4gIExvb3NlUGFyc2VyLnByb3RvdHlwZS5wb3BDeCA9IGZ1bmN0aW9uIHBvcEN4KCkge1xuICAgIHRoaXMuY3VySW5kZW50ID0gdGhpcy5jb250ZXh0LnBvcCgpO1xuICB9O1xuXG4gIExvb3NlUGFyc2VyLnByb3RvdHlwZS5saW5lRW5kID0gZnVuY3Rpb24gbGluZUVuZChwb3MpIHtcbiAgICB3aGlsZSAocG9zIDwgdGhpcy5pbnB1dC5sZW5ndGggJiYgIV8uaXNOZXdMaW5lKHRoaXMuaW5wdXQuY2hhckNvZGVBdChwb3MpKSkgKytwb3M7XG4gICAgcmV0dXJuIHBvcztcbiAgfTtcblxuICBMb29zZVBhcnNlci5wcm90b3R5cGUuaW5kZW50YXRpb25BZnRlciA9IGZ1bmN0aW9uIGluZGVudGF0aW9uQWZ0ZXIocG9zKSB7XG4gICAgZm9yICh2YXIgY291bnQgPSAwOzsgKytwb3MpIHtcbiAgICAgIHZhciBjaCA9IHRoaXMuaW5wdXQuY2hhckNvZGVBdChwb3MpO1xuICAgICAgaWYgKGNoID09PSAzMikgKytjb3VudDtlbHNlIGlmIChjaCA9PT0gOSkgY291bnQgKz0gdGhpcy5vcHRpb25zLnRhYlNpemU7ZWxzZSByZXR1cm4gY291bnQ7XG4gICAgfVxuICB9O1xuXG4gIExvb3NlUGFyc2VyLnByb3RvdHlwZS5jbG9zZXMgPSBmdW5jdGlvbiBjbG9zZXMoY2xvc2VUb2ssIGluZGVudCwgbGluZSwgYmxvY2tIZXVyaXN0aWMpIHtcbiAgICBpZiAodGhpcy50b2sudHlwZSA9PT0gY2xvc2VUb2sgfHwgdGhpcy50b2sudHlwZSA9PT0gXy50b2tUeXBlcy5lb2YpIHJldHVybiB0cnVlO1xuICAgIHJldHVybiBsaW5lICE9IHRoaXMuY3VyTGluZVN0YXJ0ICYmIHRoaXMuY3VySW5kZW50IDwgaW5kZW50ICYmIHRoaXMudG9rZW5TdGFydHNMaW5lKCkgJiYgKCFibG9ja0hldXJpc3RpYyB8fCB0aGlzLm5leHRMaW5lU3RhcnQgPj0gdGhpcy5pbnB1dC5sZW5ndGggfHwgdGhpcy5pbmRlbnRhdGlvbkFmdGVyKHRoaXMubmV4dExpbmVTdGFydCkgPCBpbmRlbnQpO1xuICB9O1xuXG4gIExvb3NlUGFyc2VyLnByb3RvdHlwZS50b2tlblN0YXJ0c0xpbmUgPSBmdW5jdGlvbiB0b2tlblN0YXJ0c0xpbmUoKSB7XG4gICAgZm9yICh2YXIgcCA9IHRoaXMudG9rLnN0YXJ0IC0gMTsgcCA+PSB0aGlzLmN1ckxpbmVTdGFydDsgLS1wKSB7XG4gICAgICB2YXIgY2ggPSB0aGlzLmlucHV0LmNoYXJDb2RlQXQocCk7XG4gICAgICBpZiAoY2ggIT09IDkgJiYgY2ggIT09IDMyKSByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9O1xuXG4gIHJldHVybiBMb29zZVBhcnNlcjtcbn0pKCk7XG5cbmV4cG9ydHMuTG9vc2VQYXJzZXIgPSBMb29zZVBhcnNlcjtcblxufSx7XCIuLlwiOjJ9XSw3OltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXtcblwidXNlIHN0cmljdFwiO1xuXG52YXIgX3N0YXRlID0gX2RlcmVxXyhcIi4vc3RhdGVcIik7XG5cbnZhciBfcGFyc2V1dGlsID0gX2RlcmVxXyhcIi4vcGFyc2V1dGlsXCIpO1xuXG52YXIgXyA9IF9kZXJlcV8oXCIuLlwiKTtcblxudmFyIGxwID0gX3N0YXRlLkxvb3NlUGFyc2VyLnByb3RvdHlwZTtcblxubHAucGFyc2VUb3BMZXZlbCA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZUF0KHRoaXMub3B0aW9ucy5sb2NhdGlvbnMgPyBbMCwgXy5nZXRMaW5lSW5mbyh0aGlzLmlucHV0LCAwKV0gOiAwKTtcbiAgbm9kZS5ib2R5ID0gW107XG4gIHdoaWxlICh0aGlzLnRvay50eXBlICE9PSBfLnRva1R5cGVzLmVvZikgbm9kZS5ib2R5LnB1c2godGhpcy5wYXJzZVN0YXRlbWVudCgpKTtcbiAgdGhpcy5sYXN0ID0gdGhpcy50b2s7XG4gIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNikge1xuICAgIG5vZGUuc291cmNlVHlwZSA9IHRoaXMub3B0aW9ucy5zb3VyY2VUeXBlO1xuICB9XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJQcm9ncmFtXCIpO1xufTtcblxubHAucGFyc2VTdGF0ZW1lbnQgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBzdGFydHR5cGUgPSB0aGlzLnRvay50eXBlLFxuICAgICAgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG5cbiAgc3dpdGNoIChzdGFydHR5cGUpIHtcbiAgICBjYXNlIF8udG9rVHlwZXMuX2JyZWFrOmNhc2UgXy50b2tUeXBlcy5fY29udGludWU6XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIHZhciBpc0JyZWFrID0gc3RhcnR0eXBlID09PSBfLnRva1R5cGVzLl9icmVhaztcbiAgICAgIGlmICh0aGlzLnNlbWljb2xvbigpIHx8IHRoaXMuY2FuSW5zZXJ0U2VtaWNvbG9uKCkpIHtcbiAgICAgICAgbm9kZS5sYWJlbCA9IG51bGw7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBub2RlLmxhYmVsID0gdGhpcy50b2sudHlwZSA9PT0gXy50b2tUeXBlcy5uYW1lID8gdGhpcy5wYXJzZUlkZW50KCkgOiBudWxsO1xuICAgICAgICB0aGlzLnNlbWljb2xvbigpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBpc0JyZWFrID8gXCJCcmVha1N0YXRlbWVudFwiIDogXCJDb250aW51ZVN0YXRlbWVudFwiKTtcblxuICAgIGNhc2UgXy50b2tUeXBlcy5fZGVidWdnZXI6XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIHRoaXMuc2VtaWNvbG9uKCk7XG4gICAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiRGVidWdnZXJTdGF0ZW1lbnRcIik7XG5cbiAgICBjYXNlIF8udG9rVHlwZXMuX2RvOlxuICAgICAgdGhpcy5uZXh0KCk7XG4gICAgICBub2RlLmJvZHkgPSB0aGlzLnBhcnNlU3RhdGVtZW50KCk7XG4gICAgICBub2RlLnRlc3QgPSB0aGlzLmVhdChfLnRva1R5cGVzLl93aGlsZSkgPyB0aGlzLnBhcnNlUGFyZW5FeHByZXNzaW9uKCkgOiB0aGlzLmR1bW15SWRlbnQoKTtcbiAgICAgIHRoaXMuc2VtaWNvbG9uKCk7XG4gICAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiRG9XaGlsZVN0YXRlbWVudFwiKTtcblxuICAgIGNhc2UgXy50b2tUeXBlcy5fZm9yOlxuICAgICAgdGhpcy5uZXh0KCk7XG4gICAgICB0aGlzLnB1c2hDeCgpO1xuICAgICAgdGhpcy5leHBlY3QoXy50b2tUeXBlcy5wYXJlbkwpO1xuICAgICAgaWYgKHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMuc2VtaSkgcmV0dXJuIHRoaXMucGFyc2VGb3Iobm9kZSwgbnVsbCk7XG4gICAgICBpZiAodGhpcy50b2sudHlwZSA9PT0gXy50b2tUeXBlcy5fdmFyIHx8IHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMuX2xldCB8fCB0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLl9jb25zdCkge1xuICAgICAgICB2YXIgX2luaXQgPSB0aGlzLnBhcnNlVmFyKHRydWUpO1xuICAgICAgICBpZiAoX2luaXQuZGVjbGFyYXRpb25zLmxlbmd0aCA9PT0gMSAmJiAodGhpcy50b2sudHlwZSA9PT0gXy50b2tUeXBlcy5faW4gfHwgdGhpcy5pc0NvbnRleHR1YWwoXCJvZlwiKSkpIHtcbiAgICAgICAgICByZXR1cm4gdGhpcy5wYXJzZUZvckluKG5vZGUsIF9pbml0KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdGhpcy5wYXJzZUZvcihub2RlLCBfaW5pdCk7XG4gICAgICB9XG4gICAgICB2YXIgaW5pdCA9IHRoaXMucGFyc2VFeHByZXNzaW9uKHRydWUpO1xuICAgICAgaWYgKHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMuX2luIHx8IHRoaXMuaXNDb250ZXh0dWFsKFwib2ZcIikpIHJldHVybiB0aGlzLnBhcnNlRm9ySW4obm9kZSwgdGhpcy50b0Fzc2lnbmFibGUoaW5pdCkpO1xuICAgICAgcmV0dXJuIHRoaXMucGFyc2VGb3Iobm9kZSwgaW5pdCk7XG5cbiAgICBjYXNlIF8udG9rVHlwZXMuX2Z1bmN0aW9uOlxuICAgICAgdGhpcy5uZXh0KCk7XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZUZ1bmN0aW9uKG5vZGUsIHRydWUpO1xuXG4gICAgY2FzZSBfLnRva1R5cGVzLl9pZjpcbiAgICAgIHRoaXMubmV4dCgpO1xuICAgICAgbm9kZS50ZXN0ID0gdGhpcy5wYXJzZVBhcmVuRXhwcmVzc2lvbigpO1xuICAgICAgbm9kZS5jb25zZXF1ZW50ID0gdGhpcy5wYXJzZVN0YXRlbWVudCgpO1xuICAgICAgbm9kZS5hbHRlcm5hdGUgPSB0aGlzLmVhdChfLnRva1R5cGVzLl9lbHNlKSA/IHRoaXMucGFyc2VTdGF0ZW1lbnQoKSA6IG51bGw7XG4gICAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiSWZTdGF0ZW1lbnRcIik7XG5cbiAgICBjYXNlIF8udG9rVHlwZXMuX3JldHVybjpcbiAgICAgIHRoaXMubmV4dCgpO1xuICAgICAgaWYgKHRoaXMuZWF0KF8udG9rVHlwZXMuc2VtaSkgfHwgdGhpcy5jYW5JbnNlcnRTZW1pY29sb24oKSkgbm9kZS5hcmd1bWVudCA9IG51bGw7ZWxzZSB7XG4gICAgICAgIG5vZGUuYXJndW1lbnQgPSB0aGlzLnBhcnNlRXhwcmVzc2lvbigpO3RoaXMuc2VtaWNvbG9uKCk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiUmV0dXJuU3RhdGVtZW50XCIpO1xuXG4gICAgY2FzZSBfLnRva1R5cGVzLl9zd2l0Y2g6XG4gICAgICB2YXIgYmxvY2tJbmRlbnQgPSB0aGlzLmN1ckluZGVudCxcbiAgICAgICAgICBsaW5lID0gdGhpcy5jdXJMaW5lU3RhcnQ7XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIG5vZGUuZGlzY3JpbWluYW50ID0gdGhpcy5wYXJzZVBhcmVuRXhwcmVzc2lvbigpO1xuICAgICAgbm9kZS5jYXNlcyA9IFtdO1xuICAgICAgdGhpcy5wdXNoQ3goKTtcbiAgICAgIHRoaXMuZXhwZWN0KF8udG9rVHlwZXMuYnJhY2VMKTtcblxuICAgICAgdmFyIGN1ciA9IHVuZGVmaW5lZDtcbiAgICAgIHdoaWxlICghdGhpcy5jbG9zZXMoXy50b2tUeXBlcy5icmFjZVIsIGJsb2NrSW5kZW50LCBsaW5lLCB0cnVlKSkge1xuICAgICAgICBpZiAodGhpcy50b2sudHlwZSA9PT0gXy50b2tUeXBlcy5fY2FzZSB8fCB0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLl9kZWZhdWx0KSB7XG4gICAgICAgICAgdmFyIGlzQ2FzZSA9IHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMuX2Nhc2U7XG4gICAgICAgICAgaWYgKGN1cikgdGhpcy5maW5pc2hOb2RlKGN1ciwgXCJTd2l0Y2hDYXNlXCIpO1xuICAgICAgICAgIG5vZGUuY2FzZXMucHVzaChjdXIgPSB0aGlzLnN0YXJ0Tm9kZSgpKTtcbiAgICAgICAgICBjdXIuY29uc2VxdWVudCA9IFtdO1xuICAgICAgICAgIHRoaXMubmV4dCgpO1xuICAgICAgICAgIGlmIChpc0Nhc2UpIGN1ci50ZXN0ID0gdGhpcy5wYXJzZUV4cHJlc3Npb24oKTtlbHNlIGN1ci50ZXN0ID0gbnVsbDtcbiAgICAgICAgICB0aGlzLmV4cGVjdChfLnRva1R5cGVzLmNvbG9uKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBpZiAoIWN1cikge1xuICAgICAgICAgICAgbm9kZS5jYXNlcy5wdXNoKGN1ciA9IHRoaXMuc3RhcnROb2RlKCkpO1xuICAgICAgICAgICAgY3VyLmNvbnNlcXVlbnQgPSBbXTtcbiAgICAgICAgICAgIGN1ci50ZXN0ID0gbnVsbDtcbiAgICAgICAgICB9XG4gICAgICAgICAgY3VyLmNvbnNlcXVlbnQucHVzaCh0aGlzLnBhcnNlU3RhdGVtZW50KCkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoY3VyKSB0aGlzLmZpbmlzaE5vZGUoY3VyLCBcIlN3aXRjaENhc2VcIik7XG4gICAgICB0aGlzLnBvcEN4KCk7XG4gICAgICB0aGlzLmVhdChfLnRva1R5cGVzLmJyYWNlUik7XG4gICAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiU3dpdGNoU3RhdGVtZW50XCIpO1xuXG4gICAgY2FzZSBfLnRva1R5cGVzLl90aHJvdzpcbiAgICAgIHRoaXMubmV4dCgpO1xuICAgICAgbm9kZS5hcmd1bWVudCA9IHRoaXMucGFyc2VFeHByZXNzaW9uKCk7XG4gICAgICB0aGlzLnNlbWljb2xvbigpO1xuICAgICAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIlRocm93U3RhdGVtZW50XCIpO1xuXG4gICAgY2FzZSBfLnRva1R5cGVzLl90cnk6XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIG5vZGUuYmxvY2sgPSB0aGlzLnBhcnNlQmxvY2soKTtcbiAgICAgIG5vZGUuaGFuZGxlciA9IG51bGw7XG4gICAgICBpZiAodGhpcy50b2sudHlwZSA9PT0gXy50b2tUeXBlcy5fY2F0Y2gpIHtcbiAgICAgICAgdmFyIGNsYXVzZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gICAgICAgIHRoaXMubmV4dCgpO1xuICAgICAgICB0aGlzLmV4cGVjdChfLnRva1R5cGVzLnBhcmVuTCk7XG4gICAgICAgIGNsYXVzZS5wYXJhbSA9IHRoaXMudG9Bc3NpZ25hYmxlKHRoaXMucGFyc2VFeHByQXRvbSgpLCB0cnVlKTtcbiAgICAgICAgdGhpcy5leHBlY3QoXy50b2tUeXBlcy5wYXJlblIpO1xuICAgICAgICBjbGF1c2UuZ3VhcmQgPSBudWxsO1xuICAgICAgICBjbGF1c2UuYm9keSA9IHRoaXMucGFyc2VCbG9jaygpO1xuICAgICAgICBub2RlLmhhbmRsZXIgPSB0aGlzLmZpbmlzaE5vZGUoY2xhdXNlLCBcIkNhdGNoQ2xhdXNlXCIpO1xuICAgICAgfVxuICAgICAgbm9kZS5maW5hbGl6ZXIgPSB0aGlzLmVhdChfLnRva1R5cGVzLl9maW5hbGx5KSA/IHRoaXMucGFyc2VCbG9jaygpIDogbnVsbDtcbiAgICAgIGlmICghbm9kZS5oYW5kbGVyICYmICFub2RlLmZpbmFsaXplcikgcmV0dXJuIG5vZGUuYmxvY2s7XG4gICAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiVHJ5U3RhdGVtZW50XCIpO1xuXG4gICAgY2FzZSBfLnRva1R5cGVzLl92YXI6XG4gICAgY2FzZSBfLnRva1R5cGVzLl9sZXQ6XG4gICAgY2FzZSBfLnRva1R5cGVzLl9jb25zdDpcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlVmFyKCk7XG5cbiAgICBjYXNlIF8udG9rVHlwZXMuX3doaWxlOlxuICAgICAgdGhpcy5uZXh0KCk7XG4gICAgICBub2RlLnRlc3QgPSB0aGlzLnBhcnNlUGFyZW5FeHByZXNzaW9uKCk7XG4gICAgICBub2RlLmJvZHkgPSB0aGlzLnBhcnNlU3RhdGVtZW50KCk7XG4gICAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiV2hpbGVTdGF0ZW1lbnRcIik7XG5cbiAgICBjYXNlIF8udG9rVHlwZXMuX3dpdGg6XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIG5vZGUub2JqZWN0ID0gdGhpcy5wYXJzZVBhcmVuRXhwcmVzc2lvbigpO1xuICAgICAgbm9kZS5ib2R5ID0gdGhpcy5wYXJzZVN0YXRlbWVudCgpO1xuICAgICAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIldpdGhTdGF0ZW1lbnRcIik7XG5cbiAgICBjYXNlIF8udG9rVHlwZXMuYnJhY2VMOlxuICAgICAgcmV0dXJuIHRoaXMucGFyc2VCbG9jaygpO1xuXG4gICAgY2FzZSBfLnRva1R5cGVzLnNlbWk6XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJFbXB0eVN0YXRlbWVudFwiKTtcblxuICAgIGNhc2UgXy50b2tUeXBlcy5fY2xhc3M6XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZUNsYXNzKHRydWUpO1xuXG4gICAgY2FzZSBfLnRva1R5cGVzLl9pbXBvcnQ6XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZUltcG9ydCgpO1xuXG4gICAgY2FzZSBfLnRva1R5cGVzLl9leHBvcnQ6XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZUV4cG9ydCgpO1xuXG4gICAgZGVmYXVsdDpcbiAgICAgIHZhciBleHByID0gdGhpcy5wYXJzZUV4cHJlc3Npb24oKTtcbiAgICAgIGlmIChfcGFyc2V1dGlsLmlzRHVtbXkoZXhwcikpIHtcbiAgICAgICAgdGhpcy5uZXh0KCk7XG4gICAgICAgIGlmICh0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLmVvZikgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkVtcHR5U3RhdGVtZW50XCIpO1xuICAgICAgICByZXR1cm4gdGhpcy5wYXJzZVN0YXRlbWVudCgpO1xuICAgICAgfSBlbHNlIGlmIChzdGFydHR5cGUgPT09IF8udG9rVHlwZXMubmFtZSAmJiBleHByLnR5cGUgPT09IFwiSWRlbnRpZmllclwiICYmIHRoaXMuZWF0KF8udG9rVHlwZXMuY29sb24pKSB7XG4gICAgICAgIG5vZGUuYm9keSA9IHRoaXMucGFyc2VTdGF0ZW1lbnQoKTtcbiAgICAgICAgbm9kZS5sYWJlbCA9IGV4cHI7XG4gICAgICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJMYWJlbGVkU3RhdGVtZW50XCIpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbm9kZS5leHByZXNzaW9uID0gZXhwcjtcbiAgICAgICAgdGhpcy5zZW1pY29sb24oKTtcbiAgICAgICAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkV4cHJlc3Npb25TdGF0ZW1lbnRcIik7XG4gICAgICB9XG4gIH1cbn07XG5cbmxwLnBhcnNlQmxvY2sgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgdGhpcy5wdXNoQ3goKTtcbiAgdGhpcy5leHBlY3QoXy50b2tUeXBlcy5icmFjZUwpO1xuICB2YXIgYmxvY2tJbmRlbnQgPSB0aGlzLmN1ckluZGVudCxcbiAgICAgIGxpbmUgPSB0aGlzLmN1ckxpbmVTdGFydDtcbiAgbm9kZS5ib2R5ID0gW107XG4gIHdoaWxlICghdGhpcy5jbG9zZXMoXy50b2tUeXBlcy5icmFjZVIsIGJsb2NrSW5kZW50LCBsaW5lLCB0cnVlKSkgbm9kZS5ib2R5LnB1c2godGhpcy5wYXJzZVN0YXRlbWVudCgpKTtcbiAgdGhpcy5wb3BDeCgpO1xuICB0aGlzLmVhdChfLnRva1R5cGVzLmJyYWNlUik7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJCbG9ja1N0YXRlbWVudFwiKTtcbn07XG5cbmxwLnBhcnNlRm9yID0gZnVuY3Rpb24gKG5vZGUsIGluaXQpIHtcbiAgbm9kZS5pbml0ID0gaW5pdDtcbiAgbm9kZS50ZXN0ID0gbm9kZS51cGRhdGUgPSBudWxsO1xuICBpZiAodGhpcy5lYXQoXy50b2tUeXBlcy5zZW1pKSAmJiB0aGlzLnRvay50eXBlICE9PSBfLnRva1R5cGVzLnNlbWkpIG5vZGUudGVzdCA9IHRoaXMucGFyc2VFeHByZXNzaW9uKCk7XG4gIGlmICh0aGlzLmVhdChfLnRva1R5cGVzLnNlbWkpICYmIHRoaXMudG9rLnR5cGUgIT09IF8udG9rVHlwZXMucGFyZW5SKSBub2RlLnVwZGF0ZSA9IHRoaXMucGFyc2VFeHByZXNzaW9uKCk7XG4gIHRoaXMucG9wQ3goKTtcbiAgdGhpcy5leHBlY3QoXy50b2tUeXBlcy5wYXJlblIpO1xuICBub2RlLmJvZHkgPSB0aGlzLnBhcnNlU3RhdGVtZW50KCk7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJGb3JTdGF0ZW1lbnRcIik7XG59O1xuXG5scC5wYXJzZUZvckluID0gZnVuY3Rpb24gKG5vZGUsIGluaXQpIHtcbiAgdmFyIHR5cGUgPSB0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLl9pbiA/IFwiRm9ySW5TdGF0ZW1lbnRcIiA6IFwiRm9yT2ZTdGF0ZW1lbnRcIjtcbiAgdGhpcy5uZXh0KCk7XG4gIG5vZGUubGVmdCA9IGluaXQ7XG4gIG5vZGUucmlnaHQgPSB0aGlzLnBhcnNlRXhwcmVzc2lvbigpO1xuICB0aGlzLnBvcEN4KCk7XG4gIHRoaXMuZXhwZWN0KF8udG9rVHlwZXMucGFyZW5SKTtcbiAgbm9kZS5ib2R5ID0gdGhpcy5wYXJzZVN0YXRlbWVudCgpO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIHR5cGUpO1xufTtcblxubHAucGFyc2VWYXIgPSBmdW5jdGlvbiAobm9Jbikge1xuICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gIG5vZGUua2luZCA9IHRoaXMudG9rLnR5cGUua2V5d29yZDtcbiAgdGhpcy5uZXh0KCk7XG4gIG5vZGUuZGVjbGFyYXRpb25zID0gW107XG4gIGRvIHtcbiAgICB2YXIgZGVjbCA9IHRoaXMuc3RhcnROb2RlKCk7XG4gICAgZGVjbC5pZCA9IHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2ID8gdGhpcy50b0Fzc2lnbmFibGUodGhpcy5wYXJzZUV4cHJBdG9tKCksIHRydWUpIDogdGhpcy5wYXJzZUlkZW50KCk7XG4gICAgZGVjbC5pbml0ID0gdGhpcy5lYXQoXy50b2tUeXBlcy5lcSkgPyB0aGlzLnBhcnNlTWF5YmVBc3NpZ24obm9JbikgOiBudWxsO1xuICAgIG5vZGUuZGVjbGFyYXRpb25zLnB1c2godGhpcy5maW5pc2hOb2RlKGRlY2wsIFwiVmFyaWFibGVEZWNsYXJhdG9yXCIpKTtcbiAgfSB3aGlsZSAodGhpcy5lYXQoXy50b2tUeXBlcy5jb21tYSkpO1xuICBpZiAoIW5vZGUuZGVjbGFyYXRpb25zLmxlbmd0aCkge1xuICAgIHZhciBkZWNsID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgICBkZWNsLmlkID0gdGhpcy5kdW1teUlkZW50KCk7XG4gICAgbm9kZS5kZWNsYXJhdGlvbnMucHVzaCh0aGlzLmZpbmlzaE5vZGUoZGVjbCwgXCJWYXJpYWJsZURlY2xhcmF0b3JcIikpO1xuICB9XG4gIGlmICghbm9JbikgdGhpcy5zZW1pY29sb24oKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIlZhcmlhYmxlRGVjbGFyYXRpb25cIik7XG59O1xuXG5scC5wYXJzZUNsYXNzID0gZnVuY3Rpb24gKGlzU3RhdGVtZW50KSB7XG4gIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgdGhpcy5uZXh0KCk7XG4gIGlmICh0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLm5hbWUpIG5vZGUuaWQgPSB0aGlzLnBhcnNlSWRlbnQoKTtlbHNlIGlmIChpc1N0YXRlbWVudCkgbm9kZS5pZCA9IHRoaXMuZHVtbXlJZGVudCgpO2Vsc2Ugbm9kZS5pZCA9IG51bGw7XG4gIG5vZGUuc3VwZXJDbGFzcyA9IHRoaXMuZWF0KF8udG9rVHlwZXMuX2V4dGVuZHMpID8gdGhpcy5wYXJzZUV4cHJlc3Npb24oKSA6IG51bGw7XG4gIG5vZGUuYm9keSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gIG5vZGUuYm9keS5ib2R5ID0gW107XG4gIHRoaXMucHVzaEN4KCk7XG4gIHZhciBpbmRlbnQgPSB0aGlzLmN1ckluZGVudCArIDEsXG4gICAgICBsaW5lID0gdGhpcy5jdXJMaW5lU3RhcnQ7XG4gIHRoaXMuZWF0KF8udG9rVHlwZXMuYnJhY2VMKTtcbiAgaWYgKHRoaXMuY3VySW5kZW50ICsgMSA8IGluZGVudCkge1xuICAgIGluZGVudCA9IHRoaXMuY3VySW5kZW50O2xpbmUgPSB0aGlzLmN1ckxpbmVTdGFydDtcbiAgfVxuICB3aGlsZSAoIXRoaXMuY2xvc2VzKF8udG9rVHlwZXMuYnJhY2VSLCBpbmRlbnQsIGxpbmUpKSB7XG4gICAgaWYgKHRoaXMuc2VtaWNvbG9uKCkpIGNvbnRpbnVlO1xuICAgIHZhciBtZXRob2QgPSB0aGlzLnN0YXJ0Tm9kZSgpLFxuICAgICAgICBpc0dlbmVyYXRvciA9IHVuZGVmaW5lZDtcbiAgICBpZiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpIHtcbiAgICAgIG1ldGhvZFtcInN0YXRpY1wiXSA9IGZhbHNlO1xuICAgICAgaXNHZW5lcmF0b3IgPSB0aGlzLmVhdChfLnRva1R5cGVzLnN0YXIpO1xuICAgIH1cbiAgICB0aGlzLnBhcnNlUHJvcGVydHlOYW1lKG1ldGhvZCk7XG4gICAgaWYgKF9wYXJzZXV0aWwuaXNEdW1teShtZXRob2Qua2V5KSkge1xuICAgICAgaWYgKF9wYXJzZXV0aWwuaXNEdW1teSh0aGlzLnBhcnNlTWF5YmVBc3NpZ24oKSkpIHRoaXMubmV4dCgpO3RoaXMuZWF0KF8udG9rVHlwZXMuY29tbWEpO2NvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAobWV0aG9kLmtleS50eXBlID09PSBcIklkZW50aWZpZXJcIiAmJiAhbWV0aG9kLmNvbXB1dGVkICYmIG1ldGhvZC5rZXkubmFtZSA9PT0gXCJzdGF0aWNcIiAmJiAodGhpcy50b2sudHlwZSAhPSBfLnRva1R5cGVzLnBhcmVuTCAmJiB0aGlzLnRvay50eXBlICE9IF8udG9rVHlwZXMuYnJhY2VMKSkge1xuICAgICAgbWV0aG9kW1wic3RhdGljXCJdID0gdHJ1ZTtcbiAgICAgIGlzR2VuZXJhdG9yID0gdGhpcy5lYXQoXy50b2tUeXBlcy5zdGFyKTtcbiAgICAgIHRoaXMucGFyc2VQcm9wZXJ0eU5hbWUobWV0aG9kKTtcbiAgICB9IGVsc2Uge1xuICAgICAgbWV0aG9kW1wic3RhdGljXCJdID0gZmFsc2U7XG4gICAgfVxuICAgIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNSAmJiBtZXRob2Qua2V5LnR5cGUgPT09IFwiSWRlbnRpZmllclwiICYmICFtZXRob2QuY29tcHV0ZWQgJiYgKG1ldGhvZC5rZXkubmFtZSA9PT0gXCJnZXRcIiB8fCBtZXRob2Qua2V5Lm5hbWUgPT09IFwic2V0XCIpICYmIHRoaXMudG9rLnR5cGUgIT09IF8udG9rVHlwZXMucGFyZW5MICYmIHRoaXMudG9rLnR5cGUgIT09IF8udG9rVHlwZXMuYnJhY2VMKSB7XG4gICAgICBtZXRob2Qua2luZCA9IG1ldGhvZC5rZXkubmFtZTtcbiAgICAgIHRoaXMucGFyc2VQcm9wZXJ0eU5hbWUobWV0aG9kKTtcbiAgICAgIG1ldGhvZC52YWx1ZSA9IHRoaXMucGFyc2VNZXRob2QoZmFsc2UpO1xuICAgIH0gZWxzZSB7XG4gICAgICBpZiAoIW1ldGhvZC5jb21wdXRlZCAmJiAhbWV0aG9kW1wic3RhdGljXCJdICYmICFpc0dlbmVyYXRvciAmJiAobWV0aG9kLmtleS50eXBlID09PSBcIklkZW50aWZpZXJcIiAmJiBtZXRob2Qua2V5Lm5hbWUgPT09IFwiY29uc3RydWN0b3JcIiB8fCBtZXRob2Qua2V5LnR5cGUgPT09IFwiTGl0ZXJhbFwiICYmIG1ldGhvZC5rZXkudmFsdWUgPT09IFwiY29uc3RydWN0b3JcIikpIHtcbiAgICAgICAgbWV0aG9kLmtpbmQgPSBcImNvbnN0cnVjdG9yXCI7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBtZXRob2Qua2luZCA9IFwibWV0aG9kXCI7XG4gICAgICB9XG4gICAgICBtZXRob2QudmFsdWUgPSB0aGlzLnBhcnNlTWV0aG9kKGlzR2VuZXJhdG9yKTtcbiAgICB9XG4gICAgbm9kZS5ib2R5LmJvZHkucHVzaCh0aGlzLmZpbmlzaE5vZGUobWV0aG9kLCBcIk1ldGhvZERlZmluaXRpb25cIikpO1xuICB9XG4gIHRoaXMucG9wQ3goKTtcbiAgaWYgKCF0aGlzLmVhdChfLnRva1R5cGVzLmJyYWNlUikpIHtcbiAgICAvLyBJZiB0aGVyZSBpcyBubyBjbG9zaW5nIGJyYWNlLCBtYWtlIHRoZSBub2RlIHNwYW4gdG8gdGhlIHN0YXJ0XG4gICAgLy8gb2YgdGhlIG5leHQgdG9rZW4gKHRoaXMgaXMgdXNlZnVsIGZvciBUZXJuKVxuICAgIHRoaXMubGFzdC5lbmQgPSB0aGlzLnRvay5zdGFydDtcbiAgICBpZiAodGhpcy5vcHRpb25zLmxvY2F0aW9ucykgdGhpcy5sYXN0LmxvYy5lbmQgPSB0aGlzLnRvay5sb2Muc3RhcnQ7XG4gIH1cbiAgdGhpcy5zZW1pY29sb24oKTtcbiAgdGhpcy5maW5pc2hOb2RlKG5vZGUuYm9keSwgXCJDbGFzc0JvZHlcIik7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgaXNTdGF0ZW1lbnQgPyBcIkNsYXNzRGVjbGFyYXRpb25cIiA6IFwiQ2xhc3NFeHByZXNzaW9uXCIpO1xufTtcblxubHAucGFyc2VGdW5jdGlvbiA9IGZ1bmN0aW9uIChub2RlLCBpc1N0YXRlbWVudCkge1xuICB0aGlzLmluaXRGdW5jdGlvbihub2RlKTtcbiAgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KSB7XG4gICAgbm9kZS5nZW5lcmF0b3IgPSB0aGlzLmVhdChfLnRva1R5cGVzLnN0YXIpO1xuICB9XG4gIGlmICh0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLm5hbWUpIG5vZGUuaWQgPSB0aGlzLnBhcnNlSWRlbnQoKTtlbHNlIGlmIChpc1N0YXRlbWVudCkgbm9kZS5pZCA9IHRoaXMuZHVtbXlJZGVudCgpO1xuICBub2RlLnBhcmFtcyA9IHRoaXMucGFyc2VGdW5jdGlvblBhcmFtcygpO1xuICBub2RlLmJvZHkgPSB0aGlzLnBhcnNlQmxvY2soKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBpc1N0YXRlbWVudCA/IFwiRnVuY3Rpb25EZWNsYXJhdGlvblwiIDogXCJGdW5jdGlvbkV4cHJlc3Npb25cIik7XG59O1xuXG5scC5wYXJzZUV4cG9ydCA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICB0aGlzLm5leHQoKTtcbiAgaWYgKHRoaXMuZWF0KF8udG9rVHlwZXMuc3RhcikpIHtcbiAgICBub2RlLnNvdXJjZSA9IHRoaXMuZWF0Q29udGV4dHVhbChcImZyb21cIikgPyB0aGlzLnBhcnNlRXhwckF0b20oKSA6IG51bGw7XG4gICAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkV4cG9ydEFsbERlY2xhcmF0aW9uXCIpO1xuICB9XG4gIGlmICh0aGlzLmVhdChfLnRva1R5cGVzLl9kZWZhdWx0KSkge1xuICAgIHZhciBleHByID0gdGhpcy5wYXJzZU1heWJlQXNzaWduKCk7XG4gICAgaWYgKGV4cHIuaWQpIHtcbiAgICAgIHN3aXRjaCAoZXhwci50eXBlKSB7XG4gICAgICAgIGNhc2UgXCJGdW5jdGlvbkV4cHJlc3Npb25cIjpcbiAgICAgICAgICBleHByLnR5cGUgPSBcIkZ1bmN0aW9uRGVjbGFyYXRpb25cIjticmVhaztcbiAgICAgICAgY2FzZSBcIkNsYXNzRXhwcmVzc2lvblwiOlxuICAgICAgICAgIGV4cHIudHlwZSA9IFwiQ2xhc3NEZWNsYXJhdGlvblwiO2JyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgICBub2RlLmRlY2xhcmF0aW9uID0gZXhwcjtcbiAgICB0aGlzLnNlbWljb2xvbigpO1xuICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJFeHBvcnREZWZhdWx0RGVjbGFyYXRpb25cIik7XG4gIH1cbiAgaWYgKHRoaXMudG9rLnR5cGUua2V5d29yZCkge1xuICAgIG5vZGUuZGVjbGFyYXRpb24gPSB0aGlzLnBhcnNlU3RhdGVtZW50KCk7XG4gICAgbm9kZS5zcGVjaWZpZXJzID0gW107XG4gICAgbm9kZS5zb3VyY2UgPSBudWxsO1xuICB9IGVsc2Uge1xuICAgIG5vZGUuZGVjbGFyYXRpb24gPSBudWxsO1xuICAgIG5vZGUuc3BlY2lmaWVycyA9IHRoaXMucGFyc2VFeHBvcnRTcGVjaWZpZXJMaXN0KCk7XG4gICAgbm9kZS5zb3VyY2UgPSB0aGlzLmVhdENvbnRleHR1YWwoXCJmcm9tXCIpID8gdGhpcy5wYXJzZUV4cHJBdG9tKCkgOiBudWxsO1xuICAgIHRoaXMuc2VtaWNvbG9uKCk7XG4gIH1cbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkV4cG9ydE5hbWVkRGVjbGFyYXRpb25cIik7XG59O1xuXG5scC5wYXJzZUltcG9ydCA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICB0aGlzLm5leHQoKTtcbiAgaWYgKHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMuc3RyaW5nKSB7XG4gICAgbm9kZS5zcGVjaWZpZXJzID0gW107XG4gICAgbm9kZS5zb3VyY2UgPSB0aGlzLnBhcnNlRXhwckF0b20oKTtcbiAgICBub2RlLmtpbmQgPSAnJztcbiAgfSBlbHNlIHtcbiAgICB2YXIgZWx0ID0gdW5kZWZpbmVkO1xuICAgIGlmICh0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLm5hbWUgJiYgdGhpcy50b2sudmFsdWUgIT09IFwiZnJvbVwiKSB7XG4gICAgICBlbHQgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICAgICAgZWx0LmxvY2FsID0gdGhpcy5wYXJzZUlkZW50KCk7XG4gICAgICB0aGlzLmZpbmlzaE5vZGUoZWx0LCBcIkltcG9ydERlZmF1bHRTcGVjaWZpZXJcIik7XG4gICAgICB0aGlzLmVhdChfLnRva1R5cGVzLmNvbW1hKTtcbiAgICB9XG4gICAgbm9kZS5zcGVjaWZpZXJzID0gdGhpcy5wYXJzZUltcG9ydFNwZWNpZmllckxpc3QoKTtcbiAgICBub2RlLnNvdXJjZSA9IHRoaXMuZWF0Q29udGV4dHVhbChcImZyb21cIikgPyB0aGlzLnBhcnNlRXhwckF0b20oKSA6IG51bGw7XG4gICAgaWYgKGVsdCkgbm9kZS5zcGVjaWZpZXJzLnVuc2hpZnQoZWx0KTtcbiAgfVxuICB0aGlzLnNlbWljb2xvbigpO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiSW1wb3J0RGVjbGFyYXRpb25cIik7XG59O1xuXG5scC5wYXJzZUltcG9ydFNwZWNpZmllckxpc3QgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBlbHRzID0gW107XG4gIGlmICh0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLnN0YXIpIHtcbiAgICB2YXIgZWx0ID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgICB0aGlzLm5leHQoKTtcbiAgICBpZiAodGhpcy5lYXRDb250ZXh0dWFsKFwiYXNcIikpIGVsdC5sb2NhbCA9IHRoaXMucGFyc2VJZGVudCgpO1xuICAgIGVsdHMucHVzaCh0aGlzLmZpbmlzaE5vZGUoZWx0LCBcIkltcG9ydE5hbWVzcGFjZVNwZWNpZmllclwiKSk7XG4gIH0gZWxzZSB7XG4gICAgdmFyIGluZGVudCA9IHRoaXMuY3VySW5kZW50LFxuICAgICAgICBsaW5lID0gdGhpcy5jdXJMaW5lU3RhcnQsXG4gICAgICAgIGNvbnRpbnVlZExpbmUgPSB0aGlzLm5leHRMaW5lU3RhcnQ7XG4gICAgdGhpcy5wdXNoQ3goKTtcbiAgICB0aGlzLmVhdChfLnRva1R5cGVzLmJyYWNlTCk7XG4gICAgaWYgKHRoaXMuY3VyTGluZVN0YXJ0ID4gY29udGludWVkTGluZSkgY29udGludWVkTGluZSA9IHRoaXMuY3VyTGluZVN0YXJ0O1xuICAgIHdoaWxlICghdGhpcy5jbG9zZXMoXy50b2tUeXBlcy5icmFjZVIsIGluZGVudCArICh0aGlzLmN1ckxpbmVTdGFydCA8PSBjb250aW51ZWRMaW5lID8gMSA6IDApLCBsaW5lKSkge1xuICAgICAgdmFyIGVsdCA9IHRoaXMuc3RhcnROb2RlKCk7XG4gICAgICBpZiAodGhpcy5lYXQoXy50b2tUeXBlcy5zdGFyKSkge1xuICAgICAgICBpZiAodGhpcy5lYXRDb250ZXh0dWFsKFwiYXNcIikpIGVsdC5sb2NhbCA9IHRoaXMucGFyc2VJZGVudCgpO1xuICAgICAgICB0aGlzLmZpbmlzaE5vZGUoZWx0LCBcIkltcG9ydE5hbWVzcGFjZVNwZWNpZmllclwiKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGlmICh0aGlzLmlzQ29udGV4dHVhbChcImZyb21cIikpIGJyZWFrO1xuICAgICAgICBlbHQuaW1wb3J0ZWQgPSB0aGlzLnBhcnNlSWRlbnQoKTtcbiAgICAgICAgaWYgKF9wYXJzZXV0aWwuaXNEdW1teShlbHQuaW1wb3J0ZWQpKSBicmVhaztcbiAgICAgICAgZWx0LmxvY2FsID0gdGhpcy5lYXRDb250ZXh0dWFsKFwiYXNcIikgPyB0aGlzLnBhcnNlSWRlbnQoKSA6IGVsdC5pbXBvcnRlZDtcbiAgICAgICAgdGhpcy5maW5pc2hOb2RlKGVsdCwgXCJJbXBvcnRTcGVjaWZpZXJcIik7XG4gICAgICB9XG4gICAgICBlbHRzLnB1c2goZWx0KTtcbiAgICAgIHRoaXMuZWF0KF8udG9rVHlwZXMuY29tbWEpO1xuICAgIH1cbiAgICB0aGlzLmVhdChfLnRva1R5cGVzLmJyYWNlUik7XG4gICAgdGhpcy5wb3BDeCgpO1xuICB9XG4gIHJldHVybiBlbHRzO1xufTtcblxubHAucGFyc2VFeHBvcnRTcGVjaWZpZXJMaXN0ID0gZnVuY3Rpb24gKCkge1xuICB2YXIgZWx0cyA9IFtdO1xuICB2YXIgaW5kZW50ID0gdGhpcy5jdXJJbmRlbnQsXG4gICAgICBsaW5lID0gdGhpcy5jdXJMaW5lU3RhcnQsXG4gICAgICBjb250aW51ZWRMaW5lID0gdGhpcy5uZXh0TGluZVN0YXJ0O1xuICB0aGlzLnB1c2hDeCgpO1xuICB0aGlzLmVhdChfLnRva1R5cGVzLmJyYWNlTCk7XG4gIGlmICh0aGlzLmN1ckxpbmVTdGFydCA+IGNvbnRpbnVlZExpbmUpIGNvbnRpbnVlZExpbmUgPSB0aGlzLmN1ckxpbmVTdGFydDtcbiAgd2hpbGUgKCF0aGlzLmNsb3NlcyhfLnRva1R5cGVzLmJyYWNlUiwgaW5kZW50ICsgKHRoaXMuY3VyTGluZVN0YXJ0IDw9IGNvbnRpbnVlZExpbmUgPyAxIDogMCksIGxpbmUpKSB7XG4gICAgaWYgKHRoaXMuaXNDb250ZXh0dWFsKFwiZnJvbVwiKSkgYnJlYWs7XG4gICAgdmFyIGVsdCA9IHRoaXMuc3RhcnROb2RlKCk7XG4gICAgZWx0LmxvY2FsID0gdGhpcy5wYXJzZUlkZW50KCk7XG4gICAgaWYgKF9wYXJzZXV0aWwuaXNEdW1teShlbHQubG9jYWwpKSBicmVhaztcbiAgICBlbHQuZXhwb3J0ZWQgPSB0aGlzLmVhdENvbnRleHR1YWwoXCJhc1wiKSA/IHRoaXMucGFyc2VJZGVudCgpIDogZWx0LmxvY2FsO1xuICAgIHRoaXMuZmluaXNoTm9kZShlbHQsIFwiRXhwb3J0U3BlY2lmaWVyXCIpO1xuICAgIGVsdHMucHVzaChlbHQpO1xuICAgIHRoaXMuZWF0KF8udG9rVHlwZXMuY29tbWEpO1xuICB9XG4gIHRoaXMuZWF0KF8udG9rVHlwZXMuYnJhY2VSKTtcbiAgdGhpcy5wb3BDeCgpO1xuICByZXR1cm4gZWx0cztcbn07XG5cbn0se1wiLi5cIjoyLFwiLi9wYXJzZXV0aWxcIjo1LFwiLi9zdGF0ZVwiOjZ9XSw4OltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXtcblwidXNlIHN0cmljdFwiO1xuXG52YXIgXyA9IF9kZXJlcV8oXCIuLlwiKTtcblxudmFyIF9zdGF0ZSA9IF9kZXJlcV8oXCIuL3N0YXRlXCIpO1xuXG52YXIgbHAgPSBfc3RhdGUuTG9vc2VQYXJzZXIucHJvdG90eXBlO1xuXG5mdW5jdGlvbiBpc1NwYWNlKGNoKSB7XG4gIHJldHVybiBjaCA8IDE0ICYmIGNoID4gOCB8fCBjaCA9PT0gMzIgfHwgY2ggPT09IDE2MCB8fCBfLmlzTmV3TGluZShjaCk7XG59XG5cbmxwLm5leHQgPSBmdW5jdGlvbiAoKSB7XG4gIHRoaXMubGFzdCA9IHRoaXMudG9rO1xuICBpZiAodGhpcy5haGVhZC5sZW5ndGgpIHRoaXMudG9rID0gdGhpcy5haGVhZC5zaGlmdCgpO2Vsc2UgdGhpcy50b2sgPSB0aGlzLnJlYWRUb2tlbigpO1xuXG4gIGlmICh0aGlzLnRvay5zdGFydCA+PSB0aGlzLm5leHRMaW5lU3RhcnQpIHtcbiAgICB3aGlsZSAodGhpcy50b2suc3RhcnQgPj0gdGhpcy5uZXh0TGluZVN0YXJ0KSB7XG4gICAgICB0aGlzLmN1ckxpbmVTdGFydCA9IHRoaXMubmV4dExpbmVTdGFydDtcbiAgICAgIHRoaXMubmV4dExpbmVTdGFydCA9IHRoaXMubGluZUVuZCh0aGlzLmN1ckxpbmVTdGFydCkgKyAxO1xuICAgIH1cbiAgICB0aGlzLmN1ckluZGVudCA9IHRoaXMuaW5kZW50YXRpb25BZnRlcih0aGlzLmN1ckxpbmVTdGFydCk7XG4gIH1cbn07XG5cbmxwLnJlYWRUb2tlbiA9IGZ1bmN0aW9uICgpIHtcbiAgZm9yICg7Oykge1xuICAgIHRyeSB7XG4gICAgICB0aGlzLnRva3MubmV4dCgpO1xuICAgICAgaWYgKHRoaXMudG9rcy50eXBlID09PSBfLnRva1R5cGVzLmRvdCAmJiB0aGlzLmlucHV0LnN1YnN0cih0aGlzLnRva3MuZW5kLCAxKSA9PT0gXCIuXCIgJiYgdGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpIHtcbiAgICAgICAgdGhpcy50b2tzLmVuZCsrO1xuICAgICAgICB0aGlzLnRva3MudHlwZSA9IF8udG9rVHlwZXMuZWxsaXBzaXM7XG4gICAgICB9XG4gICAgICByZXR1cm4gbmV3IF8uVG9rZW4odGhpcy50b2tzKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAoIShlIGluc3RhbmNlb2YgU3ludGF4RXJyb3IpKSB0aHJvdyBlO1xuXG4gICAgICAvLyBUcnkgdG8gc2tpcCBzb21lIHRleHQsIGJhc2VkIG9uIHRoZSBlcnJvciBtZXNzYWdlLCBhbmQgdGhlbiBjb250aW51ZVxuICAgICAgdmFyIG1zZyA9IGUubWVzc2FnZSxcbiAgICAgICAgICBwb3MgPSBlLnJhaXNlZEF0LFxuICAgICAgICAgIHJlcGxhY2UgPSB0cnVlO1xuICAgICAgaWYgKC91bnRlcm1pbmF0ZWQvaS50ZXN0KG1zZykpIHtcbiAgICAgICAgcG9zID0gdGhpcy5saW5lRW5kKGUucG9zICsgMSk7XG4gICAgICAgIGlmICgvc3RyaW5nLy50ZXN0KG1zZykpIHtcbiAgICAgICAgICByZXBsYWNlID0geyBzdGFydDogZS5wb3MsIGVuZDogcG9zLCB0eXBlOiBfLnRva1R5cGVzLnN0cmluZywgdmFsdWU6IHRoaXMuaW5wdXQuc2xpY2UoZS5wb3MgKyAxLCBwb3MpIH07XG4gICAgICAgIH0gZWxzZSBpZiAoL3JlZ3VsYXIgZXhwci9pLnRlc3QobXNnKSkge1xuICAgICAgICAgIHZhciByZSA9IHRoaXMuaW5wdXQuc2xpY2UoZS5wb3MsIHBvcyk7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHJlID0gbmV3IFJlZ0V4cChyZSk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge31cbiAgICAgICAgICByZXBsYWNlID0geyBzdGFydDogZS5wb3MsIGVuZDogcG9zLCB0eXBlOiBfLnRva1R5cGVzLnJlZ2V4cCwgdmFsdWU6IHJlIH07XG4gICAgICAgIH0gZWxzZSBpZiAoL3RlbXBsYXRlLy50ZXN0KG1zZykpIHtcbiAgICAgICAgICByZXBsYWNlID0geyBzdGFydDogZS5wb3MsIGVuZDogcG9zLFxuICAgICAgICAgICAgdHlwZTogXy50b2tUeXBlcy50ZW1wbGF0ZSxcbiAgICAgICAgICAgIHZhbHVlOiB0aGlzLmlucHV0LnNsaWNlKGUucG9zLCBwb3MpIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmVwbGFjZSA9IGZhbHNlO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKC9pbnZhbGlkICh1bmljb2RlfHJlZ2V4cHxudW1iZXIpfGV4cGVjdGluZyB1bmljb2RlfG9jdGFsIGxpdGVyYWx8aXMgcmVzZXJ2ZWR8ZGlyZWN0bHkgYWZ0ZXIgbnVtYmVyfGV4cGVjdGVkIG51bWJlciBpbiByYWRpeC9pLnRlc3QobXNnKSkge1xuICAgICAgICB3aGlsZSAocG9zIDwgdGhpcy5pbnB1dC5sZW5ndGggJiYgIWlzU3BhY2UodGhpcy5pbnB1dC5jaGFyQ29kZUF0KHBvcykpKSArK3BvcztcbiAgICAgIH0gZWxzZSBpZiAoL2NoYXJhY3RlciBlc2NhcGV8ZXhwZWN0ZWQgaGV4YWRlY2ltYWwvaS50ZXN0KG1zZykpIHtcbiAgICAgICAgd2hpbGUgKHBvcyA8IHRoaXMuaW5wdXQubGVuZ3RoKSB7XG4gICAgICAgICAgdmFyIGNoID0gdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHBvcysrKTtcbiAgICAgICAgICBpZiAoY2ggPT09IDM0IHx8IGNoID09PSAzOSB8fCBfLmlzTmV3TGluZShjaCkpIGJyZWFrO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKC91bmV4cGVjdGVkIGNoYXJhY3Rlci9pLnRlc3QobXNnKSkge1xuICAgICAgICBwb3MrKztcbiAgICAgICAgcmVwbGFjZSA9IGZhbHNlO1xuICAgICAgfSBlbHNlIGlmICgvcmVndWxhciBleHByZXNzaW9uL2kudGVzdChtc2cpKSB7XG4gICAgICAgIHJlcGxhY2UgPSB0cnVlO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgZTtcbiAgICAgIH1cbiAgICAgIHRoaXMucmVzZXRUbyhwb3MpO1xuICAgICAgaWYgKHJlcGxhY2UgPT09IHRydWUpIHJlcGxhY2UgPSB7IHN0YXJ0OiBwb3MsIGVuZDogcG9zLCB0eXBlOiBfLnRva1R5cGVzLm5hbWUsIHZhbHVlOiBcIuKcllwiIH07XG4gICAgICBpZiAocmVwbGFjZSkge1xuICAgICAgICBpZiAodGhpcy5vcHRpb25zLmxvY2F0aW9ucykgcmVwbGFjZS5sb2MgPSBuZXcgXy5Tb3VyY2VMb2NhdGlvbih0aGlzLnRva3MsIF8uZ2V0TGluZUluZm8odGhpcy5pbnB1dCwgcmVwbGFjZS5zdGFydCksIF8uZ2V0TGluZUluZm8odGhpcy5pbnB1dCwgcmVwbGFjZS5lbmQpKTtcbiAgICAgICAgcmV0dXJuIHJlcGxhY2U7XG4gICAgICB9XG4gICAgfVxuICB9XG59O1xuXG5scC5yZXNldFRvID0gZnVuY3Rpb24gKHBvcykge1xuICB0aGlzLnRva3MucG9zID0gcG9zO1xuICB2YXIgY2ggPSB0aGlzLmlucHV0LmNoYXJBdChwb3MgLSAxKTtcbiAgdGhpcy50b2tzLmV4cHJBbGxvd2VkID0gIWNoIHx8IC9bXFxbXFx7XFwoLDs6P1xcLyo9K1xcLX4hfCYlXjw+XS8udGVzdChjaCkgfHwgL1tlbndmZF0vLnRlc3QoY2gpICYmIC9cXGIoa2V5d29yZHN8Y2FzZXxlbHNlfHJldHVybnx0aHJvd3xuZXd8aW58KGluc3RhbmNlfHR5cGUpb2Z8ZGVsZXRlfHZvaWQpJC8udGVzdCh0aGlzLmlucHV0LnNsaWNlKHBvcyAtIDEwLCBwb3MpKTtcblxuICBpZiAodGhpcy5vcHRpb25zLmxvY2F0aW9ucykge1xuICAgIHRoaXMudG9rcy5jdXJMaW5lID0gMTtcbiAgICB0aGlzLnRva3MubGluZVN0YXJ0ID0gXy5saW5lQnJlYWtHLmxhc3RJbmRleCA9IDA7XG4gICAgdmFyIG1hdGNoID0gdW5kZWZpbmVkO1xuICAgIHdoaWxlICgobWF0Y2ggPSBfLmxpbmVCcmVha0cuZXhlYyh0aGlzLmlucHV0KSkgJiYgbWF0Y2guaW5kZXggPCBwb3MpIHtcbiAgICAgICsrdGhpcy50b2tzLmN1ckxpbmU7XG4gICAgICB0aGlzLnRva3MubGluZVN0YXJ0ID0gbWF0Y2guaW5kZXggKyBtYXRjaFswXS5sZW5ndGg7XG4gICAgfVxuICB9XG59O1xuXG5scC5sb29rQWhlYWQgPSBmdW5jdGlvbiAobikge1xuICB3aGlsZSAobiA+IHRoaXMuYWhlYWQubGVuZ3RoKSB0aGlzLmFoZWFkLnB1c2godGhpcy5yZWFkVG9rZW4oKSk7XG4gIHJldHVybiB0aGlzLmFoZWFkW24gLSAxXTtcbn07XG5cbn0se1wiLi5cIjoyLFwiLi9zdGF0ZVwiOjZ9XX0se30sWzRdKSg0KVxufSk7IiwiKGZ1bmN0aW9uKGYpe2lmKHR5cGVvZiBleHBvcnRzPT09XCJvYmplY3RcIiYmdHlwZW9mIG1vZHVsZSE9PVwidW5kZWZpbmVkXCIpe21vZHVsZS5leHBvcnRzPWYoKX1lbHNlIGlmKHR5cGVvZiBkZWZpbmU9PT1cImZ1bmN0aW9uXCImJmRlZmluZS5hbWQpe2RlZmluZShbXSxmKX1lbHNle3ZhciBnO2lmKHR5cGVvZiB3aW5kb3chPT1cInVuZGVmaW5lZFwiKXtnPXdpbmRvd31lbHNlIGlmKHR5cGVvZiBnbG9iYWwhPT1cInVuZGVmaW5lZFwiKXtnPWdsb2JhbH1lbHNlIGlmKHR5cGVvZiBzZWxmIT09XCJ1bmRlZmluZWRcIil7Zz1zZWxmfWVsc2V7Zz10aGlzfShnLmFjb3JuIHx8IChnLmFjb3JuID0ge30pKS53YWxrID0gZigpfX0pKGZ1bmN0aW9uKCl7dmFyIGRlZmluZSxtb2R1bGUsZXhwb3J0cztyZXR1cm4gKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt2YXIgZj1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpO3Rocm93IGYuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixmfXZhciBsPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChsLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGwsbC5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkoezE6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1xuLy8gQVNUIHdhbGtlciBtb2R1bGUgZm9yIE1vemlsbGEgUGFyc2VyIEFQSSBjb21wYXRpYmxlIHRyZWVzXG5cbi8vIEEgc2ltcGxlIHdhbGsgaXMgb25lIHdoZXJlIHlvdSBzaW1wbHkgc3BlY2lmeSBjYWxsYmFja3MgdG8gYmVcbi8vIGNhbGxlZCBvbiBzcGVjaWZpYyBub2Rlcy4gVGhlIGxhc3QgdHdvIGFyZ3VtZW50cyBhcmUgb3B0aW9uYWwuIEFcbi8vIHNpbXBsZSB1c2Ugd291bGQgYmVcbi8vXG4vLyAgICAgd2Fsay5zaW1wbGUobXlUcmVlLCB7XG4vLyAgICAgICAgIEV4cHJlc3Npb246IGZ1bmN0aW9uKG5vZGUpIHsgLi4uIH1cbi8vICAgICB9KTtcbi8vXG4vLyB0byBkbyBzb21ldGhpbmcgd2l0aCBhbGwgZXhwcmVzc2lvbnMuIEFsbCBQYXJzZXIgQVBJIG5vZGUgdHlwZXNcbi8vIGNhbiBiZSB1c2VkIHRvIGlkZW50aWZ5IG5vZGUgdHlwZXMsIGFzIHdlbGwgYXMgRXhwcmVzc2lvbixcbi8vIFN0YXRlbWVudCwgYW5kIFNjb3BlQm9keSwgd2hpY2ggZGVub3RlIGNhdGVnb3JpZXMgb2Ygbm9kZXMuXG4vL1xuLy8gVGhlIGJhc2UgYXJndW1lbnQgY2FuIGJlIHVzZWQgdG8gcGFzcyBhIGN1c3RvbSAocmVjdXJzaXZlKVxuLy8gd2Fsa2VyLCBhbmQgc3RhdGUgY2FuIGJlIHVzZWQgdG8gZ2l2ZSB0aGlzIHdhbGtlZCBhbiBpbml0aWFsXG4vLyBzdGF0ZS5cblxuXCJ1c2Ugc3RyaWN0XCI7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5leHBvcnRzLnNpbXBsZSA9IHNpbXBsZTtcbmV4cG9ydHMuYW5jZXN0b3IgPSBhbmNlc3RvcjtcbmV4cG9ydHMucmVjdXJzaXZlID0gcmVjdXJzaXZlO1xuZXhwb3J0cy5maW5kTm9kZUF0ID0gZmluZE5vZGVBdDtcbmV4cG9ydHMuZmluZE5vZGVBcm91bmQgPSBmaW5kTm9kZUFyb3VuZDtcbmV4cG9ydHMuZmluZE5vZGVBZnRlciA9IGZpbmROb2RlQWZ0ZXI7XG5leHBvcnRzLmZpbmROb2RlQmVmb3JlID0gZmluZE5vZGVCZWZvcmU7XG5leHBvcnRzLm1ha2UgPSBtYWtlO1xuXG5mdW5jdGlvbiBfY2xhc3NDYWxsQ2hlY2soaW5zdGFuY2UsIENvbnN0cnVjdG9yKSB7IGlmICghKGluc3RhbmNlIGluc3RhbmNlb2YgQ29uc3RydWN0b3IpKSB7IHRocm93IG5ldyBUeXBlRXJyb3IoXCJDYW5ub3QgY2FsbCBhIGNsYXNzIGFzIGEgZnVuY3Rpb25cIik7IH0gfVxuXG5mdW5jdGlvbiBzaW1wbGUobm9kZSwgdmlzaXRvcnMsIGJhc2UsIHN0YXRlLCBvdmVycmlkZSkge1xuICBpZiAoIWJhc2UpIGJhc2UgPSBleHBvcnRzLmJhc2U7KGZ1bmN0aW9uIGMobm9kZSwgc3QsIG92ZXJyaWRlKSB7XG4gICAgdmFyIHR5cGUgPSBvdmVycmlkZSB8fCBub2RlLnR5cGUsXG4gICAgICAgIGZvdW5kID0gdmlzaXRvcnNbdHlwZV07XG4gICAgYmFzZVt0eXBlXShub2RlLCBzdCwgYyk7XG4gICAgaWYgKGZvdW5kKSBmb3VuZChub2RlLCBzdCk7XG4gIH0pKG5vZGUsIHN0YXRlLCBvdmVycmlkZSk7XG59XG5cbi8vIEFuIGFuY2VzdG9yIHdhbGsgYnVpbGRzIHVwIGFuIGFycmF5IG9mIGFuY2VzdG9yIG5vZGVzIChpbmNsdWRpbmdcbi8vIHRoZSBjdXJyZW50IG5vZGUpIGFuZCBwYXNzZXMgdGhlbSB0byB0aGUgY2FsbGJhY2sgYXMgdGhlIHN0YXRlIHBhcmFtZXRlci5cblxuZnVuY3Rpb24gYW5jZXN0b3Iobm9kZSwgdmlzaXRvcnMsIGJhc2UsIHN0YXRlKSB7XG4gIGlmICghYmFzZSkgYmFzZSA9IGV4cG9ydHMuYmFzZTtcbiAgaWYgKCFzdGF0ZSkgc3RhdGUgPSBbXTsoZnVuY3Rpb24gYyhub2RlLCBzdCwgb3ZlcnJpZGUpIHtcbiAgICB2YXIgdHlwZSA9IG92ZXJyaWRlIHx8IG5vZGUudHlwZSxcbiAgICAgICAgZm91bmQgPSB2aXNpdG9yc1t0eXBlXTtcbiAgICBpZiAobm9kZSAhPSBzdFtzdC5sZW5ndGggLSAxXSkge1xuICAgICAgc3QgPSBzdC5zbGljZSgpO1xuICAgICAgc3QucHVzaChub2RlKTtcbiAgICB9XG4gICAgYmFzZVt0eXBlXShub2RlLCBzdCwgYyk7XG4gICAgaWYgKGZvdW5kKSBmb3VuZChub2RlLCBzdCk7XG4gIH0pKG5vZGUsIHN0YXRlKTtcbn1cblxuLy8gQSByZWN1cnNpdmUgd2FsayBpcyBvbmUgd2hlcmUgeW91ciBmdW5jdGlvbnMgb3ZlcnJpZGUgdGhlIGRlZmF1bHRcbi8vIHdhbGtlcnMuIFRoZXkgY2FuIG1vZGlmeSBhbmQgcmVwbGFjZSB0aGUgc3RhdGUgcGFyYW1ldGVyIHRoYXQnc1xuLy8gdGhyZWFkZWQgdGhyb3VnaCB0aGUgd2FsaywgYW5kIGNhbiBvcHQgaG93IGFuZCB3aGV0aGVyIHRvIHdhbGtcbi8vIHRoZWlyIGNoaWxkIG5vZGVzIChieSBjYWxsaW5nIHRoZWlyIHRoaXJkIGFyZ3VtZW50IG9uIHRoZXNlXG4vLyBub2RlcykuXG5cbmZ1bmN0aW9uIHJlY3Vyc2l2ZShub2RlLCBzdGF0ZSwgZnVuY3MsIGJhc2UsIG92ZXJyaWRlKSB7XG4gIHZhciB2aXNpdG9yID0gZnVuY3MgPyBleHBvcnRzLm1ha2UoZnVuY3MsIGJhc2UpIDogYmFzZTsoZnVuY3Rpb24gYyhub2RlLCBzdCwgb3ZlcnJpZGUpIHtcbiAgICB2aXNpdG9yW292ZXJyaWRlIHx8IG5vZGUudHlwZV0obm9kZSwgc3QsIGMpO1xuICB9KShub2RlLCBzdGF0ZSwgb3ZlcnJpZGUpO1xufVxuXG5mdW5jdGlvbiBtYWtlVGVzdCh0ZXN0KSB7XG4gIGlmICh0eXBlb2YgdGVzdCA9PSBcInN0cmluZ1wiKSByZXR1cm4gZnVuY3Rpb24gKHR5cGUpIHtcbiAgICByZXR1cm4gdHlwZSA9PSB0ZXN0O1xuICB9O2Vsc2UgaWYgKCF0ZXN0KSByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0cnVlO1xuICB9O2Vsc2UgcmV0dXJuIHRlc3Q7XG59XG5cbnZhciBGb3VuZCA9IGZ1bmN0aW9uIEZvdW5kKG5vZGUsIHN0YXRlKSB7XG4gIF9jbGFzc0NhbGxDaGVjayh0aGlzLCBGb3VuZCk7XG5cbiAgdGhpcy5ub2RlID0gbm9kZTt0aGlzLnN0YXRlID0gc3RhdGU7XG59XG5cbi8vIEZpbmQgYSBub2RlIHdpdGggYSBnaXZlbiBzdGFydCwgZW5kLCBhbmQgdHlwZSAoYWxsIGFyZSBvcHRpb25hbCxcbi8vIG51bGwgY2FuIGJlIHVzZWQgYXMgd2lsZGNhcmQpLiBSZXR1cm5zIGEge25vZGUsIHN0YXRlfSBvYmplY3QsIG9yXG4vLyB1bmRlZmluZWQgd2hlbiBpdCBkb2Vzbid0IGZpbmQgYSBtYXRjaGluZyBub2RlLlxuO1xuXG5mdW5jdGlvbiBmaW5kTm9kZUF0KG5vZGUsIHN0YXJ0LCBlbmQsIHRlc3QsIGJhc2UsIHN0YXRlKSB7XG4gIHRlc3QgPSBtYWtlVGVzdCh0ZXN0KTtcbiAgaWYgKCFiYXNlKSBiYXNlID0gZXhwb3J0cy5iYXNlO1xuICB0cnkge1xuICAgIDsoZnVuY3Rpb24gYyhub2RlLCBzdCwgb3ZlcnJpZGUpIHtcbiAgICAgIHZhciB0eXBlID0gb3ZlcnJpZGUgfHwgbm9kZS50eXBlO1xuICAgICAgaWYgKChzdGFydCA9PSBudWxsIHx8IG5vZGUuc3RhcnQgPD0gc3RhcnQpICYmIChlbmQgPT0gbnVsbCB8fCBub2RlLmVuZCA+PSBlbmQpKSBiYXNlW3R5cGVdKG5vZGUsIHN0LCBjKTtcbiAgICAgIGlmICh0ZXN0KHR5cGUsIG5vZGUpICYmIChzdGFydCA9PSBudWxsIHx8IG5vZGUuc3RhcnQgPT0gc3RhcnQpICYmIChlbmQgPT0gbnVsbCB8fCBub2RlLmVuZCA9PSBlbmQpKSB0aHJvdyBuZXcgRm91bmQobm9kZSwgc3QpO1xuICAgIH0pKG5vZGUsIHN0YXRlKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmIChlIGluc3RhbmNlb2YgRm91bmQpIHJldHVybiBlO1xuICAgIHRocm93IGU7XG4gIH1cbn1cblxuLy8gRmluZCB0aGUgaW5uZXJtb3N0IG5vZGUgb2YgYSBnaXZlbiB0eXBlIHRoYXQgY29udGFpbnMgdGhlIGdpdmVuXG4vLyBwb3NpdGlvbi4gSW50ZXJmYWNlIHNpbWlsYXIgdG8gZmluZE5vZGVBdC5cblxuZnVuY3Rpb24gZmluZE5vZGVBcm91bmQobm9kZSwgcG9zLCB0ZXN0LCBiYXNlLCBzdGF0ZSkge1xuICB0ZXN0ID0gbWFrZVRlc3QodGVzdCk7XG4gIGlmICghYmFzZSkgYmFzZSA9IGV4cG9ydHMuYmFzZTtcbiAgdHJ5IHtcbiAgICA7KGZ1bmN0aW9uIGMobm9kZSwgc3QsIG92ZXJyaWRlKSB7XG4gICAgICB2YXIgdHlwZSA9IG92ZXJyaWRlIHx8IG5vZGUudHlwZTtcbiAgICAgIGlmIChub2RlLnN0YXJ0ID4gcG9zIHx8IG5vZGUuZW5kIDwgcG9zKSByZXR1cm47XG4gICAgICBiYXNlW3R5cGVdKG5vZGUsIHN0LCBjKTtcbiAgICAgIGlmICh0ZXN0KHR5cGUsIG5vZGUpKSB0aHJvdyBuZXcgRm91bmQobm9kZSwgc3QpO1xuICAgIH0pKG5vZGUsIHN0YXRlKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmIChlIGluc3RhbmNlb2YgRm91bmQpIHJldHVybiBlO1xuICAgIHRocm93IGU7XG4gIH1cbn1cblxuLy8gRmluZCB0aGUgb3V0ZXJtb3N0IG1hdGNoaW5nIG5vZGUgYWZ0ZXIgYSBnaXZlbiBwb3NpdGlvbi5cblxuZnVuY3Rpb24gZmluZE5vZGVBZnRlcihub2RlLCBwb3MsIHRlc3QsIGJhc2UsIHN0YXRlKSB7XG4gIHRlc3QgPSBtYWtlVGVzdCh0ZXN0KTtcbiAgaWYgKCFiYXNlKSBiYXNlID0gZXhwb3J0cy5iYXNlO1xuICB0cnkge1xuICAgIDsoZnVuY3Rpb24gYyhub2RlLCBzdCwgb3ZlcnJpZGUpIHtcbiAgICAgIGlmIChub2RlLmVuZCA8IHBvcykgcmV0dXJuO1xuICAgICAgdmFyIHR5cGUgPSBvdmVycmlkZSB8fCBub2RlLnR5cGU7XG4gICAgICBpZiAobm9kZS5zdGFydCA+PSBwb3MgJiYgdGVzdCh0eXBlLCBub2RlKSkgdGhyb3cgbmV3IEZvdW5kKG5vZGUsIHN0KTtcbiAgICAgIGJhc2VbdHlwZV0obm9kZSwgc3QsIGMpO1xuICAgIH0pKG5vZGUsIHN0YXRlKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmIChlIGluc3RhbmNlb2YgRm91bmQpIHJldHVybiBlO1xuICAgIHRocm93IGU7XG4gIH1cbn1cblxuLy8gRmluZCB0aGUgb3V0ZXJtb3N0IG1hdGNoaW5nIG5vZGUgYmVmb3JlIGEgZ2l2ZW4gcG9zaXRpb24uXG5cbmZ1bmN0aW9uIGZpbmROb2RlQmVmb3JlKG5vZGUsIHBvcywgdGVzdCwgYmFzZSwgc3RhdGUpIHtcbiAgdGVzdCA9IG1ha2VUZXN0KHRlc3QpO1xuICBpZiAoIWJhc2UpIGJhc2UgPSBleHBvcnRzLmJhc2U7XG4gIHZhciBtYXggPSB1bmRlZmluZWQ7KGZ1bmN0aW9uIGMobm9kZSwgc3QsIG92ZXJyaWRlKSB7XG4gICAgaWYgKG5vZGUuc3RhcnQgPiBwb3MpIHJldHVybjtcbiAgICB2YXIgdHlwZSA9IG92ZXJyaWRlIHx8IG5vZGUudHlwZTtcbiAgICBpZiAobm9kZS5lbmQgPD0gcG9zICYmICghbWF4IHx8IG1heC5ub2RlLmVuZCA8IG5vZGUuZW5kKSAmJiB0ZXN0KHR5cGUsIG5vZGUpKSBtYXggPSBuZXcgRm91bmQobm9kZSwgc3QpO1xuICAgIGJhc2VbdHlwZV0obm9kZSwgc3QsIGMpO1xuICB9KShub2RlLCBzdGF0ZSk7XG4gIHJldHVybiBtYXg7XG59XG5cbi8vIFVzZWQgdG8gY3JlYXRlIGEgY3VzdG9tIHdhbGtlci4gV2lsbCBmaWxsIGluIGFsbCBtaXNzaW5nIG5vZGVcbi8vIHR5cGUgcHJvcGVydGllcyB3aXRoIHRoZSBkZWZhdWx0cy5cblxuZnVuY3Rpb24gbWFrZShmdW5jcywgYmFzZSkge1xuICBpZiAoIWJhc2UpIGJhc2UgPSBleHBvcnRzLmJhc2U7XG4gIHZhciB2aXNpdG9yID0ge307XG4gIGZvciAodmFyIHR5cGUgaW4gYmFzZSkgdmlzaXRvclt0eXBlXSA9IGJhc2VbdHlwZV07XG4gIGZvciAodmFyIHR5cGUgaW4gZnVuY3MpIHZpc2l0b3JbdHlwZV0gPSBmdW5jc1t0eXBlXTtcbiAgcmV0dXJuIHZpc2l0b3I7XG59XG5cbmZ1bmN0aW9uIHNraXBUaHJvdWdoKG5vZGUsIHN0LCBjKSB7XG4gIGMobm9kZSwgc3QpO1xufVxuZnVuY3Rpb24gaWdub3JlKF9ub2RlLCBfc3QsIF9jKSB7fVxuXG4vLyBOb2RlIHdhbGtlcnMuXG5cbnZhciBiYXNlID0ge307XG5cbmV4cG9ydHMuYmFzZSA9IGJhc2U7XG5iYXNlLlByb2dyYW0gPSBiYXNlLkJsb2NrU3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgbm9kZS5ib2R5Lmxlbmd0aDsgKytpKSB7XG4gICAgYyhub2RlLmJvZHlbaV0sIHN0LCBcIlN0YXRlbWVudFwiKTtcbiAgfVxufTtcbmJhc2UuU3RhdGVtZW50ID0gc2tpcFRocm91Z2g7XG5iYXNlLkVtcHR5U3RhdGVtZW50ID0gaWdub3JlO1xuYmFzZS5FeHByZXNzaW9uU3RhdGVtZW50ID0gYmFzZS5QYXJlbnRoZXNpemVkRXhwcmVzc2lvbiA9IGZ1bmN0aW9uIChub2RlLCBzdCwgYykge1xuICByZXR1cm4gYyhub2RlLmV4cHJlc3Npb24sIHN0LCBcIkV4cHJlc3Npb25cIik7XG59O1xuYmFzZS5JZlN0YXRlbWVudCA9IGZ1bmN0aW9uIChub2RlLCBzdCwgYykge1xuICBjKG5vZGUudGVzdCwgc3QsIFwiRXhwcmVzc2lvblwiKTtcbiAgYyhub2RlLmNvbnNlcXVlbnQsIHN0LCBcIlN0YXRlbWVudFwiKTtcbiAgaWYgKG5vZGUuYWx0ZXJuYXRlKSBjKG5vZGUuYWx0ZXJuYXRlLCBzdCwgXCJTdGF0ZW1lbnRcIik7XG59O1xuYmFzZS5MYWJlbGVkU3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIHJldHVybiBjKG5vZGUuYm9keSwgc3QsIFwiU3RhdGVtZW50XCIpO1xufTtcbmJhc2UuQnJlYWtTdGF0ZW1lbnQgPSBiYXNlLkNvbnRpbnVlU3RhdGVtZW50ID0gaWdub3JlO1xuYmFzZS5XaXRoU3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIGMobm9kZS5vYmplY3QsIHN0LCBcIkV4cHJlc3Npb25cIik7XG4gIGMobm9kZS5ib2R5LCBzdCwgXCJTdGF0ZW1lbnRcIik7XG59O1xuYmFzZS5Td2l0Y2hTdGF0ZW1lbnQgPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgYyhub2RlLmRpc2NyaW1pbmFudCwgc3QsIFwiRXhwcmVzc2lvblwiKTtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBub2RlLmNhc2VzLmxlbmd0aDsgKytpKSB7XG4gICAgdmFyIGNzID0gbm9kZS5jYXNlc1tpXTtcbiAgICBpZiAoY3MudGVzdCkgYyhjcy50ZXN0LCBzdCwgXCJFeHByZXNzaW9uXCIpO1xuICAgIGZvciAodmFyIGogPSAwOyBqIDwgY3MuY29uc2VxdWVudC5sZW5ndGg7ICsraikge1xuICAgICAgYyhjcy5jb25zZXF1ZW50W2pdLCBzdCwgXCJTdGF0ZW1lbnRcIik7XG4gICAgfVxuICB9XG59O1xuYmFzZS5SZXR1cm5TdGF0ZW1lbnQgPSBiYXNlLllpZWxkRXhwcmVzc2lvbiA9IGZ1bmN0aW9uIChub2RlLCBzdCwgYykge1xuICBpZiAobm9kZS5hcmd1bWVudCkgYyhub2RlLmFyZ3VtZW50LCBzdCwgXCJFeHByZXNzaW9uXCIpO1xufTtcbmJhc2UuVGhyb3dTdGF0ZW1lbnQgPSBiYXNlLlNwcmVhZEVsZW1lbnQgPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgcmV0dXJuIGMobm9kZS5hcmd1bWVudCwgc3QsIFwiRXhwcmVzc2lvblwiKTtcbn07XG5iYXNlLlRyeVN0YXRlbWVudCA9IGZ1bmN0aW9uIChub2RlLCBzdCwgYykge1xuICBjKG5vZGUuYmxvY2ssIHN0LCBcIlN0YXRlbWVudFwiKTtcbiAgaWYgKG5vZGUuaGFuZGxlcikge1xuICAgIGMobm9kZS5oYW5kbGVyLnBhcmFtLCBzdCwgXCJQYXR0ZXJuXCIpO1xuICAgIGMobm9kZS5oYW5kbGVyLmJvZHksIHN0LCBcIlNjb3BlQm9keVwiKTtcbiAgfVxuICBpZiAobm9kZS5maW5hbGl6ZXIpIGMobm9kZS5maW5hbGl6ZXIsIHN0LCBcIlN0YXRlbWVudFwiKTtcbn07XG5iYXNlLldoaWxlU3RhdGVtZW50ID0gYmFzZS5Eb1doaWxlU3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIGMobm9kZS50ZXN0LCBzdCwgXCJFeHByZXNzaW9uXCIpO1xuICBjKG5vZGUuYm9keSwgc3QsIFwiU3RhdGVtZW50XCIpO1xufTtcbmJhc2UuRm9yU3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIGlmIChub2RlLmluaXQpIGMobm9kZS5pbml0LCBzdCwgXCJGb3JJbml0XCIpO1xuICBpZiAobm9kZS50ZXN0KSBjKG5vZGUudGVzdCwgc3QsIFwiRXhwcmVzc2lvblwiKTtcbiAgaWYgKG5vZGUudXBkYXRlKSBjKG5vZGUudXBkYXRlLCBzdCwgXCJFeHByZXNzaW9uXCIpO1xuICBjKG5vZGUuYm9keSwgc3QsIFwiU3RhdGVtZW50XCIpO1xufTtcbmJhc2UuRm9ySW5TdGF0ZW1lbnQgPSBiYXNlLkZvck9mU3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIGMobm9kZS5sZWZ0LCBzdCwgXCJGb3JJbml0XCIpO1xuICBjKG5vZGUucmlnaHQsIHN0LCBcIkV4cHJlc3Npb25cIik7XG4gIGMobm9kZS5ib2R5LCBzdCwgXCJTdGF0ZW1lbnRcIik7XG59O1xuYmFzZS5Gb3JJbml0ID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIGlmIChub2RlLnR5cGUgPT0gXCJWYXJpYWJsZURlY2xhcmF0aW9uXCIpIGMobm9kZSwgc3QpO2Vsc2UgYyhub2RlLCBzdCwgXCJFeHByZXNzaW9uXCIpO1xufTtcbmJhc2UuRGVidWdnZXJTdGF0ZW1lbnQgPSBpZ25vcmU7XG5cbmJhc2UuRnVuY3Rpb25EZWNsYXJhdGlvbiA9IGZ1bmN0aW9uIChub2RlLCBzdCwgYykge1xuICByZXR1cm4gYyhub2RlLCBzdCwgXCJGdW5jdGlvblwiKTtcbn07XG5iYXNlLlZhcmlhYmxlRGVjbGFyYXRpb24gPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBub2RlLmRlY2xhcmF0aW9ucy5sZW5ndGg7ICsraSkge1xuICAgIHZhciBkZWNsID0gbm9kZS5kZWNsYXJhdGlvbnNbaV07XG4gICAgYyhkZWNsLmlkLCBzdCwgXCJQYXR0ZXJuXCIpO1xuICAgIGlmIChkZWNsLmluaXQpIGMoZGVjbC5pbml0LCBzdCwgXCJFeHByZXNzaW9uXCIpO1xuICB9XG59O1xuXG5iYXNlLkZ1bmN0aW9uID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgbm9kZS5wYXJhbXMubGVuZ3RoOyBpKyspIHtcbiAgICBjKG5vZGUucGFyYW1zW2ldLCBzdCwgXCJQYXR0ZXJuXCIpO1xuICB9Yyhub2RlLmJvZHksIHN0LCBub2RlLmV4cHJlc3Npb24gPyBcIlNjb3BlRXhwcmVzc2lvblwiIDogXCJTY29wZUJvZHlcIik7XG59O1xuLy8gRklYTUUgZHJvcCB0aGVzZSBub2RlIHR5cGVzIGluIG5leHQgbWFqb3IgdmVyc2lvblxuLy8gKFRoZXkgYXJlIGF3a3dhcmQsIGFuZCBpbiBFUzYgZXZlcnkgYmxvY2sgY2FuIGJlIGEgc2NvcGUuKVxuYmFzZS5TY29wZUJvZHkgPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgcmV0dXJuIGMobm9kZSwgc3QsIFwiU3RhdGVtZW50XCIpO1xufTtcbmJhc2UuU2NvcGVFeHByZXNzaW9uID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIHJldHVybiBjKG5vZGUsIHN0LCBcIkV4cHJlc3Npb25cIik7XG59O1xuXG5iYXNlLlBhdHRlcm4gPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgaWYgKG5vZGUudHlwZSA9PSBcIklkZW50aWZpZXJcIikgYyhub2RlLCBzdCwgXCJWYXJpYWJsZVBhdHRlcm5cIik7ZWxzZSBpZiAobm9kZS50eXBlID09IFwiTWVtYmVyRXhwcmVzc2lvblwiKSBjKG5vZGUsIHN0LCBcIk1lbWJlclBhdHRlcm5cIik7ZWxzZSBjKG5vZGUsIHN0KTtcbn07XG5iYXNlLlZhcmlhYmxlUGF0dGVybiA9IGlnbm9yZTtcbmJhc2UuTWVtYmVyUGF0dGVybiA9IHNraXBUaHJvdWdoO1xuYmFzZS5SZXN0RWxlbWVudCA9IGZ1bmN0aW9uIChub2RlLCBzdCwgYykge1xuICByZXR1cm4gYyhub2RlLmFyZ3VtZW50LCBzdCwgXCJQYXR0ZXJuXCIpO1xufTtcbmJhc2UuQXJyYXlQYXR0ZXJuID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgbm9kZS5lbGVtZW50cy5sZW5ndGg7ICsraSkge1xuICAgIHZhciBlbHQgPSBub2RlLmVsZW1lbnRzW2ldO1xuICAgIGlmIChlbHQpIGMoZWx0LCBzdCwgXCJQYXR0ZXJuXCIpO1xuICB9XG59O1xuYmFzZS5PYmplY3RQYXR0ZXJuID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgbm9kZS5wcm9wZXJ0aWVzLmxlbmd0aDsgKytpKSB7XG4gICAgYyhub2RlLnByb3BlcnRpZXNbaV0udmFsdWUsIHN0LCBcIlBhdHRlcm5cIik7XG4gIH1cbn07XG5cbmJhc2UuRXhwcmVzc2lvbiA9IHNraXBUaHJvdWdoO1xuYmFzZS5UaGlzRXhwcmVzc2lvbiA9IGJhc2UuU3VwZXIgPSBiYXNlLk1ldGFQcm9wZXJ0eSA9IGlnbm9yZTtcbmJhc2UuQXJyYXlFeHByZXNzaW9uID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgbm9kZS5lbGVtZW50cy5sZW5ndGg7ICsraSkge1xuICAgIHZhciBlbHQgPSBub2RlLmVsZW1lbnRzW2ldO1xuICAgIGlmIChlbHQpIGMoZWx0LCBzdCwgXCJFeHByZXNzaW9uXCIpO1xuICB9XG59O1xuYmFzZS5PYmplY3RFeHByZXNzaW9uID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgbm9kZS5wcm9wZXJ0aWVzLmxlbmd0aDsgKytpKSB7XG4gICAgYyhub2RlLnByb3BlcnRpZXNbaV0sIHN0KTtcbiAgfVxufTtcbmJhc2UuRnVuY3Rpb25FeHByZXNzaW9uID0gYmFzZS5BcnJvd0Z1bmN0aW9uRXhwcmVzc2lvbiA9IGJhc2UuRnVuY3Rpb25EZWNsYXJhdGlvbjtcbmJhc2UuU2VxdWVuY2VFeHByZXNzaW9uID0gYmFzZS5UZW1wbGF0ZUxpdGVyYWwgPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBub2RlLmV4cHJlc3Npb25zLmxlbmd0aDsgKytpKSB7XG4gICAgYyhub2RlLmV4cHJlc3Npb25zW2ldLCBzdCwgXCJFeHByZXNzaW9uXCIpO1xuICB9XG59O1xuYmFzZS5VbmFyeUV4cHJlc3Npb24gPSBiYXNlLlVwZGF0ZUV4cHJlc3Npb24gPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgYyhub2RlLmFyZ3VtZW50LCBzdCwgXCJFeHByZXNzaW9uXCIpO1xufTtcbmJhc2UuQmluYXJ5RXhwcmVzc2lvbiA9IGJhc2UuTG9naWNhbEV4cHJlc3Npb24gPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgYyhub2RlLmxlZnQsIHN0LCBcIkV4cHJlc3Npb25cIik7XG4gIGMobm9kZS5yaWdodCwgc3QsIFwiRXhwcmVzc2lvblwiKTtcbn07XG5iYXNlLkFzc2lnbm1lbnRFeHByZXNzaW9uID0gYmFzZS5Bc3NpZ25tZW50UGF0dGVybiA9IGZ1bmN0aW9uIChub2RlLCBzdCwgYykge1xuICBjKG5vZGUubGVmdCwgc3QsIFwiUGF0dGVyblwiKTtcbiAgYyhub2RlLnJpZ2h0LCBzdCwgXCJFeHByZXNzaW9uXCIpO1xufTtcbmJhc2UuQ29uZGl0aW9uYWxFeHByZXNzaW9uID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIGMobm9kZS50ZXN0LCBzdCwgXCJFeHByZXNzaW9uXCIpO1xuICBjKG5vZGUuY29uc2VxdWVudCwgc3QsIFwiRXhwcmVzc2lvblwiKTtcbiAgYyhub2RlLmFsdGVybmF0ZSwgc3QsIFwiRXhwcmVzc2lvblwiKTtcbn07XG5iYXNlLk5ld0V4cHJlc3Npb24gPSBiYXNlLkNhbGxFeHByZXNzaW9uID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIGMobm9kZS5jYWxsZWUsIHN0LCBcIkV4cHJlc3Npb25cIik7XG4gIGlmIChub2RlLmFyZ3VtZW50cykgZm9yICh2YXIgaSA9IDA7IGkgPCBub2RlLmFyZ3VtZW50cy5sZW5ndGg7ICsraSkge1xuICAgIGMobm9kZS5hcmd1bWVudHNbaV0sIHN0LCBcIkV4cHJlc3Npb25cIik7XG4gIH1cbn07XG5iYXNlLk1lbWJlckV4cHJlc3Npb24gPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgYyhub2RlLm9iamVjdCwgc3QsIFwiRXhwcmVzc2lvblwiKTtcbiAgaWYgKG5vZGUuY29tcHV0ZWQpIGMobm9kZS5wcm9wZXJ0eSwgc3QsIFwiRXhwcmVzc2lvblwiKTtcbn07XG5iYXNlLkV4cG9ydE5hbWVkRGVjbGFyYXRpb24gPSBiYXNlLkV4cG9ydERlZmF1bHREZWNsYXJhdGlvbiA9IGZ1bmN0aW9uIChub2RlLCBzdCwgYykge1xuICBpZiAobm9kZS5kZWNsYXJhdGlvbikgYyhub2RlLmRlY2xhcmF0aW9uLCBzdCk7XG59O1xuYmFzZS5JbXBvcnREZWNsYXJhdGlvbiA9IGZ1bmN0aW9uIChub2RlLCBzdCwgYykge1xuICBmb3IgKHZhciBpID0gMDsgaSA8IG5vZGUuc3BlY2lmaWVycy5sZW5ndGg7IGkrKykge1xuICAgIGMobm9kZS5zcGVjaWZpZXJzW2ldLCBzdCk7XG4gIH1cbn07XG5iYXNlLkltcG9ydFNwZWNpZmllciA9IGJhc2UuSW1wb3J0RGVmYXVsdFNwZWNpZmllciA9IGJhc2UuSW1wb3J0TmFtZXNwYWNlU3BlY2lmaWVyID0gYmFzZS5JZGVudGlmaWVyID0gYmFzZS5MaXRlcmFsID0gaWdub3JlO1xuXG5iYXNlLlRhZ2dlZFRlbXBsYXRlRXhwcmVzc2lvbiA9IGZ1bmN0aW9uIChub2RlLCBzdCwgYykge1xuICBjKG5vZGUudGFnLCBzdCwgXCJFeHByZXNzaW9uXCIpO1xuICBjKG5vZGUucXVhc2ksIHN0KTtcbn07XG5iYXNlLkNsYXNzRGVjbGFyYXRpb24gPSBiYXNlLkNsYXNzRXhwcmVzc2lvbiA9IGZ1bmN0aW9uIChub2RlLCBzdCwgYykge1xuICByZXR1cm4gYyhub2RlLCBzdCwgXCJDbGFzc1wiKTtcbn07XG5iYXNlLkNsYXNzID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIGlmIChub2RlLmlkKSBjKG5vZGUuaWQsIHN0LCBcIlBhdHRlcm5cIik7XG4gIGlmIChub2RlLnN1cGVyQ2xhc3MpIGMobm9kZS5zdXBlckNsYXNzLCBzdCwgXCJFeHByZXNzaW9uXCIpO1xuICBmb3IgKHZhciBpID0gMDsgaSA8IG5vZGUuYm9keS5ib2R5Lmxlbmd0aDsgaSsrKSB7XG4gICAgYyhub2RlLmJvZHkuYm9keVtpXSwgc3QpO1xuICB9XG59O1xuYmFzZS5NZXRob2REZWZpbml0aW9uID0gYmFzZS5Qcm9wZXJ0eSA9IGZ1bmN0aW9uIChub2RlLCBzdCwgYykge1xuICBpZiAobm9kZS5jb21wdXRlZCkgYyhub2RlLmtleSwgc3QsIFwiRXhwcmVzc2lvblwiKTtcbiAgYyhub2RlLnZhbHVlLCBzdCwgXCJFeHByZXNzaW9uXCIpO1xufTtcbmJhc2UuQ29tcHJlaGVuc2lvbkV4cHJlc3Npb24gPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBub2RlLmJsb2Nrcy5sZW5ndGg7IGkrKykge1xuICAgIGMobm9kZS5ibG9ja3NbaV0ucmlnaHQsIHN0LCBcIkV4cHJlc3Npb25cIik7XG4gIH1jKG5vZGUuYm9keSwgc3QsIFwiRXhwcmVzc2lvblwiKTtcbn07XG5cbn0se31dfSx7fSxbMV0pKDEpXG59KTsiLCJpZiAodHlwZW9mIE9iamVjdC5jcmVhdGUgPT09ICdmdW5jdGlvbicpIHtcbiAgLy8gaW1wbGVtZW50YXRpb24gZnJvbSBzdGFuZGFyZCBub2RlLmpzICd1dGlsJyBtb2R1bGVcbiAgbW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiBpbmhlcml0cyhjdG9yLCBzdXBlckN0b3IpIHtcbiAgICBjdG9yLnN1cGVyXyA9IHN1cGVyQ3RvclxuICAgIGN0b3IucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShzdXBlckN0b3IucHJvdG90eXBlLCB7XG4gICAgICBjb25zdHJ1Y3Rvcjoge1xuICAgICAgICB2YWx1ZTogY3RvcixcbiAgICAgICAgZW51bWVyYWJsZTogZmFsc2UsXG4gICAgICAgIHdyaXRhYmxlOiB0cnVlLFxuICAgICAgICBjb25maWd1cmFibGU6IHRydWVcbiAgICAgIH1cbiAgICB9KTtcbiAgfTtcbn0gZWxzZSB7XG4gIC8vIG9sZCBzY2hvb2wgc2hpbSBmb3Igb2xkIGJyb3dzZXJzXG4gIG1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gaW5oZXJpdHMoY3Rvciwgc3VwZXJDdG9yKSB7XG4gICAgY3Rvci5zdXBlcl8gPSBzdXBlckN0b3JcbiAgICB2YXIgVGVtcEN0b3IgPSBmdW5jdGlvbiAoKSB7fVxuICAgIFRlbXBDdG9yLnByb3RvdHlwZSA9IHN1cGVyQ3Rvci5wcm90b3R5cGVcbiAgICBjdG9yLnByb3RvdHlwZSA9IG5ldyBUZW1wQ3RvcigpXG4gICAgY3Rvci5wcm90b3R5cGUuY29uc3RydWN0b3IgPSBjdG9yXG4gIH1cbn1cbiIsIi8vIHNoaW0gZm9yIHVzaW5nIHByb2Nlc3MgaW4gYnJvd3NlclxuXG52YXIgcHJvY2VzcyA9IG1vZHVsZS5leHBvcnRzID0ge307XG52YXIgcXVldWUgPSBbXTtcbnZhciBkcmFpbmluZyA9IGZhbHNlO1xudmFyIGN1cnJlbnRRdWV1ZTtcbnZhciBxdWV1ZUluZGV4ID0gLTE7XG5cbmZ1bmN0aW9uIGNsZWFuVXBOZXh0VGljaygpIHtcbiAgICBkcmFpbmluZyA9IGZhbHNlO1xuICAgIGlmIChjdXJyZW50UXVldWUubGVuZ3RoKSB7XG4gICAgICAgIHF1ZXVlID0gY3VycmVudFF1ZXVlLmNvbmNhdChxdWV1ZSk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcXVldWVJbmRleCA9IC0xO1xuICAgIH1cbiAgICBpZiAocXVldWUubGVuZ3RoKSB7XG4gICAgICAgIGRyYWluUXVldWUoKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGRyYWluUXVldWUoKSB7XG4gICAgaWYgKGRyYWluaW5nKSB7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdmFyIHRpbWVvdXQgPSBzZXRUaW1lb3V0KGNsZWFuVXBOZXh0VGljayk7XG4gICAgZHJhaW5pbmcgPSB0cnVlO1xuXG4gICAgdmFyIGxlbiA9IHF1ZXVlLmxlbmd0aDtcbiAgICB3aGlsZShsZW4pIHtcbiAgICAgICAgY3VycmVudFF1ZXVlID0gcXVldWU7XG4gICAgICAgIHF1ZXVlID0gW107XG4gICAgICAgIHdoaWxlICgrK3F1ZXVlSW5kZXggPCBsZW4pIHtcbiAgICAgICAgICAgIGN1cnJlbnRRdWV1ZVtxdWV1ZUluZGV4XS5ydW4oKTtcbiAgICAgICAgfVxuICAgICAgICBxdWV1ZUluZGV4ID0gLTE7XG4gICAgICAgIGxlbiA9IHF1ZXVlLmxlbmd0aDtcbiAgICB9XG4gICAgY3VycmVudFF1ZXVlID0gbnVsbDtcbiAgICBkcmFpbmluZyA9IGZhbHNlO1xuICAgIGNsZWFyVGltZW91dCh0aW1lb3V0KTtcbn1cblxucHJvY2Vzcy5uZXh0VGljayA9IGZ1bmN0aW9uIChmdW4pIHtcbiAgICB2YXIgYXJncyA9IG5ldyBBcnJheShhcmd1bWVudHMubGVuZ3RoIC0gMSk7XG4gICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPiAxKSB7XG4gICAgICAgIGZvciAodmFyIGkgPSAxOyBpIDwgYXJndW1lbnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICBhcmdzW2kgLSAxXSA9IGFyZ3VtZW50c1tpXTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBxdWV1ZS5wdXNoKG5ldyBJdGVtKGZ1biwgYXJncykpO1xuICAgIGlmIChxdWV1ZS5sZW5ndGggPT09IDEgJiYgIWRyYWluaW5nKSB7XG4gICAgICAgIHNldFRpbWVvdXQoZHJhaW5RdWV1ZSwgMCk7XG4gICAgfVxufTtcblxuLy8gdjggbGlrZXMgcHJlZGljdGlibGUgb2JqZWN0c1xuZnVuY3Rpb24gSXRlbShmdW4sIGFycmF5KSB7XG4gICAgdGhpcy5mdW4gPSBmdW47XG4gICAgdGhpcy5hcnJheSA9IGFycmF5O1xufVxuSXRlbS5wcm90b3R5cGUucnVuID0gZnVuY3Rpb24gKCkge1xuICAgIHRoaXMuZnVuLmFwcGx5KG51bGwsIHRoaXMuYXJyYXkpO1xufTtcbnByb2Nlc3MudGl0bGUgPSAnYnJvd3Nlcic7XG5wcm9jZXNzLmJyb3dzZXIgPSB0cnVlO1xucHJvY2Vzcy5lbnYgPSB7fTtcbnByb2Nlc3MuYXJndiA9IFtdO1xucHJvY2Vzcy52ZXJzaW9uID0gJyc7IC8vIGVtcHR5IHN0cmluZyB0byBhdm9pZCByZWdleHAgaXNzdWVzXG5wcm9jZXNzLnZlcnNpb25zID0ge307XG5cbmZ1bmN0aW9uIG5vb3AoKSB7fVxuXG5wcm9jZXNzLm9uID0gbm9vcDtcbnByb2Nlc3MuYWRkTGlzdGVuZXIgPSBub29wO1xucHJvY2Vzcy5vbmNlID0gbm9vcDtcbnByb2Nlc3Mub2ZmID0gbm9vcDtcbnByb2Nlc3MucmVtb3ZlTGlzdGVuZXIgPSBub29wO1xucHJvY2Vzcy5yZW1vdmVBbGxMaXN0ZW5lcnMgPSBub29wO1xucHJvY2Vzcy5lbWl0ID0gbm9vcDtcblxucHJvY2Vzcy5iaW5kaW5nID0gZnVuY3Rpb24gKG5hbWUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2Nlc3MuYmluZGluZyBpcyBub3Qgc3VwcG9ydGVkJyk7XG59O1xuXG4vLyBUT0RPKHNodHlsbWFuKVxucHJvY2Vzcy5jd2QgPSBmdW5jdGlvbiAoKSB7IHJldHVybiAnLycgfTtcbnByb2Nlc3MuY2hkaXIgPSBmdW5jdGlvbiAoZGlyKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdwcm9jZXNzLmNoZGlyIGlzIG5vdCBzdXBwb3J0ZWQnKTtcbn07XG5wcm9jZXNzLnVtYXNrID0gZnVuY3Rpb24oKSB7IHJldHVybiAwOyB9O1xuIiwibW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiBpc0J1ZmZlcihhcmcpIHtcbiAgcmV0dXJuIGFyZyAmJiB0eXBlb2YgYXJnID09PSAnb2JqZWN0J1xuICAgICYmIHR5cGVvZiBhcmcuY29weSA9PT0gJ2Z1bmN0aW9uJ1xuICAgICYmIHR5cGVvZiBhcmcuZmlsbCA9PT0gJ2Z1bmN0aW9uJ1xuICAgICYmIHR5cGVvZiBhcmcucmVhZFVJbnQ4ID09PSAnZnVuY3Rpb24nO1xufSIsIi8vIENvcHlyaWdodCBKb3llbnQsIEluYy4gYW5kIG90aGVyIE5vZGUgY29udHJpYnV0b3JzLlxuLy9cbi8vIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhXG4vLyBjb3B5IG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlXG4vLyBcIlNvZnR3YXJlXCIpLCB0byBkZWFsIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmdcbi8vIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCxcbi8vIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXRcbi8vIHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXMgZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZVxuLy8gZm9sbG93aW5nIGNvbmRpdGlvbnM6XG4vL1xuLy8gVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWRcbi8vIGluIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuLy9cbi8vIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1Ncbi8vIE9SIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0Zcbi8vIE1FUkNIQU5UQUJJTElUWSwgRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU5cbi8vIE5PIEVWRU5UIFNIQUxMIFRIRSBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLFxuLy8gREFNQUdFUyBPUiBPVEhFUiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SXG4vLyBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwgT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFXG4vLyBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU4gVEhFIFNPRlRXQVJFLlxuXG52YXIgZm9ybWF0UmVnRXhwID0gLyVbc2RqJV0vZztcbmV4cG9ydHMuZm9ybWF0ID0gZnVuY3Rpb24oZikge1xuICBpZiAoIWlzU3RyaW5nKGYpKSB7XG4gICAgdmFyIG9iamVjdHMgPSBbXTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGFyZ3VtZW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgb2JqZWN0cy5wdXNoKGluc3BlY3QoYXJndW1lbnRzW2ldKSk7XG4gICAgfVxuICAgIHJldHVybiBvYmplY3RzLmpvaW4oJyAnKTtcbiAgfVxuXG4gIHZhciBpID0gMTtcbiAgdmFyIGFyZ3MgPSBhcmd1bWVudHM7XG4gIHZhciBsZW4gPSBhcmdzLmxlbmd0aDtcbiAgdmFyIHN0ciA9IFN0cmluZyhmKS5yZXBsYWNlKGZvcm1hdFJlZ0V4cCwgZnVuY3Rpb24oeCkge1xuICAgIGlmICh4ID09PSAnJSUnKSByZXR1cm4gJyUnO1xuICAgIGlmIChpID49IGxlbikgcmV0dXJuIHg7XG4gICAgc3dpdGNoICh4KSB7XG4gICAgICBjYXNlICclcyc6IHJldHVybiBTdHJpbmcoYXJnc1tpKytdKTtcbiAgICAgIGNhc2UgJyVkJzogcmV0dXJuIE51bWJlcihhcmdzW2krK10pO1xuICAgICAgY2FzZSAnJWonOlxuICAgICAgICB0cnkge1xuICAgICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShhcmdzW2krK10pO1xuICAgICAgICB9IGNhdGNoIChfKSB7XG4gICAgICAgICAgcmV0dXJuICdbQ2lyY3VsYXJdJztcbiAgICAgICAgfVxuICAgICAgZGVmYXVsdDpcbiAgICAgICAgcmV0dXJuIHg7XG4gICAgfVxuICB9KTtcbiAgZm9yICh2YXIgeCA9IGFyZ3NbaV07IGkgPCBsZW47IHggPSBhcmdzWysraV0pIHtcbiAgICBpZiAoaXNOdWxsKHgpIHx8ICFpc09iamVjdCh4KSkge1xuICAgICAgc3RyICs9ICcgJyArIHg7XG4gICAgfSBlbHNlIHtcbiAgICAgIHN0ciArPSAnICcgKyBpbnNwZWN0KHgpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gc3RyO1xufTtcblxuXG4vLyBNYXJrIHRoYXQgYSBtZXRob2Qgc2hvdWxkIG5vdCBiZSB1c2VkLlxuLy8gUmV0dXJucyBhIG1vZGlmaWVkIGZ1bmN0aW9uIHdoaWNoIHdhcm5zIG9uY2UgYnkgZGVmYXVsdC5cbi8vIElmIC0tbm8tZGVwcmVjYXRpb24gaXMgc2V0LCB0aGVuIGl0IGlzIGEgbm8tb3AuXG5leHBvcnRzLmRlcHJlY2F0ZSA9IGZ1bmN0aW9uKGZuLCBtc2cpIHtcbiAgLy8gQWxsb3cgZm9yIGRlcHJlY2F0aW5nIHRoaW5ncyBpbiB0aGUgcHJvY2VzcyBvZiBzdGFydGluZyB1cC5cbiAgaWYgKGlzVW5kZWZpbmVkKGdsb2JhbC5wcm9jZXNzKSkge1xuICAgIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICAgIHJldHVybiBleHBvcnRzLmRlcHJlY2F0ZShmbiwgbXNnKS5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICAgIH07XG4gIH1cblxuICBpZiAocHJvY2Vzcy5ub0RlcHJlY2F0aW9uID09PSB0cnVlKSB7XG4gICAgcmV0dXJuIGZuO1xuICB9XG5cbiAgdmFyIHdhcm5lZCA9IGZhbHNlO1xuICBmdW5jdGlvbiBkZXByZWNhdGVkKCkge1xuICAgIGlmICghd2FybmVkKSB7XG4gICAgICBpZiAocHJvY2Vzcy50aHJvd0RlcHJlY2F0aW9uKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihtc2cpO1xuICAgICAgfSBlbHNlIGlmIChwcm9jZXNzLnRyYWNlRGVwcmVjYXRpb24pIHtcbiAgICAgICAgY29uc29sZS50cmFjZShtc2cpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihtc2cpO1xuICAgICAgfVxuICAgICAgd2FybmVkID0gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIGZuLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gIH1cblxuICByZXR1cm4gZGVwcmVjYXRlZDtcbn07XG5cblxudmFyIGRlYnVncyA9IHt9O1xudmFyIGRlYnVnRW52aXJvbjtcbmV4cG9ydHMuZGVidWdsb2cgPSBmdW5jdGlvbihzZXQpIHtcbiAgaWYgKGlzVW5kZWZpbmVkKGRlYnVnRW52aXJvbikpXG4gICAgZGVidWdFbnZpcm9uID0gcHJvY2Vzcy5lbnYuTk9ERV9ERUJVRyB8fCAnJztcbiAgc2V0ID0gc2V0LnRvVXBwZXJDYXNlKCk7XG4gIGlmICghZGVidWdzW3NldF0pIHtcbiAgICBpZiAobmV3IFJlZ0V4cCgnXFxcXGInICsgc2V0ICsgJ1xcXFxiJywgJ2knKS50ZXN0KGRlYnVnRW52aXJvbikpIHtcbiAgICAgIHZhciBwaWQgPSBwcm9jZXNzLnBpZDtcbiAgICAgIGRlYnVnc1tzZXRdID0gZnVuY3Rpb24oKSB7XG4gICAgICAgIHZhciBtc2cgPSBleHBvcnRzLmZvcm1hdC5hcHBseShleHBvcnRzLCBhcmd1bWVudHMpO1xuICAgICAgICBjb25zb2xlLmVycm9yKCclcyAlZDogJXMnLCBzZXQsIHBpZCwgbXNnKTtcbiAgICAgIH07XG4gICAgfSBlbHNlIHtcbiAgICAgIGRlYnVnc1tzZXRdID0gZnVuY3Rpb24oKSB7fTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGRlYnVnc1tzZXRdO1xufTtcblxuXG4vKipcbiAqIEVjaG9zIHRoZSB2YWx1ZSBvZiBhIHZhbHVlLiBUcnlzIHRvIHByaW50IHRoZSB2YWx1ZSBvdXRcbiAqIGluIHRoZSBiZXN0IHdheSBwb3NzaWJsZSBnaXZlbiB0aGUgZGlmZmVyZW50IHR5cGVzLlxuICpcbiAqIEBwYXJhbSB7T2JqZWN0fSBvYmogVGhlIG9iamVjdCB0byBwcmludCBvdXQuXG4gKiBAcGFyYW0ge09iamVjdH0gb3B0cyBPcHRpb25hbCBvcHRpb25zIG9iamVjdCB0aGF0IGFsdGVycyB0aGUgb3V0cHV0LlxuICovXG4vKiBsZWdhY3k6IG9iaiwgc2hvd0hpZGRlbiwgZGVwdGgsIGNvbG9ycyovXG5mdW5jdGlvbiBpbnNwZWN0KG9iaiwgb3B0cykge1xuICAvLyBkZWZhdWx0IG9wdGlvbnNcbiAgdmFyIGN0eCA9IHtcbiAgICBzZWVuOiBbXSxcbiAgICBzdHlsaXplOiBzdHlsaXplTm9Db2xvclxuICB9O1xuICAvLyBsZWdhY3kuLi5cbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPj0gMykgY3R4LmRlcHRoID0gYXJndW1lbnRzWzJdO1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA+PSA0KSBjdHguY29sb3JzID0gYXJndW1lbnRzWzNdO1xuICBpZiAoaXNCb29sZWFuKG9wdHMpKSB7XG4gICAgLy8gbGVnYWN5Li4uXG4gICAgY3R4LnNob3dIaWRkZW4gPSBvcHRzO1xuICB9IGVsc2UgaWYgKG9wdHMpIHtcbiAgICAvLyBnb3QgYW4gXCJvcHRpb25zXCIgb2JqZWN0XG4gICAgZXhwb3J0cy5fZXh0ZW5kKGN0eCwgb3B0cyk7XG4gIH1cbiAgLy8gc2V0IGRlZmF1bHQgb3B0aW9uc1xuICBpZiAoaXNVbmRlZmluZWQoY3R4LnNob3dIaWRkZW4pKSBjdHguc2hvd0hpZGRlbiA9IGZhbHNlO1xuICBpZiAoaXNVbmRlZmluZWQoY3R4LmRlcHRoKSkgY3R4LmRlcHRoID0gMjtcbiAgaWYgKGlzVW5kZWZpbmVkKGN0eC5jb2xvcnMpKSBjdHguY29sb3JzID0gZmFsc2U7XG4gIGlmIChpc1VuZGVmaW5lZChjdHguY3VzdG9tSW5zcGVjdCkpIGN0eC5jdXN0b21JbnNwZWN0ID0gdHJ1ZTtcbiAgaWYgKGN0eC5jb2xvcnMpIGN0eC5zdHlsaXplID0gc3R5bGl6ZVdpdGhDb2xvcjtcbiAgcmV0dXJuIGZvcm1hdFZhbHVlKGN0eCwgb2JqLCBjdHguZGVwdGgpO1xufVxuZXhwb3J0cy5pbnNwZWN0ID0gaW5zcGVjdDtcblxuXG4vLyBodHRwOi8vZW4ud2lraXBlZGlhLm9yZy93aWtpL0FOU0lfZXNjYXBlX2NvZGUjZ3JhcGhpY3Ncbmluc3BlY3QuY29sb3JzID0ge1xuICAnYm9sZCcgOiBbMSwgMjJdLFxuICAnaXRhbGljJyA6IFszLCAyM10sXG4gICd1bmRlcmxpbmUnIDogWzQsIDI0XSxcbiAgJ2ludmVyc2UnIDogWzcsIDI3XSxcbiAgJ3doaXRlJyA6IFszNywgMzldLFxuICAnZ3JleScgOiBbOTAsIDM5XSxcbiAgJ2JsYWNrJyA6IFszMCwgMzldLFxuICAnYmx1ZScgOiBbMzQsIDM5XSxcbiAgJ2N5YW4nIDogWzM2LCAzOV0sXG4gICdncmVlbicgOiBbMzIsIDM5XSxcbiAgJ21hZ2VudGEnIDogWzM1LCAzOV0sXG4gICdyZWQnIDogWzMxLCAzOV0sXG4gICd5ZWxsb3cnIDogWzMzLCAzOV1cbn07XG5cbi8vIERvbid0IHVzZSAnYmx1ZScgbm90IHZpc2libGUgb24gY21kLmV4ZVxuaW5zcGVjdC5zdHlsZXMgPSB7XG4gICdzcGVjaWFsJzogJ2N5YW4nLFxuICAnbnVtYmVyJzogJ3llbGxvdycsXG4gICdib29sZWFuJzogJ3llbGxvdycsXG4gICd1bmRlZmluZWQnOiAnZ3JleScsXG4gICdudWxsJzogJ2JvbGQnLFxuICAnc3RyaW5nJzogJ2dyZWVuJyxcbiAgJ2RhdGUnOiAnbWFnZW50YScsXG4gIC8vIFwibmFtZVwiOiBpbnRlbnRpb25hbGx5IG5vdCBzdHlsaW5nXG4gICdyZWdleHAnOiAncmVkJ1xufTtcblxuXG5mdW5jdGlvbiBzdHlsaXplV2l0aENvbG9yKHN0ciwgc3R5bGVUeXBlKSB7XG4gIHZhciBzdHlsZSA9IGluc3BlY3Quc3R5bGVzW3N0eWxlVHlwZV07XG5cbiAgaWYgKHN0eWxlKSB7XG4gICAgcmV0dXJuICdcXHUwMDFiWycgKyBpbnNwZWN0LmNvbG9yc1tzdHlsZV1bMF0gKyAnbScgKyBzdHIgK1xuICAgICAgICAgICAnXFx1MDAxYlsnICsgaW5zcGVjdC5jb2xvcnNbc3R5bGVdWzFdICsgJ20nO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiBzdHI7XG4gIH1cbn1cblxuXG5mdW5jdGlvbiBzdHlsaXplTm9Db2xvcihzdHIsIHN0eWxlVHlwZSkge1xuICByZXR1cm4gc3RyO1xufVxuXG5cbmZ1bmN0aW9uIGFycmF5VG9IYXNoKGFycmF5KSB7XG4gIHZhciBoYXNoID0ge307XG5cbiAgYXJyYXkuZm9yRWFjaChmdW5jdGlvbih2YWwsIGlkeCkge1xuICAgIGhhc2hbdmFsXSA9IHRydWU7XG4gIH0pO1xuXG4gIHJldHVybiBoYXNoO1xufVxuXG5cbmZ1bmN0aW9uIGZvcm1hdFZhbHVlKGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcykge1xuICAvLyBQcm92aWRlIGEgaG9vayBmb3IgdXNlci1zcGVjaWZpZWQgaW5zcGVjdCBmdW5jdGlvbnMuXG4gIC8vIENoZWNrIHRoYXQgdmFsdWUgaXMgYW4gb2JqZWN0IHdpdGggYW4gaW5zcGVjdCBmdW5jdGlvbiBvbiBpdFxuICBpZiAoY3R4LmN1c3RvbUluc3BlY3QgJiZcbiAgICAgIHZhbHVlICYmXG4gICAgICBpc0Z1bmN0aW9uKHZhbHVlLmluc3BlY3QpICYmXG4gICAgICAvLyBGaWx0ZXIgb3V0IHRoZSB1dGlsIG1vZHVsZSwgaXQncyBpbnNwZWN0IGZ1bmN0aW9uIGlzIHNwZWNpYWxcbiAgICAgIHZhbHVlLmluc3BlY3QgIT09IGV4cG9ydHMuaW5zcGVjdCAmJlxuICAgICAgLy8gQWxzbyBmaWx0ZXIgb3V0IGFueSBwcm90b3R5cGUgb2JqZWN0cyB1c2luZyB0aGUgY2lyY3VsYXIgY2hlY2suXG4gICAgICAhKHZhbHVlLmNvbnN0cnVjdG9yICYmIHZhbHVlLmNvbnN0cnVjdG9yLnByb3RvdHlwZSA9PT0gdmFsdWUpKSB7XG4gICAgdmFyIHJldCA9IHZhbHVlLmluc3BlY3QocmVjdXJzZVRpbWVzLCBjdHgpO1xuICAgIGlmICghaXNTdHJpbmcocmV0KSkge1xuICAgICAgcmV0ID0gZm9ybWF0VmFsdWUoY3R4LCByZXQsIHJlY3Vyc2VUaW1lcyk7XG4gICAgfVxuICAgIHJldHVybiByZXQ7XG4gIH1cblxuICAvLyBQcmltaXRpdmUgdHlwZXMgY2Fubm90IGhhdmUgcHJvcGVydGllc1xuICB2YXIgcHJpbWl0aXZlID0gZm9ybWF0UHJpbWl0aXZlKGN0eCwgdmFsdWUpO1xuICBpZiAocHJpbWl0aXZlKSB7XG4gICAgcmV0dXJuIHByaW1pdGl2ZTtcbiAgfVxuXG4gIC8vIExvb2sgdXAgdGhlIGtleXMgb2YgdGhlIG9iamVjdC5cbiAgdmFyIGtleXMgPSBPYmplY3Qua2V5cyh2YWx1ZSk7XG4gIHZhciB2aXNpYmxlS2V5cyA9IGFycmF5VG9IYXNoKGtleXMpO1xuXG4gIGlmIChjdHguc2hvd0hpZGRlbikge1xuICAgIGtleXMgPSBPYmplY3QuZ2V0T3duUHJvcGVydHlOYW1lcyh2YWx1ZSk7XG4gIH1cblxuICAvLyBJRSBkb2Vzbid0IG1ha2UgZXJyb3IgZmllbGRzIG5vbi1lbnVtZXJhYmxlXG4gIC8vIGh0dHA6Ly9tc2RuLm1pY3Jvc29mdC5jb20vZW4tdXMvbGlicmFyeS9pZS9kd3c1MnNidCh2PXZzLjk0KS5hc3B4XG4gIGlmIChpc0Vycm9yKHZhbHVlKVxuICAgICAgJiYgKGtleXMuaW5kZXhPZignbWVzc2FnZScpID49IDAgfHwga2V5cy5pbmRleE9mKCdkZXNjcmlwdGlvbicpID49IDApKSB7XG4gICAgcmV0dXJuIGZvcm1hdEVycm9yKHZhbHVlKTtcbiAgfVxuXG4gIC8vIFNvbWUgdHlwZSBvZiBvYmplY3Qgd2l0aG91dCBwcm9wZXJ0aWVzIGNhbiBiZSBzaG9ydGN1dHRlZC5cbiAgaWYgKGtleXMubGVuZ3RoID09PSAwKSB7XG4gICAgaWYgKGlzRnVuY3Rpb24odmFsdWUpKSB7XG4gICAgICB2YXIgbmFtZSA9IHZhbHVlLm5hbWUgPyAnOiAnICsgdmFsdWUubmFtZSA6ICcnO1xuICAgICAgcmV0dXJuIGN0eC5zdHlsaXplKCdbRnVuY3Rpb24nICsgbmFtZSArICddJywgJ3NwZWNpYWwnKTtcbiAgICB9XG4gICAgaWYgKGlzUmVnRXhwKHZhbHVlKSkge1xuICAgICAgcmV0dXJuIGN0eC5zdHlsaXplKFJlZ0V4cC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh2YWx1ZSksICdyZWdleHAnKTtcbiAgICB9XG4gICAgaWYgKGlzRGF0ZSh2YWx1ZSkpIHtcbiAgICAgIHJldHVybiBjdHguc3R5bGl6ZShEYXRlLnByb3RvdHlwZS50b1N0cmluZy5jYWxsKHZhbHVlKSwgJ2RhdGUnKTtcbiAgICB9XG4gICAgaWYgKGlzRXJyb3IodmFsdWUpKSB7XG4gICAgICByZXR1cm4gZm9ybWF0RXJyb3IodmFsdWUpO1xuICAgIH1cbiAgfVxuXG4gIHZhciBiYXNlID0gJycsIGFycmF5ID0gZmFsc2UsIGJyYWNlcyA9IFsneycsICd9J107XG5cbiAgLy8gTWFrZSBBcnJheSBzYXkgdGhhdCB0aGV5IGFyZSBBcnJheVxuICBpZiAoaXNBcnJheSh2YWx1ZSkpIHtcbiAgICBhcnJheSA9IHRydWU7XG4gICAgYnJhY2VzID0gWydbJywgJ10nXTtcbiAgfVxuXG4gIC8vIE1ha2UgZnVuY3Rpb25zIHNheSB0aGF0IHRoZXkgYXJlIGZ1bmN0aW9uc1xuICBpZiAoaXNGdW5jdGlvbih2YWx1ZSkpIHtcbiAgICB2YXIgbiA9IHZhbHVlLm5hbWUgPyAnOiAnICsgdmFsdWUubmFtZSA6ICcnO1xuICAgIGJhc2UgPSAnIFtGdW5jdGlvbicgKyBuICsgJ10nO1xuICB9XG5cbiAgLy8gTWFrZSBSZWdFeHBzIHNheSB0aGF0IHRoZXkgYXJlIFJlZ0V4cHNcbiAgaWYgKGlzUmVnRXhwKHZhbHVlKSkge1xuICAgIGJhc2UgPSAnICcgKyBSZWdFeHAucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwodmFsdWUpO1xuICB9XG5cbiAgLy8gTWFrZSBkYXRlcyB3aXRoIHByb3BlcnRpZXMgZmlyc3Qgc2F5IHRoZSBkYXRlXG4gIGlmIChpc0RhdGUodmFsdWUpKSB7XG4gICAgYmFzZSA9ICcgJyArIERhdGUucHJvdG90eXBlLnRvVVRDU3RyaW5nLmNhbGwodmFsdWUpO1xuICB9XG5cbiAgLy8gTWFrZSBlcnJvciB3aXRoIG1lc3NhZ2UgZmlyc3Qgc2F5IHRoZSBlcnJvclxuICBpZiAoaXNFcnJvcih2YWx1ZSkpIHtcbiAgICBiYXNlID0gJyAnICsgZm9ybWF0RXJyb3IodmFsdWUpO1xuICB9XG5cbiAgaWYgKGtleXMubGVuZ3RoID09PSAwICYmICghYXJyYXkgfHwgdmFsdWUubGVuZ3RoID09IDApKSB7XG4gICAgcmV0dXJuIGJyYWNlc1swXSArIGJhc2UgKyBicmFjZXNbMV07XG4gIH1cblxuICBpZiAocmVjdXJzZVRpbWVzIDwgMCkge1xuICAgIGlmIChpc1JlZ0V4cCh2YWx1ZSkpIHtcbiAgICAgIHJldHVybiBjdHguc3R5bGl6ZShSZWdFeHAucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwodmFsdWUpLCAncmVnZXhwJyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiBjdHguc3R5bGl6ZSgnW09iamVjdF0nLCAnc3BlY2lhbCcpO1xuICAgIH1cbiAgfVxuXG4gIGN0eC5zZWVuLnB1c2godmFsdWUpO1xuXG4gIHZhciBvdXRwdXQ7XG4gIGlmIChhcnJheSkge1xuICAgIG91dHB1dCA9IGZvcm1hdEFycmF5KGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcywgdmlzaWJsZUtleXMsIGtleXMpO1xuICB9IGVsc2Uge1xuICAgIG91dHB1dCA9IGtleXMubWFwKGZ1bmN0aW9uKGtleSkge1xuICAgICAgcmV0dXJuIGZvcm1hdFByb3BlcnR5KGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcywgdmlzaWJsZUtleXMsIGtleSwgYXJyYXkpO1xuICAgIH0pO1xuICB9XG5cbiAgY3R4LnNlZW4ucG9wKCk7XG5cbiAgcmV0dXJuIHJlZHVjZVRvU2luZ2xlU3RyaW5nKG91dHB1dCwgYmFzZSwgYnJhY2VzKTtcbn1cblxuXG5mdW5jdGlvbiBmb3JtYXRQcmltaXRpdmUoY3R4LCB2YWx1ZSkge1xuICBpZiAoaXNVbmRlZmluZWQodmFsdWUpKVxuICAgIHJldHVybiBjdHguc3R5bGl6ZSgndW5kZWZpbmVkJywgJ3VuZGVmaW5lZCcpO1xuICBpZiAoaXNTdHJpbmcodmFsdWUpKSB7XG4gICAgdmFyIHNpbXBsZSA9ICdcXCcnICsgSlNPTi5zdHJpbmdpZnkodmFsdWUpLnJlcGxhY2UoL15cInxcIiQvZywgJycpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAucmVwbGFjZSgvJy9nLCBcIlxcXFwnXCIpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAucmVwbGFjZSgvXFxcXFwiL2csICdcIicpICsgJ1xcJyc7XG4gICAgcmV0dXJuIGN0eC5zdHlsaXplKHNpbXBsZSwgJ3N0cmluZycpO1xuICB9XG4gIGlmIChpc051bWJlcih2YWx1ZSkpXG4gICAgcmV0dXJuIGN0eC5zdHlsaXplKCcnICsgdmFsdWUsICdudW1iZXInKTtcbiAgaWYgKGlzQm9vbGVhbih2YWx1ZSkpXG4gICAgcmV0dXJuIGN0eC5zdHlsaXplKCcnICsgdmFsdWUsICdib29sZWFuJyk7XG4gIC8vIEZvciBzb21lIHJlYXNvbiB0eXBlb2YgbnVsbCBpcyBcIm9iamVjdFwiLCBzbyBzcGVjaWFsIGNhc2UgaGVyZS5cbiAgaWYgKGlzTnVsbCh2YWx1ZSkpXG4gICAgcmV0dXJuIGN0eC5zdHlsaXplKCdudWxsJywgJ251bGwnKTtcbn1cblxuXG5mdW5jdGlvbiBmb3JtYXRFcnJvcih2YWx1ZSkge1xuICByZXR1cm4gJ1snICsgRXJyb3IucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwodmFsdWUpICsgJ10nO1xufVxuXG5cbmZ1bmN0aW9uIGZvcm1hdEFycmF5KGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcywgdmlzaWJsZUtleXMsIGtleXMpIHtcbiAgdmFyIG91dHB1dCA9IFtdO1xuICBmb3IgKHZhciBpID0gMCwgbCA9IHZhbHVlLmxlbmd0aDsgaSA8IGw7ICsraSkge1xuICAgIGlmIChoYXNPd25Qcm9wZXJ0eSh2YWx1ZSwgU3RyaW5nKGkpKSkge1xuICAgICAgb3V0cHV0LnB1c2goZm9ybWF0UHJvcGVydHkoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzLCB2aXNpYmxlS2V5cyxcbiAgICAgICAgICBTdHJpbmcoaSksIHRydWUpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgb3V0cHV0LnB1c2goJycpO1xuICAgIH1cbiAgfVxuICBrZXlzLmZvckVhY2goZnVuY3Rpb24oa2V5KSB7XG4gICAgaWYgKCFrZXkubWF0Y2goL15cXGQrJC8pKSB7XG4gICAgICBvdXRwdXQucHVzaChmb3JtYXRQcm9wZXJ0eShjdHgsIHZhbHVlLCByZWN1cnNlVGltZXMsIHZpc2libGVLZXlzLFxuICAgICAgICAgIGtleSwgdHJ1ZSkpO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiBvdXRwdXQ7XG59XG5cblxuZnVuY3Rpb24gZm9ybWF0UHJvcGVydHkoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzLCB2aXNpYmxlS2V5cywga2V5LCBhcnJheSkge1xuICB2YXIgbmFtZSwgc3RyLCBkZXNjO1xuICBkZXNjID0gT2JqZWN0LmdldE93blByb3BlcnR5RGVzY3JpcHRvcih2YWx1ZSwga2V5KSB8fCB7IHZhbHVlOiB2YWx1ZVtrZXldIH07XG4gIGlmIChkZXNjLmdldCkge1xuICAgIGlmIChkZXNjLnNldCkge1xuICAgICAgc3RyID0gY3R4LnN0eWxpemUoJ1tHZXR0ZXIvU2V0dGVyXScsICdzcGVjaWFsJyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHN0ciA9IGN0eC5zdHlsaXplKCdbR2V0dGVyXScsICdzcGVjaWFsJyk7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGlmIChkZXNjLnNldCkge1xuICAgICAgc3RyID0gY3R4LnN0eWxpemUoJ1tTZXR0ZXJdJywgJ3NwZWNpYWwnKTtcbiAgICB9XG4gIH1cbiAgaWYgKCFoYXNPd25Qcm9wZXJ0eSh2aXNpYmxlS2V5cywga2V5KSkge1xuICAgIG5hbWUgPSAnWycgKyBrZXkgKyAnXSc7XG4gIH1cbiAgaWYgKCFzdHIpIHtcbiAgICBpZiAoY3R4LnNlZW4uaW5kZXhPZihkZXNjLnZhbHVlKSA8IDApIHtcbiAgICAgIGlmIChpc051bGwocmVjdXJzZVRpbWVzKSkge1xuICAgICAgICBzdHIgPSBmb3JtYXRWYWx1ZShjdHgsIGRlc2MudmFsdWUsIG51bGwpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc3RyID0gZm9ybWF0VmFsdWUoY3R4LCBkZXNjLnZhbHVlLCByZWN1cnNlVGltZXMgLSAxKTtcbiAgICAgIH1cbiAgICAgIGlmIChzdHIuaW5kZXhPZignXFxuJykgPiAtMSkge1xuICAgICAgICBpZiAoYXJyYXkpIHtcbiAgICAgICAgICBzdHIgPSBzdHIuc3BsaXQoJ1xcbicpLm1hcChmdW5jdGlvbihsaW5lKSB7XG4gICAgICAgICAgICByZXR1cm4gJyAgJyArIGxpbmU7XG4gICAgICAgICAgfSkuam9pbignXFxuJykuc3Vic3RyKDIpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHN0ciA9ICdcXG4nICsgc3RyLnNwbGl0KCdcXG4nKS5tYXAoZnVuY3Rpb24obGluZSkge1xuICAgICAgICAgICAgcmV0dXJuICcgICAnICsgbGluZTtcbiAgICAgICAgICB9KS5qb2luKCdcXG4nKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBzdHIgPSBjdHguc3R5bGl6ZSgnW0NpcmN1bGFyXScsICdzcGVjaWFsJyk7XG4gICAgfVxuICB9XG4gIGlmIChpc1VuZGVmaW5lZChuYW1lKSkge1xuICAgIGlmIChhcnJheSAmJiBrZXkubWF0Y2goL15cXGQrJC8pKSB7XG4gICAgICByZXR1cm4gc3RyO1xuICAgIH1cbiAgICBuYW1lID0gSlNPTi5zdHJpbmdpZnkoJycgKyBrZXkpO1xuICAgIGlmIChuYW1lLm1hdGNoKC9eXCIoW2EtekEtWl9dW2EtekEtWl8wLTldKilcIiQvKSkge1xuICAgICAgbmFtZSA9IG5hbWUuc3Vic3RyKDEsIG5hbWUubGVuZ3RoIC0gMik7XG4gICAgICBuYW1lID0gY3R4LnN0eWxpemUobmFtZSwgJ25hbWUnKTtcbiAgICB9IGVsc2Uge1xuICAgICAgbmFtZSA9IG5hbWUucmVwbGFjZSgvJy9nLCBcIlxcXFwnXCIpXG4gICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9cXFxcXCIvZywgJ1wiJylcbiAgICAgICAgICAgICAgICAgLnJlcGxhY2UoLyheXCJ8XCIkKS9nLCBcIidcIik7XG4gICAgICBuYW1lID0gY3R4LnN0eWxpemUobmFtZSwgJ3N0cmluZycpO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBuYW1lICsgJzogJyArIHN0cjtcbn1cblxuXG5mdW5jdGlvbiByZWR1Y2VUb1NpbmdsZVN0cmluZyhvdXRwdXQsIGJhc2UsIGJyYWNlcykge1xuICB2YXIgbnVtTGluZXNFc3QgPSAwO1xuICB2YXIgbGVuZ3RoID0gb3V0cHV0LnJlZHVjZShmdW5jdGlvbihwcmV2LCBjdXIpIHtcbiAgICBudW1MaW5lc0VzdCsrO1xuICAgIGlmIChjdXIuaW5kZXhPZignXFxuJykgPj0gMCkgbnVtTGluZXNFc3QrKztcbiAgICByZXR1cm4gcHJldiArIGN1ci5yZXBsYWNlKC9cXHUwMDFiXFxbXFxkXFxkP20vZywgJycpLmxlbmd0aCArIDE7XG4gIH0sIDApO1xuXG4gIGlmIChsZW5ndGggPiA2MCkge1xuICAgIHJldHVybiBicmFjZXNbMF0gK1xuICAgICAgICAgICAoYmFzZSA9PT0gJycgPyAnJyA6IGJhc2UgKyAnXFxuICcpICtcbiAgICAgICAgICAgJyAnICtcbiAgICAgICAgICAgb3V0cHV0LmpvaW4oJyxcXG4gICcpICtcbiAgICAgICAgICAgJyAnICtcbiAgICAgICAgICAgYnJhY2VzWzFdO1xuICB9XG5cbiAgcmV0dXJuIGJyYWNlc1swXSArIGJhc2UgKyAnICcgKyBvdXRwdXQuam9pbignLCAnKSArICcgJyArIGJyYWNlc1sxXTtcbn1cblxuXG4vLyBOT1RFOiBUaGVzZSB0eXBlIGNoZWNraW5nIGZ1bmN0aW9ucyBpbnRlbnRpb25hbGx5IGRvbid0IHVzZSBgaW5zdGFuY2VvZmBcbi8vIGJlY2F1c2UgaXQgaXMgZnJhZ2lsZSBhbmQgY2FuIGJlIGVhc2lseSBmYWtlZCB3aXRoIGBPYmplY3QuY3JlYXRlKClgLlxuZnVuY3Rpb24gaXNBcnJheShhcikge1xuICByZXR1cm4gQXJyYXkuaXNBcnJheShhcik7XG59XG5leHBvcnRzLmlzQXJyYXkgPSBpc0FycmF5O1xuXG5mdW5jdGlvbiBpc0Jvb2xlYW4oYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnYm9vbGVhbic7XG59XG5leHBvcnRzLmlzQm9vbGVhbiA9IGlzQm9vbGVhbjtcblxuZnVuY3Rpb24gaXNOdWxsKGFyZykge1xuICByZXR1cm4gYXJnID09PSBudWxsO1xufVxuZXhwb3J0cy5pc051bGwgPSBpc051bGw7XG5cbmZ1bmN0aW9uIGlzTnVsbE9yVW5kZWZpbmVkKGFyZykge1xuICByZXR1cm4gYXJnID09IG51bGw7XG59XG5leHBvcnRzLmlzTnVsbE9yVW5kZWZpbmVkID0gaXNOdWxsT3JVbmRlZmluZWQ7XG5cbmZ1bmN0aW9uIGlzTnVtYmVyKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ251bWJlcic7XG59XG5leHBvcnRzLmlzTnVtYmVyID0gaXNOdW1iZXI7XG5cbmZ1bmN0aW9uIGlzU3RyaW5nKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ3N0cmluZyc7XG59XG5leHBvcnRzLmlzU3RyaW5nID0gaXNTdHJpbmc7XG5cbmZ1bmN0aW9uIGlzU3ltYm9sKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ3N5bWJvbCc7XG59XG5leHBvcnRzLmlzU3ltYm9sID0gaXNTeW1ib2w7XG5cbmZ1bmN0aW9uIGlzVW5kZWZpbmVkKGFyZykge1xuICByZXR1cm4gYXJnID09PSB2b2lkIDA7XG59XG5leHBvcnRzLmlzVW5kZWZpbmVkID0gaXNVbmRlZmluZWQ7XG5cbmZ1bmN0aW9uIGlzUmVnRXhwKHJlKSB7XG4gIHJldHVybiBpc09iamVjdChyZSkgJiYgb2JqZWN0VG9TdHJpbmcocmUpID09PSAnW29iamVjdCBSZWdFeHBdJztcbn1cbmV4cG9ydHMuaXNSZWdFeHAgPSBpc1JlZ0V4cDtcblxuZnVuY3Rpb24gaXNPYmplY3QoYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnb2JqZWN0JyAmJiBhcmcgIT09IG51bGw7XG59XG5leHBvcnRzLmlzT2JqZWN0ID0gaXNPYmplY3Q7XG5cbmZ1bmN0aW9uIGlzRGF0ZShkKSB7XG4gIHJldHVybiBpc09iamVjdChkKSAmJiBvYmplY3RUb1N0cmluZyhkKSA9PT0gJ1tvYmplY3QgRGF0ZV0nO1xufVxuZXhwb3J0cy5pc0RhdGUgPSBpc0RhdGU7XG5cbmZ1bmN0aW9uIGlzRXJyb3IoZSkge1xuICByZXR1cm4gaXNPYmplY3QoZSkgJiZcbiAgICAgIChvYmplY3RUb1N0cmluZyhlKSA9PT0gJ1tvYmplY3QgRXJyb3JdJyB8fCBlIGluc3RhbmNlb2YgRXJyb3IpO1xufVxuZXhwb3J0cy5pc0Vycm9yID0gaXNFcnJvcjtcblxuZnVuY3Rpb24gaXNGdW5jdGlvbihhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdmdW5jdGlvbic7XG59XG5leHBvcnRzLmlzRnVuY3Rpb24gPSBpc0Z1bmN0aW9uO1xuXG5mdW5jdGlvbiBpc1ByaW1pdGl2ZShhcmcpIHtcbiAgcmV0dXJuIGFyZyA9PT0gbnVsbCB8fFxuICAgICAgICAgdHlwZW9mIGFyZyA9PT0gJ2Jvb2xlYW4nIHx8XG4gICAgICAgICB0eXBlb2YgYXJnID09PSAnbnVtYmVyJyB8fFxuICAgICAgICAgdHlwZW9mIGFyZyA9PT0gJ3N0cmluZycgfHxcbiAgICAgICAgIHR5cGVvZiBhcmcgPT09ICdzeW1ib2wnIHx8ICAvLyBFUzYgc3ltYm9sXG4gICAgICAgICB0eXBlb2YgYXJnID09PSAndW5kZWZpbmVkJztcbn1cbmV4cG9ydHMuaXNQcmltaXRpdmUgPSBpc1ByaW1pdGl2ZTtcblxuZXhwb3J0cy5pc0J1ZmZlciA9IHJlcXVpcmUoJy4vc3VwcG9ydC9pc0J1ZmZlcicpO1xuXG5mdW5jdGlvbiBvYmplY3RUb1N0cmluZyhvKSB7XG4gIHJldHVybiBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwobyk7XG59XG5cblxuZnVuY3Rpb24gcGFkKG4pIHtcbiAgcmV0dXJuIG4gPCAxMCA/ICcwJyArIG4udG9TdHJpbmcoMTApIDogbi50b1N0cmluZygxMCk7XG59XG5cblxudmFyIG1vbnRocyA9IFsnSmFuJywgJ0ZlYicsICdNYXInLCAnQXByJywgJ01heScsICdKdW4nLCAnSnVsJywgJ0F1ZycsICdTZXAnLFxuICAgICAgICAgICAgICAnT2N0JywgJ05vdicsICdEZWMnXTtcblxuLy8gMjYgRmViIDE2OjE5OjM0XG5mdW5jdGlvbiB0aW1lc3RhbXAoKSB7XG4gIHZhciBkID0gbmV3IERhdGUoKTtcbiAgdmFyIHRpbWUgPSBbcGFkKGQuZ2V0SG91cnMoKSksXG4gICAgICAgICAgICAgIHBhZChkLmdldE1pbnV0ZXMoKSksXG4gICAgICAgICAgICAgIHBhZChkLmdldFNlY29uZHMoKSldLmpvaW4oJzonKTtcbiAgcmV0dXJuIFtkLmdldERhdGUoKSwgbW9udGhzW2QuZ2V0TW9udGgoKV0sIHRpbWVdLmpvaW4oJyAnKTtcbn1cblxuXG4vLyBsb2cgaXMganVzdCBhIHRoaW4gd3JhcHBlciB0byBjb25zb2xlLmxvZyB0aGF0IHByZXBlbmRzIGEgdGltZXN0YW1wXG5leHBvcnRzLmxvZyA9IGZ1bmN0aW9uKCkge1xuICBjb25zb2xlLmxvZygnJXMgLSAlcycsIHRpbWVzdGFtcCgpLCBleHBvcnRzLmZvcm1hdC5hcHBseShleHBvcnRzLCBhcmd1bWVudHMpKTtcbn07XG5cblxuLyoqXG4gKiBJbmhlcml0IHRoZSBwcm90b3R5cGUgbWV0aG9kcyBmcm9tIG9uZSBjb25zdHJ1Y3RvciBpbnRvIGFub3RoZXIuXG4gKlxuICogVGhlIEZ1bmN0aW9uLnByb3RvdHlwZS5pbmhlcml0cyBmcm9tIGxhbmcuanMgcmV3cml0dGVuIGFzIGEgc3RhbmRhbG9uZVxuICogZnVuY3Rpb24gKG5vdCBvbiBGdW5jdGlvbi5wcm90b3R5cGUpLiBOT1RFOiBJZiB0aGlzIGZpbGUgaXMgdG8gYmUgbG9hZGVkXG4gKiBkdXJpbmcgYm9vdHN0cmFwcGluZyB0aGlzIGZ1bmN0aW9uIG5lZWRzIHRvIGJlIHJld3JpdHRlbiB1c2luZyBzb21lIG5hdGl2ZVxuICogZnVuY3Rpb25zIGFzIHByb3RvdHlwZSBzZXR1cCB1c2luZyBub3JtYWwgSmF2YVNjcmlwdCBkb2VzIG5vdCB3b3JrIGFzXG4gKiBleHBlY3RlZCBkdXJpbmcgYm9vdHN0cmFwcGluZyAoc2VlIG1pcnJvci5qcyBpbiByMTE0OTAzKS5cbiAqXG4gKiBAcGFyYW0ge2Z1bmN0aW9ufSBjdG9yIENvbnN0cnVjdG9yIGZ1bmN0aW9uIHdoaWNoIG5lZWRzIHRvIGluaGVyaXQgdGhlXG4gKiAgICAgcHJvdG90eXBlLlxuICogQHBhcmFtIHtmdW5jdGlvbn0gc3VwZXJDdG9yIENvbnN0cnVjdG9yIGZ1bmN0aW9uIHRvIGluaGVyaXQgcHJvdG90eXBlIGZyb20uXG4gKi9cbmV4cG9ydHMuaW5oZXJpdHMgPSByZXF1aXJlKCdpbmhlcml0cycpO1xuXG5leHBvcnRzLl9leHRlbmQgPSBmdW5jdGlvbihvcmlnaW4sIGFkZCkge1xuICAvLyBEb24ndCBkbyBhbnl0aGluZyBpZiBhZGQgaXNuJ3QgYW4gb2JqZWN0XG4gIGlmICghYWRkIHx8ICFpc09iamVjdChhZGQpKSByZXR1cm4gb3JpZ2luO1xuXG4gIHZhciBrZXlzID0gT2JqZWN0LmtleXMoYWRkKTtcbiAgdmFyIGkgPSBrZXlzLmxlbmd0aDtcbiAgd2hpbGUgKGktLSkge1xuICAgIG9yaWdpbltrZXlzW2ldXSA9IGFkZFtrZXlzW2ldXTtcbiAgfVxuICByZXR1cm4gb3JpZ2luO1xufTtcblxuZnVuY3Rpb24gaGFzT3duUHJvcGVydHkob2JqLCBwcm9wKSB7XG4gIHJldHVybiBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwob2JqLCBwcm9wKTtcbn1cbiJdfQ==
