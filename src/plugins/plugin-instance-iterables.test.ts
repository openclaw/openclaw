import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { PluginInstance } from "./plugin-instance.js";

const instances: PluginInstance[] = [];
const owner = () => {
  const instance = new PluginInstance("iterable-protocol");
  instances.push(instance);
  return instance;
};

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  const cleanup = Promise.allSettled(instances.splice(0).map((instance) => instance.dispose()));
  await vi.runAllTimersAsync();
  const results = await cleanup;
  vi.useRealTimers();
  for (const result of results) {
    expect(result.status).toBe("fulfilled");
  }
});

describe("plugin async iterable protocol", () => {
  it.each(["next", "throw"] as const)(
    "preserves native %s completion after exhaustion while its owner is live",
    async (method) => {
      async function* source(): AsyncGenerator<number, string, unknown> {
        yield 1;
        return "complete";
      }
      const native = source();
      const wrapped = owner().wrap(source());
      for (const iterator of [native, wrapped]) {
        await expect(iterator.next()).resolves.toEqual({ done: false, value: 1 });
        await expect(iterator.next()).resolves.toEqual({ done: true, value: "complete" });
      }
      const supplied = new Error("caller-supplied terminal reason");
      const [expected, actual] = await Promise.allSettled([
        native[method](supplied),
        wrapped[method](supplied),
      ]);
      expect(actual).toEqual(expected);
      if (method === "throw") {
        expect(actual.status).toBe("rejected");
        if (actual.status === "rejected") {
          expect(actual.reason).toBe(supplied);
        }
      }
    },
  );

  it.each(["data", "getter", "proxy"] as const)(
    "finishes iteration during retirement with a terminal %s result",
    async (kind) => {
      const instance = owner();
      const started = createDeferredCore();
      const finish = createDeferredCore();
      const readDone = vi.fn(() => true);
      const readValue = vi.fn(() => {
        throw new Error("Iteration must not read the terminal value");
      });
      const terminal = {
        done: true,
        get value() {
          return readValue();
        },
      };
      if (kind === "getter") {
        Object.defineProperty(terminal, "done", { get: readDone });
      }
      const result =
        kind === "proxy"
          ? new Proxy(terminal, {
              get(target, key, receiver) {
                return key === "done" ? readDone() : Reflect.get(target, key, receiver);
              },
            })
          : terminal;
      const stream = instance.wrap({
        [Symbol.asyncIterator]() {
          return {
            async next() {
              started.resolve();
              await finish.promise;
              return result;
            },
          };
        },
      });
      const consume = (async () => {
        for await (const _ of stream) {
          throw new Error("The fixture only returns EOF");
        }
      })();
      const consumed = expect(consume).resolves.toBeUndefined();
      await started.promise;
      const closing = instance.dispose();
      finish.resolve();
      await consumed;
      await closing;
      expect(readValue).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "done-false"] as const)(
    "releases an early-break admission when return is %s",
    async (kind) => {
      const instance = owner();
      const returned = vi.fn(async () => ({ done: false, value: 2 }));
      const source = {
        [Symbol.asyncIterator]() {
          return {
            next: async () => ({ done: false, value: 1 }),
            return: kind === "missing" ? undefined : returned,
          };
        },
      };
      const stream = instance.wrap(source);
      const values: number[] = [];
      await instance.runConsumer(async () => {
        for await (const value of stream) {
          values.push(value);
          break;
        }
      });
      expect(values).toEqual([1]);
      expect(returned).toHaveBeenCalledTimes(kind === "missing" ? 0 : 1);
      const closed = expect(instance.dispose()).resolves.toEqual({ errors: [] });
      await vi.runAllTimersAsync();
      await closed;
    },
  );

  it.each(["live", "retired"] as const)(
    "only resumes a finally yield after return when its instance is live: %s",
    async (phase) => {
      const instance = owner();
      const finished = vi.fn();
      const source = (async function* () {
        try {
          yield 1;
        } finally {
          yield 2;
          finished();
        }
      })();
      const iterator = instance.wrap(source);
      await expect(iterator.next()).resolves.toEqual({ done: false, value: 1 });
      await expect(iterator.return(undefined)).resolves.toEqual({ done: false, value: 2 });
      if (phase === "live") {
        await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
      }
      const closed = expect(instance.dispose()).resolves.toEqual({ errors: [] });
      await vi.runAllTimersAsync();
      await closed;
      await expect(iterator.next()).rejects.toThrow(/stream is closed|reloaded or disabled/);
      expect(finished).toHaveBeenCalledTimes(phase === "live" ? 1 : 0);
    },
  );

  it.each(["getter", "non-callable"] as const)(
    "releases an early-break admission when return has a %s failure",
    async (kind) => {
      const instance = owner();
      const failure = new Error("return lookup failed");
      const source = {
        [Symbol.asyncIterator]() {
          const iterator = { next: async () => ({ done: false, value: 1 }) };
          Object.defineProperty(iterator, "return", {
            get() {
              if (kind === "getter") {
                throw failure;
              }
              return 1;
            },
          });
          return iterator;
        },
      };
      const consume = async () => {
        for await (const _ of instance.wrap(source)) {
          break;
        }
      };
      if (kind === "getter") {
        await expect(consume()).rejects.toBe(failure);
      } else {
        await expect(consume()).rejects.toBeInstanceOf(TypeError);
      }
      const closed = expect(instance.dispose()).resolves.toEqual({ errors: [] });
      await vi.runAllTimersAsync();
      await closed;
    },
  );

  it.each([undefined, null, 1])(
    "releases admission after an invalid protocol result %s",
    async (value) => {
      const instance = owner();
      const stream = instance.wrap({
        [Symbol.asyncIterator]() {
          return { next: async () => value };
        },
      });
      const iterator = stream[Symbol.asyncIterator]();

      await expect(iterator.next()).rejects.toThrow("iterator result must be an object");
      await instance.dispose();
    },
  );

  it("does not read an iterator getter until the consumer requests it", () => {
    const instance = owner();
    const failure = new Error("iterator getter requested");
    const getter = vi.fn(() => {
      throw failure;
    });
    const source = { label: "plain data" };
    Object.defineProperty(source, Symbol.asyncIterator, { get: getter });

    const wrapped = instance.wrap(source);
    expect(wrapped.label).toBe("plain data");
    expect(getter).not.toHaveBeenCalled();
    expect(() => Reflect.get(wrapped, Symbol.asyncIterator)).toThrow(failure);
    expect(getter).toHaveBeenCalledOnce();
  });

  it("calls the single captured iterator factory with its original receiver", async () => {
    const instance = owner();
    let reads = 0;
    const receivers: unknown[] = [];
    const source = {
      get [Symbol.asyncIterator]() {
        const selected = ++reads;
        return async function* (this: object) {
          receivers.push(this);
          yield selected;
        };
      },
    };
    const wrapped = instance.wrap(source);
    const factory = wrapped[Symbol.asyncIterator];
    const iterator = factory.call(wrapped);
    expect(await iterator.next()).toEqual({ value: 1, done: false });
    expect(await iterator.next()).toMatchObject({ done: true });
    expect(reads).toBe(1);
    expect(receivers).toEqual([source]);
  });

  it("does not read or call result while merely iterating", async () => {
    const instance = owner();
    const result = vi.fn(async () => "unused");
    const getter = vi.fn(() => result);
    const source = {
      async *[Symbol.asyncIterator]() {
        yield "chunk";
      },
      get result() {
        return getter();
      },
    };
    const wrapped = instance.wrap(source);
    const chunks: string[] = [];
    for await (const chunk of wrapped) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["chunk"]);
    expect(getter).not.toHaveBeenCalled();
    expect(result).not.toHaveBeenCalled();
  });

  it("preserves each explicit result call, its arguments, and its receiver", async () => {
    const instance = owner();
    let calls = 0;
    const source = {
      async *[Symbol.asyncIterator]() {
        yield "chunk";
      },
      async result(argument: string) {
        expect(this).toBe(source);
        return { call: ++calls, argument };
      },
    };
    const wrapped = instance.wrap(source);
    await expect(wrapped.result("first")).resolves.toEqual({ call: 1, argument: "first" });
    await expect(wrapped.result("second")).resolves.toEqual({ call: 2, argument: "second" });
    expect(calls).toBe(2);
  });

  it("disposes an unconsumed iterable without starting its terminal work", async () => {
    const instance = owner();
    const result = vi.fn(() => new Promise<never>(() => {}));
    const iterator = vi.fn(async function* () {
      yield "unused";
    });
    const cleanup = vi.fn();
    instance.lifecycle.onDispose(cleanup);
    instance.wrap({ [Symbol.asyncIterator]: iterator, result });

    const disposed = instance.dispose().then(
      () => ({ status: "fulfilled" }),
      (error: unknown) => ({ status: "rejected", error }),
    );
    await vi.runAllTimersAsync();
    expect(await disposed).toEqual({ status: "fulfilled" });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(iterator).not.toHaveBeenCalled();
    expect(result).not.toHaveBeenCalled();
  });

  it("drains an explicitly admitted terminal promise after iteration ends", async () => {
    const instance = owner();
    const terminal = createDeferredCore<string>();
    const source = {
      async *[Symbol.asyncIterator]() {
        yield "chunk";
      },
      result: () => terminal.promise,
    };
    const wrapped = instance.wrap(source);
    const iterator = wrapped[Symbol.asyncIterator]();
    await iterator.next();
    const result = wrapped.result();
    let disposed = false;
    const closing = instance.dispose().then(() => {
      disposed = true;
    });
    try {
      await expect(iterator.next()).resolves.toMatchObject({ done: true });
      expect(disposed).toBe(false);
      terminal.resolve("final");
      await expect(result).resolves.toBe("final");
      await closing;
    } finally {
      terminal.resolve("final");
      await closing;
    }
  });
});
