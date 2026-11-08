import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { createPluginRuntimeStore } from "../plugin-sdk/runtime-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { buildPluginApi, createUnavailableRuntime } from "./api-builder.js";
import { instrumentPluginInstanceApi } from "./api-facades.js";
import { runPluginRegistration } from "./api-lifecycle.js";
import { registerPluginCommandInRegistry } from "./command-registration.js";
import type {
  PluginAgentEventSubscriptionRegistration,
  PluginRuntimeLifecycleRegistration,
  PluginSessionActionRegistration,
} from "./host-hooks.js";
import { registerPluginHttpRoute } from "./http-registry.js";
import { registerMemoryCapability } from "./memory-state.js";
import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import { runPluginCleanup } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import {
  chunks,
  createOwnedInstance,
  createTestInstance,
  drainTimeout,
  expectUnavailable,
  iterable,
  throwing,
  trackCompletion,
} from "./plugin-instance.test-support.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { adoptPluginRegistryRecords } from "./registry-lifecycle.js";
import {
  getPluginRuntimeGatewayRequestScope as getScope,
  withPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";

afterEach(() => vi.useRealTimers());

it.each(["call", "cleanup", "consumer", "host prelude"] as const)(
  "forces logical retirement at the existing deadline while a %s never settles",
  async (kind) => {
    vi.useFakeTimers();
    const instance = new PluginInstance("hung");
    const never = new Promise<void>(() => {});
    const releaseModules = vi.fn(async () => {});
    instance.onModuleDispose(releaseModules);
    if (kind === "call") {
      void instance.run(() => never);
    } else if (kind === "cleanup") {
      instance.lifecycle.onDispose(() => never);
    } else if (kind === "consumer") {
      instance.retainConsumer();
    }
    let result: Awaited<ReturnType<PluginInstance["dispose"]>> | undefined;
    void instance.dispose(kind === "host prelude" ? () => never : undefined).then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result?.errors).toHaveLength(1);
    expect(drainTimeout(result?.errors[0]).forcedRetirement).toEqual({
      activeCallCount: kind === "consumer" ? 0 : 1,
      retainedConsumerCount: kind === "consumer" ? 1 : 0,
    });
    expect(instance.lifecycle.signal.aborted).toBe(true);
    expectUnavailable(() => instance.run(() => "late"));
    expect(releaseModules).not.toHaveBeenCalled();
  },
);

it("keeps healthy cleanup within its budget when the wall clock jumps forward", async () => {
  vi.useFakeTimers();
  const instance = new PluginInstance("cleanup-clock");
  instance.lifecycle.onDispose(() => {
    vi.setSystemTime(Date.now() + 4_000);
    return new Promise<void>((resolve) => {
      setTimeout(resolve, 1_500);
    });
  });

  const disposal = instance.dispose();
  await vi.advanceTimersByTimeAsync(1_500);
  expect((await disposal).errors).toEqual([]);
});

it("optionally drains retained consumers before resources stop while preserving default drain", async () => {
  const instance = new PluginInstance("consumer-drain");
  const consumer = instance.retainConsumer();
  const cleanup = createDeferredCore();
  try {
    await expect(instance.drain()).resolves.toEqual({ errors: [] });
    const draining = trackCompletion(instance.drain({ includeConsumers: true }));
    await Promise.resolve();
    expect(draining.done).toBe(false);
    expect(instance.lifecycle.signal.aborted).toBe(false);
    expect(consumer.run(() => "existing work continues")).toBe("existing work continues");
    expectUnavailable(() => instance.run(() => undefined));
    const closing = consumer.close(() => cleanup.promise);
    await Promise.resolve();
    expect(draining.done).toBe(false);
    cleanup.resolve();
    await closing;
    await draining.promise;
    expect(instance.lifecycle.signal.aborted).toBe(false);
    instance.resume();
    expect(instance.run(() => "resumed")).toBe("resumed");
  } finally {
    cleanup.resolve();
    consumer.release();
    await instance.dispose();
  }
});

