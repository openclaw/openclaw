import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
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
import {
  expectUncalled,
  localResult,
  revocableTurn,
  remoteExecEnvironment,
  runIdentity,
} from "./worker-turn-launcher-flow.test-support.js";
import {
  ENVIRONMENT_ID,
  OWNER_EPOCH,
  SESSION_ID,
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
  type WorkerTurnEnvironmentService,
  type WorkerTurnLauncherOptions,
} from "./worker-turn-launcher.test-support.js";

afterAll(closeStateDatabaseForTest);

// Pause the real placement store/coordinator at the producer's published setup state.
async function setup(
  executionMode: "worker-turn" | "remote-exec",
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
            if (placement.state === "syncing") {
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
    finish,
    operation,
    waitForInitialPlacement: (...args: Parameters<typeof dispatch.waitForInitialPlacement>) => {
      waiting.resolve();
      return dispatch.waitForInitialPlacement(...args);
    },
    wait: (run: Promise<unknown>, signal: AbortSignal) =>
      withinTest(
        awaitGateBeforeSettlement(waiting.promise, run, "turn skipped the setup wait"),
        signal,
      ),
    settle: async (run: Promise<unknown>) => {
      finish.resolve();
      await Promise.allSettled([run, operation]);
    },
    fail: () => {
      failure = new Error("setup transfer failed");
    },
  };
}

// Exercise real remote-exec admission and settlement; only the remote transport is synthetic.
function readyEnvironment() {
  return remoteExecEnvironment(
    async (command) =>
      await runCommandWithTimeout([...command.argv], {
        cwd: root,
        input: command.input,
        timeoutMs: 5000,
      }),
  );
}

function startHeldTurn(
  fixture: Awaited<ReturnType<typeof setup>>,
  input: SessionPlacementTurnParams,
  options: {
    environments?: WorkerTurnEnvironmentService;
    throughAdmission?: boolean;
    onAdmitted?: () => void;
    resolveWorkspace?: WorkerTurnLauncherOptions["resolveWorkspace"];
  } = {},
) {
  const { environments = readyEnvironment(), throughAdmission, onAdmitted, ...overrides } = options;
  const runLocal = vi.fn(localResult);
  const provider = createWorkerSessionTurnPlacementProvider({
    environments,
    placements,
    waitForInitialPlacement: fixture.waitForInitialPlacement,
    ...overrides,
  });
  const uninstall = throughAdmission
    ? installSessionPlacementAdmissionProvider(provider)
    : () => {};
  const identity = runIdentity(input.runId);
  const run = throughAdmission
    ? withSessionPlacementTurnAdmission(identity, input, runLocal)
    : provider.executeTurn(identity, input, runLocal, onAdmitted);
  void run.catch(() => undefined);
  return {
    run,
    runLocal,
    environments,
    [Symbol.asyncDispose]: async () => {
      await fixture.settle(run);
      uninstall();
    },
  };
}

describe("initial worker setup admission", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(() => cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));

  it.for(["worker-turn", "remote-exec"] as const)(
    "holds %s input without agent IO until syncing becomes authoritative and active",
    async (mode, { signal }) => {
      const fixture = await setup(mode);
      const admitted = vi.fn();
      await using held = startHeldTurn(
        fixture,
        { ...turn("initial-input"), abortSignal: signal },
        {
          environments: mode === "worker-turn" ? unusedEnvironments() : readyEnvironment(),
          onAdmitted: admitted,
        },
      );
      const { run, runLocal, environments } = held;
      const settled = vi.fn();
      void run.then(settled, settled);
      await fixture.wait(run, signal);
      expectUncalled(settled, environments.get, runLocal, environments.startTunnel, admitted);
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
      fixture.finish.resolve();
      await fixture.operation;
      if (mode === "worker-turn") {
        await expect(run).rejects.toThrow("does not match its attached environment");
        expectUncalled(
          runLocal,
          environments.ensureRetainedRunning,
          environments.startTunnel,
          environments.acquireTurnCredential,
        );
        expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
      } else {
        await expect(run).resolves.toMatchObject({ meta: { durationMs: 1 } });
        expect(runLocal).toHaveBeenCalledOnce();
        expect(admitted).toHaveBeenCalledOnce();
        expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
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
    const fixture = await setup("remote-exec", async () => {
      const claim = await placements.claimTurn({
        ...sessionTarget,
        claimId: "setup-result-claim",
        runId: "setup-result-run",
        owner: { kind: "local", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
      });
      await placements.markWorkspaceResultPending(claim);
      await placements.clearLocalTurnClaimsAfterRestartAsync();
    });
    const claimTurn = vi.spyOn(placements, "claimTurn");
    await using held = startHeldTurn(
      fixture,
      { ...turn("waiting-input"), abortSignal: signal },
      { environments: unusedEnvironments() },
    );
    const { run, runLocal } = held;
    await fixture.wait(run, signal);
    fixture.finish.resolve();
    await fixture.operation;
    await expect(run).rejects.toThrow("Workspace recovery is still pending");
    expect(claimTurn.mock.calls.filter(([claim]) => claim.runId === "waiting-input")).toEqual([]);
    expect(runLocal).not.toHaveBeenCalled();
  });

  it.for(["failure", "abort", "incarnation", "writer", "runtime", "replacement"] as const)(
    "does not execute held input after %s",
    async (change, { signal }) => {
      const fixture = await setup(
        "remote-exec",
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
      const controller = new AbortController();
      await using held = startHeldTurn(
        fixture,
        { ...turn("obsolete-input"), abortSignal: AbortSignal.any([controller.signal, signal]) },
        { throughAdmission: true },
      );
      const { run, runLocal, environments } = held;
      await fixture.wait(run, signal);
      if (change === "failure") {
        fixture.fail();
      }
      if (change === "abort") {
        controller.abort(new Error("operator cancelled input"));
        await expect(run).rejects.toThrow(/aborted/);
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
      fixture.finish.resolve();
      await fixture.operation.catch(() => undefined);
      await expect(run).rejects.toThrow();
      expectUncalled(runLocal, environments.startTunnel);
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
    },
  );

  it.for(["source", "admitted"] as const)(
    "rejects %s authority revoked during setup before workspace IO",
    async (kind, { signal }) => {
      const fixture = await setup("remote-exec");
      const resolveWorkspace = vi.fn(async () => ({ kind: "local" as const, path: root }));
      using authority = await revocableTurn("revoked-input", kind, "test.setup-source");
      await using held = startHeldTurn(
        fixture,
        { ...authority.input, abortSignal: signal },
        { resolveWorkspace, throughAdmission: true },
      );
      const { run, runLocal, environments } = held;
      await fixture.wait(run, signal);
      authority.revoke();
      fixture.finish.resolve();
      await fixture.operation;
      await expect(run).rejects.toThrow(/authority/);
      expectUncalled(resolveWorkspace, environments.startTunnel, runLocal);
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
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
