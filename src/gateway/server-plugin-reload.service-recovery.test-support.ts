import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import {
  verifyFailedRecoveryServiceOwnership,
  verifyCandidateCleanupRefusal,
} from "./server-plugin-reload.managed-candidate.test-support.js";
import {
  createRecoveryChannelManager,
  type RecoveryFixtureFactory,
} from "./server-plugin-reload.recovery.test-support.js";
import {
  verifyOneWayDrainRecovery,
  verifyReversibleFenceRecovery,
} from "./server-plugin-reload.suspension.test-support.js";

export function registerPluginServiceRecoveryTests(createRecoveryFixture: RecoveryFixtureFactory) {
  describe("Gateway plugin service recovery ownership", () => {
    it("restores an unchanged channel after command-owner cleanup fails", async () => {
      const starts = { first: vi.fn(), sibling: vi.fn() };
      const fixture = await createRecoveryFixture({
        initialStop: async () => {
          throw new Error("command-owner cleanup refused");
        },
        register: (api, owner) => {
          if (owner === "first") {
            api.registerCommand({
              name: "cleanup-probe",
              description: "Probe command cleanup",
              handler: () => ({ text: "ok" }),
            });
          }
          api.registerChannel({
            plugin: {
              ...createChannelTestPluginBase({
                id: owner,
                config: { listAccountIds: () => ["default", "parked"] },
              }),
              gateway: {
                startAccount: async ({ accountId, abortSignal }) => {
                  starts[owner](accountId);
                  await new Promise<void>((resolve) => {
                    abortSignal.addEventListener("abort", () => resolve(), { once: true });
                  });
                },
              },
            },
          });
        },
      });
      const manager = createRecoveryChannelManager(fixture);
      fixture.runtime.channelManager = manager;
      const sibling = fixture.previousRegistry.plugins.find((record) => record.id === "sibling");
      try {
        for (const channel of ["first", "sibling"]) {
          await manager.stopChannel(channel, "parked");
          await manager.startChannel(channel, undefined, {
            manual: false,
            preserveManualStop: true,
          });
        }
        await vi.waitFor(() => {
          expect(starts.first).toHaveBeenCalledExactlyOnceWith("default");
          expect(starts.sibling).toHaveBeenCalledExactlyOnceWith("default");
        });
        await expect(fixture.reload()).rejects.toMatchObject({
          details: { committed: false, phase: "drain" },
        });
        // Command catalog refresh stops this channel, but its registration is healthy.
        expect(manager.getRuntimeSnapshot().reloadingChannels?.has("sibling")).toBe(false);
        expect(manager.hasCurrentAccountTask("sibling", "default")).toBe(true);
        await vi.waitFor(() => expect(starts.sibling).toHaveBeenCalledTimes(2));
        expect(starts.sibling.mock.calls).toEqual([["default"], ["default"]]);
        expect(manager.isManuallyStopped("sibling", "parked")).toBe(true);
        expect(
          fixture.registryOwner.registry.plugins.find((record) => record.id === "sibling"),
        ).toBe(sibling);
        expect(fixture.siblingStart).toHaveBeenCalledOnce();
        expect(fixture.siblingStop).not.toHaveBeenCalled();
        await expect(manager.startChannel("first")).rejects.toThrow("plugins are reloading");
        expect(starts.first).toHaveBeenCalledOnce();
        expect(fixture.candidates).toHaveLength(0);
      } finally {
        await manager.stopChannel("first");
        await manager.stopChannel("sibling");
      }
    });

    it("restores prepared config effects when channel admission cannot pause", async () => {
      const rollback = vi.fn(async () => {});
      const fixture = await createRecoveryFixture({ prepareConfigEffects: () => rollback });
      const failure = new Error("fixture channel pause failed");
      vi.spyOn(fixture.runtime.channelManager, "pauseChannelStarts").mockImplementationOnce(() => {
        throw failure;
      });
      await expect(fixture.reload()).rejects.toMatchObject({
        details: { committed: false },
        cause: failure,
      });
      expect(fixture.firstStop).not.toHaveBeenCalled();
      expect(rollback).toHaveBeenCalledOnce();
    });

    it.each(["restored", "failed"] as const)(
      "settles prepared config effects only after plugin rollback is %s",
      async (restoration) => {
        const recoveryStarted = createDeferredCore();
        const releaseRecovery = createDeferredCore();
        const rollback = vi.fn(async () => {
          const record = fixture.registryOwner.registry.plugins.find(
            (plugin) => plugin.id === "first",
          );
          expect(record && getPluginInstance(record)?.acceptingCalls).toBe(true);
        });
        const fixture = await createRecoveryFixture({
          prepareConfigEffects: () => rollback,
          recoveryStart: async () => {
            recoveryStarted.resolve();
            await releaseRecovery.promise;
            if (restoration === "failed") {
              throw new Error("fixture recovery failed");
            }
          },
        });
        const reloading = fixture.reload().catch((error: unknown) => error);
        try {
          await recoveryStarted.promise;
          expect(rollback).not.toHaveBeenCalled();
          releaseRecovery.resolve();
          expect(await reloading).toMatchObject({ details: { committed: false } });
          expect(rollback).toHaveBeenCalledTimes(restoration === "restored" ? 1 : 0);
        } finally {
          releaseRecovery.resolve();
          await reloading;
        }
      },
    );

    it.each(["prepare", "drain", "publish", "committed"] as const)(
      "preserves the committed owner when its invoker closes during %s",
      async (boundary) => {
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const failure = new Error("plugin invoker closed");
        let invokerOpen = true;
        const pause = async () => {
          entered.resolve();
          await release.promise;
        };
        const candidateStart = vi.fn();
        const fixture = await createRecoveryFixture({
          abortOnCandidateStart: false,
          candidateStart,
          ...(boundary === "prepare" ? { checkpoint: pause } : {}),
          ...(boundary === "drain" ? { initialStop: pause } : {}),
          ...(boundary === "publish" ? { beforePublish: pause } : {}),
          ...(boundary === "committed" ? { afterPublish: pause } : {}),
          assertInvokerOwned: () => {
            if (!invokerOpen) {
              throw failure;
            }
          },
        });
        const pending = fixture.reload().catch((error: unknown) => error);
        try {
          await Promise.race([
            entered.promise,
            pending.then(() => {
              throw new Error("plugin reload completed before its pause");
            }),
          ]);
          invokerOpen = false;
          release.resolve();
          const result = await pending;
          if (boundary === "committed") {
            expect(result).toMatchObject({
              runtime: { operationId: "service-recovery", pluginIds: ["first"] },
            });
            expect(fixture.registryOwner.registry).not.toBe(fixture.previousRegistry);
            const previousRecord = fixture.previousRegistry.plugins.find(
              (record) => record.id === "first",
            );
            assert.ok(previousRecord);
            expect(getPluginInstance(previousRecord)?.lifecycle.signal.aborted).toBe(true);
            expect(fixture.firstStart).toHaveBeenCalledOnce();
            expect(fixture.candidateStop).not.toHaveBeenCalled();
          } else {
            expect(result).toMatchObject({
              details: { phase: boundary === "publish" ? "activate" : boundary, committed: false },
              cause: failure,
            });
            expect(fixture.registryOwner.registry === fixture.previousRegistry).toBe(
              boundary === "prepare",
            );
            expect(fixture.firstStart).toHaveBeenCalledTimes(boundary === "prepare" ? 1 : 2);
            expect(fixture.candidateStop).toHaveBeenCalledTimes(boundary === "publish" ? 1 : 0);
          }
          expect(candidateStart).toHaveBeenCalledTimes(
            boundary === "publish" || boundary === "committed" ? 1 : 0,
          );
          expect(fixture.siblingStart).toHaveBeenCalledOnce();
          expect(fixture.siblingStop).not.toHaveBeenCalled();
        } finally {
          release.resolve();
          await pending;
        }
      },
    );

    it("keeps retained and failed-recovery services owned after recovery startup rejects", () =>
      verifyFailedRecoveryServiceOwnership(createRecoveryFixture));

    it("refuses recovery when candidate resource cleanup fails and retains its sibling", () =>
      verifyCandidateCleanupRefusal(createRecoveryFixture));

    it.each(["suspension", "restart signal"] as const)(
      "restores the previous plugin runtime after failed replacement during reversible %s",
      (fence) => verifyReversibleFenceRecovery(createRecoveryFixture, fence),
    );

    it("publishes retained services before awaited cleanup when admission closes and recovery is skipped", () =>
      verifyOneWayDrainRecovery(createRecoveryFixture));
  });
}
