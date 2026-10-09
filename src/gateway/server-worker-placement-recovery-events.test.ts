import { describe, expect, it, vi } from "vitest";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const runtimeMocks = vi.hoisted(() => ({
  createDispatch: vi.fn(),
  createDiskSpace: vi.fn(),
  createSessionEvidenceResolver: vi.fn(),
  publicationWarn: vi.fn(),
  destroyEnvironment: vi.fn(),
}));

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => {
      const logger = actual.createSubsystemLogger(...args);
      return args[0] === "gateway/session-events"
        ? { ...logger, warn: runtimeMocks.publicationWarn }
        : logger;
    },
  };
});

vi.mock("./worker-environments/placement-dispatch.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./worker-environments/placement-dispatch.js")>();
  return { ...actual, createWorkerPlacementDispatchService: runtimeMocks.createDispatch };
});

vi.mock("./worker-environments/placement-disk-space.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./worker-environments/placement-disk-space.js")>();
  return { ...actual, createWorkerPlacementDiskSpaceMonitor: runtimeMocks.createDiskSpace };
});

vi.mock("./server-worker-placement-session-evidence.js", () => ({
  createWorkerPlacementSessionEvidenceResolver: runtimeMocks.createSessionEvidenceResolver,
}));

import { getRuntimeConfig } from "../config/config.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./worker-environments/device-provider-identity.js";
import type { WorkerEnvironmentPlacementFacts } from "./worker-environments/placement-read-projection.types.js";

type RecoveryPlacement = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  state: "active" | "failed" | "local" | "reclaimed";
  generation: number;
  updatedAtMs: number;
  environmentId: string | null;
  activeOwnerEpoch: number | null;
  turnClaim: null;
};

function recoveryPlacement(state: RecoveryPlacement["state"] = "active"): RecoveryPlacement {
  return {
    sessionId: "session-recovered",
    sessionKey: "agent:main:move-source",
    agentId: "main",
    state,
    generation: 1,
    updatedAtMs: 1,
    environmentId: state === "local" ? null : "environment-recovered",
    activeOwnerEpoch: state === "active" ? 1 : null,
    turnClaim: null,
  };
}

