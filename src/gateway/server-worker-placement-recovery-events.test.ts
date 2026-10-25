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
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";
import {
  createEnvironments,
  createIdleDiskSpace,
  createRuntimeFactory,
  placementAsyncDefaults,
  startRuntime,
} from "./server-worker-placement.test-support.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./worker-environments/device-provider-identity.js";
import type { WorkerEnvironmentPlacementFacts } from "./worker-environments/placement-read-projection.types.js";

const createRuntime = createRuntimeFactory(createGatewayWorkerPlacementRuntime, getRuntimeConfig);
type RecoveryPlacement = ReturnType<typeof recoveryPlacement>;

function recoveryPlacement(state: "active" | "failed" | "local" | "reclaimed" = "active") {
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

type PlacementChangeIdentity = Pick<RecoveryPlacement, "sessionId" | "sessionKey" | "agentId">;
type PublishPlacementChange = (placement: PlacementChangeIdentity) => void;
type PlacementTransition = (
  placements: Map<string, RecoveryPlacement>,
  publishChange: PublishPlacementChange,
) => Promise<void> | void;

function createRecoveryRuntime(options: {
  placement?: RecoveryPlacement;
  startup?: PlacementTransition;
  sweep?: PlacementTransition;
  evidence?: "current" | "absent";
  broadcast?: GatewayBroadcastToConnIdsFn;
  hasContext?: boolean;
  hasSubscribers?: boolean;
  environmentRows?: Map<string, WorkerEnvironmentPlacementFacts>;
}) {
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
  const placementChangeListeners = new Set<PublishPlacementChange>();
  const publishPlacementChange: PublishPlacementChange = (placement) => {
    for (const listener of placementChangeListeners) {
      listener(placement);
    }
  };
  if (options.placement) {
    placements.set(options.placement.sessionId, options.placement);
  }
  const context = {
    broadcastToConnIds: vi.fn(options.broadcast),
    getRuntimeConfig: () => ({}),
    getSessionEventSubscriberConnIds: () =>
      new Set(options.hasSubscribers === false ? [] : ["session-observer"]),
  };
  runtimeMocks.createDiskSpace.mockReturnValue(createIdleDiskSpace());
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
    reconcile: vi.fn(async () => await options.startup?.(placements, publishPlacementChange)),
    reconcileActive: vi.fn(async () => await options.sweep?.(placements, publishPlacementChange)),
  }));
  const environments = {
    ...createEnvironments(),
    get: (environmentId: string) =>
      options.environmentRows?.get(environmentId) ?? {
        environmentId,
        providerId: "fake",
        profileId: "development",
        ownerEpoch: 1,
      },
    readMachineShape: () => ({ cpu: 4 }),
  };
  const readChangeSnapshot = vi.fn(async (profileIds?: readonly string[]) =>
    structuredClone(
      [...placements.values()].filter(
        (placement) =>
          !profileIds || (profileIds.includes("development") && placement.activeOwnerEpoch === 1),
      ),
    ),
  );
  const runtime = createRuntime({
    scheduler,
    placements: {
      ...placementAsyncDefaults(() => [...placements.values()]),
      readChangeSnapshot,
      subscribeChanges: (listener: PublishPlacementChange) => {
        placementChangeListeners.add(listener);
        return () => placementChangeListeners.delete(listener);
      },
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
        const placement = placements.get(sessionId);
        if (placement) {
          placements.delete(sessionId);
          publishPlacementChange(placement);
        }
      },
    } as never,
    environments: environments as never,
    getSessionChangeContext: options.hasContext === false ? undefined : () => context,
  });
  const sidecar = { current: null as Awaited<ReturnType<typeof runtime.startRuntime>> };

  return {
    context,
    changes,
    environments,
    readChangeSnapshot,
    placements,
    runtime,
    time,
    start: async () => {
      sidecar.current = await startRuntime(runtime);
      if (!sidecar.current) {
        throw new Error("worker placement runtime did not start");
      }
    },
    stop: async () => await sidecar.current?.stop(),
    catalogChanged: (profileId: string) =>
      environments.machineShapeNotifications.onChanged(profileId),
    expectBroadcast: (payload: object, delivery: object = { dropIfSlow: true }) => {
      expect(context.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
        "sessions.changed",
        expect.objectContaining({ reason: "placement", ...payload }),
        new Set(["session-observer"]),
        expect.objectContaining({ agentId: "main", ...delivery }),
      );
    },
    nextChange: () => {
      const changed = createDeferredCore();
      changes.mockImplementationOnce(() => changed.resolve());
      return changed.promise;
    },
    dispose: async () => {
      await sidecar.current?.stop();
      await flushPendingSessionsChangedEvents(context);
      unsubscribeChanges();
    },
  };
}

