// Register these cases from their original describes in the shared agent.test.ts graph.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentWaitResult } from "../../agents/run-wait.types.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  listSubagentRunsForRequester,
  markRequesterTurnYielded,
  registerSubagentRun,
  settleRequesterAfterSessionSpawns,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  resumeGatewaySuspend,
} from "../../infra/gateway-suspend-coordinator.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { findTaskByRunId } from "../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.test-support.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { waitForAgentJob } from "../agent-turn/agent-job.js";
import { withPluginSubagentTestState } from "./agent-task-tracking.test-helpers.js";
import { observeCronContinuationLifetime } from "./agent.cron-continuation-lifetime.test-support.js";
import {
  backendGatewayClient,
  cronContinuationGatewayClient,
  cronMediaCompletionEvent,
  expectRecordFields,
  getAgentTestMocks,
  invokeAgent,
  invokeGatewaySuspendPrepare,
  makeContext,
  primeMainAgentRun,
  resetAgentTaskRegistryForTests,
  requireValue,
  setupCronContinuationReleaseFixture,
  useTestStateDir,
  waitForAgentCommandCallAfter,
  waitForAssertion,
} from "./agent.test-harness.js";
import type { AgentCommandCall } from "./agent.test-harness.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";

const mocks = getAgentTestMocks();

export function registerSuccessfulAgentTaskSettlementCase() {
  it("terminalizes successful async gateway agent runs in the shared task registry", async () => {
    await withTestDir({ prefix: "openclaw-gateway-agent-task-" }, async (root) => {
      useTestStateDir(root);
      mocks.userTurnStorePath = path.join(root, "agents", "main", "sessions", "sessions.json");
      const executionWork = new AsyncWorkScope();
      const context = makeContext();
      await using execution = {
        work: executionWork,
        async [Symbol.asyncDispose]() {
          try {
            await executionWork.runWhenIdle(() => flushPendingSessionsChangedEvents(context));
          } finally {
            await executionWork.drain();
            await cleanupSessionStateForTest({ stateDir: root });
          }
        },
      };
      await execution.work.track(async () => {
        resetAgentTaskRegistryForTests();
        primeMainAgentRun();
        const commandCallCount = mocks.agentCommand.mock.calls.length;

        const respond = await invokeAgent(
          {
            message: "background cli task",
            sessionKey: "agent:main:main",
            idempotencyKey: "task-registry-agent-run",
          },
          { reqId: "task-registry-agent-run", context },
        );
        expect(respond.mock.calls).toContainEqual([
          true,
          expect.objectContaining({ status: "accepted" }),
          undefined,
          { runId: "task-registry-agent-run" },
        ]);
        await waitForAgentCommandCallAfter(commandCallCount);

        try {
          await waitForAssertion(() => {
            expectRecordFields(findTaskByRunId("task-registry-agent-run"), {
              runtime: "cli",
              childSessionKey: "agent:main:main",
              status: "succeeded",
              terminalSummary: "completed",
            });
          });
        } catch (error) {
          console.error(
            "Gateway task settlement fixture",
            JSON.stringify(
              {
                warnings: vi.mocked(context.logGateway.warn).mock.calls,
                status: findTaskByRunId("task-registry-agent-run")?.status,
              },
              null,
              2,
            ),
          );
          throw error;
        }
      });
    });
  });
}

