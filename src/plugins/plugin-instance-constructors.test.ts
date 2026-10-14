import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginInstance } from "./plugin-instance.js";

// oxlint-disable typescript/unbound-method -- Retaining methods and supplying their receiver later is the lifecycle behavior under test.

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

let instance: PluginInstance;
beforeEach(() => {
  instance = new PluginInstance("constructors");
});
afterEach(async () => {
  await instance.dispose();
});

describe("managed exported constructors", () => {
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

  it("preserves VM function derived private fields", async () => {
    const Base = createBase();
    const WrappedBase = instance.wrap(Base);
    class Derived extends WrappedBase {
      derivedPublic = "derived";
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
    const base = new WrappedBase();
    expect(base).toBeInstanceOf(Base);
    expect(base).toBeInstanceOf(WrappedBase);
    expect(base.basePublic).toBe("base");
    expect(base.readBase()).toBe("base private");
    const derived = new Derived();
    expect(derived).toBeInstanceOf(Derived);
    expect(derived).toBeInstanceOf(WrappedBase);
    expect(derived).toBeInstanceOf(Base);
    expect(derived.basePublic).toBe("base");
    expect(derived.readBase()).toBe("base private");
    expect(derived.readDerived()).toBe("derived private");
    expect(derived.derivedLabel).toBe("derived private");
    derived.baseLabel = "changed base";
    derived.derivedLabel = "changed derived";
    expect(derived.readBase()).toBe("changed base");
    expect(derived.readDerived()).toBe("changed derived");
  });

  it.each(["constructor", "method"] as const)(
    "owns the VM function prototype %s",
    async (member) => {
      const Base = createBase();
      const WrappedBase = instance.wrap(Base);
      const Constructor: BaseConstructor = Reflect.get(WrappedBase.prototype, "constructor");
      const method = WrappedBase.prototype.readBase;
      const receiver = new Base();
      expect(new Constructor().basePublic).toBe("base");
      expect(Reflect.apply(method, receiver, [])).toBe("base private");
      await instance.dispose();
      if (member === "constructor") {
        expect(() => new Constructor()).toThrow("reloaded or disabled");
      } else {
        expect(() => Reflect.apply(method, receiver, [])).toThrow("reloaded or disabled");
      }
    },
  );
});

describe("managed constructor receiver layers", () => {
  it("preserves a nested VM function prototype getter receiver", async () => {
    const Base = createBase();
    const WrappedBase = instance.wrap(Base);
    class Middle extends WrappedBase {
      #value = "middle private";
      readMiddle() {
        return this.#value;
      }
      get middleLabel() {
        return this.#value;
      }
    }
    const WrappedMiddle = instance.wrap(Middle);
    const value = new WrappedMiddle();
    expect(value).toBeInstanceOf(Base);
    expect(value).toBeInstanceOf(Middle);
    expect(value).toBeInstanceOf(WrappedMiddle);
    expect(value.readBase()).toBe("base private");
    const read = Object.getOwnPropertyDescriptor(WrappedMiddle.prototype, "middleLabel")!.get!;
    expect(Reflect.apply(read, value, [])).toBe("middle private");
    await instance.dispose();
    expect(() => Reflect.apply(read, value, [])).toThrow("reloaded or disabled");
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
});