it("lets a self-retiring call finish before joined explicit cleanup", async () => {
  const instance = new PluginInstance("self");
  const events: string[] = [];
  instance.lifecycle.onDispose(async () => {
    await Promise.resolve();
    events.push("cleanup");
  });
  const helper = instance.wrap(() => "receipt completed");
  const tool = instance.wrap(async () => {
    await instance.dispose();
    events.push("reload published");
    const result = await new Promise<string>((resolve) => {
      setImmediate(() => resolve(helper()));
    });
    events.push(result);
    return result;
  });
  const call = tool();
  const disposal = instance.dispose();
  expectUnavailable(() => tool());
  await expect(call).resolves.toBe("receipt completed");
  await disposal;
  expect(events).toEqual(["reload published", "receipt completed", "cleanup"]);
  expect(instance.lifecycle.signal.aborted).toBe(true);
});

it("lets admitted calls consume a self-retiring call's result before cleanup", async () => {
  const instance = new PluginInstance("dependent-calls");
  const startRetirement = createDeferredCore();
  const events: string[] = [];
  instance.lifecycle.onDispose(() => {
    events.push("cleanup");
  });
  const first = instance.wrap(async () => {
    await startRetirement.promise;
    await instance.dispose();
    return "first result";
  })();
  const second = instance.wrap(async () => {
    events.push(await first);
    return "second result";
  })();
  startRetirement.resolve();
  await expect(Promise.all([first, second])).resolves.toEqual(["first result", "second result"]);
  expect(events).toEqual(["first result", "cleanup"]);
});

it("hands an asynchronously returned stream to its consumer before joining retirement", async () => {
  const instance = new PluginInstance("async-stream");
  const cleaned = vi.fn();
  instance.lifecycle.onDispose(cleaned);
  const helper = instance.wrap(() => "chunk");
  const open = instance.wrap(async () => {
    await instance.dispose();
    return (async function* () {
      yield helper();
    })();
  });
  const output = await instance.run(async () => {
    const stream = await open();
    expect(cleaned).not.toHaveBeenCalled();
    const values: string[] = [];
    for await (const chunk of stream) {
      values.push(chunk);
    }
    return values;
  });
  expect(output).toEqual(["chunk"]);
  expect(cleaned).toHaveBeenCalledOnce();
  expectUnavailable(() => helper());
});

it("admits teardown only from its host owner and fences retained cleanup after disposal", async () => {
  const instance = new PluginInstance("teardown");
  const called = vi.fn();
  const helper = instance.wrap(() => called());
  const service = instance.wrap({
    async stop() {
      await Promise.resolve();
      helper();
    },
    cleanup: helper,
    dispose: helper,
    return: helper,
  });
  instance.quiesce();
  expectUnavailable(...Object.values(service));
  await runPluginCleanup(service, () => service.stop());
  expect(called).toHaveBeenCalledOnce();
  await instance.dispose();
  expect(() => runPluginCleanup(service, () => service.stop())).toThrow("retiring");
  expectUnavailable(...Object.values(service));
  expect(called).toHaveBeenCalledOnce();
});

it("keeps cached SDK runtime stores separate during preparation and rollback", async () => {
  const store = createPluginRuntimeStore<string>({ pluginId: "shared", errorMessage: "not set" });
  const current = new PluginInstance("shared");
  const candidate = new PluginInstance("shared");
  current.run(() => store.setRuntime("current"));
  candidate.run(() => store.setRuntime("candidate"));
  expect(current.run(store.getRuntime)).toBe("current");
  expect(candidate.run(store.getRuntime)).toBe("candidate");
  await candidate.dispose();
  expect(current.run(store.getRuntime)).toBe("current");
  await current.dispose();
});

