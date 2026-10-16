import { AsyncResource } from "node:async_hooks";
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
} from "./plugin-instance.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  adoptPluginRegistryRecords,
  capturePluginLifecycleAuthority,
  markPluginRecordBorrowed,
  markPluginRegistryActive,
} from "./registry-lifecycle.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

it.each([
  { kind: "run", reject: false },
  { kind: "run", reject: true },
  { kind: "consumer", reject: false },
  { kind: "consumer", reject: true },
] as const)(
  "retains an adopted selection through a pending $kind (reject: $reject)",
  async ({ kind, reject }) => {
    class PendingRegistry {
      readonly fixtureLabel = "PendingRegistry";
    }
    const { record, instance } = createOwnedInstance("retention");
    const consumer = kind === "consumer" ? instance.retainConsumer() : undefined;
    const resume = createDeferredCore();
    const failure = new Error("callback failed");
    let observed: string | undefined;
    const successor = createEmptyPluginRegistry();
    successor.plugins.push(record);
    successor.coreGatewayMethodNames.push("successor");
    const pending = (() => {
      selectRegistry(record, "intermediate", new PendingRegistry());
      const run = async () => {
        await resume.promise;
        observed = readRegistryLabel();
        if (reject) {
          throw failure;
        }
        return observed;
      };
      const result = consumer ? consumer.run(run) : instance.run(run);
      adoptPluginRegistryRecords(successor);
      return result;
    })();
    const outcome = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await expectLiveObjects(PendingRegistry, 1);
      resume.resolve();
      expect(await outcome).toEqual(reject ? { error: failure } : { value: "intermediate" });
      expect(observed).toBe("intermediate");
      await expectLiveObjects(PendingRegistry, 0);
      if (reject) {
        await expect(pending).rejects.toBe(failure);
      } else {
        await expect(pending).resolves.toBe("intermediate");
      }
      expect((consumer ?? instance).run(readRegistryLabel)).toBe("successor");
    } finally {
      resume.resolve();
      await outcome;
      consumer?.release();
      await instance.dispose();
    }
  },
);

it("keeps resolved value identity and independent registry custody for concurrent consumer calls", async () => {
  class PendingRegistry {
    readonly fixtureLabel = "PendingRegistry";
  }
  const { record, instance } = createOwnedInstance("retention");
  const consumer = instance.retainConsumer();
  const nestedResume = createDeferredCore();
  const concurrentResume = createDeferredCore();
  const nestedValue = Object.freeze({ selection: "nested" });
  const concurrentValue = Object.freeze({ selection: "concurrent" });
  const startNested = () => {
    selectRegistry(record, "nested", new PendingRegistry());
    const nested = instance.run(async () => {
      await nestedResume.promise;
      expect(readRegistryLabel()).toBe("nested");
      return nestedValue;
    });
    selectRegistry(record, "concurrent", new PendingRegistry());
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
    await expectLiveObjects(PendingRegistry, 2);
    nestedResume.resolve();
    await expect(first).resolves.toBe(nestedValue);
    await expectLiveObjects(PendingRegistry, 1);
    concurrentResume.resolve();
    await expect(second).resolves.toBe(concurrentValue);
    await expectLiveObjects(PendingRegistry, 0);
    await expect(first).resolves.toBe(nestedValue);
    await expect(second).resolves.toBe(concurrentValue);
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
    class NestedRegistry {
      readonly fixtureLabel = "NestedRegistry";
    }
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
    const nested = (() => {
      selectRegistry(record, "nested", new NestedRegistry());
      const result = resource.runInAsyncScope(() =>
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
      return result;
    })();
    const outcome = Promise.resolve(nested);
    try {
      if (kind === "sync") {
        expect(nested).toBe(payload);
      }
      await expectLiveObjects(NestedRegistry, kind === "sync" ? 0 : 1);
      expect(outerSettled).toBe(false);
      expect(instance.ordinaryCallCount).toBe(0);
      nestedFinish.resolve();
      expect(await outcome).toBe(payload);
      expect(observed).toBe("nested");
      expect(thenReads).toBe(kind === "thenable" ? 1 : 0);
      expect(thenCalls).toBe(kind === "thenable" ? 1 : 0);
      await expectLiveObjects(NestedRegistry, 0);
      expect(outerSettled).toBe(false);
      expect(await outcome).toBe(payload);
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
  class PendingRegistry {
    readonly fixtureLabel = "PendingRegistry";
  }
  const { record, instance } = createOwnedInstance("retention");
  const consumer = instance.retainConsumer();
  const resource = consumer.run(() => new AsyncResource("completed-consumer-scope"));
  const resume = createDeferredCore();
  const pending = (() => {
    selectRegistry(record, "late", new PendingRegistry());
    const result = resource.runInAsyncScope(() =>
      instance.run(async () => {
        await resume.promise;
        return readRegistryLabel();
      }),
    );
    adoptPluginRegistryRecords({ ...createEmptyPluginRegistry(), plugins: [record] });
    return result;
  })();
  try {
    await expectLiveObjects(PendingRegistry, 1);
    resume.resolve();
    await expect(pending).resolves.toBe("late");
    await expectLiveObjects(PendingRegistry, 0);
    await expect(pending).resolves.toBe("late");
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
  const replacement = createEmptyPluginRegistry();
  replacement.plugins.push(record);
  adoptPluginRegistryRecords(replacement);
  const value = instance.adopt({ execute: () => "owned" });
  const call = instance.wrap(value.execute);
  const consumer = instance.retainConsumer(undefined, registry);
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  instance.onModuleDispose(async () => {
    expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(replacement);
    entered.resolve();
    await finish.promise;
  });
  const disposal = instance.dispose();
  try {
    expect(instance.owner?.revoked).toBe(true);
    expect(instance.owner?.registry).toBe(replacement);
    expect(consumer.run(() => getPluginRuntimeGatewayRequestScope()?.pluginRegistry)).toBe(
      registry,
    );
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
  const borrower = createEmptyPluginRegistry();
  borrower.plugins.push(record);
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
    const fail = () => {
      throw failure;
    };
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
