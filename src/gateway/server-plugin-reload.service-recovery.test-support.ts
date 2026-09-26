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
    it.each(["settled", "rejected", "deadline"] as const)(
      "observes shared-deadline service cleanup before restoring channels: %s",
      async (outcome) => {
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const laterEntered = createDeferredCore();
        const laterRelease = createDeferredCore();
        const workRelease = createDeferredCore();
        let admittedWrite: Promise<void> | undefined;
        let completedWrites = 0;
        const disposed: number[] = [];
        const starts: string[] = [];
        let registrations = 0;
        const laterStop = vi.fn(async () => {
          laterEntered.resolve();
          await laterRelease.promise;
        });
        const fixture = await createRecoveryFixture({
          abortOnCandidateStart: false,
          initialStop: async () => {
            assert(original);
            // Pre-stop calls already drained; cleanup can admit work that recovery must join.
            admittedWrite = original.runCleanup(() =>
              original.runConsumer(async () => {
                await workRelease.promise;
                completedWrites += 1;
              }),
            );
            entered.resolve();
            await release.promise;
            if (outcome === "rejected") {
              throw new Error("original cleanup permanently refused");
            }
          },
          register(api, owner) {
            if (owner !== "first") {
              return;
            }
            const generation = ++registrations;
            api.lifecycle.onDispose?.(() => {
              disposed.push(generation);
            });
            // The fixture's main service is registered last and stops first.
            api.registerService({ id: "later-cleanup", start() {}, stop: laterStop });
            api.registerChannel({
              plugin: {
                ...createChannelTestPluginBase({
                  id: "cleanup-recovery",
                  config: { listAccountIds: () => ["default", "parked"] },
                }),
                gateway: {
                  startAccount: async ({ accountId, abortSignal }) => {
                    starts.push(accountId);
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
        await manager.stopChannel("cleanup-recovery", "parked");
        await manager.startChannel("cleanup-recovery", undefined, {
          manual: false,
          preserveManualStop: true,
        });
        await vi.waitFor(() => expect(starts).toEqual(["default"]));
        const original = getPluginInstance(fixture.previousRegistry.plugins[0]!);
        assert(original);
        const generation = fixture.owner.currentClaim();
        vi.useFakeTimers();
        let settled = false;
        const pending = fixture
          .reload()
          .catch((error: unknown) => error)
          .then((result) => {
            settled = true;
            return result;
          });
        try {
          await entered.promise;
          await vi.advanceTimersByTimeAsync(5_000);
          await laterEntered.promise;
          expect(fixture.firstStop).toHaveBeenCalledOnce();
          expect(laterStop).toHaveBeenCalledOnce();
          await vi.advanceTimersByTimeAsync(10_000);
          expect(fixture.candidates).toHaveLength(0);
          expect(disposed).toEqual([]);
          expect(registrations).toBe(1);
          expect(starts).toEqual(["default"]);
          expect(() => original.run(() => "stale")).toThrow("reloaded or disabled");
          // The first observer used the shared budget; the second still owns its
          // original cleanup despite having zero observation time remaining.
          if (outcome === "deadline") {
            await vi.advanceTimersByTimeAsync(70_000);
            expect(settled).toBe(true);
            expect(fixture.owner.getReloadStatus()?.phase).toBe("failed");
          } else {
            expect(settled).toBe(false);
            expect(fixture.owner.getReloadStatus()?.phase).toBe("recovering");
          }
          release.resolve();
          await vi.advanceTimersByTimeAsync(1_000);
          expect(disposed).toEqual([]);
          expect(registrations).toBe(1);
          laterRelease.resolve();
          await vi.advanceTimersByTimeAsync(1_000);
          expect(disposed).toEqual([]);
          expect(registrations).toBe(1);
          expect(completedWrites).toBe(0);
          workRelease.resolve();
          await admittedWrite;
          expect(completedWrites).toBe(1);
          await vi.advanceTimersByTimeAsync(10_000);
          expect(await pending).toMatchObject({ details: { committed: false, phase: "drain" } });
          expect(fixture.owner.currentClaim()).toEqual(generation);
          expect(fixture.firstStop).toHaveBeenCalledOnce();
          expect(laterStop).toHaveBeenCalledOnce();
          expect(fixture.siblingStop).not.toHaveBeenCalled();
          expect(manager.isManuallyStopped("cleanup-recovery", "parked")).toBe(true);
          if (outcome === "settled") {
            expect(disposed).toEqual([1]);
            expect(registrations).toBe(2);
            expect(starts).toEqual(["default", "default"]);
            expect(fixture.owner.getReloadStatus()).toBeUndefined();
            expect(fixture.registryOwner.registry).not.toBe(fixture.previousRegistry);
          } else {
            expect(disposed).toEqual([]);
            expect(registrations).toBe(1);
            expect(fixture.owner.getReloadStatus()?.phase).toBe("failed");
            expect(starts).toEqual(["default"]);
          }
          expect(manager.getRuntimeSnapshot().reloadingChannels?.size).toBe(0);
          expect(() => original.run(() => "still stale")).toThrow("reloaded or disabled");
        } finally {
          release.resolve();
          laterRelease.resolve();
          workRelease.resolve();
          await admittedWrite;
          await vi.advanceTimersByTimeAsync(80_000);
          await pending;
          vi.useRealTimers();
          await manager.stopChannel("cleanup-recovery");
        }
      },
    );

    it.each(["service", "channel"] as const)(
      "does not recover a pending service stop mixed with permanent %s failure",
      async (failureOwner) => {
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const permanent = new Error("mixed cleanup permanently refused");
        let registrations = 0;
        const pendingStop = vi.fn(async () => {
          entered.resolve();
          await release.promise;
        });
        const fixture = await createRecoveryFixture({
          abortOnCandidateStart: false,
          initialStop:
            failureOwner === "service"
              ? async () => {
                  throw permanent;
                }
              : pendingStop,
          register(api, owner) {
            if (owner !== "first") {
              return;
            }
            registrations += 1;
            if (failureOwner === "service") {
              api.registerService({ id: "pending-cleanup", start() {}, stop: pendingStop });
            } else {
              api.registerChannel({ plugin: createChannelTestPluginBase({ id: "first" }) });
            }
          },
        });
        const manager = createRecoveryChannelManager(fixture);
        fixture.runtime.channelManager = manager;
        if (failureOwner === "channel") {
          vi.spyOn(manager, "stopChannel").mockRejectedValueOnce(permanent);
        }
        const original = getPluginInstance(fixture.previousRegistry.plugins[0]!);
        const generation = fixture.owner.currentClaim();
        vi.useFakeTimers();
        let settled = false;
        const pending = fixture
          .reload()
          .catch((error: unknown) => error)
          .then((result) => {
            settled = true;
            return result;
          });
        try {
          await entered.promise;
          // Observe the existing service-stop and admitted-work drain deadlines.
          await vi.advanceTimersByTimeAsync(15_000);
          expect(settled).toBe(true);
          expect(await pending).toMatchObject({ details: { committed: false, phase: "drain" } });
          expect(fixture.owner.getReloadStatus()?.phase).toBe("failed");
          expect(original?.acceptingCalls).toBe(false);
          release.resolve();
          await vi.advanceTimersByTimeAsync(70_000);
          expect(fixture.owner.getReloadStatus()?.phase).toBe("failed");
          expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
          expect(fixture.owner.currentClaim()).toEqual(generation);
          expect(fixture.candidates).toHaveLength(0);
          expect(registrations).toBe(1);
          expect(fixture.firstStart).toHaveBeenCalledOnce();
          expect(fixture.firstStop).toHaveBeenCalledOnce();
          expect(pendingStop).toHaveBeenCalledOnce();
          expect(fixture.siblingStop).not.toHaveBeenCalled();
        } finally {
          release.resolve();
          await vi.advanceTimersByTimeAsync(70_000);
          await pending;
          vi.useRealTimers();
          await manager.stopChannel("first");
        }
      },
    );

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
        expect(fixture.rollbackConfigEffects).toHaveBeenCalledOnce();
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
        expect(manager.getRuntimeSnapshot().reloadingChannels?.size).toBe(0);
        await expect(manager.startChannel("first")).rejects.toThrow("reloaded or disabled");
        expect(starts.first).toHaveBeenCalledOnce();
        expect(fixture.candidates).toHaveLength(0);
      } finally {
        await manager.stopChannel("first");
        await manager.stopChannel("sibling");
      }
    });

    it("restores prepared config effects when channel admission cannot pause", async () => {
      const rollback = vi.fn(async () => {
        for (const record of fixture.previousRegistry.plugins) {
          getPluginInstance(record)?.retainWork()();
        }
      });
      const fixture = await createRecoveryFixture({
        prepareConfigEffects: () => {
          const record = fixture.previousRegistry.plugins.find((plugin) => plugin.id === "first");
          assert(record);
          expect(() => getPluginInstance(record)?.retainWork()).toThrow(
            "replacement is in progress",
          );
          return rollback;
        },
      });
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
          if (restoration === "restored") {
            expect(record && getPluginInstance(record)?.acceptingCalls).toBe(true);
          }
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
          expect(rollback).toHaveBeenCalledOnce();
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
