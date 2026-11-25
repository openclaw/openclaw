import { runInNewContext } from "node:vm";
import { beforeEach, expect, it } from "vitest";
import { getPluginValueInstance } from "./plugin-instance-scope.js";
import type { PluginInstance } from "./plugin-instance.js";
import { createTestInstance, expectUnavailable } from "./plugin-instance.test-support.js";

let instance: PluginInstance;
beforeEach(() => {
  instance = createTestInstance("reflection");
});

function createSource(): object {
  return runInNewContext(
    `Object.defineProperty(Object.assign([], { execute() { return "current"; } }), "reader", { configurable: true, get() { return this.execute; } })`,
  );
}

it("preserves a primitive accessor receiver", async () => {
  const receiver = Symbol("receiver");
  const view = instance.wrap({
    get receiverKind() {
      return typeof this;
    },
  });
  expect(Reflect.get(view, "receiverKind", receiver)).toBe(typeof receiver);
  const descriptor = Object.getOwnPropertyDescriptor(view, "receiverKind")!;
  expect(descriptor.get!.call(receiver)).toBe(typeof receiver);
});

it("keeps ownership opaque to reflection and foreign Proxy forwarding", async () => {
  const source = { execute: () => "current" };
  const view = instance.wrap(source);
  const reads: PropertyKey[] = [];
  const forwarded = new Proxy(view, {
    get(target, key, receiver) {
      reads.push(key);
      return Reflect.get(target, key, receiver);
    },
    getOwnPropertyDescriptor(target, key) {
      reads.push(key);
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  expect(getPluginValueInstance(view)).toBe(instance);
  expect(Reflect.ownKeys(view)).toEqual(Reflect.ownKeys(source));
  expect(getPluginValueInstance(source)).toBeUndefined();
  expect(getPluginValueInstance(forwarded)).toBeUndefined();
  expect(getPluginValueInstance(Object.create(view))).toBeUndefined();
  expect(reads).toEqual([]);
  await instance.dispose();
  expect(getPluginValueInstance(view)).toBe(instance);
  expect(() => view.execute()).toThrow("reloaded or disabled");
});

it("defines fixed data on VM array views atomically", async () => {
  const source = createSource();
  const view = instance.wrap(source);
  const descriptor = { value: 1, configurable: false, writable: false, enumerable: true };
  expect(Reflect.defineProperty(view, "fixed", descriptor)).toBe(true);
  expect(Object.getOwnPropertyDescriptor(source, "fixed")).toEqual(descriptor);
  expect(Object.getOwnPropertyDescriptor(view, "fixed")).toEqual(descriptor);
  expect(Reflect.get(view, "fixed")).toBe(1);
  expect(Object.keys(view)).toContain("fixed");
  expect(Reflect.set(view, "fixed", 2)).toBe(false);
  expect(Reflect.deleteProperty(view, "fixed")).toBe(false);
  expect(Reflect.defineProperty(view, "fixed", { value: 2 })).toBe(false);
  expect(Reflect.get(source, "fixed")).toBe(1);
  await instance.dispose();
  expectUnavailable(() => Reflect.defineProperty(view, "late", { value: 2 }));
  expect(Object.hasOwn(source, "late")).toBe(false);
});

it.each(["method", "accessor"] as const)("fences fixed VM array %s exports", async (kind) => {
  const view = instance.wrap(createSource());
  const key = kind === "method" ? "execute" : "reader";
  const before = Reflect.get(view, key);
  const attributes = { configurable: false, ...(kind === "method" ? { writable: false } : {}) };
  expect(Reflect.defineProperty(view, key, attributes)).toBe(true);
  const descriptor = Object.getOwnPropertyDescriptor(view, key)!;
  expect(descriptor).toMatchObject(attributes);
  const read = () => (kind === "method" ? Reflect.get(view, key) : descriptor.get!.call(view));
  const execute = read();
  if (kind === "method") {
    expect(descriptor.value).toBe(before);
    expect(execute).toBe(before);
  }
  expect(Reflect.apply(execute, view, [])).toBe("current");
  await instance.dispose();
  expectUnavailable(
    () => Reflect.apply(read(), view, []),
    () => Reflect.apply(Reflect.get(view, key), view, []),
    () => Reflect.apply(execute, view, []),
  );
});

it("rejects freezing before changing either object's extensibility", async () => {
  const source = { execute: () => "current" };
  const view = instance.wrap(source);
  expect(() => Object.freeze(view)).toThrow(TypeError);
  expect(Object.isExtensible(view)).toBe(true);
  expect(Object.isExtensible(source)).toBe(true);
  expect(Reflect.defineProperty(view, "next", { value: 2, configurable: true })).toBe(true);
  expect(Reflect.get(source, "next")).toBe(2);
  expect(view.execute()).toBe("current");
});

const proxyOperations = [
  ["get", (view: object) => Reflect.get(view, "value"), 1],
  ["has", (view: object) => Reflect.has(view, "value"), true],
  ["ownKeys", Reflect.ownKeys, ["value", "execute"]],
  [
    "getOwnPropertyDescriptor",
    (view: object) => Reflect.getOwnPropertyDescriptor(view, "value")?.value,
    1,
  ],
  ["getPrototypeOf", Reflect.getPrototypeOf, Object.prototype],
] as const;

it.each(proxyOperations)("admits %s traps and fences retirement", async (name, read, expected) => {
  const admissions: boolean[] = [];
  const record =
    <Args extends unknown[], Result>(reflect: (...args: Args) => Result) =>
    (...args: Args): Result => {
      admissions.push(instance.hasActiveCall);
      return reflect(...args);
    };
  const target = { value: 1, execute: () => "current" };
  const proxy = new Proxy(target, {
    get: record(Reflect.get),
    has: record(Reflect.has),
    ownKeys: record(Reflect.ownKeys),
    getOwnPropertyDescriptor: record(Reflect.getOwnPropertyDescriptor),
    getPrototypeOf: record(Reflect.getPrototypeOf),
  });
  const source: object = name === "get" ? Object.create(proxy) : proxy;
  const view = instance.wrap(source);
  admissions.length = 0;
  expect(read(view)).toEqual(expected);
  expect(admissions.length).toBeGreaterThan(0);
  expect(admissions.every(Boolean)).toBe(true);
  await instance.dispose();
  admissions.length = 0;
  expectUnavailable(() => read(view));
  expect(admissions).toEqual([]);
});

// oxlint-disable typescript/unbound-method -- Retained methods are invoked with their receiver below.
interface BaseInstance {
  basePublic: string;
  baseLabel: string;
  readBase(): string;
}
interface BaseConstructor {
  new (): BaseInstance;
  prototype: BaseInstance;
}

function createBase(): BaseConstructor {
  return runInNewContext(`(() => {
    const values = new WeakMap();
    function Base() { this.basePublic = "base"; values.set(this, "base private"); }
    Object.defineProperties(Base.prototype, {
      readBase: { configurable: true, value() { return values.get(this); } },
      baseLabel: { configurable: true,
        get() { return values.get(this); },
        set(value) { values.set(this, value); }
      }
    });
    return Base;
  })()`);
}

function expectInstances(value: object, ...constructors: Array<new () => object>) {
  for (const constructor of constructors) {
    expect(value).toBeInstanceOf(constructor);
  }
}

it("reads a custom prototype accessor only when requested", async () => {
  let reads = 0;
  const source = () => "call";
  Object.defineProperty(source, "prototype", { get: () => ({ value: ++reads }) });
  const wrapped = instance.wrap(source);
  expect(reads).toBe(0);
  expect(Reflect.get(wrapped, "prototype")).toEqual({ value: 1 });
  await instance.dispose();
  expect(() => Reflect.get(wrapped, "prototype")).toThrow("reloaded or disabled");
  expect(reads).toBe(1);
});

it.each([false, true])("preserves derived private fields (nested wrapper: %s)", async (nested) => {
  const Base = createBase();
  const WrappedBase = instance.wrap(Base);
  class Derived extends WrappedBase {
    #value = "derived private";
    readDerived() {
      return this.#value;
    }
    get derivedLabel() {
      return this.#value;
    }
    set derivedLabel(value: string) {
      this.#value = value;
    }
  }
  const Constructor = nested ? instance.wrap(Derived) : Derived;
  const derived = new Constructor();
  expectInstances(derived, Constructor, Derived, WrappedBase, Base);
  expect(derived.basePublic).toBe("base");
  expect(derived.readBase()).toBe("base private");
  expect(derived.readDerived()).toBe("derived private");
  expect(derived.derivedLabel).toBe("derived private");
  derived.baseLabel = "changed base";
  derived.derivedLabel = "changed derived";
  expect(derived.readBase()).toBe("changed base");
  expect(derived.readDerived()).toBe("changed derived");
  const read = Object.getOwnPropertyDescriptor(Constructor.prototype, "derivedLabel")!.get!;
  expect(Reflect.apply(read, derived, [])).toBe("changed derived");
  if (nested) {
    await instance.dispose();
    expect(() => Reflect.apply(read, derived, [])).toThrow("reloaded or disabled");
  }
});

it("owns VM function prototype constructors and methods", async () => {
  const Base = createBase();
  const WrappedBase = instance.wrap(Base);
  const Constructor: BaseConstructor = Reflect.get(WrappedBase.prototype, "constructor");
  const method = WrappedBase.prototype.readBase;
  const receiver = new Base();
  expect(new Constructor().basePublic).toBe("base");
  expect(Reflect.apply(method, receiver, [])).toBe("base private");
  await instance.dispose();
  expectUnavailable(
    () => new Constructor(),
    () => Reflect.apply(method, receiver, []),
  );
});

it("preserves VM base and derived own callable assignment receivers", async () => {
  const source = `(class Base {
      #value = "base own";
      replacedOwn = function() { return this.#value; };
      constructor() { this.baseOwn = function() { return this.#value; }; }
    })`;
  const Base: new () => { baseOwn(): string; replacedOwn(): string } = runInNewContext(source);
  const WrappedBase = instance.wrap(Base);
  class DerivedAssignment extends WrappedBase {
    #value = "derived own";
    declare derivedOwn: () => string;
    constructor() {
      super();
      this.replacedOwn = function (this: DerivedAssignment) {
        return this.#value;
      };
      this.derivedOwn = function (this: DerivedAssignment) {
        return this.#value;
      };
    }
  }
  const value = new DerivedAssignment();
  const baseOwn = value.baseOwn;
  const derivedOwn = value.derivedOwn;
  const replacedOwn = value.replacedOwn;
  expect(baseOwn()).toBe("base own");
  expect(Reflect.apply(derivedOwn, undefined, [])).toBe("derived own");
  expect(Reflect.apply(replacedOwn, undefined, [])).toBe("derived own");
  await instance.dispose();
  expect(() => baseOwn()).toThrow("reloaded or disabled");
  expect(() => Reflect.apply(derivedOwn, undefined, [])).toThrow("reloaded or disabled");
  expect(() => Reflect.apply(replacedOwn, undefined, [])).toThrow("reloaded or disabled");
});