it("preserves class receivers and fences callable re-exports, including frozen getters", async () => {
  const instance = new PluginInstance("classes");
  class Counter {
    static #label = "counter";
    static label() {
      return this.#label;
    }
    static get reader() {
      return () => this.#label;
    }
    #value: number;
    constructor(value: number) {
      this.#value = value;
    }
    get read() {
      return () => this.#value;
    }
    increment() {
      return ++this.#value;
    }
  }
  const WrappedCounter = instance.wrap(Object.freeze(Counter));
  const label: () => string = Reflect.get(WrappedCounter, "label");
  const readLabel = WrappedCounter.reader;
  expect([label(), readLabel()]).toEqual(["counter", "counter"]);
  const counter = new WrappedCounter(2);
  const readExport = vi.fn(() => counter.read);
  const exports = instance.wrap(
    Object.freeze({
      get read() {
        return readExport();
      },
    }),
  );
  expect(Object.keys(exports)).toEqual(["read"]);
  const readDescriptor = Object.getOwnPropertyDescriptor(exports, "read")!;
  expect(typeof readDescriptor.get).toBe("function");
  expect(readExport).not.toHaveBeenCalled();
  const read = exports.read;
  expect(counter).toBeInstanceOf(Counter);
  expect([counter.increment(), read()]).toEqual([3, 3]);
  await instance.dispose();
  expectUnavailable(
    read,
    () => exports.read,
    () => new WrappedCounter(2),
    label,
    readLabel,
    () => WrappedCounter.reader,
    () => readDescriptor.get!(),
  );
});

it.each(["before wrapping", "after growing"] as const)(
  "preserves cross-realm array descriptors frozen %s",
  async (freezeAt) => {
    const instance = createTestInstance("frozen-array");
    const source: Array<{ execute(): string }> = runInNewContext(
      '[{ execute() { return "current"; } }]',
    );
    if (freezeAt === "before wrapping") {
      Object.freeze(source);
    }
    const view = instance.wrap(source);
    if (freezeAt === "after growing") {
      source.push({ execute: () => "second" });
    }
    Object.freeze(source);
    expect(Array.isArray(view)).toBe(true);
    expect(Object.keys(view)).toEqual(Object.keys(source));
    expect(Object.getOwnPropertyDescriptor(view, "length")).toEqual(
      Object.getOwnPropertyDescriptor(source, "length"),
    );
    expect(view.length).toBe(source.length);
    const execute: () => string = Reflect.get(view[0]!, "execute");
    expect(execute()).toBe("current");
    await instance.dispose();
    expectUnavailable(() => execute());
  },
);

it.each(["stream", "iterator"] as const)(
  "fences retained %s getters after stream closure without hiding plain data",
  async (target) => {
    const instance = new PluginInstance("stream-getters");
    const read = vi.fn(() => "retired getter");
    const iterator = chunks("chunk");
    const source = {
      [Symbol.asyncIterator]: () => iterator,
      label: "retained data",
    };
    Object.defineProperty(iterator, "status", { get: read });
    Object.defineProperty(source, "status", { get: read });
    const stream = instance.wrap(source);
    const view = stream[Symbol.asyncIterator]();
    await expect(view.next()).resolves.toEqual({ done: false, value: "chunk" });
    await expect(view.next()).resolves.toMatchObject({ done: true });
    await instance.dispose();
    expect(() => Reflect.get(target === "stream" ? stream : view, "status")).toThrow(
      /stream is closed|reloaded or disabled/,
    );
    expect(read).not.toHaveBeenCalled();
    expect(stream.label).toBe("retained data");
  },
);

it.each(["iteratorMember", "asyncSourceMethod"] as const)(
  "fences callable values returned through a stream's %s",
  async (target) => {
    const instance = new PluginInstance("stream-values");
    const read = vi.fn(() => "owned value");
    const payload = { read, done: true };
    const iterator = Object.assign(chunks(payload), { member: payload });
    const stream = instance.wrap({
      [Symbol.asyncIterator]: () => iterator,
      helperAsync: async () => read,
    });
    const view = stream[Symbol.asyncIterator]();
    await expect(view.next()).resolves.toMatchObject({ done: false, value: { done: true } });
    const readers = {
      iteratorMember: () => view.member.read,
      asyncSourceMethod: () => stream.helperAsync(),
    };
    const retained = await readers[target]();
    expect(retained()).toBe("owned value");
    await expect(view.next()).resolves.toMatchObject({ done: true });
    await instance.dispose();
    expectUnavailable(() => retained());
    expect(read).toHaveBeenCalledOnce();
  },
);