async function withRecoveryRuntime(
  options: {
    placement?: RecoveryPlacement;
    startup?: (placements: Map<string, RecoveryPlacement>) => Promise<void> | void;
    sweep?: (placements: Map<string, RecoveryPlacement>) => Promise<void> | void;
    evidence?: "current" | "absent";
    broadcast?: () => void;
    hasContext?: boolean;
    hasSubscribers?: boolean;
    environmentRows?: Map<string, WorkerEnvironmentPlacementFacts>;
  },
  verify: (runtime: {
    context: {
      broadcastToConnIds: ReturnType<typeof vi.fn>;
      chatAbortControllers: Map<never, never>;
      getRuntimeConfig: () => object;
      getSessionEventSubscriberConnIds: () => Set<string>;
    };
    changes: ReturnType<typeof vi.fn>;
    environments: { start: ReturnType<typeof vi.fn> };
    readChangeSnapshot: ReturnType<
      typeof vi.fn<(profileIds?: readonly string[]) => Promise<RecoveryPlacement[]>>
    >;
    placements: Map<string, RecoveryPlacement>;
    runtime: ReturnType<typeof createGatewayWorkerPlacementRuntime>;
    time: ReturnType<typeof createGatewaySchedulerClock>;
    start: () => Promise<void>;
    stop: () => Promise<void>;
    catalogChanged: (profileId: string) => void;
    warn: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const time = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(time.clock);
    runtimeMocks.publicationWarn.mockClear();
    runtimeMocks.destroyEnvironment.mockReset();
    const changes = vi.fn();
    const unsubscribeChanges = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && change.sessionKey === "agent:main:move-source") {
        changes(change);
      }
    });
    const placements = new Map<string, RecoveryPlacement>();
    if (options.placement) {
      placements.set(options.placement.sessionId, options.placement);
    }
    const context = {
      broadcastToConnIds: vi.fn(options.broadcast),
      chatAbortControllers: new Map<never, never>(),
      getRuntimeConfig: () => ({}),
      getSessionEventSubscriberConnIds: () =>
        new Set(options.hasSubscribers === false ? [] : ["session-observer"]),
    };
    runtimeMocks.createDiskSpace.mockReturnValue({
      read: vi.fn(),
      version: vi.fn(() => 0),
      sweep: vi.fn().mockResolvedValue(undefined),
    });
    runtimeMocks.createSessionEvidenceResolver.mockResolvedValue(
      async () => options.evidence ?? "current",
    );
    runtimeMocks.createDispatch.mockImplementation(() => ({
      dispatch: vi.fn(),
      forceDestroyEnvironment: runtimeMocks.destroyEnvironment,
      getEnvironmentAttachedSessionIds: () => [],
      readEnvironmentSessionIds: async (environmentId: string) =>
        [...placements.values()]
          .filter((placement) => placement.environmentId === environmentId)
          .map((placement) => placement.sessionId),
      reclaim: vi.fn(),
      reconcile: vi.fn(async () => await options.startup?.(placements)),
      reconcileActive: vi.fn(async () => await options.sweep?.(placements)),
    }));
    let onMachineShapeChanged: ((profileId: string) => void) | undefined;
    const environments = {
      get: (environmentId: string) =>
        options.environmentRows?.get(environmentId) ?? {
          environmentId,
          providerId: "fake",
          profileId: "development",
          ownerEpoch: 1,
        },
      readMachineShape: () => ({ cpu: 4 }),
      subscribeMachineShapeChanged: (listener: (profileId: string) => void) => {
        onMachineShapeChanged = listener;
        return () => {
          onMachineShapeChanged = undefined;
        };
      },
      installReconcileEnvironmentGuard: vi.fn(() => vi.fn()),
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const warn = vi.fn();
    const readChangeSnapshot = vi.fn(async (profileIds?: readonly string[]) =>
      structuredClone(
        [...placements.values()].filter(
          (placement) =>
            !profileIds || (profileIds.includes("development") && placement.activeOwnerEpoch === 1),
        ),
      ),
    );
    const runtime = createGatewayWorkerPlacementRuntime({
      scheduler,
      getCommittedRuntimeConfig: getRuntimeConfig,
      cancelSessionWork: vi.fn(async () => {}),
      placements: {
        workspaceResultInstanceId: () => "gateway-test",
        getAsync: async (sessionId: string) => placements.get(sessionId),
        listAsync: async () => [...placements.values()],
        readChangeSnapshot,
        readProjection: async (sessionIds: readonly string[]) => ({
          placements: new Map(
            sessionIds.flatMap((id) => {
              const placement = placements.get(id);
              return placement ? [[id, structuredClone(placement)]] : [];
            }),
          ),
          environments: options.environmentRows ?? new Map(),
        }),
        retireSessionPlacementAsync: async ({ sessionId }: { sessionId: string }) => {
          placements.delete(sessionId);
        },
        pruneOrphanedWorkspaceReconciliations: async () => [],
        listWorkspaceReconciliationOwners: async () => [],
        listPendingWorkspaceResultsAsync: async () => [],
      } as never,
      environments: environments as never,
      gatewayNamespace: "gateway-test",
      getSessionChangeContext: options.hasContext === false ? undefined : () => context,
      revokeSessionAuthority: vi.fn(),
      warn,
    });
    const sidecar = { current: null as Awaited<ReturnType<typeof runtime.startRuntime>> };

    try {
      await verify({
        context,
        changes,
        environments,
        readChangeSnapshot,
        placements,
        runtime,
        time,
        start: async () => {
          sidecar.current = await runtime.startRuntime({
            isClosePreludeStarted: () => false,
            registerSidecar: vi.fn(),
            unregisterSidecar: vi.fn(),
          });
          if (!sidecar.current) {
            throw new Error("worker placement runtime did not start");
          }
        },
        stop: async () => {
          await sidecar.current?.stop();
        },
        catalogChanged: (profileId) => onMachineShapeChanged?.(profileId),
        warn,
      });
    } finally {
      await sidecar.current?.stop();
      await flushPendingSessionsChangedEvents(context);
      unsubscribeChanges();
    }
  });
}

