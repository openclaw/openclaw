import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { expect, vi } from "vitest";
import {
  getGatewaySuspendStatus,
  prepareGatewaySuspend,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  resumeGatewaySuspend,
} from "../infra/gateway-suspend-coordinator.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import {
  beginGatewayRestartSignalAdmission,
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { createChannelManager } from "./server-channels.js";
import type { RecoveryFixtureFactory } from "./server-plugin-reload.recovery.test-support.js";

export async function verifyReversibleFenceRecovery(
  createRecoveryFixture: RecoveryFixtureFactory,
  fence: "suspension" | "restart signal",
) {
  const stopEntered = createDeferredCore();
  const releaseStop = createDeferredCore();
  const candidateCleanup = createDeferredCore();
  const recoveryWork = vi.fn(async () => "recovered");
  const channelIds = { first: "suspend-first", sibling: "suspend-sibling" } as const;
  const signals = { first: [] as AbortSignal[], sibling: [] as AbortSignal[] };
  const fixture = await createRecoveryFixture({
    initialStop: async () => {
      stopEntered.resolve();
      await releaseStop.promise;
    },
    recoveryStart: async () => {
      await enqueueCommandInLane("plugin-reload-recovery", recoveryWork);
    },
    candidateStop: async () => {
      candidateCleanup.resolve();
    },
    register: (api, owner) => {
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
    },
  });
  const manager = createChannelManager({
    getRuntimeConfig: fixture.getConfig,
    getPluginRegistry: () => fixture.registryOwner.registry,
    channelLogs: {},
    channelRuntimeEnvs: {},
  });
  fixture.runtime.channelManager = manager;
  const instance = getPluginInstance(fixture.previousRegistry.plugins[0]!);
  assert(instance);
  let releaseFence: (() => void) | undefined;
  let reloading: Promise<unknown> | undefined;
  let reloadSettled = false;
  try {
    await manager.startChannel(channelIds.first);
    await manager.startChannel(channelIds.sibling);
    await vi.waitFor(() => {
      expect(signals.first).toHaveLength(1);
      expect(signals.sibling).toHaveLength(1);
    });
    reloading = runWithGatewayIndependentRootWorkAdmission(() => fixture.reload(), "plugins.reload")
      .catch((error: unknown) => error)
      .then((result) => {
        reloadSettled = true;
        return result;
      });
    await Promise.race([
      stopEntered.promise,
      reloading.then((error) => {
        throw error;
      }),
    ]);
    if (fence === "suspension") {
      const pauseScheduling = vi.fn();
      const resumeScheduling = vi.fn();
      const prepared = prepareGatewaySuspend({
        requestId: "plugin-reload-suspension",
        drain: true,
        pauseScheduling,
        resumeScheduling,
      });
      assert(prepared.status === "draining");
      expect(prepared.activeCount).toBeGreaterThan(0);
      expect(pauseScheduling).toHaveBeenCalledOnce();
      releaseFence = () => {
        expect(getGatewaySuspendStatus(prepared.suspensionId).status).toBe("ready");
        expect(resumeGatewaySuspend(prepared.suspensionId)).toMatchObject({
          ok: true,
          resumed: true,
        });
        expect(resumeScheduling).toHaveBeenCalledOnce();
      };
    } else {
      const lease = beginGatewayRestartSignalAdmission();
      assert(lease);
      releaseFence = () => {
        expect(lease.rollback()).toBe(true);
      };
    }
    expect(isGatewayWorkAdmissionClosed()).toBe(true);
    releaseStop.resolve();
    if (fence === "restart signal") {
      await candidateCleanup.promise;
      // Let candidate teardown settle while signal delivery still owns its fence.
      // Recovery's command work must wait for that owner to reopen admission.
      await setImmediate();
      expect(reloadSettled).toBe(false);
      expect(recoveryWork).not.toHaveBeenCalled();
      releaseFence();
      releaseFence = undefined;
    }
    expect(await reloading).toMatchObject({ details: { phase: "activate", committed: false } });
    if (releaseFence) {
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      releaseFence();
      releaseFence = undefined;
    }
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
    expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
    expect(fixture.firstStart).toHaveBeenCalledTimes(2);
    expect(recoveryWork).toHaveBeenCalledOnce();
    expect(fixture.siblingStart).toHaveBeenCalledOnce();
    expect(fixture.siblingStop).not.toHaveBeenCalled();
    expect(instance.run(() => "restored")).toBe("restored");
    await vi.waitFor(() => expect(signals.first).toHaveLength(2));
    expect(signals.first[0]?.aborted).toBe(true);
    expect(signals.first[1]?.aborted).toBe(false);
    expect(signals.sibling).toHaveLength(1);
    expect(signals.sibling[0]?.aborted).toBe(false);
  } finally {
    releaseStop.resolve();
    if (fence === "restart signal") {
      releaseFence?.();
      releaseFence = undefined;
    }
    await reloading;
    releaseFence?.();
    resetGatewaySuspendCoordinatorForLifecycleRestart();
    await manager.stopChannel(channelIds.first);
    await manager.stopChannel(channelIds.sibling);
  }
}

export async function verifyOneWayDrainRecovery(createRecoveryFixture: RecoveryFixtureFactory) {
  const cleanupEntered = createDeferredCore();
  const cleanupReleased = createDeferredCore();
  const fixture = await createRecoveryFixture({
    candidateStart: markGatewayRestartDraining,
    candidateStop: async () => {
      cleanupEntered.resolve();
      await cleanupReleased.promise;
    },
  });
  const reloading = fixture.reload().catch((error: unknown) => error);
  try {
    await Promise.race([
      cleanupEntered.promise,
      reloading.then((error) => {
        throw error;
      }),
    ]);
    const shuttingDown = fixture.owner.currentServices()!.stop();
    cleanupReleased.resolve();
    const failure = await reloading;
    await shuttingDown;
    expect(failure).toMatchObject({ details: { phase: "activate", committed: false } });
    expect(fixture.firstStart).toHaveBeenCalledOnce();
    expect(fixture.siblingStart).toHaveBeenCalledOnce();
    expect(fixture.siblingStop).toHaveBeenCalledOnce();
    expect(fixture.candidateStop).toHaveBeenCalledOnce();
  } finally {
    cleanupReleased.resolve();
    await reloading;
  }
}
