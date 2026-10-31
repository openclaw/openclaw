import { AsyncResource } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import { getPluginValueInstance, runPluginCleanup } from "./plugin-instance-scope.js";
import {
  createOwnedInstance,
  expectLiveObjects,
  readRegistryLabel,
  selectRegistry,
  throwing,
} from "./plugin-instance.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  adoptPluginRegistryRecords,
  capturePluginLifecycleAuthority,
  markPluginRecordBorrowed,
  markPluginRegistryActive,
} from "./registry-lifecycle.js";
import { getPluginRuntimeGatewayRequestScope as getScope } from "./runtime/gateway-request-scope.js";

class RetainedRegistry {
  readonly fixtureLabel = "RetainedRegistry";
}

it("keeps owner work independent of its caller and follows adopted registry custody", async () => {
  const { record, instance } = createOwnedInstance("owner-work");
  selectRegistry(record, "initial", new RetainedRegistry());
  const caller = instance.retainConsumer();
  const authority = caller.run(() => instance.retainOwnerWork());
  caller.release();
  selectRegistry(record, "successor");
  try {
    await expectLiveObjects(RetainedRegistry, 0);
    instance.quiesce();
    await instance.waitForIdle(new AbortController().signal);
    expect(authority.run(readRegistryLabel)).toBe("successor");
    authority.release();
    expect(() => authority.run(readRegistryLabel)).toThrow(PluginInstanceUnavailableError);
  } finally {
    authority.release();
    await instance.dispose();
  }
});

it("joins physical owner callbacks after their retained admission closes", async () => {
  const { instance } = createOwnedInstance("owner-work-settlement");
  const authority = instance.retainOwnerWork();
  const finish = createDeferredCore();
  const pending = authority.run(() => finish.promise);
  authority.release();
  let disposed = false;
  const disposal = instance.dispose().then((result) => {
    disposed = true;
    return result;
  });
  try {
    await nextTurn();
    expect(disposed).toBe(false);
    finish.resolve();
    await pending;
    await expect(disposal).resolves.toEqual({ errors: [] });
  } finally {
    finish.resolve();
    await Promise.allSettled([pending, disposal]);
  }
});

it("drains physical owner work before disposal without awaiting its lifetime authority", async ({
  signal,
}) => {
  const { instance } = createOwnedInstance("owner-pre-disposal-drain");
  const authority = instance.retainOwnerWork();
  const finish = createDeferredCore();
  const pending = authority.run(() => finish.promise);
  const settled: string[] = [];
  const drain = instance.drain({ signal }).then((result) => {
    settled.push("drain");
    return result;
  });
  const retained = instance.waitForRetainedWork(signal, { includeCalls: true }).then(() => {
    settled.push("retained");
  });
  const idle = instance.waitForIdle(signal).then(() => {
    settled.push("idle");
  });
  try {
    await instance.waitForAdmittedWork(signal);
    await nextTurn();
    expect(settled).toEqual([]);
    finish.resolve();
    await pending;
    await expect(Promise.all([drain, retained, idle])).resolves.toEqual([
      { errors: [] },
      undefined,
      undefined,
    ]);
    expect(authority.run(() => "owner still active")).toBe("owner still active");
  } finally {
    finish.resolve();
    authority.release();
    await Promise.allSettled([pending, drain, retained, idle, instance.dispose()]);
  }
});

it("retains an adopted selection until a pending call rejects", async () => {
  const { record, instance } = createOwnedInstance("retention");
  const resume = createDeferredCore();
  const failure = new Error("callback failed");
  let observed: string | undefined;
  selectRegistry(record, "intermediate", new RetainedRegistry());
  const pending = instance.run(async () => {
    await resume.promise;
    observed = readRegistryLabel();
    throw failure;
  });
  selectRegistry(record, "successor");
  void pending.catch(() => {});
  try {
    await expectLiveObjects(RetainedRegistry, 1);
    resume.resolve();
    await expect(pending).rejects.toBe(failure);
    expect(observed).toBe("intermediate");
    await expectLiveObjects(RetainedRegistry, 0);
    expect(instance.run(readRegistryLabel)).toBe("successor");
  } finally {
    resume.resolve();
    await pending.catch(() => {});
    await instance.dispose();
  }
});

