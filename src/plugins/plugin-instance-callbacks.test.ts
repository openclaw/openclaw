import { setImmediate as yieldImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { createPluginRuntimeStore } from "../plugin-sdk/runtime-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  bindCurrentPluginInstanceCallbacks,
  getPluginValueInstance,
} from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";

describe("host callback records", () => {
  it("preserves receivers, data, result identity and async owner continuations", async () => {
    const owner = new PluginInstance("channel");
    const provider = new PluginInstance("provider");
    const runtime = createPluginRuntimeStore<string>("uninitialized callback owner");
    owner.run(() => runtime.setRuntime("channel"));
    const receiver = {};
    const data = {};
    const result = {};
    const symbol = Symbol("callback");
    const source = Object.freeze({
      data,
      [symbol](this: object, input: object) {
        expect(this).toBe(receiver);
        expect(input).toBe(data);
        expect(runtime.getRuntime()).toBe("channel");
        return result;
      },
      async progress() {
        await Promise.resolve();
        expect(runtime.getRuntime()).toBe("channel");
        return result;
      },
    });
    try {
      const bound = owner.run(() => bindCurrentPluginInstanceCallbacks(source));
      expect(bound.data).toBe(data);
      expect(provider.run(() => bound[symbol].call(receiver, data))).toBe(result);
      expect(await provider.run(() => bound.progress())).toBe(result);
      expect(provider.run(() => runtime.tryGetRuntime())).toBeNull();
      owner.quiesce();
      expect(() => bound.progress()).toThrow("reloaded or disabled");
    } finally {
      await Promise.all([owner.dispose(), provider.dispose()]);
    }
  });

  it("leaves host-only callback records and absent records unchanged", () => {
    const callbacks = { deliver: () => "host" };
    expect(bindCurrentPluginInstanceCallbacks(callbacks)).toBe(callbacks);
    expect(bindCurrentPluginInstanceCallbacks(undefined)).toBeUndefined();
  });
});

describe("plugin value invocation ownership", () => {
  it("preserves a custom then receiver and its exact owned continuation", async () => {
    const instance = new PluginInstance("custom-continuation");
    const source = Promise.resolve("finished");
    let continuation: Promise<unknown> | undefined;
    const calls: Array<{ receiver: unknown; arguments: number }> = [];
    const then = function (this: Promise<string>, ...args: Parameters<Promise<string>["then"]>) {
      calls.push({ receiver: this, arguments: args.length });
      continuation = Promise.prototype.then.apply(this, args);
      return continuation;
    };
    Object.defineProperty(then, "call", {
      get() {
        throw new Error("then.call must not be inspected");
      },
    });
    // oxlint-disable-next-line unicorn/no-thenable -- Exercise a plugin-defined continuation without changing native assimilation.
    void Object.defineProperty(source, "then", { value: then });
    try {
      const result = instance.run(() => source);
      expect(result).toBe(continuation);
      expect(getPluginValueInstance(result)).toBe(instance);
      expect(calls).toEqual([{ receiver: source, arguments: 2 }]);
      expect(await result).toBe("finished");
    } finally {
      await instance.dispose();
    }
  });

  it.each(["function", "active iterator getter"] as const)(
    "keeps Promise inspection and assimilation in %s admission",
    async (surface) => {
      const registry = createEmptyPluginRegistry();
      const record = createPluginRecord({ id: "promise-export" });
      registry.plugins.push(record);
      const instance = new PluginInstance(record.id, { record, registry });
      const store = createPluginRuntimeStore<string>("unset fixture runtime");
      instance.run(() => store.setRuntime("owned runtime"));
      const pending = createDeferredCore();
      const value = surface === "function" ? pending.promise : {};
      const observed: Array<{ phase: string; registry: unknown; runtime: unknown }> = [];
      const observe = (phase: string) =>
        observed.push({
          phase,
          registry: getPluginRuntimeGatewayRequestScope()?.pluginRegistry,
          runtime: store.tryGetRuntime(),
        });
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
          const stream = instance.wrap({
            [Symbol.asyncIterator]() {
              return {
                next: async () => ({ done: false, value: "chunk" }),
                return: async () => ({ done: true, value: undefined }),
                get metadata() {
                  observe("value getter");
                  return value;
                },
              };
            },
          });
          const iterator = stream[Symbol.asyncIterator]();
          closeIterator = () => iterator.return();
          await iterator.next();
          result = Promise.resolve(iterator.metadata);
        }
        pending.resolve();
        await result;
        expect(observed.map((item) => item.phase)).toContain("getter");
        expect(observed.map((item) => item.phase)).toContain("method");
        for (const item of observed) {
          expect.soft(item.registry, item.phase).toBe(registry);
          expect.soft(item.runtime, item.phase).toBe("owned runtime");
        }
      } finally {
        pending.resolve();
        await result;
        await closeIterator?.();
        await instance.dispose();
      }
    },
  );
});

