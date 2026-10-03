import { runInNewContext, runInThisContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPluginValueInstance } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";

const cases = [
  { realm: "host", kind: "function" },
  { realm: "VM", kind: "object" },
  { realm: "VM", kind: "array" },
] as const;

let instance: PluginInstance;
beforeEach(() => {
  instance = new PluginInstance("reflection");
});
afterEach(async () => {
  await instance.dispose();
});

function createSource(realm: "host" | "VM", kind: "object" | "function" | "array"): object {
  const expression = kind === "object" ? "{}" : kind === "array" ? "[]" : "function exported() {}";
  const source = `Object.defineProperty(Object.assign(${expression}, { execute() { return "current"; } }), "reader", { configurable: true, get() { return this.execute; } })`;
  return realm === "VM" ? runInNewContext(source) : runInThisContext(source);
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

  it.each(cases)("defines fixed data on $realm $kind views atomically", async ({ realm, kind }) => {
    const source = createSource(realm, kind);
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
    expect(() => Reflect.defineProperty(view, "late", { value: 2 })).toThrow(
      "reloaded or disabled",
    );
    expect(Object.hasOwn(source, "late")).toBe(false);
  });

  it.each(cases)(
    "keeps existing $realm $kind methods fenced when made fixed",
    async ({ realm, kind }) => {
      const source = createSource(realm, kind);
      const view = instance.wrap(source);
      const execute = Reflect.get(view, "execute");
      expect(
        Reflect.defineProperty(view, "execute", { configurable: false, writable: false }),
      ).toBe(true);
      const descriptor = Object.getOwnPropertyDescriptor(view, "execute");
      expect(descriptor).toMatchObject({ configurable: false, writable: false, value: execute });
      expect(Reflect.get(view, "execute")).toBe(execute);
      expect(Reflect.apply(execute, view, [])).toBe("current");
      await instance.dispose();
      expect(() => Reflect.apply(execute, view, [])).toThrow("reloaded or disabled");
      expect(() => Reflect.apply(Reflect.get(view, "execute"), view, [])).toThrow(
        "reloaded or disabled",
      );
    },
  );

  it.each(cases)(
    "keeps existing $realm $kind accessors fenced when made fixed",
    async ({ realm, kind }) => {
      const view = instance.wrap(createSource(realm, kind));
      expect(Reflect.defineProperty(view, "reader", { configurable: false })).toBe(true);
      const descriptor = Object.getOwnPropertyDescriptor(view, "reader")!;
      expect(descriptor.configurable).toBe(false);
      const execute = descriptor.get!.call(view);
      expect(Reflect.apply(execute, view, [])).toBe("current");
      await instance.dispose();
      expect(() => descriptor.get!.call(view)).toThrow("reloaded or disabled");
      expect(() => Reflect.get(view, "reader")).toThrow("reloaded or disabled");
      expect(() => Reflect.apply(execute, view, [])).toThrow("reloaded or disabled");
    },
  );

  it.each(["value", "get"] as const)("preserves caller-owned fixed %s identity", async (field) => {
    const view = instance.wrap({ execute() {} });
    const supplied = () => "caller";
    expect(Reflect.defineProperty(view, "caller", { [field]: supplied, configurable: false })).toBe(
      true,
    );
    const descriptor = Object.getOwnPropertyDescriptor(view, "caller")!;
    expect(descriptor[field]).toBe(supplied);
    expect(Reflect.get(view, "caller")).toBe(field === "value" ? supplied : "caller");
    await instance.dispose();
    // Caller-owned code does not acquire plugin ownership through a fixed descriptor.
    expect(Reflect.apply(descriptor[field], view, [])).toBe("caller");
  });

  it("rejects freezing before changing either object's extensibility", async () => {
    const source = {
      execute() {
        return "current";
      },
    };
    const view = instance.wrap(source);
    expect(() => Object.freeze(view)).toThrow(TypeError);
    expect(Object.isExtensible(view)).toBe(true);
    expect(Object.isExtensible(source)).toBe(true);
    expect(Reflect.defineProperty(view, "next", { value: 2, configurable: true })).toBe(true);
    expect(Reflect.get(source, "next")).toBe(2);
    expect(view.execute()).toBe("current");
  });
  it("applies native descriptor transitions without partially committing an invalid request", async () => {
    const source = { execute() {}, mutable: 1 };
    const view = instance.wrap(source);
    const getter = () => 2;
    expect(Reflect.defineProperty(view, "mutable", { get: getter, configurable: false })).toBe(
      true,
    );
    expect(Object.getOwnPropertyDescriptor(view, "mutable")).toEqual({
      get: getter,
      set: undefined,
      configurable: false,
      enumerable: true,
    });
    expect(Reflect.get(view, "mutable")).toBe(2);
    expect(Reflect.defineProperty(view, "mutable", { value: 3 })).toBe(false);
    expect(Object.getOwnPropertyDescriptor(source, "mutable")).toMatchObject({ get: getter });
  });
});

const proxyOperations = [
  { name: "get", read: (view: object) => Reflect.get(view, "value"), expected: 1 },
  { name: "has", read: (view: object) => Reflect.has(view, "value"), expected: true },
  {
    name: "ownKeys",
    read: (view: object) => Reflect.ownKeys(view),
    expected: ["value", "execute"],
  },
  {
    name: "getOwnPropertyDescriptor",
    read: (view: object) => Reflect.getOwnPropertyDescriptor(view, "value")?.value,
    expected: 1,
  },
  {
    name: "getPrototypeOf",
    read: (view: object) => Reflect.getPrototypeOf(view),
    expected: Object.prototype,
  },
];

const proxyCases = proxyOperations.flatMap((operation) =>
  (operation.name === "get" || operation.name === "has"
    ? (["direct", "inherited"] as const)
    : (["direct"] as const)
  ).map((placement) => ({ operation, placement })),
);

describe("managed plugin proxy exports", () => {
  it.each(proxyCases)(
    "admits $placement $operation.name traps and fences retirement",
    async (testCase) => {
      const admissions: boolean[] = [];
      const record = () => admissions.push(instance.hasActiveCall);
      const target = { value: 1, execute: () => "current" };
      const proxy = new Proxy(target, {
        get(object, key, receiver) {
          record();
          return Reflect.get(object, key, receiver);
        },
        has(object, key) {
          record();
          return Reflect.has(object, key);
        },
        ownKeys(object) {
          record();
          return Reflect.ownKeys(object);
        },
        getOwnPropertyDescriptor(object, key) {
          record();
          return Reflect.getOwnPropertyDescriptor(object, key);
        },
        getPrototypeOf(object) {
          record();
          return Reflect.getPrototypeOf(object);
        },
      });
      const source: object = testCase.placement === "direct" ? proxy : Object.create(proxy);
      const view = instance.wrap(source);
      admissions.length = 0;
      expect(testCase.operation.read(view)).toEqual(testCase.operation.expected);
      expect(admissions.length).toBeGreaterThan(0);
      expect(admissions.every(Boolean)).toBe(true);
      await instance.dispose();
      admissions.length = 0;
      expect(() => testCase.operation.read(view)).toThrow("reloaded or disabled");
      expect(admissions).toEqual([]);
    },
  );
});
