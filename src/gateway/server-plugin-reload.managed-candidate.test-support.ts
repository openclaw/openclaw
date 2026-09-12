import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, vi } from "vitest";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import {
  disposePluginRegistryInstances,
  waitForPluginRegistryRetirement,
} from "../plugins/runtime.js";
import { startPluginServices } from "../plugins/services.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { createChannelManager } from "./server-channels.js";
import type { RecoveryFixtureFactory } from "./server-plugin-reload.recovery.test-support.js";
import { GatewayConfigReloadSupersededError } from "./server-reload-contracts.js";

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
          if (current === 2) {
            entered.resolve();
            await release.promise;
          }
          process.on(event, listener);
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
    expect(process.listenerCount(event)).toBe(before);
    // Observe each existing deadline: failed startup, service stop, then instance drain.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(outcome).toBeUndefined();
    expect(instance.disposing).toBe(false);
    expect(queuedStart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(
      await waitForPluginRegistryRetirement(candidate, { deferConsumers: true }),
    ).toMatchObject({ deferredPluginIds: ["first"] });
    expect(instance.disposing).toBe(true);
    expect(order).toEqual([]);
    expect(process.listenerCount(event)).toBe(before);
    let retired = false;
    alternateRetirement = disposePluginRegistryInstances(candidate).then(() => {
      retired = true;
    });
    if (action === "shutdown") {
      shuttingDown = fixture.lifetime.stop();
    }
    await vi.advanceTimersByTimeAsync(5_000);
    await reloading;
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
    expect(retired).toBe(false);
    expect(instance.lifecycle.signal.aborted).toBe(false);
    expect(() => instance.run(() => "retired dispatch")).toThrow("reloaded or disabled");
    expect(order.filter((entry) => entry.endsWith(":2"))).toEqual([]);
    expect(process.listenerCount(event)).toBe(before);
    expect(queuedStart).not.toHaveBeenCalled();
    expect(fixture.runtime.runtimeState.gatewayLifetimeSidecars).toEqual([]);
    if (action === "shutdown") {
      shuttingDown = fixture.lifetime.sealAndJoin();
    } else {
      await expect(fixture.reload()).resolves.toMatchObject({
        runtime: { pluginIds: ["first"] },
      });
      expect(queuedStart).toHaveBeenCalledOnce();
    }
    // Native startup can acquire resources late; its one stop still precedes instance disposal.
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await alternateRetirement;
    await shuttingDown;
    expect(retired).toBe(true);
    expect(instance.lifecycle.signal.aborted).toBe(true);
    expect(order.filter((entry) => entry.endsWith(":2"))).toEqual([
      "start:2",
      "stop:2",
      "dispose:2",
    ]);
    expect(process.listenerCount(event)).toBe(before + (action === "retry" ? 1 : 0));
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
    expect(instance.lifecycle.signal.aborted).toBe(false);
    expect(() => instance.run(() => "retired dispatch")).toThrow("reloaded or disabled");
    expect(serviceStop).toHaveBeenCalledOnce();
    expect(hookStop).toHaveBeenCalledOnce();
    expect(fixture.siblingStart).toHaveBeenCalledTimes(2);
    expect(fixture.siblingStop).toHaveBeenCalledOnce();
    hookRelease.resolve();
    startupRelease.resolve();
    await startup;
    await vi.advanceTimersByTimeAsync(0);
    expect(serviceStop).toHaveBeenCalledTimes(2);
    expect(instance.lifecycle.signal.aborted).toBe(true);
    retry = fixture.reload();
    await expect(retry).resolves.toMatchObject({ runtime: { pluginIds: ["first"] } });
    expect(starts).toBe(4);
    expect(serviceStop).toHaveBeenCalledTimes(3);
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

export async function verifyGatewayCleanupRetry(
  createRecoveryFixture: RecoveryFixtureFactory,
  withChannels: boolean,
) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const hookStart = vi.fn();
  const hookStop = vi.fn(async () => {
    entered.resolve();
    await release.promise;
  });
  const channelIds = { first: "cleanup-first", sibling: "cleanup-sibling" } as const;
  const signals = { first: [] as AbortSignal[], sibling: [] as AbortSignal[] };
  const fixture = await createRecoveryFixture({
    abortOnCandidateStart: false,
    register: (api, owner) => {
      if (owner === "first") {
        api.on("gateway_start", hookStart);
        api.on("gateway_stop", hookStop);
      }
      if (withChannels) {
        api.registerChannel({
          plugin: {
            ...createChannelTestPluginBase({ id: channelIds[owner] }),
            gateway: {
              startAccount: async ({ abortSignal }) => {
                signals[owner].push(abortSignal);
                await new Promise<void>((resolve) => {
                  abortSignal.addEventListener("abort", () => resolve(), { once: true });
                });
              },
            },
          },
        });
      }
    },
  });
  const manager = createChannelManager({
    getRuntimeConfig: fixture.getConfig,
    channelLogs: {},
    channelRuntimeEnvs: {},
    getPluginRegistry: () => fixture.registryOwner.registry,
  });
  if (withChannels) {
    fixture.runtime.channelManager = manager;
    await manager.startChannel(channelIds.first);
    await manager.startChannel(channelIds.sibling);
    await vi.waitFor(() => {
      expect(signals.first).toHaveLength(1);
      expect(signals.sibling).toHaveLength(1);
    });
  }
  const instance = getPluginInstance(fixture.previousRegistry.plugins[0]!);
  assert(instance);
  vi.useFakeTimers();
  let retry: Promise<unknown> | undefined;
  const reloading = fixture.reload().catch((error: unknown) => error);
  try {
    await entered.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await reloading).toMatchObject({
      runtime: {
        pluginIds: ["first"],
        warnings: expect.arrayContaining([expect.stringContaining("Plugin stop hook failed")]),
      },
    });
    expect(hookStart).toHaveBeenCalledOnce();
    expect(instance.lifecycle.signal.aborted).toBe(true);
    expect(() => instance.run(() => "closed")).toThrow("reloaded or disabled");
    if (withChannels) {
      expect(signals.first).toHaveLength(2);
      expect(signals.first[0]?.aborted).toBe(true);
      expect(signals.first[1]?.aborted).toBe(false);
      expect(signals.sibling[0]?.aborted).toBe(false);
    }
    expect(hookStop).toHaveBeenCalledOnce();
    release.resolve();
    retry = fixture.reload();
    await retry;
    expect(hookStop).toHaveBeenCalledTimes(2);
    expect(hookStart).toHaveBeenCalledTimes(2);
    expect(() => instance.run(() => "still closed")).toThrow("reloaded or disabled");
    if (withChannels) {
      expect(signals.first).toHaveLength(3);
      expect(signals.first[1]?.aborted).toBe(true);
      expect(signals.first[2]?.aborted).toBe(false);
      expect(signals.sibling).toHaveLength(1);
      expect(signals.sibling[0]?.aborted).toBe(false);
    }
  } finally {
    release.resolve();
    if (withChannels) {
      await manager.stopChannel(channelIds.first);
    }
    await Promise.allSettled([reloading, retry]);
    if (withChannels) {
      await manager.stopChannel(channelIds.first);
      await manager.stopChannel(channelIds.sibling);
    }
    vi.useRealTimers();
  }
}