describe("plugin values delivered through caller callbacks", () => {
  it.each(["caller", "returned", "plugin-created"] as const)(
    "returns %s callable handles to their owning registry",
    async (acquisition) => {
      const instance = new PluginInstance("callable-registry");
      const registrations = new Map<() => string, string>();
      const registry = instance.wrap({
        create(label: string, callback?: () => string) {
          const handle = callback ?? (() => label);
          registrations.set(handle, label);
          return handle;
        },
        lookup(handle: () => string) {
          return registrations.get(handle);
        },
        remove(handle: () => string) {
          return registrations.delete(handle);
        },
        emit() {
          for (const handle of registrations.keys()) {
            handle();
          }
        },
      });
      let calls = 0;
      const callback = () => {
        calls += 1;
        return "first";
      };
      try {
        const first = registry.create(
          "first",
          acquisition === "plugin-created" ? undefined : callback,
        );
        const second = registry.create("second");
        registry.emit();
        expect(registry.lookup(first)).toBe("first");
        expect(registry.remove(acquisition === "caller" ? callback : first)).toBe(true);
        registry.emit();
        expect(calls).toBe(acquisition === "plugin-created" ? 0 : 1);
        expect(registry.lookup(first)).toBeUndefined();
        expect(registry.lookup(second)).toBe("second");
        expect(registrations.size).toBe(1);
      } finally {
        await instance.dispose();
      }
    },
  );
});