it("keeps resolved value identity and independent registry custody for concurrent consumer calls", async () => {
  const { record, instance } = createOwnedInstance("retention");
  const consumer = instance.retainConsumer();
  const nestedResume = createDeferredCore();
  const concurrentResume = createDeferredCore();
  const nestedValue = Object.freeze({ selection: "nested" });
  const concurrentValue = Object.freeze({ selection: "concurrent" });
  const startNested = () => {
    selectRegistry(record, "nested", new RetainedRegistry());
    const nested = instance.run(async () => {
      await nestedResume.promise;
      expect(readRegistryLabel()).toBe("nested");
      return nestedValue;
    });
    selectRegistry(record, "concurrent", new RetainedRegistry());
    return nested;
  };
  const first = consumer.run(async () => await startNested());
  const second = consumer.run(async () => {
    await concurrentResume.promise;
    expect(readRegistryLabel()).toBe("concurrent");
    return concurrentValue;
  });
  adoptPluginRegistryRecords({ ...createEmptyPluginRegistry(), plugins: [record] });
  try {
    await expectLiveObjects(RetainedRegistry, 2);
    nestedResume.resolve();
    await expect(first).resolves.toBe(nestedValue);
    await expectLiveObjects(RetainedRegistry, 1);
    concurrentResume.resolve();
    await expect(second).resolves.toBe(concurrentValue);
    await expectLiveObjects(RetainedRegistry, 0);
  } finally {
    nestedResume.resolve();
    concurrentResume.resolve();
    await Promise.allSettled([first, second]);
    consumer.release();
    await instance.dispose();
  }
});

it.each(["sync", "promise", "thenable"] as const)(
  "releases completed nested %s custody while its outer monitor remains active",
  async (kind) => {
    const { record, instance } = createOwnedInstance("retention");
    const consumer = instance.retainConsumer();
    const outerFinish = createDeferredCore();
    const nestedFinish = createDeferredCore();
    const payload = Object.freeze({ result: "nested" });
    let resource!: AsyncResource;
    let outerInvocation: ReturnType<typeof pluginInstanceInvocation.getStore>;
    let outerSettled = false;
    let observed: string | undefined;
    let thenReads = 0;
    let thenCalls = 0;
    const outer = consumer.run(async () => {
      outerInvocation = pluginInstanceInvocation.getStore();
      resource = new AsyncResource("active-consumer-monitor");
      await outerFinish.promise;
      outerSettled = true;
    });
    const readSelection = () => {
      expect(pluginInstanceInvocation.getStore()).toBe(outerInvocation);
      expect(instance.hasActiveCall).toBe(true);
      observed = readRegistryLabel();
    };
    selectRegistry(record, "nested", new RetainedRegistry());
    const nested = resource.runInAsyncScope(() =>
      instance.run(() => {
        if (kind === "sync") {
          readSelection();
          return payload;
        }
        const pending = (async () => {
          await nestedFinish.promise;
          readSelection();
          return payload;
        })();
        if (kind === "promise") {
          return pending;
        }
        // The custom then getter and receiver must be consumed only once.
        const thenable: PromiseLike<typeof payload> = {
          // oxlint-disable-next-line unicorn/no-thenable -- Exercise exactly-once foreign thenable assimilation.
          get then() {
            thenReads++;
            return new Proxy(pending.then.bind(pending), {
              apply(target, receiver, args) {
                thenCalls++;
                expect(receiver).toBe(thenable);
                return Reflect.apply(target, receiver, args);
              },
            });
          },
        };
        return thenable;
      }),
    );
    adoptPluginRegistryRecords({ ...createEmptyPluginRegistry(), plugins: [record] });
    const outcome = Promise.resolve(nested);
    try {
      if (kind === "sync") {
        expect(nested).toBe(payload);
      }
      await expectLiveObjects(RetainedRegistry, kind === "sync" ? 0 : 1);
      expect([outerSettled, instance.ordinaryCallCount]).toEqual([false, 0]);
      nestedFinish.resolve();
      expect(await outcome).toBe(payload);
      expect(observed).toBe("nested");
      expect([thenReads, thenCalls]).toEqual(kind === "thenable" ? [1, 1] : [0, 0]);
      await expectLiveObjects(RetainedRegistry, 0);
      expect(outerSettled).toBe(false);
    } finally {
      nestedFinish.resolve();
      await Promise.allSettled([outcome]);
      outerFinish.resolve();
      await outer;
      resource.emitDestroy();
      consumer.release();
      await instance.dispose();
    }
  },
);