async function withRecoveryRuntime(
  options: Parameters<typeof createRecoveryRuntime>[0],
  verify: (runtime: ReturnType<typeof createRecoveryRuntime>) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const runtime = createRecoveryRuntime(options);
    try {
      await verify(runtime);
    } finally {
      await runtime.dispose();
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
      async ({ context, placements, runtime, start, expectBroadcast, nextChange }) => {
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
        const published = nextChange();
        const revision = runtime.runnerAvailability.version();
        runtime.runnerAvailability.markChanged("changed-device");
        runtime.runnerAvailability.markChanged("changed-device");
        expect(runtime.runnerAvailability.version()).toBe(revision + 2);
        await published;
        await flushPendingSessionsChangedEvents(context);
        expectBroadcast({ sessionKey: placement.sessionKey, sessionId: placement.sessionId });
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

  it("publishes a recovered move once and ignores an unchanged periodic sweep", async () => {
    const recovered = recoveryPlacement("local");
    let sweepCount = 0;
    await withRecoveryRuntime(
      {
        sweep: (placements, publishChange) => {
          sweepCount += 1;
          if (sweepCount === 2) {
            placements.set(recovered.sessionId, recovered);
            publishChange(recovered);
          }
        },
      },
      async ({ context, changes, start, time, expectBroadcast }) => {
        const initialMutationVersion = changes.mock.calls.length;
        await start();
        await time.advanceBy(60_000);
        sweepCount = 0;
        await time.advanceBy(60_000);
        expect(sweepCount).toBe(1);
        expect(context.broadcastToConnIds).not.toHaveBeenCalled();
        expect(changes.mock.calls.length).toBe(initialMutationVersion);

        await time.advanceBy(60_000);
        expect(sweepCount).toBe(2);
        await flushPendingSessionsChangedEvents(context);

        expectBroadcast({ sessionKey: recovered.sessionKey, agentId: recovered.agentId });
        expect(changes.mock.calls.length).toBe(initialMutationVersion + 1);
        await time.advanceBy(60_000);
        expect(changes.mock.calls.length).toBe(initialMutationVersion + 1);
      },
    );
  });

  it.each([
    "reconcile",
    "reconcileActive",
    "no context",
    "no subscribers",
    "operation failure",
    "broadcast failure",
  ] as const)(
    "preserves reconciliation outcomes and reports placement changes: %s",
    async (mode) => {
      const current = recoveryPlacement();
      const operationFails = mode === "operation failure";
      const transitionExisting =
        mode === "reconcile" || mode === "reconcileActive" || mode === "operation failure";
      const operationError = new Error("reconciliation failed");
      const transition = vi.fn<PlacementTransition>((placements, publishChange) => {
        const committed = transitionExisting
          ? {
              ...current,
              state: "failed" as const,
              generation: current.generation + 1,
              updatedAtMs: current.updatedAtMs + 1,
            }
          : current;
        placements.set(current.sessionId, committed);
        publishChange(committed);
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
        async ({ context, changes, runtime, expectBroadcast }) => {
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
          if (mode === "no context") {
            expect(context.broadcastToConnIds).not.toHaveBeenCalled();
          } else if (mode === "no subscribers") {
            expect(changes).toHaveBeenCalledExactlyOnceWith({
              sessionKey: current.sessionKey,
              agentId: current.agentId,
            });
            expect(context.broadcastToConnIds).not.toHaveBeenCalled();
          } else {
            expectBroadcast({ sessionKey: current.sessionKey }, {});
            expect(changes.mock.calls.length).toBe(1);
            if (mode === "broadcast failure") {
              expect(runtimeMocks.publicationWarn).toHaveBeenCalledWith(
                "Session change publication failed",
                { error: "session broadcast failed" },
              );
            }
          }
        },
      );
    },
  );

  it("coalesces reconciliation reporting without fencing independent destruction", async () => {
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
      async ({ runtime }) => {
        const first = runtime.dispatchService.reconcileActive();
        const second = runtime.dispatchService.reconcile("startup");
        let destroy: Promise<unknown> | undefined;
        try {
          await operationStarted.promise;
          expect(started).toEqual(["first"]);
          destroy = runtime.dispatchService.forceDestroyEnvironment("environment-recovered");
          await destroy;
          expect(runtimeMocks.destroyEnvironment).toHaveBeenCalledOnce();
          firstOperation.resolve();
          await Promise.all([first, second, destroy]);
          expect(started).toEqual(["first"]);
          expect(runtimeMocks.destroyEnvironment).toHaveBeenCalledOnce();
        } finally {
          firstOperation.resolve();
          await Promise.all([first, second, destroy]);
        }
      },
    );
  });

  it("publishes startup reconciliation before the runtime becomes ready", async () => {
    const recovered = recoveryPlacement();
    await withRecoveryRuntime(
      {
        startup: (placements, publishChange) => {
          placements.set(recovered.sessionId, recovered);
          publishChange(recovered);
        },
      },
      async ({ context, environments, start, expectBroadcast }) => {
        context.broadcastToConnIds.mockImplementation(() => {
          expect(environments.start).not.toHaveBeenCalled();
        });

        await start();

        expectBroadcast({ sessionKey: recovered.sessionKey }, {});
        expect(environments.start).toHaveBeenCalledOnce();
      },
    );
  });

  it("publishes session placement retirement after startup", async () => {
    const current = recoveryPlacement("local");
    await withRecoveryRuntime(
      { placement: current, evidence: "absent" },
      async ({ placements, start, expectBroadcast }) => {
        await start();
        await vi.dynamicImportSettled();

        expect(placements.has(current.sessionId)).toBe(false);
        expectBroadcast({ sessionKey: current.sessionKey }, {});
      },
    );
  });
});
