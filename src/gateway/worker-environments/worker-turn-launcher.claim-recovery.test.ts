import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { resolveEmbeddedSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import { createEmbeddedRunLaneController } from "../../agents/embedded-agent-runner/run/lane-controller.js";
import { abortAndDrainEmbeddedAgentRun } from "../../agents/embedded-agent-runner/runs.js";
import {
  installSessionPlacementAdmissionProvider,
  withSessionPlacementTurnAdmission,
  withLocalSessionPlacementTurnSettlement,
  type SessionPlacementTurnParams,
} from "../../agents/session-placement-admission.js";
import { resolveSessionPlacementTurnSettlementAssertion } from "../../agents/session-placement-forced-terminal-settlement.js";
import {
  createReplyOperation,
  forceClearReplyOperation,
  waitForReplyRunSuccessorAdmission,
} from "../../auto-reply/reply/reply-run-registry.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { recoverStuckDiagnosticSession } from "../../logging/diagnostic-stuck-session-recovery.runtime.js";
import { getCommandLaneSnapshot } from "../../process/command-queue.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { WorkerNodeLostError } from "../../worker/worker-node-loss.js";
import type { WorkerSessionTurnClaim } from "./placement-store.js";
import {
  advancePlacementFixtureToActive,
  writePlacementEnvironmentFixture,
} from "./placement-test-fixtures.js";
import { canRedispatchFailedWorkerPlacement } from "./session-placement-lifecycle.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import { createWorkerPlacementRedispatch } from "./worker-placement-redispatch.js";
import {
  ENVIRONMENT_ID,
  appendWorkerReply,
  acknowledgeCompletedWorkerTurn,
  OWNER_EPOCH,
  MANIFEST_REF,
  attachedEnvironment,
  credential,
  root,
  seedActivePlacement,
  SESSION_ID,
  SESSION_KEY,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  createWorkerTurnTunnel,
  reconcileUnchangedLocalWorkspace,
  type WorkerTurnLauncherOptions,
  database,
  placements,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  workerTurnRequest,
  workerTurnEnvironments,
} from "./worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

afterAll(closeStateDatabaseForTest);
beforeEach(setupWorkerTurnLauncherTest);
afterEach(() => cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));

function createProvider(
  options: Partial<Parameters<typeof createWorkerSessionTurnPlacementProvider>[0]> = {},
) {
  return createWorkerSessionTurnPlacementProvider({
    environments: unusedEnvironments(),
    placements,
    ...options,
  });
}

const createOperation = () =>
  createReplyOperation({ sessionId: SESSION_ID, sessionKey: SESSION_KEY, resetTriggered: false });
const unexpectedLocalExecution = async () => {
  throw new Error("unexpected local execution");
};
const currentClaim = () => placements.get(SESSION_ID)?.turnClaim;
const pendingResults = () => placements.listPendingWorkspaceResultsAsync();
const expectSuccessorAdmission = async () =>
  expect(waitForReplyRunSuccessorAdmission(SESSION_KEY, null)).resolves.toMatchObject({
    settled: true,
  });

function enqueueWorker(params: SessionPlacementTurnParams, session = true) {
  const lane = createLane(params);
  const run = () => lane.enqueueGlobal(unexpectedLocalExecution);
  return session ? lane.enqueueSession(run) : run();
}

async function underRetiredParent(
  provider: ReturnType<typeof createProvider>,
  task: () => Promise<void>,
) {
  let assertParent: (() => void) | undefined;
  await provider.executeLocalTurn(
    {
      ...workerTurnRequest("parent-run"),
      sessionId: "parent-session",
      sessionKey: "agent:main:parent",
    },
    async () => {
      assertParent = resolveSessionPlacementTurnSettlementAssertion();
      await task();
    },
  );
  expect(assertParent).toBeTypeOf("function");
  expect(assertParent).toThrow("settlement is closed");
}