export function registerCronContinuationRecoveryCase() {
  it("recovers a continuation release after reporting a durable write failure", async () => {
    await withTestDir({ prefix: "openclaw-agent-continuation-release-" }, async (root) => {
      useTestStateDir(root);
      mocks.userTurnStorePath = path.join(root, "agents", "main", "sessions", "sessions.json");
      const executionWork = new AsyncWorkScope();
      const context = makeContext();
      vi.useFakeTimers();
      resetGatewaySuspendCoordinatorForLifecycleRestart();
      resetGatewayWorkAdmission();
      try {
        await using continuation = observeCronContinuationLifetime(executionWork, async () => {
          try {
            await executionWork.runWhenIdle(() => flushPendingSessionsChangedEvents(context));
          } finally {
            await executionWork.drain();
          }
        });
        await continuation.work.track(async () => {
          mocks.agentCommand.mockClear();
          const { sessionKey, store } = setupCronContinuationReleaseFixture();
          let releaseAttempts = 0;
          mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
            if (
              expectDefined(store[sessionKey], "store[sessionKey] test invariant")
                .cronRunContinuation?.phase === "continuing"
            ) {
              releaseAttempts += 1;
              if (releaseAttempts <= 3) {
                throw new Error("disk unavailable");
              }
            }
            return await updater(store);
          });
          mocks.agentCommand.mockResolvedValue({ payloads: [{ text: "continued" }], meta: {} });
          const request = {
            message: "media completion",
            sessionKey,
            internalEvents: [cronMediaCompletionEvent()],
            idempotencyKey: "cron-media-release-fails",
          };

          const respond = await invokeAgent(request, {
            reqId: "cron-media-release-fails",
            client: cronContinuationGatewayClient(),
            context,
            flushDispatch: false,
          });
          await vi.advanceTimersByTimeAsync(10);

          expect(releaseAttempts).toBe(3);
          expect(
            expectDefined(store[sessionKey], "store[sessionKey] test invariant")
              .cronRunContinuation,
          ).toMatchObject({
            phase: "continuing",
            ownerRunId: "cron-media-release-fails",
          });
          expect(respond).toHaveBeenLastCalledWith(
            false,
            expect.objectContaining({
              status: "error",
              summary: "failed to persist cron continuation settlement",
            }),
            expect.objectContaining({ code: ErrorCodes.UNAVAILABLE }),
            expect.objectContaining({ runId: "cron-media-release-fails" }),
          );
          const busyPrepare = await invokeGatewaySuspendPrepare(
            context,
            "cron-media-release-backoff",
          );
          expect(busyPrepare).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
              status: "busy",
              reason: "active-work",
              blockers: expect.arrayContaining([expect.objectContaining({ kind: "root-request" })]),
            }),
          );

          await vi.advanceTimersByTimeAsync(250);

          expect(releaseAttempts).toBe(4);
          expect(
            expectDefined(store[sessionKey], "store[sessionKey] test invariant")
              .cronRunContinuation,
          ).toEqual({
            lifecycleRevision: "revision-1",
            phase: "ready",
            basePersisted: true,
          });
          await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
          const readyPrepare = await invokeGatewaySuspendPrepare(
            context,
            "cron-media-release-recovered",
          );
          const readyPayload = readyPrepare.mock.calls.at(-1)?.[1] as
            | { status?: string; suspensionId?: string }
            | undefined;
          try {
            expect(readyPayload).toMatchObject({ status: "ready" });
          } catch (error) {
            console.error(
              "Gateway continuation fixture",
              JSON.stringify(
                {
                  warnings: vi.mocked(context.logGateway.warn).mock.calls,
                  suspension: readyPayload,
                },
                null,
                2,
              ),
            );
            throw error;
          }
          expect(resumeGatewaySuspend(readyPayload?.suspensionId ?? "missing")).toMatchObject({
            ok: true,
            status: "running",
          });
          const retryRespond = await invokeAgent(request, {
            reqId: "cron-media-release-retry",
            client: cronContinuationGatewayClient(),
            context,
          });
          expect(retryRespond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ status: "ok", summary: "completed" }),
            undefined,
            { cached: true },
          );
          expect(mocks.agentCommand).toHaveBeenCalledOnce();
        });
      } finally {
        try {
          await cleanupSessionStateForTest({ stateDir: root });
        } finally {
          resetGatewaySuspendCoordinatorForLifecycleRestart();
          resetGatewayWorkAdmission();
          vi.useRealTimers();
        }
      }
    });
  });
}

