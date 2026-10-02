import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  createReplyOperation,
  forceClearReplyOperation,
  waitForReplyRunSuccessorAdmission,
} from "../../auto-reply/reply/reply-run-registry.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { recoverStuckDiagnosticSession } from "../../logging/diagnostic-stuck-session-recovery.runtime.js";
import { getCommandLaneSnapshot } from "../../process/command-queue.js";
import {
  advancePlacementFixtureToActive,
  writePlacementEnvironmentFixture,
} from "./placement-test-fixtures.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { canRedispatchFailedWorkerPlacement } from "./session-placement-lifecycle.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import * as workerGitHubBinding from "./worker-github-binding.js";
import { createWorkerPlacementRedispatch } from "./worker-placement-redispatch.js";
import {
  ENVIRONMENT_ID,
  OWNER_EPOCH,
  MANIFEST_REF,
  attachedEnvironment,
  credential,
  measureLaunchTurn,
  readLaunchToolNames,
  openSessionManager,
  root,
  seedActivePlacement,
  SESSION_ID,
  SESSION_KEY,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  database,
  placements,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
} from "./worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

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
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it.each(["local", "standalone", "remote"] as const)(
    "admits a queued %s child after its inherited parent claim closes",
    async (execution) => {
      const provider = createWorkerSessionTurnPlacementProvider({
        environments: unusedEnvironments(),
        placements,
      });
      const gate = createDeferred();
      const localTask = vi.fn(async () => {
        if (execution === "local") {
          expect(placements.get(SESSION_ID)?.turnClaim?.runId).toBe("child-run");
        }
        return { meta: { durationMs: 1 } };
      });
      const remoteTask = vi.fn<typeof provider.executeTurn>(
        async (_claim, _params, _runLocal, onAdmitted) => {
          onAdmitted?.();
          return { meta: { durationMs: 2 } };
        },
      );
      let uninstall = installSessionPlacementAdmissionProvider(provider);
      let child: Promise<unknown> | undefined;
      let assertParent: (() => void) | undefined;
      try {
        await provider.executeLocalTurn(
          {
            sessionId: "parent-session",
            sessionKey: "agent:main:parent",
            agentId: "main",
            runId: "parent-run",
          },
          async () => {
            assertParent = resolveSessionPlacementTurnSettlementAssertion();
            const lane = createLane(turn("child-run"));
            child = lane.enqueueSession(async () => {
              await gate.promise;
              lane.throwIfAborted();
              return lane.enqueueGlobal(localTask);
            });
          },
        );
        expect(assertParent).toBeTypeOf("function");
        expect(assertParent).toThrow("settlement is closed");
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
        expect(localTask).toHaveBeenCalledTimes(execution === "remote" ? 0 : 1);
        expect(remoteTask).toHaveBeenCalledTimes(execution === "remote" ? 1 : 0);
        expect(placements.get(SESSION_ID)?.turnClaim ?? null).toBeNull();
      } finally {
        gate.resolve();
        await Promise.allSettled([child]);
        uninstall();
      }
    },
  );

  it.each(["embedded", "CLI"] as const)(
    "isolates standalone %s admission from a retired parent settlement",
    async (execution) => {
      const provider = createWorkerSessionTurnPlacementProvider({
        environments: unusedEnvironments(),
        placements,
      });
      const gate = createDeferred();
      const task = vi.fn(async () => ({ meta: { durationMs: 1 } }));
      let child: Promise<unknown> | undefined;
      let assertParent: (() => void) | undefined;
      await provider.executeLocalTurn(
        {
          sessionId: "parent-session",
          sessionKey: "agent:main:parent",
          agentId: "main",
          runId: "parent-run",
        },
        async () => {
          assertParent = resolveSessionPlacementTurnSettlementAssertion();
          child = gate.promise.then(() => {
            const params = turn("standalone-run");
            return execution === "CLI"
              ? withLocalSessionPlacementTurnSettlement(params, task)
              : withSessionPlacementTurnAdmission(params, params, task);
          });
        },
      );
      try {
        expect(assertParent).toThrow("settlement is closed");
        gate.resolve();
        await expect(child).resolves.toMatchObject({ meta: { durationMs: 1 } });
        expect(task).toHaveBeenCalledOnce();
      } finally {
        gate.resolve();
        await Promise.allSettled([child]);
      }
    },
  );

  it.each(["preflight", "attempt admission", "terminal result"])(
    "releases a force-cleared reply before backend registration and fences its late %s",
    async (stage) => {
      const provider = createWorkerSessionTurnPlacementProvider({
        environments: unusedEnvironments(),
        placements,
      });
      const uninstall = installSessionPlacementAdmissionProvider(provider);
      const operation = createReplyOperation({
        sessionKey: SESSION_KEY,
        sessionId: SESSION_ID,
        resetTriggered: false,
      });
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
        expect(placements.get(SESSION_ID)?.turnClaim).not.toBeNull();
        await expect(
          abortAndDrainEmbeddedAgentRun({
            sessionId: SESSION_ID,
            sessionKey: SESSION_KEY,
            settleMs: 100,
            forceClear: true,
            reason: "stuck_recovery",
          }),
        ).resolves.toMatchObject({ forceCleared: true });
        await expect(waitForReplyRunSuccessorAdmission(SESSION_KEY, null)).resolves.toMatchObject({
          settled: true,
        });
        expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();

        replacement = provider.executeLocalTurn({ ...params, runId: "replacement" }, async () => {
          replacementStarted.resolve();
          await finishReplacement.promise;
        });
        await replacementStarted.promise;
        const replacementClaim = placements.get(SESSION_ID)?.turnClaim?.claimId;
        resume.resolve();
        expect(await oldOutcome).toMatchObject({
          message: "session placement turn settlement is closed",
        });
        expect(modelStart).toHaveBeenCalledTimes(stage === "terminal result" ? 1 : 0);
        expect(placements.get(SESSION_ID)?.turnClaim?.claimId).toBe(replacementClaim);
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
      const provider = createWorkerSessionTurnPlacementProvider({
        environments: unusedEnvironments(),
        placements,
      });
      const uninstall = installSessionPlacementAdmissionProvider(provider);
      const operation = createReplyOperation({
        sessionKey: SESSION_KEY,
        sessionId: SESSION_ID,
        resetTriggered: false,
      });
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
        expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
      } finally {
        operation.complete();
        uninstall();
      }
    },
  );
});

