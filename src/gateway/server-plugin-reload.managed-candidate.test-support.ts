import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, vi } from "vitest";
import { PluginInstanceDrainTimeoutError } from "../plugins/plugin-instance-error.js";
import {
  disposePluginRegistryInstances,
  waitForPluginRegistryRetirement,
} from "../plugins/runtime.js";
import { startPluginServices } from "../plugins/services.test-support.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import {
  firstReloaded,
  reloadFailure,
  rejectWith,
  heldWork,
  observeSettlement,
  pluginInstance,
} from "./server-plugin-reload.fixture-tools.test-support.js";
import {
  createCleanupChannels,
  expectSiblingUnchanged,
  observeRetainedWork,
  type RecoveryFixtureFactory,
} from "./server-plugin-reload.recovery.test-support.js";
import { GatewayConfigReloadSupersededError } from "./server-reload-contracts.js";

export async function verifyManagedCandidateRetirement(
  createRecoveryFixture: RecoveryFixtureFactory,
  action: "retry" | "shutdown",
) {
  const startupGate = heldWork();
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
            await startupGate.run();
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
  let alternateRetirement: Promise<void> | undefined;
  let shuttingDown: Promise<void> | undefined;
  let retry: Promise<void> | undefined;
  const operation = observeSettlement(fixture.reload());
  const reloading = operation.result;
  try {
    await startupGate.entered;
    const candidate = fixture.candidates[0]!.registry;
    const instance = pluginInstance(candidate);
    // Observe each existing deadline: failed startup, service stop, then instance drain.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(instance.disposing).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(
      await waitForPluginRegistryRetirement(candidate, { deferConsumers: true }),
    ).toMatchObject({ deferredPluginIds: ["first"] });
    expect(instance.disposing).toBe(true);
    let retired = false;
    let logicalRetirement = false;
    alternateRetirement = disposePluginRegistryInstances(candidate).then(async (result) => {
      expect(result.failures).toHaveLength(1);
      const error = result.failures[0]!.error;
      assert(error instanceof PluginInstanceDrainTimeoutError);
      logicalRetirement = true;
      await error.settled;
      retired = true;
    });
    if (action === "shutdown") {
      shuttingDown = fixture.lifetime.stop();
    }
    await vi.advanceTimersByTimeAsync(5_000);
    // Logical retirement is bounded; the metadata owner still joins physical service cleanup.
    expect(operation.state.value).toBeUndefined();
    expect(logicalRetirement).toBe(true);
    expect(instance.lifecycle.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    await reloading;
    expect(operation.state.value).toMatchObject({
      details: { phase: "activate", committed: false },
      message: expect.stringContaining("plugin service startup timed out"),
    });
    expect(retired).toBe(false);
    expect(() => instance.run(() => "retired dispatch")).toThrow("reloaded or disabled");
    expect(order).toEqual([]);
    expect(queuedStart).not.toHaveBeenCalled();
    expect(fixture.runtime.runtimeState.gatewayLifetimeSidecars.snapshot()).toEqual([]);
    if (action === "shutdown") {
      shuttingDown = fixture.lifetime.sealAndJoin();
    } else {
      retry = expect(fixture.reload()).resolves.toMatchObject(firstReloaded);
      await nextTurn();
      expect(queuedStart).not.toHaveBeenCalled();
      expect(fixture.candidates).toHaveLength(1);
    }
    // Native startup can acquire resources late; its one stop still precedes instance disposal.
    startupGate.release();
    await vi.advanceTimersByTimeAsync(0);
    await alternateRetirement;
    await shuttingDown;
    await retry;
    expect(retired).toBe(true);
    expect(order.filter((entry) => entry.endsWith(":2"))).toEqual([
      "start:2",
      "stop:2",
      "dispose:2",
    ]);
    expect(process.listenerCount(event)).toBe(before + (action === "retry" ? 1 : 0));
    expect(() => instance.run(() => "still retired")).toThrow("reloaded or disabled");
    expect(queuedStart).toHaveBeenCalledTimes(action === "retry" ? 1 : 0);
  } finally {
    startupGate.release();
    await reloading;
    await Promise.allSettled([alternateRetirement, shuttingDown, retry]);
    for (const listener of listeners) {
      process.removeListener(event, listener);
    }
    vi.useRealTimers();
  }
}