export async function verifyPendingServiceCleanupRollback(
  createRecoveryFixture: RecoveryFixtureFactory,
) {
  const stopEntered = createDeferredCore();
  const releaseStop = createDeferredCore();
  const events: string[] = [];
  let candidateStarts = 0;
  const fixture = await createRecoveryFixture({
    abortOnCandidateStart: false,
    initialStop: async () => {
      events.push("old-stop-started");
      stopEntered.resolve();
      await releaseStop.promise;
      events.push("old-stop-finished");
    },
    candidateStart: () => {
      events.push("candidate-started");
      if (++candidateStarts === 1) {
        throw new Error("candidate startup rejected");
      }
    },
    recoveryStart: async () => {
      events.push("old-restarted");
    },
  });
  vi.useFakeTimers();
  const reload = fixture.reload().catch((error: unknown) => error);
  try {
    await stopEntered.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await reload).toMatchObject({ details: { phase: "activate", committed: false } });
    expect([...events]).toEqual(["old-stop-started", "candidate-started"]);
    expect(fixture.firstStart).toHaveBeenCalledOnce();
    expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
    expect(fixture.siblingStart).toHaveBeenCalledOnce();
    expect(fixture.siblingStop).not.toHaveBeenCalled();

    releaseStop.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(["old-stop-started", "candidate-started", "old-stop-finished"]);
    await expect(fixture.reload()).resolves.toMatchObject({ runtime: { pluginIds: ["first"] } });
    expect(candidateStarts).toBe(2);
    expect(fixture.firstStart).toHaveBeenCalledOnce();
    expect(fixture.firstStop).toHaveBeenCalledOnce();
    expect(fixture.siblingStart).toHaveBeenCalledOnce();
    expect(fixture.siblingStop).not.toHaveBeenCalled();
  } finally {
    releaseStop.resolve();
    await reload;
    vi.useRealTimers();
  }
}

