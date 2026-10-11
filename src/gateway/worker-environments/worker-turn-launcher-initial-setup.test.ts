import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import {
  closeAdmittedRunDelegatedAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import {
  type SessionPlacementTurnParams,
  installSessionPlacementAdmissionProvider,
  resolveSessionPlacementRuntimeOverride,
  withSessionPlacementTurnAdmission,
} from "../../agents/session-placement-admission.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import { createCoordinatorTestService } from "./placement-dispatch-coordinator.test-support.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  ENVIRONMENT_ID,
  MANIFEST_REF,
  OWNER_EPOCH,
  SESSION_ID,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  database,
  dispatchInitialWorkerPlacement,
  createWorkerSessionTurnPlacementProvider,
  placements,
  root,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
} from "./worker-turn-launcher.test-support.js";

afterAll(closeStateDatabaseForTest);

// Pause the real placement store/coordinator at the producer's published setup state.
async function setup(
  executionMode: "worker-turn" | "remote-exec",
  pauseAt = "syncing",
  onActivated?: () => Promise<void>,
) {
  const paused = createDeferredCore();
  const finish = createDeferredCore();
  const waiting = createDeferredCore();
  let failure: Error | undefined;
  const dispatch = coordinateWorkerPlacementDispatch(
    createCoordinatorTestService({
      dispatch: async (_request, report) =>
        await dispatchInitialWorkerPlacement({
          database,
          placements,
          identity: { ...sessionTarget, executionMode },
          workspace: root,
          onTransition: async (placement) => {
            report?.(placement);
            if (placement.state === "active") {
              await onActivated?.();
            }
            if (placement.state === pauseAt) {
              paused.resolve();
              await finish.promise;
              if (failure) {
                throw failure;
              }
            }
          },
        }),
    }),
    (_request, run) => run(),
  );
  const operation = dispatch.dispatch({
    ...sessionTarget,
    executionMode,
    profileId: "development",
  });
  void operation.catch(() => undefined);
  await paused.promise;
  return {
    dispatch,
    finish,
    operation,
    waiting: waiting.promise,
    waitForInitialPlacement: (...args: Parameters<typeof dispatch.waitForInitialPlacement>) => {
      waiting.resolve();
      return dispatch.waitForInitialPlacement(...args);
    },
    fail: () => {
      failure = new Error("setup transfer failed");
    },
  };
}

// Exercise real remote-exec admission and settlement; only the remote transport is synthetic.
function readyEnvironment() {
  const tunnel: WorkerTunnelHandle = {
    environmentId: ENVIRONMENT_ID,
    ownerEpoch: OWNER_EPOCH,
    runWorkspaceCommand: async (command) =>
      await runCommandWithTimeout([...command.argv], {
        cwd: root,
        input: command.input,
        timeoutMs: 5000,
      }),
    quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
    reconcileWorkspace: async (request) => {
      if (request.source.kind !== "local") {
        throw new Error("expected local workspace");
      }
      await request.source.journal.commit(MANIFEST_REF);
      return {
        manifestRef: MANIFEST_REF,
        changed: false,
        verifyStable: async () => {},
        verifyLocalStable: async () => {},
        publishStagedResult: async () => {},
        discardPreparedStagedResult: async () => {},
      };
    },
    syncWorkspace: vi.fn(),
    stop: async () => {},
  };
  return {
    ...unusedEnvironments(),
    get: vi.fn(attachedEnvironment),
    startTunnel: vi.fn(async () => tunnel),
  };
}