it.each(["source", "iterator"] as const)(
  "joins an admitted async %s helper after its cursor ends",
  async (target) => {
    const instance = new PluginInstance("stream-helper");
    const proceed = createDeferredCore();
    const events: string[] = [];
    instance.lifecycle.onDispose(() => {
      events.push("cleanup");
    });
    const read = instance.wrap(() => "owned value");
    const inspect = async () => {
      await proceed.promise;
      const value = read();
      events.push("helper");
      return value;
    };
    const source = Object.assign(chunks("chunk"), { inspect });
    const stream = instance.wrap({ ...iterable(source), inspect });
    const iterator = stream[Symbol.asyncIterator]();
    const pending = target === "source" ? stream.inspect() : iterator.inspect();
    try {
      await expect(iterator.next()).resolves.toEqual({ value: "chunk", done: false });
      await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
      const disposing = instance.dispose();
      await Promise.resolve();
      expect(events).toEqual([]);
      proceed.resolve();
      await expect(pending).resolves.toBe("owned value");
      await disposing;
      expect(events).toEqual(["helper", "cleanup"]);
    } finally {
      proceed.resolve();
      await Promise.allSettled([pending, iterator.return(undefined), instance.dispose()]);
    }
  },
);

it("releases a directly consumed async generator when its consumer returns early", async () => {
  const instance = new PluginInstance("iterator");
  const finished = vi.fn();
  const stream = instance.wrap(async function* () {
    try {
      yield "chunk";
      yield "unused";
    } finally {
      finished();
    }
  })();
  await expect(stream.next()).resolves.toEqual({ value: "chunk", done: false });
  const draining = instance.dispose();
  await stream.return(undefined);
  await draining;
  expect(finished).toHaveBeenCalledOnce();
});

it.each(["completion", "failure"] as const)(
  "permits terminal return after %s without reentering plugin code",
  async (outcome) => {
    const instance = createTestInstance("terminal-return");
    const finished = vi.fn();
    const failure = new Error("generator failed");
    const source = (async function* () {
      try {
        yield "chunk";
        if (outcome === "failure") {
          throw failure;
        }
        return "original result";
      } finally {
        finished();
      }
    })();
    const originalReturn = source.return.bind(source);
    const readReturn = vi.fn(() => originalReturn);
    Object.defineProperty(source, "return", { get: readReturn });
    const stream = instance.wrap(source);
    const iterator = stream[Symbol.asyncIterator]();
    const retainedReturn = iterator.return.bind(iterator);
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "chunk" });
    if (outcome === "failure") {
      await expect(iterator.next()).rejects.toBe(failure);
    } else {
      await expect(iterator.next()).resolves.toEqual({ done: true, value: "original result" });
    }
    await instance.dispose();
    for (const close of [
      retainedReturn,
      iterator.return.bind(iterator),
      stream.return.bind(stream),
    ]) {
      await expect(close(Promise.resolve("closed"))).resolves.toEqual({
        done: true,
        value: "closed",
      });
    }
    expect(readReturn).toHaveBeenCalledOnce();
    expect(finished).toHaveBeenCalledOnce();
    await expect(iterator.next()).rejects.toThrow("was reloaded or disabled");
    await expect(iterator.throw(failure)).rejects.toThrow("was reloaded or disabled");
  },
);

it("joins every explicitly admitted iterator and terminal result", async () => {
  const instance = new PluginInstance("terminal-stream");
  const terminal = createDeferredCore<string>();
  const stream = instance.wrap({
    [Symbol.asyncIterator]: () => chunks("chunk"),
    result: () => terminal.promise,
  });
  const first = stream[Symbol.asyncIterator]();
  const second = stream[Symbol.asyncIterator]();
  const final = stream.result();
  const draining = trackCompletion(instance.dispose());
  await expect(first.next()).resolves.toEqual({ value: "chunk", done: false });
  await expect(first.next()).resolves.toMatchObject({ done: true });
  await Promise.resolve();
  expect(draining.done).toBe(false);
  await expect(second.next()).resolves.toEqual({ value: "chunk", done: false });
  terminal.resolve("final");
  await expect(final).resolves.toBe("final");
  expect(draining.done).toBe(false);
  await expect(second.next()).resolves.toEqual({ value: undefined, done: true });
  await draining.promise;
});