export async function verifyFailedRecoveryServiceOwnership(
  createRecoveryFixture: RecoveryFixtureFactory,
) {
  const startFailure = new Error("previous service failed to restart");
  const stopFailure = new Error("previous service cleanup failed");
  const fixture = await createRecoveryFixture({
    recoveryStart: async () => {
      throw startFailure;
    },
    recoveryStop: async () => {
      throw stopFailure;
    },
  });
  const failure = await fixture.reload().catch((error: unknown) => error);
  expect(failure).toMatchObject({
    details: { phase: "activate", committed: false },
    cause: {
      errors: [
        expect.any(GatewayConfigReloadSupersededError),
        expect.objectContaining({ errors: expect.arrayContaining([startFailure]) }),
      ],
    },
  });
  expect(fixture.firstStart).toHaveBeenCalledTimes(2);
  expect(fixture.siblingStart).toHaveBeenCalledOnce();
  expect(fixture.siblingStop).not.toHaveBeenCalled();
  const shutdown = await fixture.owner
    .currentServices()!
    .stop({ strict: true, deadlineAtMs: Date.now() + 5_000 })
    .catch((error: unknown) => error);
  expect(shutdown).toMatchObject({
    errors: [expect.objectContaining({ cause: stopFailure })],
  });
  expect(fixture.siblingStop).toHaveBeenCalledOnce();
  expect(fixture.firstStop).toHaveBeenCalledTimes(2);
}

export async function verifyCandidateCleanupRecovery(
  createRecoveryFixture: RecoveryFixtureFactory,
) {
  const stopFailure = new Error("candidate service cleanup failed");
  const fixture = await createRecoveryFixture({
    candidateStop: async () => {
      throw stopFailure;
    },
  });
  for (const attempt of [1, 2]) {
    const failure = await fixture.reload().catch((error: unknown) => error);
    expect(fixture.firstStart).toHaveBeenCalledTimes(attempt + 1);
    expect(failure).toMatchObject({
      details: { phase: "activate", committed: false },
      cause: expect.any(GatewayConfigReloadSupersededError),
    });
    expect(fixture.candidateStop).toHaveBeenCalledTimes(attempt);
    expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
    expect(fixture.siblingStart).toHaveBeenCalledOnce();
    expect(fixture.siblingStop).not.toHaveBeenCalled();
  }
  await expect(
    fixture.owner.currentServices()!.stop({ strict: true, deadlineAtMs: Date.now() + 5_000 }),
  ).resolves.toBeUndefined();
  expect(fixture.siblingStop).toHaveBeenCalledOnce();
  expect(fixture.candidateStop).toHaveBeenCalledTimes(2);
  await expect(fixture.lifetime.stop()).resolves.toBeUndefined();
  expect(fixture.runtime.runtimeState.gatewayLifetimeSidecars).toEqual([]);
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
