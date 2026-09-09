import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeAdmittedRunDelegatedAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import {
  type SessionPlacementTurnParams,
  installSessionPlacementAdmissionProvider,
  withSessionPlacementTurnAdmission,
} from "../../agents/session-placement-admission.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
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
  createWorkerSessionTurnPlacementProvider,
  placements,
  root,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
} from "./worker-turn-launcher.test-support.js";

// Pause the real placement store/coordinator at the producer's published setup state.
async function setup(executionMode: "worker-turn" | "remote-exec", pauseAt = "syncing") {
  const paused = createDeferredCore();
  const finish = createDeferredCore();
  let failure: Error | undefined;
  const dispatch = coordinateWorkerPlacementDispatch(
    createCoordinatorTestService({
      dispatch: async (_request, report) => {
        let placement = placements.startDispatch({ ...sessionTarget, executionMode });
        const publish = async () => {
          report?.(placement);
          if (placement.state === pauseAt) {
            paused.resolve();
            await finish.promise;
            if (failure) {
              throw failure;
            }
          }
        };
        await publish();
        for (const step of [
          { to: "provisioning", patch: { environmentId: ENVIRONMENT_ID } },
          { to: "syncing", patch: { workerBundleHash: "a".repeat(64) } },
          {
            to: "starting",
            patch: {
              remoteWorkspaceDir: root,
              workspaceBaseManifestRef: MANIFEST_REF,
            },
          },
          { to: "active", patch: { activeOwnerEpoch: OWNER_EPOCH } },
        ] as const) {
          placement = placements.transition({
            sessionId: SESSION_ID,
            from: placement.state,
            expectedGeneration: placement.generation,
            ...step,
          });
          await publish();
        }
        if (placement.state !== "active") {
          throw new Error("fixture did not activate");
        }
        return placement;
      },
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
      request.source.journal.commit(MANIFEST_REF);
      return {
        manifestRef: MANIFEST_REF,
        changed: false,
        verifyStable: async () => {},
        verifyLocalStable: async () => {},
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
  afterEach(cleanupWorkerTurnLauncherTest);

  it.each(["worker-turn", "remote-exec"] as const)(
    "holds %s input during initial sync without agent IO, then claims the intended active placement",
    async (executionMode) => {
      const fixture = await setup(executionMode);
      const environments = unusedEnvironments();
      const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
      const provider = createWorkerSessionTurnPlacementProvider({
        environments,
        placements,
        waitForInitialPlacement: fixture.dispatch.waitForInitialPlacement,
      });
      let outcome = "held";
      const run = provider.executeTurn(
        { ...sessionTarget, runId: "initial-input" },
        turn("initial-input"),
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
        await setImmediate();
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

  it.each(["requested", "provisioning", "syncing", "starting"])(
    "executes once after %s becomes authoritative and active",
    async (phase) => {
      const fixture = await setup("remote-exec", phase);
      const environments = readyEnvironment();
      const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
      const admitted = vi.fn();
      const provider = createWorkerSessionTurnPlacementProvider({
        environments,
        placements,
        waitForInitialPlacement: fixture.dispatch.waitForInitialPlacement,
      });
      const run = provider.executeTurn(
        { ...sessionTarget, runId: "ready-input" },
        turn("ready-input"),
        runLocal,
        admitted,
      );
      void run.catch(() => undefined);
      try {
        await setImmediate();
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

  it.each([
    "failure",
    "abort",
    "incarnation",
    "writer",
    "runtime",
    "stop",
    "move",
    "replacement",
  ] as const)("does not execute held input after %s", async (change) => {
    const fixture = await setup("remote-exec");
    const environments = readyEnvironment();
    const controller = new AbortController();
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements,
      waitForInitialPlacement: fixture.dispatch.waitForInitialPlacement,
    });
    const uninstall = installSessionPlacementAdmissionProvider(provider);
    const run = withSessionPlacementTurnAdmission(
      { ...sessionTarget, runId: "obsolete-input" },
      { ...turn("obsolete-input"), abortSignal: controller.signal },
      runLocal,
    );
    void run.catch(() => undefined);
    let competing: Promise<unknown> | undefined;
    try {
      await setImmediate();
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
      if (change === "replacement") {
        // Replace live placement after the producer's completion, before its waiter resumes.
        void fixture.operation.then(() => {
          const current = placements.get(SESSION_ID)!;
          placements.transition({
            sessionId: SESSION_ID,
            expectedGeneration: current.generation,
            from: "active",
            to: "draining",
          });
        });
      }
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

  it.each(["source", "admitted"] as const)(
    "rejects %s authority revoked during setup before workspace IO",
    async (kind) => {
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
        preparedRunAdmission: admitted ? undefined : admission,
        admittedRunContext: admitted,
      };
      const uninstall = installSessionPlacementAdmissionProvider(
        createWorkerSessionTurnPlacementProvider({
          environments,
          placements,
          resolveWorkspace,
          waitForInitialPlacement: fixture.dispatch.waitForInitialPlacement,
        }),
      );
      const run = withSessionPlacementTurnAdmission(
        { ...sessionTarget, runId: base.runId },
        input,
        runLocal,
      );
      void run.catch(() => undefined);
      try {
        await setImmediate();
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
    const placement = placements.startDispatch(sessionTarget);
    const dispatch = coordinateWorkerPlacementDispatch(
      createCoordinatorTestService({}),
      (_request, run) => run(),
    );
    await expect(dispatch.waitForInitialPlacement(placement)).rejects.toThrow(
      "no matching live dispatch owner",
    );
  });
});