function createLane(initialParams: SessionPlacementTurnParams) {
  let params = initialParams;
  let generation = getAgentEventLifecycleGeneration();
  return createEmbeddedRunLaneController({
    getParams: () => params,
    setParams: (value) => {
      params = value;
    },
    getLifecycleGeneration: () => generation,
    setLifecycleGeneration: (value) => {
      generation = value;
    },
    initialQueuedLifecycleGeneration: generation,
    globalLane: "claim-recovery-global",
    sessionLane: resolveEmbeddedSessionLane(params.sessionKey ?? params.sessionId),
  });
}

describe("local claim recovery before backend registration", () => {
  it.each(["local", "standalone", "remote", "embedded", "CLI"] as const)(
    "admits a %s child after its inherited parent claim closes",
    async (execution) => {
      const provider = createProvider();
      const gate = createDeferred();
      const localTask = vi.fn(async () => {
        if (execution === "local") {
          expect(currentClaim()?.runId).toBe("child-run");
        }
        return { meta: { durationMs: 1 } };
      });
      const remoteTask = vi.fn<typeof provider.executeTurn>(
        async (_claim, _params, _runLocal, onAdmitted) => {
          onAdmitted?.();
          return { meta: { durationMs: 2 } };
        },
      );
      const queued = execution !== "embedded" && execution !== "CLI";
      let uninstall = queued ? installSessionPlacementAdmissionProvider(provider) : () => {};
      let child: Promise<unknown> | undefined;
      try {
        await underRetiredParent(provider, async () => {
          if (queued) {
            const lane = createLane(turn("child-run"));
            child = lane.enqueueSession(async () => {
              await gate.promise;
              lane.throwIfAborted();
              return lane.enqueueGlobal(localTask);
            });
          } else {
            child = gate.promise.then(() => {
              const params = turn("standalone-run");
              return execution === "CLI"
                ? withLocalSessionPlacementTurnSettlement(params, localTask)
                : withSessionPlacementTurnAdmission(params, params, localTask);
            });
          }
        });
        if (execution !== "local") {
          uninstall();
          uninstall = () => {};
        }
        if (execution === "remote") {
          uninstall = installSessionPlacementAdmissionProvider({
            assertCompactionSuccessorAllowed: () => {},
            executeLocalTurn: provider.executeLocalTurn,
            executeTurn: remoteTask,
          });
        }
        gate.resolve();
        await expect(child).resolves.toMatchObject({
          meta: { durationMs: execution === "remote" ? 2 : 1 },
        });
        expect([localTask.mock.calls.length, remoteTask.mock.calls.length]).toEqual(
          execution === "remote" ? [0, 1] : [1, 0],
        );
        expect((await placements.getAsync(SESSION_ID))?.turnClaim ?? null).toBeNull();
      } finally {
        gate.resolve();
        await Promise.allSettled([child]);
        uninstall();
      }
    },
  );

  it.each(["preflight", "attempt admission", "terminal result"])(
    "releases a force-cleared reply before backend registration and fences its late %s",
    async (stage) => {
      const provider = createProvider();
      const uninstall = installSessionPlacementAdmissionProvider(provider);
      const operation = createOperation();
      const params = { ...turn("run-preflight"), replyOperation: operation };
      const lane = createLane(params);
      const started = createDeferred();
      const resume = createDeferred();
      const replacementStarted = createDeferred();
      const finishReplacement = createDeferred();
      const modelStart = vi.fn();
      let oldRun: Promise<unknown> | undefined;
      let replacement: Promise<unknown> | undefined;
      try {
        oldRun = lane.enqueueGlobal(async () => {
          const admittedRunContext = await params.preparedRunAdmission.admit("embedded");
          started.resolve();
          await resume.promise;
          if (stage === "preflight") {
            lane.throwIfAborted();
          } else if (stage === "attempt admission") {
            lane.createAttemptControls({ admittedRunContext }).close();
          }
          modelStart();
          return { meta: { durationMs: 1 } };
        });
        // Observe rejection immediately so a failing assertion still cleans up the old turn.
        const oldOutcome = oldRun.then(
          () => undefined,
          (error: unknown) => error,
        );
        await started.promise;
        expect(currentClaim()).not.toBeNull();
        await expect(
          abortAndDrainEmbeddedAgentRun({
            sessionId: SESSION_ID,
            sessionKey: SESSION_KEY,
            settleMs: 100,
            forceClear: true,
            reason: "stuck_recovery",
          }),
        ).resolves.toMatchObject({ forceCleared: true });
        await expectSuccessorAdmission();
        expect(currentClaim()).toBeNull();

        replacement = provider.executeLocalTurn({ ...params, runId: "replacement" }, async () => {
          replacementStarted.resolve();
          await finishReplacement.promise;
        });
        await replacementStarted.promise;
        const replacementClaim = currentClaim()?.claimId;
        resume.resolve();
        expect(await oldOutcome).toMatchObject({
          message: "session placement turn settlement is closed",
        });
        expect(modelStart).toHaveBeenCalledTimes(stage === "terminal result" ? 1 : 0);
        expect(currentClaim()?.claimId).toBe(replacementClaim);
      } finally {
        resume.resolve();
        finishReplacement.resolve();
        await Promise.allSettled([oldRun, replacement]);
        operation.complete();
        params.preparedRunAdmission.close();
        uninstall();
      }
    },
  );

  it.each(["before", "during"])(
    "does not start local work for a reply cleared %s admission",
    async (timing) => {
      const provider = createProvider();
      const uninstall = installSessionPlacementAdmissionProvider(provider);
      const operation = createOperation();
      const params = { ...turn("run-cleared-before-admission"), replyOperation: operation };
      const run = vi.fn(async () => ({ meta: { durationMs: 1 } }));
      try {
        if (timing === "before") {
          forceClearReplyOperation(operation);
        }
        await expect(
          withSessionPlacementTurnAdmission(params, params, run, () => {
            if (timing === "during") {
              forceClearReplyOperation(operation);
            }
          }),
        ).rejects.toThrow("settlement is closed");
        expect(run).not.toHaveBeenCalled();
        expect(currentClaim()).toBeNull();
      } finally {
        operation.complete();
        uninstall();
      }
    },
  );
});