export function registerCompactionSessionSettlementCase() {
  it("updates tracked agent session identity after compaction rotation", async () => {
    primeMainAgentRun();
    const context = makeContext();
    let trackedSessionId: string | undefined;
    mocks.agentCommand.mockImplementation(async (call: AgentCommandCall) => {
      const onSessionIdChanged = call.onSessionIdChanged;
      if (typeof onSessionIdChanged !== "function") {
        throw new Error("expected session id change callback");
      }
      onSessionIdChanged("rotated-session-id");
      trackedSessionId = context.chatAbortControllers.get("agent-session-rotation")?.sessionId;
      return {
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      };
    });

    await invokeAgent(
      {
        message: "rotate session",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "agent-session-rotation",
      },
      {
        reqId: "agent-session-rotation",
        context,
      },
    );

    expect(trackedSessionId).toBe("rotated-session-id");
    expect(await waitForAgentJob({ runId: "agent-session-rotation", timeoutMs: 0 })).toMatchObject({
      session: { sessionId: "rotated-session-id" },
    });
  });
}

export function registerYieldedRequesterSettlementCase(
  mockSpawnedChildSessionEntry: (sessionKey: string, root: string) => void,
) {
  it("keeps one task when a completed child wakes its requester before the yielded lifecycle ends", async () => {
    await withPluginSubagentTestState("openclaw-gateway-yield-settlement-race-", async (state) => {
      const root = state.stateDir;
      // Adoption commits the registry and its canonical task together in SQLite.
      resetTaskRegistryForTests({ persist: false });
      const requesterSessionKey = "agent:main:main";
      const childSessionKey = "agent:main:subagent:settlement-orchestrator";
      const workerSessionKey = "agent:main:subagent:settlement-worker";
      const previousRunId = "orchestrator-yielding";
      const nextRunId = "orchestrator-settle-continuation";
      const workerRunId = "settled-worker";
      const result = "The completed worker result has been checked.";
      const completion = createDeferred<AgentWaitResult>();
      const previousWait = createDeferred<AgentWaitResult>();
      const announce = mocks.registryAnnounce.mockResolvedValue("delivered");
      let continuedAtDispatch: ReturnType<typeof getSubagentRunByChildSessionKey> | undefined;
      const executionWork = new AsyncWorkScope();
      const context = makeContext();
      context.trackExecution = (run) => executionWork.track(run);
      await using execution = {
        work: executionWork,
        async [Symbol.asyncDispose]() {
          try {
            await executionWork.runWhenIdle(() => flushPendingSessionsChangedEvents(context));
          } finally {
            await executionWork.drain();
          }
        },
      };
      const wakeCompleted = createDeferred();
      const wakeRespond = vi.fn((ok: boolean, payload?: { status?: string }) => {
        if (!ok || payload?.status !== "accepted") {
          wakeCompleted.resolve();
        }
      });
      const wake = mocks.registryWake.mockImplementation(async (params) => {
        if (params.requesterSessionKey !== childSessionKey) {
          return false;
        }
        // The transport crosses the real agent admission boundary before the
        // predecessor's lifecycle end is delivered, as in the production race.
        await invokeAgent(
          {
            message: "The worker finished; verify and return its result.",
            sessionKey: childSessionKey,
            idempotencyKey: nextRunId,
            inputProvenance: {
              kind: "inter_session",
              sourceSessionKey: workerSessionKey,
              sourceTool: "subagent_settle",
            },
          },
          {
            context,
            reqId: nextRunId,
            client: backendGatewayClient(),
            respond: wakeRespond,
            // This wake awaits SQLite; keep the outer lifecycle wait on real timers.
            flushDispatch: false,
          },
        );
        return true;
      });
      mocks.registryCallGateway.mockImplementation(
        async ({ params }) =>
          await (asOptionalRecord(params)?.runId === previousRunId
            ? previousWait.promise
            : completion.promise),
      );
      await registerSubagentRun({
        runId: previousRunId,
        childSessionKey,
        requesterSessionKey,
        requesterAgentId: "main",
        requesterDisplayKey: requesterSessionKey,
        task: "Collect and verify the worker's result",
        cleanup: "keep",
        expectsCompletionMessage: true,
      });
      const originalTask = requireValue(findTaskByRunId(previousRunId), "original requester task");
      addSubagentRunForTests({
        runId: workerRunId,
        childSessionKey: workerSessionKey,
        requesterSessionKey: childSessionKey,
        requesterAgentId: "main",
        requesterTurnRunId: previousRunId,
        requesterDisplayKey: childSessionKey,
        task: "Produce the worker result",
        startedAt: Date.now() - 10,
        endedAt: Date.now(),
        outcome: { status: "ok" },
        expectsCompletionMessage: true,
        completion: {
          required: true,
          resultText: "Worker result is ready.",
          capturedAt: Date.now(),
        },
        delivery: { status: "delivered" },
        cleanupCompletedAt: Date.now(),
      });
      mockSpawnedChildSessionEntry(childSessionKey, root);
      mocks.agentCommand.mockImplementation(async () => {
        continuedAtDispatch = structuredClone(getSubagentRunByChildSessionKey(childSessionKey));
        completion.resolve({
          status: "ok",
          startedAt: Date.now(),
          endedAt: Date.now(),
          terminalReply: { disposition: "visible", text: result },
        });
        return { payloads: [{ text: result }], meta: { durationMs: 1 } };
      });
      expectRecordFields(getSubagentRunByChildSessionKey(childSessionKey)?.execution, {
        status: "running",
        endedAt: undefined,
      });
      expect(
        markRequesterTurnYielded({
          requesterSessionKey: childSessionKey,
          requesterAgentId: "main",
          requesterTurnRunId: previousRunId,
        }),
      ).toBe(1);
      expect(
        settleRequesterAfterSessionSpawns({
          requesterSessionKey: childSessionKey,
          requesterAgentId: "main",
          requesterTurnRunId: previousRunId,
          requesterYielded: true,
          acceptedSessionSpawns: [
            {
              runId: workerRunId,
              childSessionKey: workerSessionKey,
              expectsCompletionMessage: true,
            },
          ],
        }),
      ).toBe(true);
      await wakeCompleted.promise;
      expect(wake).toHaveBeenCalled();
      await execution.work.runWhenIdle(() => {
        expect(wakeRespond.mock.calls.find(([ok]) => !ok)).toBeUndefined();
        expectRecordFields(context.dedupe.get(`agent:${nextRunId}`)?.payload, { status: "ok" });
      });
      expectRecordFields(continuedAtDispatch, {
        runId: nextRunId,
        taskRunId: previousRunId,
        requesterSessionKey,
        pauseReason: undefined,
      });
      await waitForAssertion(() => {
        expectRecordFields(findTaskByRunId(previousRunId), {
          taskId: originalTask.taskId,
          status: "succeeded",
          deliveryStatus: "delivered",
        });
      });
      expect(findTaskByRunId(nextRunId)).toBeUndefined();
      const { emitAgentEvent } = await vi.importActual<
        typeof import("../../infra/agent-events.js")
      >("../../infra/agent-events.js");
      emitAgentEvent({
        runId: previousRunId,
        sessionKey: childSessionKey,
        stream: "lifecycle",
        data: { phase: "end", endedAt: Date.now(), yielded: true },
      });
      await Promise.resolve();
      expectRecordFields(findTaskByRunId(previousRunId), {
        taskId: originalTask.taskId,
        status: "succeeded",
      });
      expect(
        listSubagentRunsForRequester(requesterSessionKey).map((entry) => entry.runId),
      ).not.toContain(previousRunId);
      expect(announce).toHaveBeenCalledTimes(1);
      expect(announce).toHaveBeenCalledWith(
        expect.objectContaining({
          childRunId: nextRunId,
          requesterSessionKey,
          roundOneReply: result,
        }),
      );
    });
  });
}