describe("initial worker setup admission", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(() => cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));

  it.for(["worker-turn", "remote-exec"] as const)(
    "holds %s input during initial sync without agent IO, then claims the intended active placement",
    async (executionMode, { signal }) => {
      const fixture = await setup(executionMode);
      const environments = unusedEnvironments();
      const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
      const provider = createWorkerSessionTurnPlacementProvider({
        environments,
        placements,
        waitForInitialPlacement: fixture.waitForInitialPlacement,
      });
      let outcome = "held";
      const run = provider.executeTurn(
        { ...sessionTarget, runId: "initial-input" },
        { ...turn("initial-input"), abortSignal: signal },
        runLocal,
      );
      void run.then(
        () => {
          outcome = "completed";
        },
        () => {
          outcome = "rejected";
        },
      );
      try {
        await withinTest(
          awaitGateBeforeSettlement(fixture.waiting, run, "turn skipped the setup wait"),
          signal,
        );
        expect(outcome).toBe("held");
        expect(environments.get).not.toHaveBeenCalled();
        expect(runLocal).not.toHaveBeenCalled();
        expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
      } finally {
        fixture.finish.resolve();
        await fixture.operation;
        await run.catch(() => undefined);
      }
      await expect(run).rejects.toThrow("does not match its attached environment");
      expect(environments.get).toHaveBeenCalledOnce();
      expect(runLocal).not.toHaveBeenCalled();
    },
  );

  it.for(["requested", "provisioning", "syncing", "starting"])(
    "executes once after %s becomes authoritative and active",
    async (phase, { signal }) => {
      const fixture = await setup("remote-exec", phase);
      const environments = readyEnvironment();
      const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
      const admitted = vi.fn();
      const provider = createWorkerSessionTurnPlacementProvider({
        environments,
        placements,
        waitForInitialPlacement: fixture.waitForInitialPlacement,
      });
      const run = provider.executeTurn(
        { ...sessionTarget, runId: "ready-input" },
        { ...turn("ready-input"), abortSignal: signal },
        runLocal,
        admitted,
      );
      void run.catch(() => undefined);
      try {
        await withinTest(
          awaitGateBeforeSettlement(fixture.waiting, run, "turn skipped the setup wait"),
          signal,
        );
        expect(runLocal).not.toHaveBeenCalled();
        expect(environments.startTunnel).not.toHaveBeenCalled();
        expect(admitted).not.toHaveBeenCalled();
        fixture.finish.resolve();
        await fixture.operation;
        await expect(run).resolves.toMatchObject({ meta: { durationMs: 1 } });
        expect(runLocal).toHaveBeenCalledOnce();
        expect(admitted).toHaveBeenCalledOnce();
        expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
      } finally {
        fixture.finish.resolve();
        await Promise.allSettled([run, fixture.operation]);
      }
    },
  );

  it("keeps the worker runtime default when setup finishes during its read", async ({ signal }) => {
    const fixture = await setup("worker-turn");
    const reading = createDeferredCore();
    const resumeRead = createDeferredCore();
    const readProjection = placements.readProjection.bind(placements);
    const read = vi.spyOn(placements, "readProjection").mockImplementationOnce(async (...args) => {
      const projection = await readProjection(...args);
      reading.resolve();
      await resumeRead.promise;
      return projection;
    });
    const environments = unusedEnvironments();
    const uninstall = installSessionPlacementAdmissionProvider(
      createWorkerSessionTurnPlacementProvider({ environments, placements }),
    );
    const runtime = resolveSessionPlacementRuntimeOverride(sessionTarget);
    void runtime.catch(() => undefined);
    try {
      await withinTest(
        awaitGateBeforeSettlement(reading.promise, runtime, "runtime selection skipped its read"),
        signal,
      );
      fixture.finish.resolve();
      await fixture.operation;
      resumeRead.resolve();
      await expect(runtime).resolves.toBe("openclaw");
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
      expect(environments.startTunnel).not.toHaveBeenCalled();
    } finally {
      resumeRead.resolve();
      fixture.finish.resolve();
      await Promise.allSettled([runtime, fixture.operation]);
      uninstall();
      read.mockRestore();
    }
  });

  it("refreshes pending-result facts after waiting for initial setup", async ({ signal }) => {
    const fixture = await setup("remote-exec", "syncing", async () => {
      const claim = await placements.claimTurn({
        ...sessionTarget,
        claimId: "setup-result-claim",
        runId: "setup-result-run",
        owner: { kind: "local", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
      });
      await placements.markWorkspaceResultPending(claim);
      placements.clearLocalTurnClaimsAfterRestart();
    });
    const claimTurn = vi.spyOn(placements, "claimTurn");
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: unusedEnvironments(),
      placements,
      waitForInitialPlacement: fixture.waitForInitialPlacement,
    });
    const run = provider.executeTurn(
      { ...sessionTarget, runId: "waiting-input" },
      { ...turn("waiting-input"), abortSignal: signal },
      runLocal,
    );
    void run.catch(() => undefined);
    try {
      await withinTest(
        awaitGateBeforeSettlement(fixture.waiting, run, "turn skipped the setup wait"),
        signal,
      );
      fixture.finish.resolve();
      await fixture.operation;
      await expect(run).rejects.toThrow("Workspace recovery is still pending");
      expect(claimTurn.mock.calls.filter(([claim]) => claim.runId === "waiting-input")).toEqual([]);
      expect(runLocal).not.toHaveBeenCalled();
    } finally {
      fixture.finish.resolve();
      await Promise.allSettled([run, fixture.operation]);
    }
  });

  it.for([
    "failure",
    "abort",
    "incarnation",
    "writer",
    "runtime",
    "stop",
    "move",
    "replacement",
  ] as const)("does not execute held input after %s", async (change, { signal }) => {
    const fixture = await setup(
      "remote-exec",
      "syncing",
      change === "replacement"
        ? async () => {
            const current = placements.get(SESSION_ID)!;
            await placements.transition({
              sessionId: SESSION_ID,
              expectedGeneration: current.generation,
              from: "active",
              to: "draining",
            });
          }
        : undefined,
    );
    const environments = readyEnvironment();
    const controller = new AbortController();
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements,
      waitForInitialPlacement: fixture.waitForInitialPlacement,
    });
    const uninstall = installSessionPlacementAdmissionProvider(provider);
    const run = withSessionPlacementTurnAdmission(
      { ...sessionTarget, runId: "obsolete-input" },
      { ...turn("obsolete-input"), abortSignal: AbortSignal.any([controller.signal, signal]) },
      runLocal,
    );
    void run.catch(() => undefined);
    let competing: Promise<unknown> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(fixture.waiting, run, "turn skipped the setup wait"),
        signal,
      );
      if (change === "failure") {
        fixture.fail();
      }
      if (change === "abort") {
        controller.abort(new Error("operator cancelled input"));
      }
      if (change === "incarnation") {
        await patchSessionEntryCore(sessionTarget, () => ({ lifecycleRevision: "replacement" }));
      }
      if (change === "writer") {
        await patchSessionEntryCore(sessionTarget, () => ({ activeWriterRunId: "replacement" }));
      }
      if (change === "runtime") {
        rotateAgentEventLifecycleGeneration();
      }
      if (change === "stop") {
        competing = fixture.dispatch.reclaim(sessionTarget);
      }
      if (change === "move") {
        competing = fixture.dispatch.move({
          ...sessionTarget,
          source: { generation: 3, environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
          target: { kind: "gateway" },
        });
      }
      void competing?.catch(() => undefined);
      if (["abort", "stop", "move"].includes(change)) {
        await expect(run).rejects.toThrow(/aborted/);
      }
      fixture.finish.resolve();
      await Promise.allSettled([fixture.operation, competing]);
      await expect(run).rejects.toThrow();
      expect(runLocal).not.toHaveBeenCalled();
      expect(environments.startTunnel).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
    } finally {
      fixture.finish.resolve();
      await Promise.allSettled([run, fixture.operation, competing]);
      uninstall();
    }
  });

  it.for(["source", "admitted"] as const)(
    "rejects %s authority revoked during setup before workspace IO",
    async (kind, { signal }) => {
      const fixture = await setup("remote-exec");
      const environments = readyEnvironment();
      const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
      const resolveWorkspace = vi.fn(async () => ({ kind: "local" as const, path: root }));
      let sourceLive = true;
      const base = turn("revoked-input");
      const admission = prepareAgentRunAdmission({
        cfg: base.config,
        operationalRunInstance: createOperationalRunInstanceRef(base.runId),
        facts: {
          runId: base.runId,
          agentId: sessionTarget.agentId,
          ingress: { kind: "worker", boundary: "test.setup-source", state: "present" },
        },
        assertSourceCurrent: () => {
          if (!sourceLive) {
            throw new Error("source authority revoked");
          }
        },
      });
      const admitted = kind === "admitted" ? await admission.admit("embedded") : undefined;
      const input: SessionPlacementTurnParams = {
        ...base,
        abortSignal: signal,
        preparedRunAdmission: admitted ? undefined : admission,
        admittedRunContext: admitted,
      };
      const uninstall = installSessionPlacementAdmissionProvider(
        createWorkerSessionTurnPlacementProvider({
          environments,
          placements,
          resolveWorkspace,
          waitForInitialPlacement: fixture.waitForInitialPlacement,
        }),
      );
      const run = withSessionPlacementTurnAdmission(
        { ...sessionTarget, runId: base.runId },
        input,
        runLocal,
      );
      void run.catch(() => undefined);
      try {
        await withinTest(
          awaitGateBeforeSettlement(fixture.waiting, run, "turn skipped the setup wait"),
          signal,
        );
        if (admitted) {
          closeAdmittedRunDelegatedAuthority(admitted);
        } else {
          sourceLive = false;
        }
        fixture.finish.resolve();
        await fixture.operation;
        await expect(run).rejects.toThrow(/authority/);
        expect(resolveWorkspace).not.toHaveBeenCalled();
        expect(environments.startTunnel).not.toHaveBeenCalled();
        expect(runLocal).not.toHaveBeenCalled();
        expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
      } finally {
        fixture.finish.resolve();
        await Promise.allSettled([run, fixture.operation]);
        admission.close();
        uninstall();
      }
    },
  );

  it("rejects orphan setup instead of waiting indefinitely or running locally", async () => {
    const placement = await placements.startDispatch(sessionTarget);
    const dispatch = coordinateWorkerPlacementDispatch(
      createCoordinatorTestService({}),
      (_request, run) => run(),
    );
    await expect(dispatch.waitForInitialPlacement(placement)).rejects.toThrow(
      "no matching live dispatch owner",
    );
  });
});
