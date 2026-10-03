import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { PluginInstance } from "./plugin-instance.js";
import { PluginInvocationScope, runPluginCleanupScope } from "./plugin-invocation-scope.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

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
  it.each(["promise", "thenable"] as const)(
    "awaits a next() %s with native assimilation and live admission",
    async (kind) => {
      const instance = owner();
      const result = { done: false, value: { text: "chunk" } };
      const receivers: unknown[] = [];
      const thenable = {
        // oxlint-disable-next-line unicorn/no-thenable -- Exercise native async-iterator result assimilation.
        then(resolve: (value: typeof result) => void) {
          receivers.push(this);
          expect(instance.hasActiveCall).toBe(true);
          resolve(result);
        },
      };
      const promise = Promise.resolve(result);
      // oxlint-disable-next-line unicorn/no-thenable -- Native await must bypass this fulfilled Promise's override.
      void Object.defineProperty(promise, "then", {
        get() {
          throw new Error("Native await must not inspect this Promise's then override");
        },
      });
      const source = instance.wrap({
        [Symbol.asyncIterator]() {
          return {
            next: () => (kind === "promise" ? promise : thenable),
            return: async () => ({ done: true, value: undefined }),
          };
        },
      });
      const iterator = source[Symbol.asyncIterator]();
      try {
        const next = await iterator.next();
        expect(next.value).toBe(result.value);
        expect(receivers).toEqual(kind === "thenable" ? [thenable] : []);
      } finally {
        await iterator.return();
      }
    },
  );

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

  it.each(["inner", "outer"] as const)(
    "stops pending and future stream work when the %s consumer closes while delivered data stays readable",
    async (closed) => {
      const instance = owner();
      const consumer = instance.retainConsumer();
      const outer = instance.retainConsumer();
      const value = Object.freeze({ read: () => "first" });
      const later = createDeferredCore<IteratorResult<typeof value>>();
      let calls = 0;
      const stream = consumer.wrap({
        [Symbol.asyncIterator]() {
          return {
            next: () => (++calls === 1 ? { done: false, value } : later.promise),
          };
        },
      });
      const iterator = outer.wrap(stream)[Symbol.asyncIterator]();
      const retained = await iterator.next();
      const pending = Promise.resolve(iterator.next());
      const rejected = expect(pending).rejects.toThrow("stream is closed");
      try {
        (closed === "inner" ? consumer : outer).release();
        expect(instance.run(() => "still live")).toBe("still live");
        expect(retained.value).toBe(value);
        expect(retained.value.read()).toBe("first");
        later.resolve({ done: false, value });
        await rejected;
        if (closed === "inner") {
          await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
        } else {
          await expect(iterator.next()).rejects.toThrow("consumer is closed");
        }
        expect(calls).toBe(2);
      } finally {
        consumer.release();
        outer.release();
        later.resolve({ done: true, value });
        await pending.catch(() => {});
      }
    },
  );

  it.each(
    (["idle", "pending"] as const).flatMap((phase) => [
      { phase, operation: "next", sourceKind: "cursor" },
      { phase, operation: "iterator", sourceKind: "cursor" },
      { phase, operation: "iterator", sourceKind: "self" },
    ]),
  )(
    "settles a $phase $sourceKind stream lease when its closed cleanup scope rejects $operation",
    async ({ phase, operation, sourceKind }) => {
      const instance = owner();
      const finish = createDeferredCore<IteratorResult<string>>();
      const returned = vi.fn(async () => ({ done: true, value: "unexpected return" }));
      let calls = 0;
      let acquisitions = 0;
      const cursor = {
        [Symbol.asyncIterator]() {
          acquisitions += 1;
          return this;
        },
        async next() {
          calls += 1;
          return calls === 1 ? { done: false, value: "first" } : finish.promise;
        },
        return: returned,
      };
      const source = instance.wrap(
        sourceKind === "self" ? cursor : { [Symbol.asyncIterator]: () => cursor },
      );
      let iterator!: typeof cursor;
      let acquireIterator!: () => typeof cursor;
      let pending: ReturnType<typeof iterator.next> | undefined;
      try {
        await instance.run(() =>
          runPluginCleanupScope([source], async () => {
            const open = source[Symbol.asyncIterator];
            iterator = open();
            acquireIterator = sourceKind === "self" ? open : iterator[Symbol.asyncIterator];
            await expect(iterator.next()).resolves.toEqual({ done: false, value: "first" });
            if (phase === "pending") {
              pending = iterator.next();
              void pending.catch(() => {});
            }
          }),
        );
        expect(instance.ordinaryCallCount).toBe(1);
        if (operation === "iterator") {
          expect(acquireIterator).toThrow("Plugin cleanup scope is closed");
        } else {
          await expect(iterator.next()).rejects.toThrow("Plugin cleanup scope is closed");
        }
        expect(instance.ordinaryCallCount).toBe(phase === "pending" ? 1 : 0);
        await expect(iterator.return()).resolves.toEqual({ done: true, value: undefined });
        expect(instance.ordinaryCallCount).toBe(phase === "pending" ? 1 : 0);
        expect(returned).not.toHaveBeenCalled();
        expect(calls).toBe(phase === "pending" ? 2 : 1);
        expect(acquisitions).toBe(sourceKind === "self" ? 1 : 0);
        finish.resolve({ done: true, value: "finished" });
        await pending?.catch(() => {});
        expect(instance.ordinaryCallCount).toBe(0);
      } finally {
        finish.resolve({ done: true, value: "finished" });
        await pending?.catch(() => {});
      }
    },
  );

  it("settles a stream lease after its non-retained invocation scope closes", async () => {
    const instance = owner();
    const scope = new PluginInvocationScope(createEmptyPluginRegistry(), [instance]);
    const next = vi.fn(async () => ({ done: false, value: "first" }));
    const returned = vi.fn(async () => ({ done: true, value: undefined }));
    const source = { [Symbol.asyncIterator]: () => ({ next, return: returned }) };
    try {
      const iterator = scope.run(() => instance.wrap(source)[Symbol.asyncIterator]());
      await expect(iterator.next()).resolves.toEqual({ done: false, value: "first" });
      expect(instance.hasRetainedConsumers).toBe(false);
      expect(instance.ordinaryCallCount).toBe(1);
      scope.release();
      await expect(iterator.next()).rejects.toThrow("Plugin invocation scope is closed");
      expect(instance.ordinaryCallCount).toBe(0);
      await expect(iterator.return()).resolves.toEqual({ done: true, value: undefined });
      expect(next).toHaveBeenCalledOnce();
      expect(returned).not.toHaveBeenCalled();
    } finally {
      scope.release();
    }
  });

  it.each(["next", "return", "metadata"] as const)(
    "fences an inactive iterator's %s getter when its original scope closes",
    async (member) => {
      const instance = owner();
      const scope = new PluginInvocationScope(createEmptyPluginRegistry(), [instance]);
      const source = (async function* () {
        try {
          yield 1;
        } finally {
          yield 2;
        }
      })();
      const native =
        member === "next"
          ? source.next.bind(source)
          : member === "return"
            ? source.return.bind(source)
            : undefined;
      let reads = 0;
      Object.defineProperty(source, member, {
        configurable: true,
        get() {
          reads += 1;
          return member === "metadata" ? "plugin metadata" : native;
        },
      });
      try {
        const iterator = scope.run(() => instance.wrap(source)[Symbol.asyncIterator]());
        await expect(iterator.next()).resolves.toEqual({ done: false, value: 1 });
        await expect(iterator.return(undefined)).resolves.toEqual({ done: false, value: 2 });
        expect(instance.ordinaryCallCount).toBe(0);
        const admittedReads = reads;
        scope.release();
        expect(() => Reflect.get(iterator, member)).toThrow("Plugin invocation scope is closed");
        expect(reads).toBe(admittedReads);
        expect(instance.ordinaryCallCount).toBe(0);
      } finally {
        scope.release();
      }
    },
  );

  it("negotiates a completed self-iterator without entering plugin code again", async () => {
    const instance = owner();
    let acquisitions = 0;
    let factoryReads = 0;
    class Stream {
      get [Symbol.asyncIterator](): () => Stream {
        factoryReads += 1;
        return acquire;
      }

      async next() {
        return { done: true, value: "finished" };
      }
    }
    function acquire(this: Stream) {
      acquisitions += 1;
      return this;
    }
    const source = instance.wrap(new Stream());
    const open = source[Symbol.asyncIterator];
    const iterator = open();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: "finished" });
    expect(open()).toBe(iterator);
    expect(iterator[Symbol.asyncIterator]()).toBe(iterator);
    expect(instance.ordinaryCallCount).toBe(0);
    expect(acquisitions).toBe(1);
    expect(factoryReads).toBe(1);
  });

  it.each(["record", "callable", "proxy"] as const)(
    "preserves unread terminal %s results after self-retirement",
    async (kind) => {
      const instance = owner();
      const payload = { content: [{ text: "complete" }] };
      const result = { done: true, value: payload };
      const callable = Object.assign(() => {}, result);
      Object.defineProperty(callable, "length", {
        get() {
          expect(instance.hasActiveCall).toBe(true);
          return 0;
        },
      });
      const source = instance.wrap({
        [Symbol.asyncIterator]() {
          return {
            async next() {
              await instance.dispose();
              return kind === "callable"
                ? callable
                : kind === "proxy"
                  ? Object.create(new Proxy(result, {}))
                  : result;
            },
          };
        },
      });
      const iterator = source[Symbol.asyncIterator]();
      const next = await iterator.next();
      expect(next.done).toBe(true);
      await instance.dispose();
      expect(next.value).toBe(payload);
      expect(structuredClone(next.value)).toEqual(payload);
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

  it.each([
    { phase: "live", resume: "next" },
    { phase: "live", resume: "iterator" },
    { phase: "retired", resume: "next" },
  ] as const)(
    "only resumes a finally yield through $resume when its instance is $phase",
    async ({ phase, resume }) => {
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
        if (resume === "iterator") {
          expect(iterator[Symbol.asyncIterator]()).toBe(iterator);
        }
        await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
      }
      const closed = expect(instance.dispose()).resolves.toEqual({ errors: [] });
      await vi.runAllTimersAsync();
      await closed;
      await expect(iterator.next()).rejects.toThrow(/stream is closed|reloaded or disabled/);
      expect(finished).toHaveBeenCalledTimes(phase === "live" ? 1 : 0);
    },
  );

  it.each(
    (["finite scope", "consumer"] as const).flatMap((custody) =>
      (["next", "iterator"] as const).map((operation) => ({ custody, operation })),
    ),
  )(
    "keeps the original $custody authority after renewal when a late $operation resumes",
    async ({ custody, operation }) => {
      const instance = owner();
      const origin =
        custody === "finite scope"
          ? new PluginInvocationScope(createEmptyPluginRegistry(), [instance])
          : instance.retainConsumer();
      const finished = vi.fn();
      const source = (async function* () {
        try {
          yield 1;
        } finally {
          yield 2;
          yield 3;
          finished();
        }
      })();
      let open!: () => typeof source;
      try {
        const iterator = origin.run(() => {
          const stream = instance.wrap(source);
          open = stream[Symbol.asyncIterator];
          return open();
        });
        // oxlint-disable-next-line typescript/unbound-method -- Detached on purpose: the wrapped iterator must keep its receiver.
        const next = iterator.next;
        await expect(next()).resolves.toEqual({ done: false, value: 1 });
        await expect(iterator.return(undefined)).resolves.toEqual({ done: false, value: 2 });
        expect(open()).toBe(iterator);
        await expect(next()).resolves.toEqual({ done: false, value: 3 });
        expect(instance.ordinaryCallCount).toBe(custody === "finite scope" ? 1 : 0);
        origin.release();
        const closed =
          custody === "finite scope"
            ? /invocation scope is closed/
            : /consumer is closed|stream is closed/;
        if (operation === "iterator") {
          expect(open).toThrow(closed);
        } else {
          await expect(next()).rejects.toThrow(closed);
        }
        expect(finished).not.toHaveBeenCalled();
        expect(instance.ordinaryCallCount).toBe(0);
      } finally {
        origin.release();
      }
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

  it.each([null, 1])("releases admission after an invalid protocol result %s", async (value) => {
    const instance = owner();
    const stream = instance.wrap({
      [Symbol.asyncIterator]() {
        return { next: async () => value };
      },
    });
    const iterator = stream[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow("iterator result must be an object");
    await instance.dispose();
  });

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
