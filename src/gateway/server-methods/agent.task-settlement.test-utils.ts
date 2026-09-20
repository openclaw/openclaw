// Register these cases from their original describes in the shared agent.test.ts graph.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
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
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { waitForAgentJob } from "../agent-turn/agent-job.js";
import { observeCronContinuationLifetime } from "./agent.cron-continuation-lifetime.test-support.js";
import {
  cronContinuationGatewayClient,
  cronMediaCompletionEvent,
  expectRecordFields,
  getAgentTestMocks,
  invokeAgent,
  invokeGatewaySuspendPrepare,
  makeContext,
  primeMainAgentRun,
  resetAgentTaskRegistryForTests,
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
