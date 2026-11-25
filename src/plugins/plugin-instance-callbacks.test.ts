import { setImmediate as yieldImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { createPluginRuntimeStore } from "../plugin-sdk/runtime-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getPluginValueInstance } from "./plugin-instance-scope.js";
import {
  createOwnedTestInstance,
  createTestInstance,
  iterable,
  throwing,
  trackCompletion,
} from "./plugin-instance.test-support.js";
import { getPluginRuntimeGatewayRequestScope as getScope } from "./runtime/gateway-request-scope.js";

it("preserves a custom then receiver and its exact owned continuation", async () => {
  const instance = createTestInstance("custom-continuation");
  const source = Promise.resolve("finished");
  let continuation: Promise<unknown> | undefined;
  const then = function (this: Promise<string>, ...args: Parameters<Promise<string>["then"]>) {
    expect(this).toBe(source);
    continuation = Promise.prototype.then.apply(this, args);
    return continuation;
  };
  Object.defineProperty(then, "call", {
    get: throwing(new Error("then.call must not be inspected")),
  });
  // oxlint-disable-next-line unicorn/no-thenable -- Exercise a plugin-defined continuation without changing native assimilation.
  void Object.defineProperty(source, "then", { value: then });
  const result = instance.run(() => source);
  expect(result).toBe(continuation);
  expect(getPluginValueInstance(result)).toBe(instance);
  expect(await result).toBe("finished");
});

it.each(["function", "active iterator getter"] as const)(
  "inspects and assimilates Promises in %s admission",
  async (surface) => {
    const instance = createOwnedTestInstance("promise-export");
    const registry = instance.owner!.registry;
    const store = createPluginRuntimeStore<string>("unset fixture runtime");
    instance.run(() => store.setRuntime("owned runtime"));
    const pending = createDeferredCore();
    const value = surface === "function" ? pending.promise : {};
    const observed = new Set<string>();
    const observe = (phase: string) => {
      observed.add(phase);
      expect(getScope()?.pluginRegistry, phase).toBe(registry);
      expect(store.tryGetRuntime(), phase).toBe("owned runtime");
    };
    // oxlint-disable-next-line unicorn/no-thenable -- Promise assimilation remains part of the executable invocation.
    void Object.defineProperty(value, "then", {
      get() {
        observe("getter");
        return (...args: Parameters<Promise<void>["then"]>) => {
          observe("method");
          return Promise.prototype.then.apply(pending.promise, args);
        };
      },
    });
    let result: Promise<unknown> | undefined;
    let closeIterator: (() => Promise<unknown>) | undefined;
    try {
      if (surface === "function") {
        result = Promise.resolve(instance.wrap(() => value)());
      } else {
        const stream = instance.wrap(
          iterable({
            next: async () => ({ done: false, value: "chunk" }),
            return: async () => ({ done: true, value: undefined }),
            get metadata() {
              observe("value getter");
              return value;
            },
          }),
        );
        const iterator = stream[Symbol.asyncIterator]();
        closeIterator = () => iterator.return();
        await iterator.next();
        result = Promise.resolve(iterator.metadata);
      }
      pending.resolve();
      await result;
      expect(observed).toEqual(
        new Set(
          surface === "function" ? ["getter", "method"] : ["value getter", "getter", "method"],
        ),
      );
    } finally {
      pending.resolve();
      await result;
      await closeIterator?.();
    }
  },
);
it.each(["caller", "returned", "plugin-created"] as const)(
  "restores %s callable handles to their registry",
  async (acquisition) => {
    const instance = createTestInstance("callable-registry");
    const registrations = new Map<() => string, string>();
    const registry = instance.wrap({
      create(label: string, callback?: () => string) {
        const handle = callback ?? (() => label);
        registrations.set(handle, label);
        return handle;
      },
      lookup: (handle: () => string) => registrations.get(handle),
      remove: (handle: () => string) => registrations.delete(handle),
      emit: () => registrations.forEach((_, handle) => handle()),
    });
    let calls = 0;
    const callback = () => {
      calls += 1;
      return "first";
    };
    const first = registry.create("first", acquisition === "plugin-created" ? undefined : callback);
    const second = registry.create("second");
    registry.emit();
    expect(registry.lookup(first)).toBe("first");
    expect(registry.remove(acquisition === "caller" ? callback : first)).toBe(true);
    registry.emit();
    expect(calls).toBe(acquisition === "plugin-created" ? 0 : 1);
    expect(registry.lookup(first)).toBeUndefined();
    expect(registry.lookup(second)).toBe("second");
  },
);
it("restores a layered handle without traversing its enclosing data", async () => {
  class Handle {
    #value = 42;
    static read(value: Handle) {
      return value.#value;
    }
  }
  const instance = createTestInstance("layered-handle");
  const consumer = instance.retainConsumer();
  const handle = new Handle();
  const view = consumer.wrap(instance.wrap(handle));
  const envelope = Object.freeze({ handle: view });
  const api = instance.wrap({
    read(value: typeof handle) {
      return Handle.read(value);
    },
    inspect(value: typeof envelope) {
      expect(value).toBe(envelope);
      expect(value.handle).toBe(view);
    },
  });
  try {
    expect(api.read(view)).toBe(42);
    api.inspect(envelope);
  } finally {
    consumer.release();
    await instance.dispose();
  }
});

it.each(["map", "set", "array", "weak-map", "weak-set"] as const)(
  "preserves native %s callable data identity",
  async (collection) => {
    const instance = createTestInstance(`data-${collection}`);
    const original = () => "original";
    const replacement = () => "replacement";
    if (collection === "map") {
      const source: Map<() => string, () => string> = runInNewContext(
        'new Map([[original, () => "value"]])',
        { original },
      );
      const view = instance.wrap(source);
      let key = original;
      const receiver = {};
      view.forEach(function (this: typeof receiver, value, candidate) {
        expect(this).toBe(receiver);
        expect(value).toBe(source.get(original));
        expect(candidate).toBe(original);
        key = candidate;
      }, receiver);
      expect(view.get(key)!()).toBe("value");
      expect(view.set(key, replacement)).toBe(source);
      expect(source.get(original)).toBe(replacement);
    } else if (collection === "set") {
      const source = new Set([original]);
      const view = instance.wrap(source);
      expect(view.add(original)).toBe(source);
      expect(source.size).toBe(1);
      view.add(replacement);
      expect(source.has(replacement)).toBe(true);
    } else if (collection === "array") {
      const source = [original];
      const view = instance.wrap(source);
      const key = view[0]!;
      expect(view.includes(key)).toBe(true);
      view.push(replacement);
      expect(source[1]).toBe(replacement);
    } else {
      const source =
        collection === "weak-map" ? new WeakMap([[original, "value"]]) : new WeakSet([original]);
      const view = instance.wrap(source);
      expect(view.has(instance.wrap(original))).toBe(true);
      expect(view.delete(instance.wrap(original))).toBe(true);
      expect(source.has(original)).toBe(false);
    }
  },
);

it.each([
  { method: "reduce", shape: "function" },
  { method: "reduceRight", shape: "object" },
] as const)("preserves native $method $shape accumulator identity", async ({ method, shape }) => {
  type Accumulator = (() => string) | { read: () => string };
  const instance = createTestInstance("reduce-data");
  const initial = () => "initial";
  const returned: Accumulator[] = ["first", "final"].map((label) =>
    shape === "function" ? () => label : { read: () => label },
  );
  const source = [() => "left plugin element", () => "right plugin element"];
  const view = instance.wrap(source);
  const accumulators: Accumulator[] = [];
  const result = view[method]<Accumulator>((current, element, index, array) => {
    expect(array).toBe(source);
    expect(element).toBe(source[index]);
    accumulators.push(current);
    return returned[accumulators.length - 1]!;
  }, initial);
  expect(accumulators).toHaveLength(2);
  accumulators.forEach((value, index) =>
    expect.soft(value).toBe(index === 0 ? initial : returned[0]),
  );
  expect(result).toBe(returned[1]);
  // Without an initial value or callback invocation, the result is still a plugin element.
  const single = instance.wrap([source[0]!]);
  expect(single[method](() => initial)).toBe(instance.wrap(source[0]));
});
it.each([
  { target: "source", lifetime: "async" },
  { target: "iterator", lifetime: "async" },
  { target: "iterator", lifetime: "retained" },
] as const)(
  "owns $lifetime callback values from a $target helper",
  async ({ target, lifetime }) => {
    const instance = createTestInstance(`iterable-${target}-${lifetime}`);
    const release = createDeferredCore();
    class Visitor {
      #handler = () => "private helper value";
      visit(callback: (handler: () => string) => unknown) {
        callback(this.#handler);
      }
    }
    const iterator = Object.assign(new Visitor(), {
      next: async () => ({ done: true as const, value: undefined }),
      return: async () => ({ done: true as const, value: undefined }),
    });
    const stream = instance.wrap(
      Object.assign(new Visitor(), {
        [Symbol.asyncIterator]: () => iterator,
      }),
    );
    const view = stream[Symbol.asyncIterator]();
    const helper = target === "source" ? stream : view;
    let retained: (() => string) | undefined;
    let callback: Promise<string> | undefined;
    let retirement: ReturnType<typeof trackCompletion> | undefined;
    try {
      helper.visit(
        lifetime === "retained"
          ? (handler) => {
              retained = handler;
              expect(handler()).toBe("private helper value");
            }
          : (handler) => {
              callback = release.promise.then(() => handler());
              void callback.catch(() => {});
              return callback;
            },
      );
      await view.next();
      retirement = trackCompletion(instance.dispose());
      if (lifetime === "retained") {
        await retirement.promise;
        expect(retained?.()).toBe("private helper value");
      } else {
        await yieldImmediate();
        expect(retirement.done, "stream completion retired an admitted helper callback").toBe(
          false,
        );
        release.resolve();
        await expect(callback).resolves.toBe("private helper value");
        await retirement.promise;
      }
    } finally {
      release.resolve();
      await view.return();
      await (retirement?.promise ?? instance.dispose());
      await callback?.catch(() => {});
    }
  },
);
