import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createEmbeddedRunLaneController } from "../../agents/embedded-agent-runner/run/lane-controller.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { runFallbackAttempt } from "../../agents/model-fallback-attempt.js";
import {
  isAgentRunRestartAbortReason,
  resolveAgentRunErrorLifecycleFields,
} from "../../agents/run-termination.js";
import { installSessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import {
  type AgentEventPayload,
  getAgentEventLifecycleGeneration,
  onAgentEvent as subscribeAgentEvent,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
  retainQueuedAgentRunContext,
  sweepStaleRunContexts,
} from "../../infra/agent-run-registry.js";
import { getDiagnosticSessionActivitySnapshot } from "../../logging/diagnostic-run-activity.js";
import { setCommandLaneConcurrency } from "../../process/command-queue.js";
import { waitForSessionRunEnd } from "../../sessions/session-controller.native-runtime.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { STALE_WORKER_BUILD_REASON } from "./admission.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import {
  completeTurn,
  createLauncher,
  environmentForTunnel,
  expectUncalled,
  executeTurn,
  localResult,
  runIdentity,
} from "./worker-turn-launcher-flow.test-support.js";
import {
  createWorkerTurnTunnel,
  reconcileUnchangedLocalWorkspace,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  placements,
  root,
  seedActivePlacement,
  seedReclaimedPlacement,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  type WorkerTurnLauncherOptions,
} from "./worker-turn-launcher.test-support.js";

afterAll(closeStateDatabaseForTest);

function queuedWorkerRun(runId: string) {
  let lifecycleGeneration = getAgentEventLifecycleGeneration();
  const waiting = createDeferred();
  const onLaneWait = vi.fn<NonNullable<RunEmbeddedAgentParams["onLaneWait"]>>((wait) => {
    if (wait.waiting) {
      waiting.resolve();
    }
  });
  let params: RunEmbeddedAgentParams & { sessionFile: string } = {
    ...turn(runId),
    lifecycleGeneration,
    trigger: "user",
    onLaneWait,
  };
  const globalLane = `global:${runId}`;
  const controller = createEmbeddedRunLaneController({
    getLifecycleGeneration: () => lifecycleGeneration,
    getParams: () => params,
    globalLane,
    initialQueuedLifecycleGeneration: lifecycleGeneration,
    setLifecycleGeneration: (generation) => {
      lifecycleGeneration = generation;
    },
    setParams: (next) => {
      params = next;
    },
  });
  return {
    lifecycleGeneration,
    globalLane,
    onLaneWait,
    waiting: waiting.promise,
    get params() {
      return params;
    },
    enqueue: (run: () => Promise<{ meta: { durationMs: number } }>) =>
      controller.enqueueSession(() => controller.enqueueGlobal(run)),
  };
}

describe("worker turn launcher reclaimed placement", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(() => cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));

  it.each([
    ["agent id", { agentId: "other", sessionKey: SESSION_KEY }],
    ["session key", { agentId: "main", sessionKey: "agent:main:other" }],
    ["blank session key", { agentId: "main", sessionKey: " " }],
  ])("rejects a conflicting supplied %s before redispatch", async (_label, identity) => {
    await seedReclaimedPlacement();
    const redispatchPlacement = vi.fn(async () => {
      throw new Error("redispatch should not run");
    });
    const provider = createLauncher({ redispatchPlacement });

    await expect(
      provider.executeTurn(
        { sessionId: SESSION_ID, ...identity, runId: `run-reclaimed-conflict-${_label}` },
        turn(`run-reclaimed-conflict-${_label}`),
        vi.fn(),
      ),
    ).rejects.toThrow(/Worker turn (agent id|session key) (?:is required|does not match)/u);
    expect(redispatchPlacement).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "reclaimed", turnClaim: null });
  });

  it("redispatches a reclaimed placement before launching the worker turn", async () => {
    const reclaimed = await seedReclaimedPlacement();
    const runId = "run-reclaimed-worker";
    // Exercise the sweep's configurable age without advancing the operation watchdog.
    const contextTtlMs = 1;
    const registeredAt = Date.now();
    const admissionAt = registeredAt + contextTtlMs + 1;
    const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext(runId, {
      lifecycleGeneration,
      registeredAt,
      sessionKey: SESSION_KEY,
    });
    const releaseQueuedContext = retainQueuedAgentRunContext(runId, lifecycleGeneration);
    const redispatchEntered = createDeferred();
    const resumeRedispatch = createDeferred();
    const workerStarted = createDeferred();
    const resumeWorker = createDeferred();
    let redispatchCalls = 0;
    const redispatchPlacement: NonNullable<
      WorkerTurnLauncherOptions["redispatchPlacement"]
    > = async (placement) => {
      redispatchCalls += 1;
      expect(placement).toEqual(reclaimed);
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
      redispatchEntered.resolve();
      await resumeRedispatch.promise;
      await seedActivePlacement();
      const active = placements.get(SESSION_ID);
      if (active?.state !== "active") {
        throw new Error("expected active redispatched placement");
      }
      return active;
    };
    const launchTurn = vi.fn<WorkerTurnTunnelHandle["launchTurn"]>(async (request) => {
      request.onDispatchReady?.();
      workerStarted.resolve();
      await resumeWorker.promise;
      expect(placements.get(SESSION_ID)).toMatchObject({
        state: "active",
        turnClaim: { owner: "worker", runId },
      });
      return completeTurn(request, "Redispatched worker reply", 51);
    });
    const environments = environmentForTunnel({
      startTunnel: vi.fn(async () =>
        createWorkerTurnTunnel({
          launchTurn,
          reconcileWorkspace: vi.fn(reconcileUnchangedLocalWorkspace),
        }),
      ),
    });
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements,
      redispatchPlacement,
    });
    const runLocal = vi.fn(localResult);
    const onAdmitted = vi.fn(() => {
      expect(placements.get(SESSION_ID)).toMatchObject({
        state: "active",
        turnClaim: { owner: "worker", runId },
      });
      releaseQueuedContext?.("admitted");
    });
    const events: AgentEventPayload[] = [];
    const unsubscribe = subscribeAgentEvent((event) => events.push(event));
    const pending = provider.executeTurn(runIdentity(runId), turn(runId), runLocal, onAdmitted);
    const result = await (async () => {
      try {
        await redispatchEntered.promise;
        clock.mockReturnValue(admissionAt);
        expect(sweepStaleRunContexts(contextTtlMs)).toBe(0);
        expect(getAgentRunContext(runId)).toMatchObject({ lifecycleGeneration, registeredAt });
        expect(onAdmitted).not.toHaveBeenCalled();

        resumeRedispatch.resolve();
        await Promise.race([workerStarted.promise, pending]);
        expect(onAdmitted).toHaveBeenCalledOnce();
        expect(getAgentRunContext(runId)?.lastActiveAt).toBe(admissionAt);
        expect(runLocal).not.toHaveBeenCalled();

        clock.mockReturnValue(admissionAt + contextTtlMs + 1);
        expect(sweepStaleRunContexts(contextTtlMs)).toBe(0);
        expect(getAgentRunContext(runId)).toBeDefined();
        expect(placements.get(SESSION_ID)?.turnClaim).toMatchObject({ owner: "worker", runId });

        clock.mockReturnValue(admissionAt);
        resumeWorker.resolve();
        return await pending;
      } finally {
        resumeRedispatch.resolve();
        resumeWorker.resolve();
        await pending.catch(() => {});
        unsubscribe();
        releaseQueuedContext?.("abandoned");
        clearAgentRunContext(runId);
        clock.mockRestore();
      }
    })();

    expect(events).toContainEqual(
      expect.objectContaining({
        runId,
        stream: "run_status",
        sessionKey: SESSION_KEY,
        agentId: "main",
        data: { phase: "provisioning_environment" },
      }),
    );
    expect(result.payloads).toEqual([{ text: "Redispatched worker reply" }]);
    expect(redispatchCalls).toBe(1);
    expect(launchTurn).toHaveBeenCalledOnce();
    expect(runLocal).not.toHaveBeenCalled();
    await waitForSessionRunEnd(SESSION_ID, null);
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });

  it("rejects a rotated foreground run before an actual remote worker starts", async () => {
    await seedActivePlacement();
    const runId = "run-rotated-worker";
    const queued = queuedWorkerRun(runId);
    const { globalLane, waiting } = queued;
    const environments = unusedEnvironments();
    environments.get = vi.fn(() => attachedEnvironment());
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const uninstall = installSessionPlacementAdmissionProvider(provider);
    const local = vi.fn(localResult);
    // Global capacity is separate from the admitted per-session controller operation.
    setCommandLaneConcurrency(globalLane, 0);
    const pending = queued.enqueue(local);
    const outcome = expect(pending).rejects.toMatchObject({
      name: "AbortError",
      code: "OPENCLAW_RESTART_ABORT",
    });
    try {
      await waiting;
      rotateAgentEventLifecycleGeneration();
      setCommandLaneConcurrency(globalLane, 1);
      await outcome;
      expect(environments.startTunnel).not.toHaveBeenCalled();
      expect(local).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    } finally {
      setCommandLaneConcurrency(globalLane, 1);
      await Promise.allSettled([pending]);
      uninstall();
    }
  });

  it.each(["placement admission", "worker preparation"] as const)(
    "rejects an actual worker turn when its lifecycle rotates during %s",
    async (phase) => {
      await seedActivePlacement();
      const runId = "run-worker-rotated-during-admission";
      const registeredAt = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
      const queued = queuedWorkerRun(runId);
      const { lifecycleGeneration, onLaneWait } = queued;
      registerAgentRunContext(runId, {
        lifecycleGeneration,
        registeredAt,
        sessionKey: SESSION_KEY,
      });

      const workspaceResolutionStarted = createDeferred();
      const resumeWorkspaceResolution = createDeferred();
      const environments = unusedEnvironments();
      const claimTurn = placements.claimTurn.bind(placements);
      if (phase === "placement admission") {
        vi.spyOn(placements, "claimTurn").mockImplementation(async (...args) => {
          workspaceResolutionStarted.resolve();
          await resumeWorkspaceResolution.promise;
          return await claimTurn(...args);
        });
      }
      const provider = createWorkerSessionTurnPlacementProvider({
        environments,
        placements,
        resolveWorkspace: async () => {
          workspaceResolutionStarted.resolve();
          await resumeWorkspaceResolution.promise;
          return { kind: "local", path: root };
        },
      });
      const uninstallPlacement = installSessionPlacementAdmissionProvider(provider);
      const runLocal = vi.fn(localResult);
      const pending = queued.enqueue(runLocal);

      try {
        await workspaceResolutionStarted.promise;
        expect(placements.get(SESSION_ID)?.turnClaim?.runId).toBe(
          phase === "worker preparation" ? runId : undefined,
        );
        expect(onLaneWait.mock.calls).toEqual(
          phase === "worker preparation" ? [[{ waitMs: 0, queuedAhead: 0, waiting: false }]] : [],
        );
        clock.mockReturnValue(registeredAt + 30 * 60 * 1000 + 1);
        const replacementGeneration = rotateAgentEventLifecycleGeneration();
        expect(sweepStaleRunContexts()).toBe(1);
        registerAgentRunContext(runId, {
          lifecycleGeneration: replacementGeneration,
          registeredAt: Date.now(),
          sessionId: "replacement-session",
          sessionKey: "agent:main:replacement",
        });
        const replacementContext = getAgentRunContext(runId);

        if (phase === "placement admission") {
          resumeWorkspaceResolution.resolve();
        }
        const rejection = await pending.catch((error: unknown) => error);
        // The controller owns cancellation before placement admission and worker preparation.
        expect(isAgentRunRestartAbortReason(rejection)).toBe(true);
        expect(resolveAgentRunErrorLifecycleFields(rejection, queued.params.abortSignal)).toEqual({
          aborted: true,
          stopReason: "restart",
        });
        const attempts: Parameters<typeof runFallbackAttempt>[0]["attempts"] = [];
        await expect(
          runFallbackAttempt({
            run: async () => {
              throw rejection;
            },
            provider: "fixture-primary",
            model: "fixture-model",
            attempts,
            attempt: 1,
            total: 2,
          }),
        ).rejects.toBe(rejection);
        expect(attempts).toEqual([]);
        // The preparation read remains blocked until after exact claim settlement.
        expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
        resumeWorkspaceResolution.resolve();
        expect(
          getDiagnosticSessionActivitySnapshot({ sessionId: SESSION_ID }).activeWorkKind,
        ).toBeUndefined();
        expect(getAgentRunContext(runId)).toMatchObject({
          lifecycleGeneration: replacementGeneration,
          sessionId: "replacement-session",
          sessionKey: "agent:main:replacement",
        });
        expect(getAgentRunContext(runId)).toBe(replacementContext);
        if (phase === "placement admission") {
          expect(onLaneWait).not.toHaveBeenCalledWith(expect.objectContaining({ waiting: false }));
        } else {
          expect(onLaneWait.mock.calls).toEqual([[{ waitMs: 0, queuedAhead: 0, waiting: false }]]);
        }
        expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
        expectUncalled(environments.get, environments.startTunnel, runLocal);
      } finally {
        resumeWorkspaceResolution.resolve();
        uninstallPlacement();
        await pending.catch(() => {});
        clearAgentRunContext(runId);
        clock.mockRestore();
      }
    },
  );

  it.each(["requested", "failed"] as const)(
    "rejects %s placement without local fallback",
    async (state) => {
      await placements.startDispatch(runIdentity(`run-${state}`));
      if (state === "failed") {
        await placements.fail({
          sessionId: SESSION_ID,
          recoveryError: "stale terminal worker failure",
        });
        await placements.fail({ sessionId: SESSION_ID, recoveryError: STALE_WORKER_BUILD_REASON });
      }
      const provider = createLauncher();
      const runLocal = vi.fn(localResult);

      const run = executeTurn(provider, `run-${state}`, runLocal);
      await expect(run).rejects.toThrow();
      await expect(run).rejects.toMatchObject({
        message:
          state === "failed"
            ? `Worker turn rejected in placement failed: ${STALE_WORKER_BUILD_REASON}`
            : expect.stringContaining("Worker setup has no live dispatch owner."),
      });
      expect(runLocal).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
    },
  );
});