describe("worker pre-launch claim recovery", () => {
  it.each([
    "workspace resolution",
    "workspace queue",
    "execution-start publication",
    "workspace mutation",
    "dispatch",
    "uncertain dispatch",
    "pending result",
  ] as const)("recovers a warm second turn blocked in %s with exact custody", async (stage) => {
    await seedActivePlacement();
    const entered = createDeferred();
    const resume = createDeferred();
    const successorEntered = createDeferred();
    const finishSuccessor = createDeferred();
    const coordinator = createWorkerWorkspaceOperationCoordinator();
    const pauseAt = async (expected: typeof stage) => {
      if (blockSecond && stage === expected) {
        entered.resolve();
        await resume.promise;
      }
    };
    let blockSecond = false;
    let queuedBlocker: Promise<void> | undefined;
    const launch = vi.fn<WorkerTurnTunnelHandle["launchTurn"]>(async (request) => {
      request.onDispatchReady?.();
      if (blockSecond) {
        if (stage === "pending result") {
          await placements.markWorkspaceResultPending(request.turnClaim);
        }
        entered.resolve();
        await resume.promise;
        if (stage === "dispatch") {
          return {
            stdout: "",
            stderr: "",
            code: 1,
            signal: null,
            killed: true,
            termination: "exit",
          };
        }
        throw new AggregateError(
          [new Error("cancel receipt unavailable")],
          "node cancellation unconfirmed",
        );
      }
      const leafId = await appendWorkerReply("First turn complete", 41);
      const result = await acknowledgeCompletedWorkerTurn(request.turnClaim, leafId);
      await placements.markWorkspaceResultPending(request.turnClaim);
      return result;
    });
    let environment: ReturnType<typeof attachedEnvironment> = {
      ...attachedEnvironment(),
      nodeDeviceId: "worker-node",
      sshEndpoint: null,
    };
    const destroy = vi.fn(async () => {
      if (environment.leaseId === null) {
        throw new Error("expected leased worker environment");
      }
      environment = {
        ...environment,
        state: "destroyed" as const,
        attachedSessionIds: [],
        tunnelStatus: "stopped",
      };
      writePlacementEnvironmentFixture(database, environment);
      return environment;
    });
    const environments = {
      ...unusedEnvironments(),
      get: () => environment,
      acquireTurnCredential: vi.fn(async () => ({
        ...credential(),
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
      })),
      acknowledgeCredentialDelivery: async () => true,
      startTunnel: async () =>
        createWorkerTurnTunnel({
          environmentId: environment.environmentId,
          ownerEpoch: environment.ownerEpoch,
          syncWorkspace: vi.fn(),
          launchTurn: launch,
          reconcileWorkspace: reconcileUnchangedLocalWorkspace,
        }),
      destroy,
    };
    const redispatchPlacement = createWorkerPlacementRedispatch({
      placements,
      resolveDevicePlacementRequirement: async () => ({
        requiredNodeCommands: [],
        consumesWorkerSlot: true,
      }),
      dispatch: async (request, _onTransition, assertCurrent) => {
        assertCurrent?.();
        const recoveredEnvironmentId = `${ENVIRONMENT_ID}-recovered`;
        const recoveredOwnerEpoch = OWNER_EPOCH + 1;
        const recovered = await advancePlacementFixtureToActive(placements, database, request, {
          environmentId: recoveredEnvironmentId,
          ownerEpoch: recoveredOwnerEpoch,
          remoteWorkspaceDir: "/workspace/recovered",
          workspaceBaseManifestRef: MANIFEST_REF,
        });
        const recoveredEnvironment = attachedEnvironment();
        if (recoveredEnvironment.leaseId === null) {
          throw new Error("expected leased worker environment");
        }
        environment = {
          ...recoveredEnvironment,
          environmentId: recoveredEnvironmentId,
          ownerEpoch: recoveredOwnerEpoch,
          nodeDeviceId: "worker-node",
          leaseId: "lease-worker-turn-recovered",
          sshEndpoint: null,
        };
        writePlacementEnvironmentFixture(database, environment);
        return recovered;
      },
    });
    let workspaceCalls = 0;
    const provider = createProvider({
      environments,
      reconcileActivePlacement: async () => {},
      redispatchPlacement,
      resolveWorkspace: async () => {
        workspaceCalls++;
        if (workspaceCalls === 3 && blockSecond) {
          successorEntered.resolve();
          await finishSuccessor.promise;
          throw new Error("successor finished");
        }
        await pauseAt("workspace resolution");
        return { kind: "local", path: root };
      },
      workspaceOperations: {
        run(environmentId, task, ...options) {
          const result = coordinator.run(
            environmentId,
            async () => {
              if (blockSecond && stage === "workspace mutation") {
                await pauseAt("workspace mutation");
                // The entered writer still owns the exact claim after cancellation.
                expect(currentClaim()?.runId).toBe("blocked-second");
              }
              return await task();
            },
            ...options,
          );
          if (blockSecond && stage === "workspace queue") {
            entered.resolve();
          }
          return result;
        },
      },
    });
    const uninstall = installSessionPlacementAdmissionProvider(provider);
    const operation = createOperation();
    const first = turn("warm-first");
    const second = {
      ...turn("blocked-second"),
      timeoutMs: 48 * 60 * 60 * 1_000,
      replyOperation: operation,
      onExecutionStarted: () => pauseAt("execution-start publication"),
    };
    let blocked: Promise<unknown> | undefined;
    let successor: Promise<unknown> | undefined;
    let recovery: Promise<unknown> | undefined;
    try {
      await expect(enqueueWorker(first, false)).resolves.toMatchObject({
        payloads: [{ text: "First turn complete" }],
      });
      await placements.waitForTurnClaimRelease(SESSION_ID, {});
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
      expect(await pendingResults()).toEqual([]);
      blockSecond = true;
      if (stage === "workspace queue") {
        queuedBlocker = coordinator.run(ENVIRONMENT_ID, () => resume.promise);
      }
      blocked = enqueueWorker(second);
      const outcome = blocked.catch((error: unknown) => error);
      await entered.promise;
      const oldClaim = currentClaim();
      expect(oldClaim?.runId).toBe("blocked-second");
      expect(await pendingResults()).toHaveLength(stage === "pending result" ? 1 : 0);
      const dispatched =
        stage === "dispatch" || stage === "uncertain dispatch" || stage === "pending result";
      expect(launch).toHaveBeenCalledTimes(dispatched ? 2 : 1);
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 360_000);
      recovery = recoverStuckDiagnosticSession({
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        ageMs: 360_000,
        queueDepth: 1,
        allowActiveAbort: true,
        staleActiveProgressAbortMs: 360_000,
      });
      let recovered = false;
      void recovery.then(() => {
        recovered = true;
      });
      await vi.advanceTimersByTimeAsync(15_100);
      if (stage === "workspace mutation" || stage === "execution-start publication" || dispatched) {
        expect(recovered).toBe(false);
        expect(currentClaim()).toEqual(oldClaim);
        resume.resolve();
      }
      await expect(recovery).resolves.toMatchObject({
        status: "aborted",
        action: "abort_embedded_run",
      });
      vi.useRealTimers();
      if (stage === "uncertain dispatch") {
        const failed = placements.get(SESSION_ID);
        expect(failed).toMatchObject({
          state: "failed",
          turnClaim: null,
          environmentId: ENVIRONMENT_ID,
          activeOwnerEpoch: OWNER_EPOCH,
        });
        if (failed?.state !== "failed") {
          throw new Error("expected failed custody fence");
        }
        expect(canRedispatchFailedWorkerPlacement(failed, environment)).toBe(true);
        expect(environments.stopTunnel).toHaveBeenCalledOnce();
        expect(destroy).toHaveBeenCalledOnce();
        expect(launch).toHaveBeenCalledTimes(2);
        await expectSuccessorAdmission();
        blockSecond = false;
        const third = turn("successor-third");
        await expect(enqueueWorker(third)).resolves.toMatchObject({
          payloads: [{ text: "First turn complete" }],
        });
        await placements.waitForTurnClaimRelease(SESSION_ID, {});
        expect(placements.get(SESSION_ID)).toMatchObject({
          state: "active",
          environmentId: `${ENVIRONMENT_ID}-recovered`,
          activeOwnerEpoch: OWNER_EPOCH + 1,
          turnClaim: null,
        });
        expect(launch).toHaveBeenCalledTimes(3);
        third.preparedRunAdmission.close();
        return;
      }
      if (stage === "pending result") {
        expect(currentClaim()).toEqual(oldClaim);
        const pending = (await pendingResults())[0]!;
        expect(pending.claimId).toBe(oldClaim?.claimId);
        expect(pending.recoveryRequestedAtMs).not.toBeNull();
        expect(environments.destroy).not.toHaveBeenCalled();
        return;
      }
      // Read-only and queued gates remain closed; entered writes/dispatches had to join.
      expect(currentClaim()).toBeNull();
      await expectSuccessorAdmission();
      expect(getCommandLaneSnapshot(resolveEmbeddedSessionLane(SESSION_KEY)).activeCount).toBe(0);
      const third = turn("successor-third");
      successor = enqueueWorker(third);
      void successor.catch(() => {});
      await successorEntered.promise;
      const replacement = currentClaim();
      expect(replacement?.runId).toBe("successor-third");
      resume.resolve();
      expect(await outcome).toBeInstanceOf(Error);
      if (!dispatched) {
        expect(await outcome).toMatchObject({ name: "AbortError" });
      }
      expect(currentClaim()).toEqual(replacement);
      expect(launch).toHaveBeenCalledTimes(dispatched ? 2 : 1);
      expect(environments.destroy).not.toHaveBeenCalled();
      third.preparedRunAdmission.close();
    } finally {
      vi.useRealTimers();
      resume.resolve();
      finishSuccessor.resolve();
      await Promise.allSettled([blocked, successor, queuedBlocker, recovery]);
      operation.complete();
      first.preparedRunAdmission.close();
      second.preparedRunAdmission.close();
      uninstall();
    }
  });
});