it("gives a completed consumer context fresh finite custody when it re-enters", async () => {
  const { record, instance } = createOwnedInstance("retention");
  const consumer = instance.retainConsumer();
  const resource = consumer.run(() => new AsyncResource("completed-consumer-scope"));
  const resume = createDeferredCore();
  selectRegistry(record, "late", new RetainedRegistry());
  const pending = resource.runInAsyncScope(() =>
    instance.run(async () => {
      await resume.promise;
      return readRegistryLabel();
    }),
  );
  adoptPluginRegistryRecords({ ...createEmptyPluginRegistry(), plugins: [record] });
  try {
    await expectLiveObjects(RetainedRegistry, 1);
    resume.resolve();
    await expect(pending).resolves.toBe("late");
    await expectLiveObjects(RetainedRegistry, 0);
    expect(resource.runInAsyncScope(() => instance.run(() => "still admitted"))).toBe(
      "still admitted",
    );
  } finally {
    resume.resolve();
    await Promise.allSettled([pending]);
    resource.emitDestroy();
    consumer.release();
    await instance.dispose();
  }
});

it("releases the adopted registry only after consumer and module cleanup settle", async () => {
  const { registry, record, instance } = createOwnedInstance("retention");
  const replacement = { ...createEmptyPluginRegistry(), plugins: [record] };
  adoptPluginRegistryRecords(replacement);
  const value = instance.adopt({ execute: () => "owned" });
  const call = instance.wrap(value.execute);
  const consumer = instance.retainConsumer(undefined, registry);
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  instance.onModuleDispose(async () => {
    expect(getScope()?.pluginRegistry).toBe(replacement);
    entered.resolve();
    await finish.promise;
  });
  const disposal = instance.dispose();
  try {
    expect(instance.owner?.revoked).toBe(true);
    expect(instance.owner?.registry).toBe(replacement);
    expect(consumer.run(() => getScope()?.pluginRegistry)).toBe(registry);
    expect(() => call()).toThrow(PluginInstanceUnavailableError);
    consumer.release();
    await entered.promise;
    expect(instance.owner?.registry).toBe(replacement);
    finish.resolve();
    expect((await disposal).errors).toEqual([]);
    expect(instance.owner?.registry).toBeUndefined();
    // Removing the value association would turn stale cleanup into an unowned call.
    expect(getPluginValueInstance(value)).toBe(instance);
    expect(() => runPluginCleanup(value, value.execute)).toThrow("retiring");
    expect(() => call()).toThrow(PluginInstanceUnavailableError);
    adoptPluginRegistryRecords(registry);
    expect(instance.owner?.registry).toBeUndefined();
  } finally {
    consumer.release();
    finish.resolve();
    await disposal;
  }
});

it("does not reacquire borrowed authority after its lender releases registry custody", async () => {
  const { registry, record, instance } = createOwnedInstance("retention");
  markPluginRegistryActive(registry);
  const borrower = { ...createEmptyPluginRegistry(), plugins: [record] };
  markPluginRecordBorrowed(borrower, record);
  markPluginRegistryActive(borrower);
  const authority = capturePluginLifecycleAuthority(borrower, record);
  expect(authority?.()).toBe(true);
  expect(instance.owner?.registry).toBe(registry);
  await instance.dispose();
  expect(instance.owner?.registry).toBeUndefined();
  expect(authority?.()).toBe(false);
  expect(capturePluginLifecycleAuthority(borrower, record)).toBeUndefined();
});

it.each(["host", "module"] as const)(
  "retains registry custody after %s cleanup fails",
  async (kind) => {
    const { registry, instance } = createOwnedInstance("retention");
    const failure = new Error("cleanup prerequisite failed");
    const fail = throwing(failure);
    if (kind === "module") {
      instance.onModuleDispose(fail);
    }
    const disposal = instance.dispose(kind === "host" ? fail : undefined);
    if (kind === "host") {
      await expect(disposal).rejects.toBe(failure);
    } else {
      expect((await disposal).errors).toContain(failure);
    }
    expect(instance.owner?.registry).toBe(registry);
    expect(instance.owner?.revoked).toBe(true);
    expect(() => instance.run(() => "late")).toThrow(PluginInstanceUnavailableError);
  },
);
