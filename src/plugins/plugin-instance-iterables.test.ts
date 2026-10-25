import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { PluginInstance } from "./plugin-instance.js";
import { chunks, iterable, throwing } from "./plugin-instance.test-support.js";
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

async function* yieldingFinally(values: number[], finished = () => {}) {
  try {
    yield 1;
  } finally {
    for (const value of values) {
      yield value;
    }
    finished();
  }
}

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
      get: throwing(new Error("Native await must not inspect this Promise's then override")),
    });
    const source = instance.wrap(
      iterable({
        next: () => (kind === "promise" ? promise : thenable),
        return: async () => ({ done: true, value: undefined }),
      }),
    );
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
  "preserves exhausted iterator negotiation and native %s completion",
  async (method) => {
    async function* source(): AsyncGenerator<number, string, unknown> {
      yield 1;
      return "complete";
    }
    const native = source();
    const instance = owner();
    const stream = instance.wrap(source());
    const open = stream[Symbol.asyncIterator];
    const wrapped = open();
    for (const iterator of [native, wrapped]) {
      await expect(iterator.next()).resolves.toEqual({ done: false, value: 1 });
      await expect(iterator.next()).resolves.toEqual({ done: true, value: "complete" });
    }
    expect(open()).toBe(wrapped);
    expect(wrapped[Symbol.asyncIterator]()).toBe(wrapped);
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

it("finishes iteration during retirement with a terminal proxy result", async () => {
  const instance = owner();
  const started = createDeferredCore();
  const finish = createDeferredCore();
  const readValue = vi.fn(throwing(new Error("Iteration must not read the terminal value")));
  const terminal = {
    done: true,
    get value() {
      return readValue();
    },
  };
  const result = new Proxy(terminal, {
    get(target, key, receiver) {
      return key === "done" ? true : Reflect.get(target, key, receiver);
    },
  });
  const stream = instance.wrap(
    iterable({
      async next() {
        started.resolve();
        await finish.promise;
        return result;
      },
    }),
  );
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
});

it.each(["inner", "outer"] as const)(
  "closes pending/future streams, preserving delivered data, when the %s consumer closes",
  async (closed) => {
    const instance = owner();
    const consumer = instance.retainConsumer();
    const outer = instance.retainConsumer();
    const value = Object.freeze({ read: () => "first" });
    const later = createDeferredCore<IteratorResult<typeof value>>();
    let calls = 0;
    const stream = consumer.wrap(
      iterable({
        next: () => (++calls === 1 ? { done: false, value } : later.promise),
      }),
    );
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
  "settles $phase $sourceKind streams when closed cleanup rejects $operation",
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
      expect([calls, acquisitions]).toEqual([
        phase === "pending" ? 2 : 1,
        sourceKind === "self" ? 1 : 0,
      ]);
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
    expect(instance).toMatchObject({ hasRetainedConsumers: false, ordinaryCallCount: 1 });
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
    const source = yieldingFinally([2]);
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

it("preserves unread terminal callable results after self-retirement", async () => {
  const instance = owner();
  const payload = { content: [{ text: "complete" }] };
  const result = { done: true, value: payload };
  const callable = Object.assign(() => {}, result);
  const source = instance.wrap(
    iterable({
      async next() {
        await instance.dispose();
        return callable;
      },
    }),
  );
  const iterator = source[Symbol.asyncIterator]();
  const next = await iterator.next();
  expect(next.done).toBe(true);
  await instance.dispose();
  expect(next.value).toBe(payload);
  expect(structuredClone(next.value)).toEqual(payload);
});

it.each(["missing", "done-false", "getter", "non-callable"] as const)(
  "releases an early-break admission when return is %s",
  async (kind) => {
    const instance = owner();
    const failure = new Error("return lookup failed");
    const returned = vi.fn(async () => ({ done: false, value: 2 }));
    const source = {
      [Symbol.asyncIterator]() {
        const iterator = { next: async () => ({ done: false, value: 1 }) };
        Object.defineProperty(iterator, "return", {
          get() {
            if (kind === "getter") {
              throw failure;
            }
            return kind === "missing" ? undefined : kind === "non-callable" ? 1 : returned;
          },
        });
        return iterator;
      },
    };
    const values: number[] = [];
    const consume = async () => {
      for await (const value of instance.wrap(source)) {
        values.push(value);
        break;
      }
    };
    const consumed =
      kind === "getter" || kind === "non-callable" ? consume() : instance.runConsumer(consume);
    if (kind === "getter") {
      await expect(consumed).rejects.toBe(failure);
    } else if (kind === "non-callable") {
      await expect(consumed).rejects.toBeInstanceOf(TypeError);
    } else {
      await consumed;
    }
    expect(values).toEqual([1]);
    expect(returned).toHaveBeenCalledTimes(kind === "done-false" ? 1 : 0);
    const closed = expect(instance.dispose()).resolves.toEqual({ errors: [] });
    await vi.runAllTimersAsync();
    await closed;
  },
);

it.each(["live", "retired"] as const)(
  "only resumes a finally yield when its instance is %s",
  async (phase) => {
    const instance = owner();
    const finished = vi.fn();
    const source = yieldingFinally([2], finished);
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

it.each(
  (["finite scope", "consumer"] as const).flatMap((custody) =>
    (["next", "iterator"] as const).map((operation) => ({ custody, operation })),
  ),
)(
  "retains $custody authority across renewal and late $operation",
  async ({ custody, operation }) => {
    const instance = owner();
    const origin =
      custody === "finite scope"
        ? new PluginInvocationScope(createEmptyPluginRegistry(), [instance])
        : instance.retainConsumer();
    const finished = vi.fn();
    const source = yieldingFinally([2, 3], finished);
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

it.each([null, 1])("releases admission after an invalid protocol result %s", async (value) => {
  const instance = owner();
  const stream = instance.wrap(iterable({ next: async () => value }));
  const iterator = stream[Symbol.asyncIterator]();

  await expect(iterator.next()).rejects.toThrow("iterator result must be an object");
  await instance.dispose();
});

it.each(["factory", "throw"] as const)(
  "reads an iterator getter lazily and preserves its %s outcome",
  async (outcome) => {
    const instance = owner();
    const failure = new Error("iterator getter requested");
    let reads = 0;
    const receivers: unknown[] = [];
    const getter = vi.fn(() => {
      const selected = ++reads;
      if (outcome === "throw") {
        throw failure;
      }
      return async function* (this: object) {
        receivers.push(this);
        yield selected;
      };
    });
    const source = {
      label: "plain data",
      get [Symbol.asyncIterator]() {
        return getter();
      },
    };
    const wrapped = instance.wrap(source);
    expect(wrapped.label).toBe("plain data");
    expect(getter).not.toHaveBeenCalled();
    if (outcome === "throw") {
      expect(() => Reflect.get(wrapped, Symbol.asyncIterator)).toThrow(failure);
    } else {
      const factory = wrapped[Symbol.asyncIterator];
      const iterator = factory.call(wrapped);
      expect(await iterator.next()).toEqual({ value: 1, done: false });
      expect(await iterator.next()).toMatchObject({ done: true });
      expect(receivers).toEqual([source]);
    }
    expect(reads).toBe(1);
    expect(getter).toHaveBeenCalledOnce();
  },
);

it("only invokes a terminal hook on explicit calls, preserving arguments and receiver", async () => {
  const instance = owner();
  let calls = 0;
  const result = vi.fn(async function (this: object, argument: string) {
    expect(this).toBe(source);
    return { call: ++calls, argument };
  });
  const getter = vi.fn(() => result);
  const source = {
    [Symbol.asyncIterator]: () => chunks("chunk"),
    get result() {
      return getter();
    },
  };
  const wrapped = instance.wrap(source);
  const values: string[] = [];
  for await (const chunk of wrapped) {
    values.push(chunk);
  }
  expect(values).toEqual(["chunk"]);
  expect(getter).not.toHaveBeenCalled();
  expect(result).not.toHaveBeenCalled();
  await expect(wrapped.result("first")).resolves.toEqual({ call: 1, argument: "first" });
  await expect(wrapped.result("second")).resolves.toEqual({ call: 2, argument: "second" });
  expect(calls).toBe(2);
});

it("disposes an unconsumed iterable without starting its terminal work", async () => {
  const instance = owner();
  const result = vi.fn(() => new Promise<never>(() => {}));
  const iterator = vi.fn(() => chunks("unused"));
  const cleanup = vi.fn();
  instance.lifecycle.onDispose(cleanup);
  instance.wrap({ [Symbol.asyncIterator]: iterator, result });

  const disposed = expect(instance.dispose()).resolves.toEqual({ errors: [] });
  await vi.runAllTimersAsync();
  await disposed;
  expect(cleanup).toHaveBeenCalledOnce();
  expect(iterator).not.toHaveBeenCalled();
  expect(result).not.toHaveBeenCalled();
});