export async function verifyPendingServiceCleanupRetry(
  createRecoveryFixture: RecoveryFixtureFactory,
) {
  const hookGate = heldWork();
  const startupGate = heldWork();
  let starts = 0;
  const serviceStop = vi.fn();
  const hookStop = vi.fn(hookGate.run);
  const fixture = await createRecoveryFixture({
    abortOnCandidateStart: false,
    register: (api, owner) => {
      if (owner === "first") {
        api.on("gateway_stop", hookStop);
        api.registerService({
          id: "pending-startup",
          start: () => {
            if (++starts === 2) {
              return startupGate.run();
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
      fixture.owner.setServices(handle);
    },
  });
  await startupGate.entered;
  fixture.expectServices({ siblingStart: 1, siblingStop: 1 });
  const instance = fixture.instance();
  const observation = observeRetainedWork(instance);
  vi.useFakeTimers();
  let retry: Promise<unknown> | undefined;
  const first = fixture.reload().catch((error: unknown) => error);
  try {
    await Promise.race([observation.entered, first]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(serviceStop).toHaveBeenCalledOnce();
    expect(hookStop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await first).toMatchObject(reloadFailure("drain"));
    expect(instance.run(() => "still serving")).toBe("still serving");
    expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
    startupGate.release();
    await startup;
    retry = fixture.reload();
    await hookGate.entered;
    expect(serviceStop).toHaveBeenCalledTimes(2);
    expect(starts).toBe(2);
    expect(fixture.candidates).toHaveLength(0);
    hookGate.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(await retry).toMatchObject(firstReloaded);
    expect(fixture.registryOwner.registry).not.toBe(fixture.previousRegistry);
    expect(starts).toBe(3);
    expect(instance.lifecycle.signal.aborted).toBe(true);
    expect(() => instance.run(() => "retired dispatch")).toThrow("reloaded or disabled");
    expect(hookStop).toHaveBeenCalledOnce();
    fixture.expectServices({ siblingStart: 2, siblingStop: 1 });
    retry = fixture.reload();
    await expect(retry).resolves.toMatchObject(firstReloaded);
    expect(starts).toBe(4);
    expect(serviceStop).toHaveBeenCalledTimes(3);
    expect(hookStop).toHaveBeenCalledTimes(2);
    expect(() => instance.run(() => "still retired")).toThrow("reloaded or disabled");
    fixture.expectServices({ siblingStart: 2, siblingStop: 1 });
  } finally {
    observation.restore();
    hookGate.release();
    startupGate.release();
    await Promise.allSettled([first, retry, startup]);
    vi.useRealTimers();
  }
}

export async function verifyGatewayCleanupRefusal(createRecoveryFixture: RecoveryFixtureFactory) {
  const hookGate = heldWork();
  const hookStart = vi.fn();
  const hookStop = vi.fn(hookGate.run);
  const channelIds = { first: "cleanup-first", sibling: "cleanup-sibling" } as const;
  const { fixture, manager, signals } = await createCleanupChannels(
    createRecoveryFixture,
    (api) => {
      api.on("gateway_start", hookStart);
      api.on("gateway_stop", hookStop);
    },
  );
  const instance = fixture.instance();
  vi.useFakeTimers();
  const reloading = fixture.reload().catch((error: unknown) => error);
  try {
    await hookGate.entered;
    await vi.advanceTimersByTimeAsync(5_000);
    hookGate.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(await reloading).toMatchObject({
      details: { phase: "drain", committed: false, pluginIds: ["first"] },
    });
    expect(hookStart).not.toHaveBeenCalled();
    expect(fixture.firstStart).toHaveBeenCalledOnce();
    expect(fixture.candidates).toHaveLength(0);
    expect(instance.lifecycle.signal.aborted).toBe(true);
    expect(() => instance.run(() => "closed")).toThrow("reloaded or disabled");
    expect(signals).toMatchObject({ first: [{ aborted: true }], sibling: [{ aborted: false }] });
    expect(hookStop).toHaveBeenCalledOnce();
  } finally {
    hookGate.release();
    await manager.stopChannel(channelIds.first);
    await reloading;
    await manager.stopChannel(channelIds.first);
    await manager.stopChannel(channelIds.sibling);
    vi.useRealTimers();
  }
}

export async function verifyPendingServiceCleanupRollback(
  createRecoveryFixture: RecoveryFixtureFactory,
) {
  const stopGate = heldWork();
  const events: string[] = [];
  let candidateStarts = 0;
  const fixture = await createRecoveryFixture({
    abortOnCandidateStart: false,
    initialStop: async () => {
      events.push("old-stop-started");
      await stopGate.run();
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
    await stopGate.entered;
    await vi.advanceTimersByTimeAsync(1_000);
    stopGate.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(await reload).toMatchObject(reloadFailure("activate"));
    expect(events).toEqual([
      "old-stop-started",
      "old-stop-finished",
      "candidate-started",
      "old-restarted",
    ]);
    expect(fixture.registryOwner.registry).not.toBe(fixture.previousRegistry);
    expectSiblingUnchanged(fixture);

    await expect(fixture.reload()).resolves.toMatchObject(firstReloaded);
    expect(candidateStarts).toBe(2);
    fixture.expectServices({ firstStart: 2, firstStop: 2 });
    expectSiblingUnchanged(fixture);
  } finally {
    stopGate.release();
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
    recoveryStart: rejectWith(startFailure),
    recoveryStop: rejectWith(stopFailure),
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
  expectSiblingUnchanged(fixture);
  const shutdown = await fixture.owner
    .currentServices()!
    .stop({ strict: true, deadlineAtMs: Date.now() + 5_000 })
    .catch((error: unknown) => error);
  expect(shutdown).toMatchObject({ errors: [expect.objectContaining({ cause: stopFailure })] });
  fixture.expectServices({ siblingStop: 1, firstStop: 2 });
}

export async function verifyCandidateCleanupRefusal(createRecoveryFixture: RecoveryFixtureFactory) {
  const stopFailure = new Error("candidate service cleanup failed");
  let resourceOpen = false;
  let registrations = 0;
  const disposed: number[] = [];
  const fixture = await createRecoveryFixture({
    expectedMetadataCloseError: stopFailure,
    registerFirst(api) {
      expect(resourceOpen).toBe(false);
      resourceOpen = true;
      const registration = ++registrations;
      api.registerService({
        id: "exclusive-resource",
        start() {},
        stop() {
          if (registration === 2) {
            throw stopFailure;
          }
          resourceOpen = false;
        },
      });
      assert(api.lifecycle.onDispose);
      api.lifecycle.onDispose(() => {
        disposed.push(registration);
      });
    },
  });
  const failure = await fixture.reload().catch((error: unknown) => error);
  expect(fixture.firstStart).toHaveBeenCalledOnce();
  expect(failure).toMatchObject({
    details: { phase: "activate", committed: false },
    message: expect.stringContaining("automatic recovery could not safely start"),
  });
  expect(registrations).toBe(2);
  expect(disposed).toEqual([1, 2]);
  expect(resourceOpen).toBe(true);
  expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
  expectSiblingUnchanged(fixture);
  const sibling = pluginInstance(fixture.registryOwner.registry, "sibling");
  expect(sibling.run(() => "still serving")).toBe("still serving");
  await expect(fixture.reload()).rejects.toMatchObject({
    details: { phase: "prepare", committed: false },
    message: expect.stringContaining(stopFailure.message),
  });
  expect(registrations).toBe(2);
  expect(resourceOpen).toBe(true);
  expect(sibling.run(() => "still serving after rejected retry")).toBe(
    "still serving after rejected retry",
  );
}

export async function verifyPreCommitRetirementOwnership(
  createRecoveryFixture: RecoveryFixtureFactory,
) {
  const cleanupGate = heldWork();
  let generations = 0;
  let cleanupCalls = 0;
  const first = await createRecoveryFixture({
    abortOnCandidateStart: false,
    register(api, owner) {
      if (owner === "first" && ++generations === 1) {
        assert(api.lifecycle.onDispose);
        api.lifecycle.onDispose(async () => {
          cleanupCalls++;
          await cleanupGate.run();
        });
      }
    },
  });
  // A second real registry owner retains the shared boot inventory throughout this cutover.
  await createRecoveryFixture({ abortOnCandidateStart: false });
  const operation = observeSettlement(first.reload());
  const reloading = operation.result;
  let closing: Promise<unknown> | undefined;
  try {
    await cleanupGate.entered;
    const shutdown = observeSettlement(
      (async () => {
        await first.owner.currentServices()?.stop();
        await first.registryOwner.close();
        await first.runtime.kernel.pluginMetadata.close();
      })(),
    );
    closing = shutdown.result;
    await nextTurn();
    expect.soft(operation.state.settled).toBe(false);
    expect.soft(shutdown.state.settled).toBe(false);
    expect(first.candidates).toHaveLength(0);
    cleanupGate.release();
    expect(await reloading).toMatchObject({ details: { committed: false } });
    expect(await closing).toBeUndefined();
    expect(cleanupCalls).toBe(1);
  } finally {
    cleanupGate.release();
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
      fixture.expectServices({ firstStop: 0, siblingStop: 0 });
      throw refusal;
    },
  });
  const pause = vi.spyOn(fixture.runtime.channelManager, "pauseChannelStarts");
  await expect(
    fixture.reload(undefined, ["first"], ["plugins.entries.sibling.enabled"]),
  ).rejects.toMatchObject({ cause: refusal, details: { phase: "prepare", committed: false } });
  expect(pause).not.toHaveBeenCalled();
  expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
}