it.each(["iteration", "result", "failure"] as const)(
  "preserves self-retiring %s output when cleanup fails",
  async (terminal) => {
    const instance = new PluginInstance("stream-cleanup");
    const failure = new Error("stream failed");
    const cleanupFailure = new Error("owned cleanup failed");
    const cleanup = throwing(cleanupFailure);
    instance.lifecycle.onDispose(
      terminal === "failure" ? cleanup : () => Promise.resolve().then(cleanup),
    );
    const iterate = async function* () {
      await instance.dispose();
      yield "chunk";
      if (terminal === "failure") {
        throw failure;
      }
    };
    if (terminal === "failure") {
      const stream = instance.wrap(iterate)();
      await expect(stream.next()).resolves.toEqual({ value: "chunk", done: false });
      await expect(stream.next()).rejects.toBe(failure);
    } else {
      const stream = instance.wrap({
        [Symbol.asyncIterator]: iterate,
        async result() {
          await instance.dispose();
          return "final";
        },
      });
      if (terminal === "result") {
        await expect(stream.result()).resolves.toBe("final");
      } else {
        for await (const chunk of stream) {
          expect(chunk).toBe("chunk");
        }
      }
    }
    const disposal = instance.dispose();
    await expect(disposal).resolves.toEqual({ errors: [cleanupFailure] });
    expect(instance.dispose()).toBe(disposal);
  },
);

it("runs explicit cleanup after a drain timeout and allows its callback to finish", async () => {
  vi.useFakeTimers();
  const instance = new PluginInstance("stuck");
  const pending = createDeferredCore();
  const resumedStream = vi.fn();
  const stream = instance.wrap(async function* () {
    resumedStream();
    yield "stale";
  })();
  const helper = instance.wrap(() => "current");
  const call = instance.wrap(async () => {
    await pending.promise;
    return helper();
  })();
  const rejectedCall = expect(call).rejects.toThrow("reloaded or disabled");
  const timer = setInterval(() => {}, 100);
  const cleanupEntered = vi.fn();
  const cleaned = vi.fn();
  instance.lifecycle.onDispose(() => {
    clearInterval(timer);
    return new Promise<void>((resolve) => {
      process.nextTick(() => {
        cleanupEntered();
        setTimeout(() => {
          cleaned();
          resolve();
        }, 1_000);
      });
    });
  });
  const draining = instance.drain();
  expectUnavailable(() => helper());
  await vi.advanceTimersByTimeAsync(5_000);
  await expect(draining).resolves.toMatchObject({
    errors: [new Error("Plugin stuck still has active calls after 5000ms")],
  });
  expect(instance.lifecycle.signal.aborted).toBe(false);
  const disposing = instance.dispose();
  await vi.advanceTimersByTimeAsync(5_000);
  const atDrainTimeout = {
    aborted: instance.lifecycle.signal.aborted,
    cleanupEntered: cleanupEntered.mock.calls.length,
    cleaned: cleaned.mock.calls.length,
  };
  await vi.advanceTimersByTimeAsync(1_000);
  await disposing;
  pending.resolve();
  await rejectedCall;
  expect(atDrainTimeout).toEqual({ aborted: true, cleanupEntered: 1, cleaned: 0 });
  const { errors } = await disposing;
  expect(errors).toHaveLength(1);
  const timeout = drainTimeout(errors[0]);

  expect(timeout.forcedRetirement).toEqual({ activeCallCount: 2, retainedConsumerCount: 0 });
  await expect(timeout.settled).resolves.toBeUndefined();
  expect(instance.lifecycle.signal.aborted).toBe(true);
  expect(cleaned).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  await expect(stream.return(undefined)).rejects.toThrow(/stream is closed|reloaded or disabled/);
  await expect(stream.next()).rejects.toThrow(/stream is closed|reloaded or disabled/);
  expect(resumedStream).not.toHaveBeenCalled();
  expect(instance.dispose()).toBe(disposing);
});

