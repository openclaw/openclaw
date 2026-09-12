import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, vi } from "vitest";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { startPluginServices } from "../plugins/services.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import type { RecoveryFixtureFactory } from "./server-plugin-reload.recovery.test-support.js";

export async function verifyManagedCandidateRetirement(
  createRecoveryFixture: RecoveryFixtureFactory,
  action: "retry" | "shutdown",
) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const event = "gateway-managed-candidate-start";
  const listeners: Array<() => void> = [];
  const before = process.listenerCount(event);
  const order: string[] = [];
  const queuedStart = vi.fn();
  let generation = 0;
  const fixture = await createRecoveryFixture({
    abortOnCandidateStart: false,
    register(api, owner) {
      if (owner !== "first" || ++generation === 1) {
        return;
      }
      const current = generation;
      const listener = () => {};
      listeners.push(listener);
      assert(api.lifecycle.onDispose, "Expected managed instance cleanup registration");
      api.lifecycle.onDispose(() => {
        process.removeListener(event, listener);
        order.push(`dispose:${current}`);
      });
      api.registerService({
        id: "held-candidate",
        async start() {
          process.on(event, listener);
          if (current === 2) {
            entered.resolve();
            await release.promise;
          }
          order.push(`start:${current}`);
        },
        stop() {
          order.push(`stop:${current}`);
          process.removeListener(event, listener);
        },
      });
      api.registerService({ id: "after-held-candidate", start: queuedStart });
    },
  });
  vi.useFakeTimers();
  let outcome: unknown;
  let alternateRetirement: Promise<void> | undefined;
  let shuttingDown: Promise<void> | undefined;
  const reloading = fixture.reload().then(
    (result) => {
      outcome = result;
    },
    (error: unknown) => {
      outcome = error;
    },
  );
  try {
    await entered.promise;
    const candidate = fixture.candidates[0]!.registry;
    const instance = getPluginInstance(candidate.plugins.find((record) => record.id === "first")!);
    assert(instance);
    expect(process.listenerCount(event)).toBe(before + 1);
    // Observe each existing deadline: failed startup, service stop, then instance drain.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(outcome).toBeUndefined();
    expect(instance.disposing).toBe(false);
    expect(queuedStart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(instance.disposing).toBe(true);
    expect(order).toEqual([]);
    expect(process.listenerCount(event)).toBe(before + 1);
    let retired = false;
    alternateRetirement = disposePluginRegistryInstances(candidate).then(() => {
      retired = true;
    });
    if (action === "shutdown") {
      shuttingDown = fixture.lifetime.stop();
    }
    await vi.advanceTimersByTimeAsync(5_000);
    await reloading;
    await alternateRetirement;
    await shuttingDown;
    expect(outcome).toMatchObject({
      details: { phase: "activate", committed: false },
      cause: {
        errors: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("plugin service startup timed out"),
          }),
        ]),
      },
    });
    expect(retired).toBe(true);
    expect(instance.lifecycle.signal.aborted).toBe(true);
    expect(() => instance.run(() => "retired dispatch")).toThrow("reloaded or disabled");
    expect(order.filter((entry) => entry.endsWith(":2"))).toEqual(["dispose:2"]);
    expect(process.listenerCount(event)).toBe(before);
    expect(queuedStart).not.toHaveBeenCalled();
    expect(fixture.runtime.runtimeState.gatewayLifetimeSidecars).toEqual([]);
    if (action === "shutdown") {
      await fixture.lifetime.sealAndJoin();
    } else {
      await expect(fixture.reload()).resolves.toMatchObject({
        runtime: { pluginIds: ["first"] },
      });
      expect(queuedStart).toHaveBeenCalledOnce();
    }
    // Native continuation may finish after best-effort disposal; it cannot reopen dispatch.
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(order.filter((entry) => entry.endsWith(":2"))).toEqual(["dispose:2", "start:2"]);
    expect(() => instance.run(() => "still retired")).toThrow("reloaded or disabled");
    expect(queuedStart).toHaveBeenCalledTimes(action === "retry" ? 1 : 0);
  } finally {
    release.resolve();
    await reloading;
    await Promise.allSettled(
      [alternateRetirement, shuttingDown].filter(
        (pending): pending is Promise<void> => pending !== undefined,
      ),
    );
    for (const listener of listeners) {
      process.removeListener(event, listener);
    }
    vi.useRealTimers();
  }
}