describe("native collection data argument identity", () => {
  it("restores a layered handle without traversing its enclosing data", async () => {
    class Handle {
      #value = 42;
      static read(value: Handle) {
        return value.#value;
      }
    }
    const instance = new PluginInstance("layered-handle");
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
      const instance = new PluginInstance(`data-${collection}`);
      const original = () => "original";
      const replacement = () => "replacement";
      try {
        if (collection === "map") {
          const source: Map<() => string, () => string> = runInNewContext(
            'new Map([[original, () => "value"]])',
            { original },
          );
          const view = instance.wrap(source);
          let key = original;
          class Receiver {
            #label = "caller receiver";
            read() {
              return this.#label;
            }
          }
          const receiver = new Receiver();
          view.forEach(function (this: Receiver, value, candidate) {
            expect(this).toBe(receiver);
            expect(this.read()).toBe("caller receiver");
            expect(value).toBe(source.get(original));
            expect(candidate).toBe(original);
            key = candidate;
          }, receiver);
          expect(view.has(key)).toBe(true);
          expect(view.get(key)!()).toBe("value");
          expect(view.set(key, replacement)).toBe(source);
          expect(source.size).toBe(1);
          expect(source.get(original)).toBe(replacement);
          expect(view.get(key)!()).toBe("replacement");
          expect(view.delete(key)).toBe(true);
          expect(source.size).toBe(0);
        } else if (collection === "set") {
          const source = new Set([original]);
          const view = instance.wrap(source);
          expect(view.has(original)).toBe(true);
          expect(view.add(original)).toBe(source);
          expect(source.size).toBe(1);
          view.add(replacement);
          expect(source.has(replacement)).toBe(true);
          expect(view.delete(original)).toBe(true);
          expect(source.has(original)).toBe(false);
          expect(view.delete(replacement)).toBe(true);
        } else if (collection === "array") {
          const source = [original];
          const view = instance.wrap(source);
          const key = view[0]!;
          expect(view.includes(key)).toBe(true);
          expect(view.indexOf(key)).toBe(0);
          view.push(replacement);
          expect(source[1]).toBe(replacement);
          expect(view.includes(view[1]!)).toBe(true);
          view.splice(0, 1, replacement);
          expect(source[0]).toBe(replacement);
        } else {
          const source =
            collection === "weak-map"
              ? new WeakMap([[original, "value"]])
              : new WeakSet([original]);
          const view = instance.wrap(source);
          expect(view.has(original)).toBe(true);
          expect(view.has(instance.wrap(original))).toBe(true);
          expect(view.delete(instance.wrap(original))).toBe(true);
          expect(source.has(original)).toBe(false);
        }
      } finally {
        await instance.dispose();
      }
    },
  );

  it.each([
    { method: "reduce", shape: "function" },
    { method: "reduceRight", shape: "object" },
  ] as const)("preserves native $method $shape accumulator identity", async ({ method, shape }) => {
    type Accumulator = (() => string) | { read: () => string };
    const instance = new PluginInstance("reduce-data");
    const initial = () => "initial";
    const returned: Accumulator[] = ["first", "final"].map((label) =>
      shape === "function" ? () => label : { read: () => label },
    );
    const source = [() => "left plugin element", () => "right plugin element"];
    const view = instance.wrap(source);
    const run = (collection: typeof source) => {
      const accumulators: Accumulator[] = [];
      const result = collection[method]<Accumulator>((current, element, index, array) => {
        expect(array).toBe(source);
        expect(element).toBe(source[index]);
        accumulators.push(current);
        return returned[accumulators.length - 1]!;
      }, initial);
      return { result, accumulators };
    };
    try {
      const native = run(source);
      const managed = run(view);
      expect(managed.accumulators).toHaveLength(2);
      managed.accumulators.forEach((value, index) =>
        expect.soft(value).toBe(native.accumulators[index]),
      );
      expect(managed.result).toBe(native.result);
      // Without an initial value or callback invocation, the result is still a plugin element.
      const single = instance.wrap([source[0]!]);
      expect(single[method](() => initial)).toBe(instance.wrap(source[0]));
    } finally {
      await instance.dispose();
    }
  });
});

describe("async iterable helper callbacks", () => {
  it.each([
    { target: "source", lifetime: "async" },
    { target: "iterator", lifetime: "async" },
    { target: "iterator", lifetime: "retained" },
  ] as const)(
    "owns $lifetime callback values from a $target helper",
    async ({ target, lifetime }) => {
      const instance = new PluginInstance(`iterable-${target}-${lifetime}`);
      const release = createDeferredCore();
      const finished = createDeferredCore();
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
      let answer: unknown;
      let disposal: Promise<void> | undefined;
      try {
        helper.visit(
          lifetime === "retained"
            ? (handler) => {
                retained = handler;
                expect(handler()).toBe("private helper value");
              }
            : async (handler) => {
                try {
                  await release.promise;
                  answer = handler();
                } catch (error) {
                  answer = error;
                } finally {
                  finished.resolve();
                }
              },
        );
        await view.next();
        let disposed = false;
        disposal = instance.dispose().then(() => {
          disposed = true;
        });
        if (lifetime === "retained") {
          await disposal;
          expect(retained?.()).toBe("private helper value");
        } else {
          await yieldImmediate();
          expect(disposed, "stream completion retired an admitted helper callback").toBe(false);
          release.resolve();
          await finished.promise;
          await disposal;
          expect(answer).toBe("private helper value");
        }
      } finally {
        release.resolve();
        await view.return();
        await (disposal ?? instance.dispose());
        if (lifetime === "async") {
          await finished.promise;
        }
      }
    },
  );
});