it.each(["resolve", "reject"] as const)(
  "keeps disposal's drain settlement pending until its original call actually %ss",
  async (completion) => {
    vi.useFakeTimers();
    const instance = new PluginInstance("late-call");
    const pending = createDeferredCore<string>();
    const callFailure = new Error("original call failed");
    const cleanupFailure = new Error("resource cleanup failed");
    const cleanup = vi.fn(throwing(cleanupFailure));
    instance.lifecycle.onDispose(cleanup);
    const call = instance.wrap(() => pending.promise)();
    const callOutcome = call.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const disposing = instance.dispose();
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await disposing;
      const timeout = drainTimeout(result.errors[0]);

      expect(timeout.forcedRetirement).toEqual({
        activeCallCount: 1,
        retainedConsumerCount: 0,
      });
      expect(result.errors).toEqual([timeout, cleanupFailure]);
      expect(cleanup).toHaveBeenCalledOnce();
      const settlement = trackCompletion(
        timeout.settled.catch((error: unknown) => {
          expect(error).toBeInstanceOf(AggregateError);
          expect((error as AggregateError).errors).toEqual([cleanupFailure]);
        }),
      );
      await Promise.resolve();
      expect(instance.lifecycle.signal.aborted).toBe(true);
      expectUnavailable(() => instance.run(() => "retired"));
      expect(settlement.done).toBe(false);
      if (completion === "resolve") {
        pending.resolve("finished");
      } else {
        pending.reject(callFailure);
      }
      expect(await callOutcome).toEqual(
        completion === "resolve"
          ? { error: new PluginInstanceUnavailableError("late-call") }
          : { error: callFailure },
      );
      await settlement.promise;
      expect(settlement.done).toBe(true);
      expect(await instance.dispose()).toBe(result);
      expect(result.errors).toEqual([timeout, cleanupFailure]);
    } finally {
      pending.resolve("finished");
      await Promise.allSettled([call, disposing]);
    }
  },
);

it("refuses an earlier result whose final release crosses the retirement deadline", async () => {
  vi.useFakeTimers();
  const instance = new PluginInstance("slow-removal");
  const result = createDeferredCore<string>();
  const removal = createDeferredCore();
  instance.onModuleDispose(() => removal.promise);
  const call = instance.run(() => result.promise);
  const rejected = expect(call).rejects.toThrow("reloaded or disabled");
  const retirement = instance.dispose();
  result.resolve("finished before timeout");
  await vi.advanceTimersByTimeAsync(5_000);
  await rejected;
  expect((await retirement).errors).toMatchObject([{ forcedRetirement: { activeCallCount: 1 } }]);
  removal.resolve();
});

it("keeps a host prelude guard exceptional while attempting explicit cleanup", async () => {
  const instance = new PluginInstance("guarded-cleanup");
  const guard = new Error("host cleanup admission closed");
  const cleanup = vi.fn();
  instance.lifecycle.onDispose(cleanup);
  const callback = instance.wrap(() => "live");
  await expect(instance.dispose(throwing(guard))).rejects.toBe(guard);
  expect(cleanup).toHaveBeenCalledOnce();
  expectUnavailable(callback);
});

it("preserves prepared caller scope and follows an adopted instance for detached work", async () => {
  const { record, registry: first, instance } = createOwnedInstance("owned");
  const next = { ...createEmptyPluginRegistry(), plugins: [record] };
  let observed: ReturnType<typeof getScope>;
  const callback = instance.wrap(() => {
    observed = getScope();
  });
  adoptPluginRegistryRecords(first);
  adoptPluginRegistryRecords(next);
  callback();
  expect(observed?.pluginRegistry).toBe(next);
  const caller = { isWebchatConnect: () => false, invokeWithSessionNodeAuthority: vi.fn() };
  withPluginRuntimeGatewayRequestScope(caller, () =>
    withPluginRuntimeGenerationScope(
      {
        metadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [{ id: record.id, origin: record.origin, source: record.source }],
        }),
        pluginRegistry: first,
      },
      () => {
        callback();
        expect(observed?.pluginRegistry).toBe(first);
        expect(observed?.pluginId).toBe(record.id);
        expect(observed?.invokeWithSessionNodeAuthority).toBe(
          caller.invokeWithSessionNodeAuthority,
        );
      },
    ),
  );
  expect(getScope()).toBeUndefined();
  await instance.dispose();
});

