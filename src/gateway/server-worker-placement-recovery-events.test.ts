import { describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const runtimeMocks = vi.hoisted(() => ({
  createDispatch: vi.fn(),
  createDiskSpace: vi.fn(),
  createSessionEvidenceResolver: vi.fn(),
}));

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

import {
  flushPendingSessionsChangedEvents,
  readSessionsMutationVersion,
} from "./server-methods/session-change-event.js";
import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";

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
  },
  verify: (runtime: {
    context: {
      broadcastToConnIds: ReturnType<typeof vi.fn>;
      chatAbortControllers: Map<never, never>;
      getRuntimeConfig: () => object;
      getSessionEventSubscriberConnIds: () => Set<string>;
    };
    environments: { start: ReturnType<typeof vi.fn> };
    listPlacements: ReturnType<typeof vi.fn>;
    placements: Map<string, RecoveryPlacement>;
    runtime: ReturnType<typeof createGatewayWorkerPlacementRuntime>;
    start: () => Promise<void>;
    stop: () => Promise<void>;
    catalogChanged: (profileId: string) => void;
    warn: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    vi.useFakeTimers();
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
      forceDestroyEnvironment: vi.fn(),
      reclaim: vi.fn(),
      reconcile: vi.fn(async () => await options.startup?.(placements)),
      reconcileActive: vi.fn(async () => await options.sweep?.(placements)),
    }));
    let onMachineShapeChanged: ((profileId: string) => void) | undefined;
    const environments = {
      get: (environmentId: string) => ({
        environmentId,
        providerId: "fake",
        profileId: "development",
        ownerEpoch: 1,
      }),
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
    const listPlacements = vi.fn(() => [...placements.values()]);
    const runtime = createGatewayWorkerPlacementRuntime({
      cancelSessionWork: vi.fn(async () => {}),
      placements: {
        workspaceResultInstanceId: () => "gateway-test",
        get: (sessionId: string) => placements.get(sessionId),
        list: listPlacements,
        retireSessionPlacement: ({ sessionId }: { sessionId: string }) => {
          placements.delete(sessionId);
        },
        pruneOrphanedWorkspaceReconciliations: () => [],
        listWorkspaceReconciliationOwners: () => [],
        listPendingWorkspaceResults: () => [],
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
        environments,
        listPlacements,
        placements,
        runtime,
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
      flushPendingSessionsChangedEvents(context);
      vi.useRealTimers();
    }
  });
}

describe("worker placement recovery session events", () => {
  it("refreshes correlated session observers when machine metadata arrives and unsubscribes on stop", async () => {
    const placement = recoveryPlacement();
    await withRecoveryRuntime(
      { placement },
      async ({ context, placements, start, stop, catalogChanged }) => {
        placements.set("stale-session", {
          ...placement,
          sessionId: "stale-session",
          sessionKey: "agent:main:stale",
          activeOwnerEpoch: 2,
        });
        await start();
        const initialVersion = readSessionsMutationVersion(context);
        catalogChanged("other-profile");
        expect(readSessionsMutationVersion(context)).toBe(initialVersion);
        catalogChanged("development");
        flushPendingSessionsChangedEvents(context);
        expect(context.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
          "sessions.changed",
          expect.objectContaining({ reason: "placement", sessionKey: placement.sessionKey }),
          new Set(["session-observer"]),
          expect.objectContaining({ agentId: placement.agentId, dropIfSlow: true }),
        );
        expect(readSessionsMutationVersion(context)).toBe(initialVersion + 1);
        await stop();
        catalogChanged("development");
        expect(readSessionsMutationVersion(context)).toBe(initialVersion + 1);
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
      async ({ context, start }) => {
        const initialMutationVersion = readSessionsMutationVersion(context);
        await start();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(context.broadcastToConnIds).not.toHaveBeenCalled();
        expect(readSessionsMutationVersion(context)).toBe(initialMutationVersion);

        await vi.advanceTimersByTimeAsync(60_000);

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
        expect(readSessionsMutationVersion(context)).toBe(initialMutationVersion + 1);
        expect(runtimeMocks.createDispatch.mock.lastCall?.[0]).not.toHaveProperty(
          "onRecoveredMoveTransition",
        );
      },
    );
  });

  it.each(["reconcile", "reconcileActive"] as const)(
    "publishes a non-move transition from externally requested %s",
    async (method) => {
      const current = recoveryPlacement();
      const transition = (placements: Map<string, RecoveryPlacement>) => {
        placements.set(current.sessionId, {
          ...current,
          state: "failed",
          generation: current.generation + 1,
          updatedAtMs: current.updatedAtMs + 1,
        });
      };
      await withRecoveryRuntime(
        {
          placement: current,
          ...(method === "reconcile" ? { startup: transition } : { sweep: transition }),
        },
        async ({ context, runtime }) => {
          if (method === "reconcile") {
            await runtime.dispatchService.reconcile("startup");
          } else {
            await runtime.dispatchService.reconcileActive("environment-recovered");
          }

          expect(context.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
            "sessions.changed",
            expect.objectContaining({ reason: "placement", sessionKey: current.sessionKey }),
            new Set(["session-observer"]),
            expect.objectContaining({ agentId: current.agentId }),
          );
          expect(readSessionsMutationVersion(context)).toBe(1);
        },
      );
    },
  );

  it("skips placement snapshots when the session change context is unavailable", async () => {
    const sweep = vi.fn();
    await withRecoveryRuntime(
      { sweep, hasContext: false },
      async ({ context, listPlacements, runtime }) => {
        await runtime.dispatchService.reconcileActive();

        expect(sweep).toHaveBeenCalledOnce();
        expect(listPlacements).not.toHaveBeenCalled();
        expect(context.broadcastToConnIds).not.toHaveBeenCalled();
      },
    );
  });

  it("advances the sessions list fence without connected subscribers", async () => {
    const recovered = recoveryPlacement();
    await withRecoveryRuntime(
      {
        hasSubscribers: false,
        sweep: (placements) => void placements.set(recovered.sessionId, recovered),
      },
      async ({ context, listPlacements, runtime }) => {
        await runtime.dispatchService.reconcileActive();

        expect(listPlacements).toHaveBeenCalledTimes(2);
        expect(readSessionsMutationVersion(context)).toBe(1);
        expect(context.broadcastToConnIds).not.toHaveBeenCalled();
      },
    );
  });

  it("publishes a committed transition without replacing a later reconciliation error", async () => {
    const current = recoveryPlacement();
    const reconcileError = new Error("reconciliation failed after committing placement");
    await withRecoveryRuntime(
      {
        placement: current,
        sweep: (placements) => {
          placements.set(current.sessionId, { ...current, state: "failed", generation: 2 });
          throw reconcileError;
        },
      },
      async ({ context, runtime }) => {
        await expect(runtime.dispatchService.reconcileActive()).rejects.toBe(reconcileError);
        expect(context.broadcastToConnIds).toHaveBeenCalledOnce();
        expect(readSessionsMutationVersion(context)).toBe(1);
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

  it("does not let broadcast reporting failures overturn reconciliation", async () => {
    const recovered = recoveryPlacement();
    await withRecoveryRuntime(
      {
        broadcast: () => {
          throw new Error("session broadcast failed");
        },
        sweep: (placements) => void placements.set(recovered.sessionId, recovered),
      },
      async ({ context, runtime, warn }) => {
        await expect(runtime.dispatchService.reconcileActive()).resolves.toBeUndefined();
        expect(context.broadcastToConnIds).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("session broadcast failed"));
      },
    );
  });
});