describe("worker pre-launch claim recovery", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it.each([
    "workspace resolution",
    "workspace queue",
    "GitHub binding",
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
    let blockSecond = false;
    let holdSuccessor = true;
    let queuedBlocker: Promise<void> | undefined;
    const launch = vi.fn<WorkerTurnTunnelHandle["launchTurn"]>(async (request) => {
      request.onDispatchReady?.();
      if (blockSecond) {
        if (stage === "pending result") {
          placements.markWorkspaceResultPending(request.turnClaim);
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
      const leafId = openSessionManager().appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "First turn complete" }],
          timestamp: 41,
        }),
      );
      await createWorkerSessionPlacementGate(placements).updateAckCursors({
        claim: request.turnClaim,
        transcriptSeq: 2,
        liveSeq: 1,
      });
      placements.markWorkspaceResultPending(request.turnClaim);
      return {
        stdout: JSON.stringify({
          status: "completed",
          transcriptLeafId: leafId,
          transcriptNextSeq: 3,
        }),
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      };
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
      startTunnel: async () => ({
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
        runWorkspaceCommand: vi.fn(),
        syncWorkspace: vi.fn(),
        stop: vi.fn(),
        measureLaunchTurn,
        readLaunchToolNames,
        launchTurn: launch,
        quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
        reconcileWorkspace: async (
          request: Parameters<WorkerTurnTunnelHandle["reconcileWorkspace"]>[0],
        ) => {
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
        const recovered = await advancePlacementFixtureToActive(
          placements,
          database,
          {
            sessionId: request.sessionId,
            sessionKey: request.sessionKey,
            agentId: request.agentId,
            executionMode: request.executionMode,
            expectedPlacement: request.expectedPlacement,
          },
          {
            environmentId: recoveredEnvironmentId,
            ownerEpoch: recoveredOwnerEpoch,
            remoteWorkspaceDir: "/workspace/recovered",
            workspaceBaseManifestRef: MANIFEST_REF,
          },
        );
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
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements,
      reconcileActivePlacement: async () => {},
      redispatchPlacement,
      resolveWorkspace: async () => {
        workspaceCalls++;
        if (workspaceCalls === 3 && holdSuccessor) {
          successorEntered.resolve();
          await finishSuccessor.promise;
          throw new Error("successor finished");
        }
        if (blockSecond && stage === "workspace resolution") {
          entered.resolve();
          await resume.promise;
        }
        return { kind: "local", path: root };
      },
      workspaceOperations: {
        run(environmentId, task, ...options) {
          const result = coordinator.run(
            environmentId,
            async () => {
              if (blockSecond && stage === "workspace mutation") {
                entered.resolve();
                await resume.promise;
                // The entered writer still owns the exact claim after cancellation.
                expect(placements.get(SESSION_ID)?.turnClaim?.runId).toBe("blocked-second");
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
    const operation = createReplyOperation({
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      resetTriggered: false,
    });
    const first = turn("warm-first");
    const second = {
      ...turn("blocked-second"),
      timeoutMs: 48 * 60 * 60 * 1_000,
      replyOperation: operation,
      onExecutionStarted: async () => {
        if (stage === "execution-start publication") {
          entered.resolve();
          await resume.promise;
        }
      },
    };
    let github: MockInstance<typeof workerGitHubBinding.prepareWorkerGitHubBinding> | undefined;
    let blocked: Promise<unknown> | undefined;
    let successor: Promise<unknown> | undefined;
    let recovery: Promise<unknown> | undefined;
    try {
      await expect(
        createLane(first).enqueueGlobal(async () => {
          throw new Error("unexpected local execution");
        }),
      ).resolves.toMatchObject({ payloads: [{ text: "First turn complete" }] });
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
      blockSecond = true;
      if (stage === "GitHub binding") {
        github = vi
          .spyOn(workerGitHubBinding, "prepareWorkerGitHubBinding")
          .mockImplementationOnce(async () => {
            entered.resolve();
            await resume.promise;
            return undefined;
          });
      }
      if (stage === "workspace queue") {
        queuedBlocker = coordinator.run(ENVIRONMENT_ID, () => resume.promise);
      }
      const lane = createLane(second);
      blocked = lane.enqueueSession(() =>
        lane.enqueueGlobal(async () => {
          throw new Error("unexpected local execution");
        }),
      );
      const outcome = blocked.catch((error: unknown) => error);
      await entered.promise;
      const oldClaim = placements.get(SESSION_ID)?.turnClaim;
      expect(oldClaim?.runId).toBe("blocked-second");
      expect(placements.listPendingWorkspaceResults()).toHaveLength(
        stage === "pending result" ? 1 : 0,
      );
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
        expect(placements.get(SESSION_ID)?.turnClaim).toEqual(oldClaim);
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
        await expect(waitForReplyRunSuccessorAdmission(SESSION_KEY, null)).resolves.toMatchObject({
          settled: true,
        });
        blockSecond = false;
        holdSuccessor = false;
        const third = turn("successor-third");
        const thirdLane = createLane(third);
        await expect(
          thirdLane.enqueueSession(() =>
            thirdLane.enqueueGlobal(async () => {
              throw new Error("unexpected local execution");
            }),
          ),
        ).resolves.toMatchObject({ payloads: [{ text: "First turn complete" }] });
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
        expect(placements.get(SESSION_ID)?.turnClaim).toEqual(oldClaim);
        const pending = placements.listPendingWorkspaceResults()[0]!;
        expect(pending.claimId).toBe(oldClaim?.claimId);
        expect(pending.recoveryRequestedAtMs).not.toBeNull();
        expect(environments.destroy).not.toHaveBeenCalled();
        return;
      }
      // Read-only and queued gates remain closed; entered writes/dispatches had to join.
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
      await expect(waitForReplyRunSuccessorAdmission(SESSION_KEY, null)).resolves.toMatchObject({
        settled: true,
      });
      expect(getCommandLaneSnapshot(resolveEmbeddedSessionLane(SESSION_KEY)).activeCount).toBe(0);
      const third = turn("successor-third");
      const thirdLane = createLane(third);
      successor = thirdLane.enqueueSession(() =>
        thirdLane.enqueueGlobal(async () => {
          throw new Error("unexpected local execution");
        }),
      );
      void successor.catch(() => {});
      await successorEntered.promise;
      const replacement = placements.get(SESSION_ID)?.turnClaim;
      expect(replacement?.runId).toBe("successor-third");
      resume.resolve();
      expect(await outcome).toBeInstanceOf(Error);
      if (!dispatched) {
        expect(await outcome).toMatchObject({ name: "AbortError" });
      }
      expect(placements.get(SESSION_ID)?.turnClaim).toEqual(replacement);
      expect(launch).toHaveBeenCalledTimes(dispatched ? 2 : 1);
      expect(environments.destroy).not.toHaveBeenCalled();
      third.preparedRunAdmission.close();
    } finally {
      vi.useRealTimers();
      resume.resolve();
      finishSuccessor.resolve();
      await Promise.allSettled([blocked, successor, queuedBlocker, recovery]);
      github?.mockRestore();
      operation.complete();
      first.preparedRunAdmission.close();
      second.preparedRunAdmission.close();
      uninstall();
    }
  });
});