it("owns grouped SDK registrations through registration closure and instance disposal", async () => {
  const instance = new PluginInstance("facades");
  const registerSessionAction = vi.fn<(entry: PluginSessionActionRegistration) => void>();
  const registerAgentEventSubscription =
    vi.fn<(entry: PluginAgentEventSubscriptionRegistration) => void>();
  const registerRuntimeLifecycle = vi.fn<(entry: PluginRuntimeLifecycleRegistration) => void>();
  const api = instrumentPluginInstanceApi(
    buildPluginApi({
      id: "facades",
      name: "facades",
      source: "test",
      registrationMode: "full",
      config: {},
      runtime: createUnavailableRuntime("setup-only"),
      logger: { info() {}, warn() {}, error() {} },
      resolvePath: (value) => value,
      handlers: { registerSessionAction, registerAgentEventSubscription, registerRuntimeLifecycle },
    }),
    instance,
  );
  const handler = vi.fn<() => void>();
  let lateRegistration: (() => void) | undefined;
  let registeredLifecycle = api.lifecycle;
  runPluginRegistration((registeredApi) => {
    registeredLifecycle = registeredApi.lifecycle;
    registeredApi.session.controls.registerSessionAction({ id: "grouped", handler });
    registeredApi.agent.events.registerAgentEventSubscription({ id: "events", handle: handler });
    registeredApi.lifecycle.registerRuntimeLifecycle({ id: "lifecycle", cleanup: () => {} });
    lateRegistration = () =>
      registeredApi.session.controls.registerSessionAction({ id: "late", handler });
  }, api);
  lateRegistration?.();
  expect(registerSessionAction).toHaveBeenCalledOnce();
  const disposed = vi.fn();
  registeredLifecycle.onDispose?.(disposed);
  expect(registeredLifecycle.signal).toBe(instance.controller.signal);
  expect(registerRuntimeLifecycle).toHaveBeenCalledOnce();
  const callbacks = [
    ...registerSessionAction.mock.calls.map(([entry]) => entry.handler),
    registerAgentEventSubscription.mock.calls[0]![0].handle,
  ];
  for (const callback of callbacks) {
    Reflect.apply(callback, undefined, []);
  }
  expect(handler).toHaveBeenCalledTimes(2);
  await instance.dispose();
  expect(disposed).toHaveBeenCalledOnce();
  for (const callback of callbacks) {
    expectUnavailable(() => Reflect.apply(callback, undefined, []));
  }
});

it("owns direct SDK registrations in the candidate registry and fences retained callbacks", async () => {
  const { registry, record, instance } = createOwnedInstance("direct");
  instance.run(() => {
    expect(
      registerPluginCommandInRegistry(registry, record.id, {
        name: "direct",
        description: "Direct SDK command",
        handler: () => ({ text: "current" }),
      }),
    ).toEqual({ ok: true });
    registerMemoryCapability(record.id, { promptBuilder: () => ["current"] });
    registerPluginHttpRoute({
      path: "/direct",
      pluginId: record.id,
      auth: "plugin",
      handler: () => true,
    });
  });
  expect(registry.httpRoutes).toHaveLength(1);
  const command = registry.commands[0]!.command.handler;
  const memory = registry.memoryCapabilities[0]!.capability.promptBuilder!;
  const route = registry.httpRoutes[0]!.handler;
  expect(command({} as never)).toEqual({ text: "current" });
  expect(memory({} as never)).toEqual(["current"]);
  expect(route({} as never, {} as never)).toBe(true);
  await instance.dispose();
  for (const callback of [command, memory, route]) {
    expectUnavailable(() => Reflect.apply(callback, undefined, []));
  }
});
