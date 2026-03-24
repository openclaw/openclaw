"use strict";

function pluginSdkStub() {
  return stub;
}

Object.defineProperty(pluginSdkStub, "__esModule", {
  configurable: true,
  enumerable: false,
  value: true,
  writable: false,
});

Object.defineProperty(pluginSdkStub, "default", {
  configurable: true,
  enumerable: false,
  value: pluginSdkStub,
  writable: false,
});

const stub = new Proxy(pluginSdkStub, {
  apply() {
    return stub;
  },
  construct() {
    return stub;
  },
  get(target, prop, receiver) {
    if (prop === "then") {
      return undefined;
    }
    if (prop === Symbol.toPrimitive) {
      return () => "";
    }
    if (prop === "toJSON") {
      return () => undefined;
    }
    if (prop === "toString") {
      return () => "";
    }
    if (prop === "valueOf") {
      return () => 0;
    }
    if (Reflect.has(target, prop)) {
      return Reflect.get(target, prop, receiver);
    }
    return stub;
  },
});

module.exports = stub;
