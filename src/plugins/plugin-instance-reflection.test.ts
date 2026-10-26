import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPluginValueInstance } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import { expectUnavailable } from "./plugin-instance.test-support.js";

let instance: PluginInstance;
beforeEach(() => {
  instance = new PluginInstance("reflection");
});
afterEach(async () => {
  await instance.dispose();
});

function createSource(): object {
  return runInNewContext(
    `Object.defineProperty(Object.assign([], { execute() { return "current"; } }), "reader", { configurable: true, get() { return this.execute; } })`,
  );
}

describe("managed plugin reflection", () => {
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

  it("keeps existing VM array methods fenced when made fixed", async () => {
    const source = createSource();
    const view = instance.wrap(source);
    const execute = Reflect.get(view, "execute");
    expect(Reflect.defineProperty(view, "execute", { configurable: false, writable: false })).toBe(
      true,
    );
    const descriptor = Object.getOwnPropertyDescriptor(view, "execute");
    expect(descriptor).toMatchObject({ configurable: false, writable: false, value: execute });
    expect(Reflect.get(view, "execute")).toBe(execute);
    expect(Reflect.apply(execute, view, [])).toBe("current");
    await instance.dispose();
    expectUnavailable(
      () => Reflect.apply(execute, view, []),
      () => Reflect.apply(Reflect.get(view, "execute"), view, []),
    );
  });

  it("keeps existing VM array accessors fenced when made fixed", async () => {
    const view = instance.wrap(createSource());
    expect(Reflect.defineProperty(view, "reader", { configurable: false })).toBe(true);
    const descriptor = Object.getOwnPropertyDescriptor(view, "reader")!;
    expect(descriptor.configurable).toBe(false);
    const execute = descriptor.get!.call(view);
    expect(Reflect.apply(execute, view, [])).toBe("current");
    await instance.dispose();
    expectUnavailable(
      () => descriptor.get!.call(view),
      () => Reflect.get(view, "reader"),
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

describe("managed plugin proxy exports", () => {
  it.each(proxyOperations)(
    "admits %s traps and fences retirement",
    async (name, read, expected) => {
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
    },
  );
});