describe("worker turn launcher node-loss continuation", () => {
  it.each([
    "reconnect",
    "partial persistence failed",
    "node never reconnects",
    "retained workspace and no reconnect",
  ] as const)("allows continuation only after a settled reconnect: %s", async (mode) => {
    await seedActivePlacement();
    const reconnects = mode === "reconnect";
    const runId = reconnects ? "node-loss-reconnect" : "node-loss-unavailable";
    const loss = new WorkerNodeLostError();
    const reconnect = createDeferred();
    const waiting = createDeferred();
    const order: string[] = [];
    let interruptedClaim: WorkerSessionTurnClaim | undefined;
    const launchTurn = vi.fn<WorkerTurnTunnelHandle["launchTurn"]>(async (request) => {
      interruptedClaim = request.turnClaim;
      request.onDispatchReady?.();
      if (!reconnects && mode !== "retained workspace and no reconnect") {
        await placements.markWorkspaceResultPending(request.turnClaim);
      }
      throw loss;
    });
    const waitForAdmissionNode = vi.fn<
      NonNullable<WorkerTurnLauncherOptions["waitForAdmissionNode"]>
    >(async ({ signal, assertCurrent }) => {
      if (!reconnects) {
        throw new Error("node admission expired");
      }
      expect(signal.aborted).toBe(false);
      expect(await pendingResults()).toMatchObject([
        { runId, recoveryRequestedAtMs: expect.any(Number) },
      ]);
      waiting.resolve();
      await reconnect.promise;
      assertCurrent();
      order.push("node reconnected");
    });
    const reconcileActivePlacement = vi.fn(async () => {
      if (reconnects) {
        expect(interruptedClaim).toBeDefined();
        await placements.acceptWorkspaceResult(interruptedClaim!);
        await placements.completeWorkspaceResultAndReleaseTurn(interruptedClaim!);
        order.push("workspace settled");
      }
    });
    const destroy = vi.fn(async () => attachedEnvironment());
    const nodeEnvironment = {
      ...attachedEnvironment(),
      nodeDeviceId: "paired-node",
      sshEndpoint: null,
    };
    const provider = createProvider({
      waitForAdmissionNode,
      reconcileActivePlacement,
      persistAbandonedPartial: async (claim) => {
        if (mode === "partial persistence failed") {
          throw new Error("transcript unavailable");
        }
        if (reconnects) {
          expect(claim.missingToolResultText).toBe(loss.message);
          order.push("transcript saved");
        }
      },
      environments: workerTurnEnvironments(
        createWorkerTurnTunnel({
          reconcileWorkspace: reconcileUnchangedLocalWorkspace,
          launchTurn,
        }),
        {
          get: reconnects ? () => nodeEnvironment : attachedEnvironment,
          ...(reconnects ? {} : { destroy }),
          acknowledgeCredentialDelivery: async () => true,
          stopTunnel: async () => {
            if (reconnects) {
              order.push("tunnel stopped");
            }
          },
        },
      ),
    });
    const runLocal = vi.fn();
    const attempt = provider.executeTurn(workerTurnRequest(runId), turn(runId), runLocal);
    const outcome = attempt.catch((error: unknown) => error);
    try {
      if (!reconnects) {
        await expect(attempt).rejects.toBe(loss);
        expect(loss.canContinue).toBe(false);
        expect(waitForAdmissionNode).toHaveBeenCalledTimes(
          mode === "partial persistence failed" ? 0 : 1,
        );
        expect(await pendingResults()).toHaveLength(1);
        expect(destroy).not.toHaveBeenCalled();
        if (mode === "retained workspace and no reconnect") {
          expect(placements.get(SESSION_ID)).toMatchObject({ state: "active" });
          expect(await pendingResults()).toMatchObject([
            { recoveryRequestedAtMs: expect.any(Number) },
          ]);
        }
      } else {
        await awaitGateBeforeSettlement(
          waiting.promise,
          outcome,
          "node loss settled before reconnect admission",
        );
        expect(loss.canContinue).toBe(false);
        expect(reconcileActivePlacement).not.toHaveBeenCalled();
        reconnect.resolve();
        expect(await outcome).toBe(loss);
        expect(loss.canContinue).toBe(true);
        expect(order).toEqual([
          "transcript saved",
          "tunnel stopped",
          "node reconnected",
          "workspace settled",
        ]);
        expect(runLocal).not.toHaveBeenCalled();
        expect(await pendingResults()).toEqual([]);
        expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
      }
      expect(launchTurn).toHaveBeenCalledOnce();
    } finally {
      reconnect.resolve();
      await outcome;
    }
  });
});