describe("worker placement recovery session events", () => {
  it("publishes only active device bindings affected by coalesced runner edges", async () => {
    const placement = recoveryPlacement();
    const environmentRows = new Map<string, WorkerEnvironmentPlacementFacts>();
    const environment = (row: RecoveryPlacement, deviceId: string) => {
      environmentRows.set(row.environmentId!, {
        environmentId: row.environmentId!,
        providerId: DEVICE_WORKER_PROVIDER_ID,
        profileId: `device:${deviceId}`,
        profileSnapshot: {},
        state: "attached",
        leaseId: "device-lease",
        ownerEpoch: 1,
        nodeDeviceId: deviceId,
        attachedSessionIds: [row.sessionId],
      });
    };
    environment(placement, "changed-device");
    await withRecoveryRuntime(
      { placement, environmentRows },
      async ({ context, changes, placements, runtime, start }) => {
        for (const excluded of ["other-device", "inactive", "stale-epoch", "cloud"] as const) {
          const row: RecoveryPlacement = {
            ...placement,
            sessionId: excluded,
            sessionKey: `agent:main:${excluded}`,
            environmentId: `environment-${excluded}`,
            ...(excluded === "inactive" ? { state: "failed" } : {}),
            ...(excluded === "stale-epoch" ? { activeOwnerEpoch: 2 } : {}),
          };
          placements.set(row.sessionId, row);
          environment(row, excluded === "other-device" ? "other-device" : "changed-device");
          if (excluded === "cloud") {
            environmentRows.get(row.environmentId!)!.providerId = "cloud";
          }
        }
        await start();
        const published = createDeferredCore();
        changes.mockImplementationOnce(() => published.resolve());
        const revision = runtime.runnerAvailability.version();
        runtime.runnerAvailability.markChanged("changed-device");
        runtime.runnerAvailability.markChanged("changed-device");
        expect(runtime.runnerAvailability.version()).toBe(revision + 2);
        await published.promise;
        await flushPendingSessionsChangedEvents(context);
        expect(context.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
          "sessions.changed",
          expect.objectContaining({
            reason: "placement",
            sessionKey: placement.sessionKey,
            sessionId: placement.sessionId,
          }),
          new Set(["session-observer"]),
          expect.objectContaining({ agentId: placement.agentId, dropIfSlow: true }),
        );
      },
    );
  });

  it("joins pending machine metadata reporting on stop without publishing a late reply", async () => {
    const placement = recoveryPlacement();
    await withRecoveryRuntime(
      { placement },
      async ({ changes, readChangeSnapshot, start, stop, catalogChanged }) => {
        await start();
        const initialVersion = changes.mock.calls.length;
        const reading = createDeferredCore();
        const reply = createDeferredCore<RecoveryPlacement[]>();
        readChangeSnapshot.mockImplementationOnce(() => {
          reading.resolve();
          return reply.promise;
        });
        catalogChanged("development");
        await reading.promise;
        catalogChanged("development");
        let stopped = false;
        const stopping = stop().then(() => {
          stopped = true;
        });
        try {
          await Promise.resolve();
          expect(stopped).toBe(false);
        } finally {
          reply.resolve([placement]);
        }
        await stopping;
        expect(changes.mock.calls.length).toBe(initialVersion);
      },
    );
  });

  it("reports a later catalog notification queued as the previous batch finishes", async () => {
    const placement = recoveryPlacement();
    await withRecoveryRuntime({ placement }, async ({ changes, start, catalogChanged }) => {
      await start();
      const published = createDeferredCore();
      let publications = 0;
      changes.mockImplementation(() => {
        if (++publications === 1) {
          queueMicrotask(() => catalogChanged("development"));
        } else {
          published.resolve();
        }
      });
      catalogChanged("development");
      await published.promise;
      expect(publications).toBe(2);
    });
  });

  it("refreshes correlated session observers when machine metadata arrives and unsubscribes on stop", async () => {
    const placement = recoveryPlacement();
    await withRecoveryRuntime(
      { placement },
      async ({ context, changes, placements, start, stop, catalogChanged }) => {
        placements.set("stale-session", {
          ...placement,
          sessionId: "stale-session",
          sessionKey: "agent:main:stale",
          activeOwnerEpoch: 2,
        });
        await start();
        const initialVersion = changes.mock.calls.length;
        catalogChanged("other-profile");
        expect(changes.mock.calls.length).toBe(initialVersion);
        const published = createDeferredCore();
        changes.mockImplementationOnce(() => published.resolve());
        catalogChanged("development");
        await published.promise;
        await flushPendingSessionsChangedEvents(context);
        expect(context.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
          "sessions.changed",
          expect.objectContaining({ reason: "placement", sessionKey: placement.sessionKey }),
          new Set(["session-observer"]),
          expect.objectContaining({ agentId: placement.agentId, dropIfSlow: true }),
        );
        expect(changes.mock.calls.length).toBe(initialVersion + 1);
        await stop();
        catalogChanged("development");
        expect(changes.mock.calls.length).toBe(initialVersion + 1);
      },
    );
  });

  it("publishes a recovered move once and ignores an unchanged periodic sweep", async () => {
    const recovered = recoveryPlacement("local");
    let sweepCount = 0;
    await withRecoveryRuntime(
      {
        sweep: (placements) => {
          sweepCount += 1;
          if (sweepCount === 2) {
            placements.set(recovered.sessionId, recovered);
          }
        },
      },
      async ({ context, changes, readChangeSnapshot, start, time }) => {
        const initialMutationVersion = changes.mock.calls.length;
        await start();
        await time.advanceBy(60_000);
        sweepCount = 0;
        readChangeSnapshot.mockClear();
        await time.advanceBy(60_000);
        expect(sweepCount).toBe(1);
        // Empty retirement and disabled auto-suspension need no reporting snapshots.
        expect(readChangeSnapshot).toHaveBeenCalledTimes(2);
        expect(context.broadcastToConnIds).not.toHaveBeenCalled();
        expect(changes.mock.calls.length).toBe(initialMutationVersion);

        await time.advanceBy(60_000);
        expect(sweepCount).toBe(2);
        await flushPendingSessionsChangedEvents(context);

        expect(context.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
          "sessions.changed",
          expect.objectContaining({
            reason: "placement",
            sessionKey: recovered.sessionKey,
            agentId: recovered.agentId,
          }),
          new Set(["session-observer"]),
          expect.objectContaining({ agentId: recovered.agentId, dropIfSlow: true }),
        );
        expect(changes.mock.calls.length).toBe(initialMutationVersion + 1);
        readChangeSnapshot.mockClear();
        await time.advanceBy(60_000);
        // Nonempty retirement reuses its scan as the before-snapshot, then reads once after.
        expect(readChangeSnapshot).toHaveBeenCalledTimes(3);
        expect(changes.mock.calls.length).toBe(initialMutationVersion + 1);
        expect(runtimeMocks.createDispatch.mock.lastCall?.[0]).not.toHaveProperty(
          "onRecoveredMoveTransition",
        );
      },
    );
  });

  it.each([
    "reconcile",
    "reconcileActive",
    "no context",
    "no subscribers",
    "operation failure",
    "before snapshot failure",
    "after snapshot failure",
    "broadcast failure",
  ] as const)(
    "preserves reconciliation outcomes and reports placement changes: %s",
    async (mode) => {
      const current = recoveryPlacement();
      const snapshotFailure =
        mode === "before snapshot failure" || mode === "after snapshot failure";
      const operationFails = snapshotFailure || mode === "operation failure";
      const transitionExisting =
        mode === "reconcile" || mode === "reconcileActive" || mode === "operation failure";
      const operationError = new Error("reconciliation failed");
      const transition = vi.fn((placements: Map<string, RecoveryPlacement>) => {
        if (mode !== "no context" && !snapshotFailure) {
          placements.set(
            current.sessionId,
            transitionExisting
              ? {
                  ...current,
                  state: "failed",
                  generation: current.generation + 1,
                  updatedAtMs: current.updatedAtMs + 1,
                }
              : current,
          );
        }
        if (operationFails) {
          throw operationError;
        }
      });
      await withRecoveryRuntime(
        {
          placement: transitionExisting ? current : undefined,
          hasContext: mode !== "no context",
          hasSubscribers: mode !== "no subscribers",
          broadcast:
            mode === "broadcast failure"
              ? () => {
                  throw new Error("session broadcast failed");
                }
              : undefined,
          ...(mode === "reconcile" ? { startup: transition } : { sweep: transition }),
        },
        async ({ context, changes, readChangeSnapshot, runtime, warn }) => {
          if (snapshotFailure) {
            if (mode === "after snapshot failure") {
              readChangeSnapshot.mockResolvedValueOnce([]);
            }
            readChangeSnapshot.mockRejectedValueOnce(new Error("snapshot worker failed"));
          }
          const operation =
            mode === "reconcile"
              ? runtime.dispatchService.reconcile("startup")
              : runtime.dispatchService.reconcileActive(
                  mode === "reconcileActive" ? "environment-recovered" : undefined,
                );
          if (operationFails) {
            await expect(operation).rejects.toBe(operationError);
          } else {
            await expect(operation).resolves.toBeUndefined();
          }
          expect(transition).toHaveBeenCalledOnce();
          if (snapshotFailure) {
            expect(warn).toHaveBeenCalledWith(
              "Worker placement session change reporting failed: snapshot worker failed",
            );
          } else if (mode === "no context") {
            expect(readChangeSnapshot).not.toHaveBeenCalled();
            expect(context.broadcastToConnIds).not.toHaveBeenCalled();
          } else if (mode === "no subscribers") {
            expect(changes).toHaveBeenCalledExactlyOnceWith({
              sessionKey: current.sessionKey,
              agentId: current.agentId,
            });
            expect(context.broadcastToConnIds).not.toHaveBeenCalled();
          } else {
            expect(context.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
              "sessions.changed",
              expect.objectContaining({ reason: "placement", sessionKey: current.sessionKey }),
              new Set(["session-observer"]),
              expect.objectContaining({ agentId: current.agentId }),
            );
            expect(changes.mock.calls.length).toBe(1);
            if (mode === "broadcast failure") {
              expect(runtimeMocks.publicationWarn).toHaveBeenCalledWith(
                "Session change publication failed",
                { error: expect.objectContaining({ message: "session broadcast failed" }) },
              );
            }
          }
        },
      );
    },
  );

  it("coalesces reconciliation reporting without fencing independent destruction", async () => {
    const snapshot = createDeferredCore<RecoveryPlacement[]>();
    const snapshotStarted = createDeferredCore();
    const operationStarted = createDeferredCore();
    const firstOperation = createDeferredCore();
    const started: string[] = [];
    await withRecoveryRuntime(
      {
        sweep: async () => {
          started.push("first");
          operationStarted.resolve();
          await firstOperation.promise;
        },
        startup: () => void started.push("second"),
      },
      async ({ readChangeSnapshot, runtime }) => {
        readChangeSnapshot.mockImplementationOnce(() => {
          snapshotStarted.resolve();
          return snapshot.promise;
        });
        const first = runtime.dispatchService.reconcileActive();
        const second = runtime.dispatchService.reconcile("startup");
        let destroy: Promise<unknown> | undefined;
        try {
          await snapshotStarted.promise;
          expect(readChangeSnapshot).toHaveBeenCalledOnce();
          expect(started).toEqual([]);
          destroy = runtime.dispatchService.forceDestroyEnvironment("environment-recovered");
          await destroy;
          expect(runtimeMocks.destroyEnvironment).toHaveBeenCalledOnce();
          snapshot.resolve([]);
          await operationStarted.promise;
          firstOperation.resolve();
          await Promise.all([first, second, destroy]);
          expect(started).toEqual(["first"]);
          expect(readChangeSnapshot).toHaveBeenCalledTimes(2);
          expect(runtimeMocks.destroyEnvironment).toHaveBeenCalledOnce();
        } finally {
          snapshot.resolve([]);
          firstOperation.resolve();
          await Promise.all([first, second, destroy]);
        }
      },
    );
  });

  it("publishes startup reconciliation before the runtime becomes ready", async () => {
    const recovered = recoveryPlacement();
    await withRecoveryRuntime(
      { startup: (placements) => void placements.set(recovered.sessionId, recovered) },
      async ({ context, environments, start }) => {
        context.broadcastToConnIds.mockImplementation(() => {
          expect(environments.start).not.toHaveBeenCalled();
        });

        await start();

        expect(context.broadcastToConnIds).toHaveBeenCalledOnce();
        expect(context.broadcastToConnIds.mock.calls[0]?.[1]).toMatchObject({
          reason: "placement",
          sessionKey: recovered.sessionKey,
        });
        expect(environments.start).toHaveBeenCalledOnce();
      },
    );
  });

  it("publishes session placement retirement after startup", async () => {
    const current = recoveryPlacement("local");
    await withRecoveryRuntime(
      { placement: current, evidence: "absent" },
      async ({ context, placements, start }) => {
        await start();
        await vi.dynamicImportSettled();

        expect(placements.has(current.sessionId)).toBe(false);
        expect(context.broadcastToConnIds).toHaveBeenCalledOnce();
        expect(context.broadcastToConnIds.mock.calls[0]?.[1]).toMatchObject({
          reason: "placement",
          sessionKey: current.sessionKey,
        });
      },
    );
  });
});