export async function verifyPendingServiceCleanupRetry(
  createRecoveryFixture: RecoveryFixtureFactory,
) {
  const hookEntered = createDeferredCore();
  const hookRelease = createDeferredCore();
  const startupEntered = createDeferredCore();
  const startupRelease = createDeferredCore();
  let starts = 0;
  const serviceStop = vi.fn();
  const hookStop = vi.fn(async () => {
    hookEntered.resolve();
    await hookRelease.promise;
  });
  const fixture = await createRecoveryFixture({
    abortOnCandidateStart: false,
    register: (api, owner) => {
      if (owner === "first") {
        api.on("gateway_stop", hookStop);
        api.registerService({
          id: "pending-startup",
          start: () => {
            if (++starts === 2) {
              startupEntered.resolve();
              return startupRelease.promise;
            }
            return undefined;
          },
          stop: serviceStop,
        });
      }
    },
  });
  await fixture.owner.currentServices()?.stop();
  // Startup publishes its issued handle before awaiting the service promise.
  const startup = startPluginServices({
    registry: fixture.previousRegistry,
    config: fixture.getConfig(),
    onHandle: (handle) => {
      expect(fixture.owner.publishServices(fixture.owner.currentClaim(), handle)).toBe(true);
    },
  });
  await startupEntered.promise;
  expect(fixture.siblingStart).toHaveBeenCalledOnce();
  expect(fixture.siblingStop).toHaveBeenCalledOnce();
  const instance = getPluginInstance(fixture.previousRegistry.plugins[0]!);
  assert(instance);
  vi.useFakeTimers();
  let retry: Promise<unknown> | undefined;
  const first = fixture.reload().catch((error: unknown) => error);
  try {
    await hookEntered.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(serviceStop).toHaveBeenCalledOnce();
    expect(starts).toBe(2);
    expect(() => instance.run(() => "quiesced dispatch")).toThrow("reloaded or disabled");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fixture.registryOwner.registry).not.toBe(fixture.previousRegistry);
    expect(starts).toBe(3);
    // Final disposal observes the still-admitted old work under its own existing bound.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await first).toMatchObject({
      runtime: {
        pluginIds: ["first"],
        warnings: expect.arrayContaining([
          expect.stringContaining("Plugin stop hook failed"),
          expect.stringContaining("Plugin service cleanup failed"),
          expect.stringContaining("active calls"),
        ]),
      },
    });
    expect(instance.lifecycle.signal.aborted).toBe(true);
    expect(() => instance.run(() => "retired dispatch")).toThrow("reloaded or disabled");
    expect(serviceStop).toHaveBeenCalledOnce();
    expect(hookStop).toHaveBeenCalledOnce();
    expect(fixture.siblingStart).toHaveBeenCalledTimes(2);
    expect(fixture.siblingStop).toHaveBeenCalledOnce();
    hookRelease.resolve();
    startupRelease.resolve();
    await startup;
    await vi.advanceTimersByTimeAsync(0);
    expect(serviceStop).toHaveBeenCalledOnce();
    retry = fixture.reload();
    await expect(retry).resolves.toMatchObject({ runtime: { pluginIds: ["first"] } });
    expect(starts).toBe(4);
    expect(serviceStop).toHaveBeenCalledTimes(2);
    expect(hookStop).toHaveBeenCalledTimes(2);
    expect(() => instance.run(() => "still retired")).toThrow("reloaded or disabled");
    expect(fixture.siblingStart).toHaveBeenCalledTimes(2);
    expect(fixture.siblingStop).toHaveBeenCalledOnce();
  } finally {
    hookRelease.resolve();
    startupRelease.resolve();
    await Promise.allSettled([first, retry, startup]);
    vi.useRealTimers();
  }
}

export async function verifyCommittedRetirementOwnership(
  createRecoveryFixture: RecoveryFixtureFactory,
) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const registryClosed = createDeferredCore();
  const postCommitFailure = new Error("synthetic committed attachment failure");
  let generations = 0;
  let cleanupCalls = 0;
  const first = await createRecoveryFixture({
    abortOnCandidateStart: false,
    register(api, owner) {
      if (owner === "first" && ++generations === 1) {
        assert(api.lifecycle.onDispose);
        api.lifecycle.onDispose(async () => {
          cleanupCalls++;
          entered.resolve();
          await release.promise;
        });
      }
    },
    afterPublish: async () => {
      throw postCommitFailure;
    },
  });
  // A second real registry owner retains the shared boot inventory throughout this cutover.
  await createRecoveryFixture({ abortOnCandidateStart: false });
  let operationSettled = false;
  const reloading = first.reload().then(
    (result) => {
      operationSettled = true;
      return result;
    },
    (error: unknown) => {
      operationSettled = true;
      return error;
    },
  );
  let closeSettled = false;
  let closing: Promise<unknown> | undefined;
  try {
    await entered.promise;
    closing = (async () => {
      await first.owner.currentServices()?.stop();
      await first.registryOwner.close();
      registryClosed.resolve();
      await first.runtime.kernel.pluginMetadata.close();
    })().then(
      () => {
        closeSettled = true;
      },
      (error: unknown) => {
        closeSettled = true;
        return error;
      },
    );
    await registryClosed.promise;
    await nextTurn();
    expect.soft(operationSettled).toBe(false);
    expect.soft(closeSettled).toBe(false);
    expect(cleanupCalls).toBe(1);
    release.resolve();
    expect(await reloading).toMatchObject({
      details: { committed: true, phase: "activate" },
      cause: postCommitFailure,
    });
    expect(await closing).toBeUndefined();
    expect(cleanupCalls).toBe(1);
  } finally {
    release.resolve();
    await Promise.allSettled([reloading, closing]);
  }
}

export async function verifyExpandedReplacementTargets(
  createRecoveryFixture: RecoveryFixtureFactory,
) {
  const refusal = new Error("remaining config has no recovery owner");
  const fixture = await createRecoveryFixture({
    abortOnCandidateStart: false,
    register: (api, owner) => {
      api.registerChannel({
        plugin: createChannelTestPluginBase({ id: owner === "first" ? "discord" : "slack" }),
      });
    },
    prepareConfigEffects: ({ pluginIds, channels }) => {
      expect(pluginIds).toEqual(new Set(["first", "sibling"]));
      expect(channels).toEqual(new Set(["discord", "slack"]));
      expect(fixture.firstStop).not.toHaveBeenCalled();
      expect(fixture.siblingStop).not.toHaveBeenCalled();
      throw refusal;
    },
  });
  const pause = vi.spyOn(fixture.runtime.channelManager, "pauseChannelStarts");
  await expect(
    fixture.reload(undefined, ["first"], ["plugins.entries.sibling.enabled"]),
  ).rejects.toMatchObject({
    cause: refusal,
    details: { phase: "prepare", committed: false },
  });
  expect(pause).not.toHaveBeenCalled();
  expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
}
