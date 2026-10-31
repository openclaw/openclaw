import { expect, it, vi, type Mock } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import type { RunEmbeddedAgentInternalParams as AgentRunParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { expectPendingQuestionAnswerClaimable } from "../../agents/harness/gateway-question-claim.test-support.js";
import type { AgentQuestionDispatcher } from "../../agents/harness/gateway-question-dispatch.js";
import { registerPendingAgentQuestion } from "../../agents/harness/gateway-question.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../agents/harness/tool-authority.runtime.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.js";
import type { TemplateContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import * as pendingToolTaskDrain from "./pending-tool-task-drain.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";
import type { FollowupRun } from "./queue.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import * as routedReplies from "./route-reply.js";

type FollowupDrainFixture = {
  runHookBackedEmbeddedAgent: (params: {
    agentId?: string;
    prompt: string;
    runId: string;
    sessionId: string;
    sessionKey?: string;
    trigger?: string;
    workspaceDir: string;
  }) => Promise<unknown>;
  state: {
    backendQueueMessageMock: Mock;
    runEmbeddedAgentMock: Mock;
    beforeAgentReplyHasHooksMock: Mock;
    beforeAgentReplyRunMock: Mock;
  };
  createMinimalRun: (params?: {
    isActive?: boolean;
    isRunActive?: () => boolean;
    shouldFollowup?: boolean;
    shouldSteer?: boolean;
    sessionCtx?: Partial<TemplateContext>;
    runOverrides?: Partial<FollowupRun["run"]>;
    resolvedQueueMode?: string;
    opts?: InternalGetReplyOptions;
  }) => {
    followupRun: FollowupRun;
    run: () => Promise<ReplyPayload | ReplyPayload[] | undefined>;
  };
  runEmbeddedAgentMock: Pick<Mock, "mockImplementationOnce">;
  requireScheduledFollowupRunner: () => (run: FollowupRun) => Promise<void>;
};

export function registerFollowupDrainCases({
  runHookBackedEmbeddedAgent,
  state,
  createMinimalRun,
  runEmbeddedAgentMock,
  requireScheduledFollowupRunner,
}: FollowupDrainFixture): void {
  it("defers hooks until an active run's follow-up is admitted", async () => {
    state.beforeAgentReplyHasHooksMock.mockImplementation(
      (hookName) => hookName === "before_agent_reply",
    );
    const { run } = createMinimalRun({
      isActive: true,
      shouldFollowup: true,
      resolvedQueueMode: "collect",
    });

    await expect(run()).resolves.toBeUndefined();

    expect(state.beforeAgentReplyRunMock).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it.each([
    { requester: "same", active: true, outcome: "answered" },
    { requester: "same", active: false, outcome: "answered" },
    { requester: "other", active: true, outcome: "queued" },
    { requester: "other", active: false, outcome: "queued" },
    { requester: "restricted", active: false, outcome: "refused" },
  ] as const)(
    "preserves direct question custody for $requester requester with active=$active",
    async ({ requester, active, outcome }) => {
      const creator = createMinimalRun();
      const runState: ReplyOperationRunState = {};
      const incoming = createMinimalRun({
        isActive: active,
        shouldSteer: true,
        shouldFollowup: true,
        resolvedQueueMode: "steer",
        sessionCtx: { SenderId: requester === "other" ? "another-user" : "sender-42" },
        opts: { [REPLY_OPERATION_RUN_STATE]: runState },
      });
      if (requester === "restricted") {
        incoming.followupRun.toolsAllow = [];
      }
      const runId = "direct-question-creator";
      const admission = prepareAgentRunAdmission({
        cfg: creator.followupRun.run.config,
        operationalRunInstance: createOperationalRunInstanceRef(runId),
        facts: {
          agentId: "main",
          runId,
          ingress: { kind: "system", state: "present", boundary: "direct-question-test" },
        },
      });
      const dispatch = vi.fn<AgentQuestionDispatcher["call"]>(async ({ authority }) => {
        if (authority.kind === "source-bound") {
          authority.assertCurrent();
        }
        return { status: "answered" };
      });
      try {
        await withPreparedEmbeddedRunToolAuthority(
          {
            admittedRunContext: await admission.admit("embedded", "direct-question-test"),
            sessionPersistence: "detached",
          },
          {
            ...creator.followupRun.run,
            agentId: "main",
            runId,
            modelId: creator.followupRun.run.model,
          },
          undefined,
          async () => {
            const question = registerPendingAgentQuestion({
              questionId: "direct-question",
              sessionKey: "main",
              questions: [{ id: "answer", header: "Answer", question: "Continue?" }],
              gatewayCall: { version: 2, call: dispatch },
              answer: Promise.resolve({ status: "pending" }),
            });
            question.attachRegistration(Promise.resolve({ id: "direct-question" }));
            try {
              expect(getSessionControllerOperation("main")).toBeUndefined();
              const result = await incoming.run();
              expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
              if (outcome === "answered") {
                expect(result).toBeUndefined();
                expect(dispatch).toHaveBeenCalledOnce();
                expect(runState.admission).toEqual({ status: "accepted", mode: "steer" });
                expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
              } else {
                expect(dispatch).not.toHaveBeenCalled();
                await expectPendingQuestionAnswerClaimable("main", true);
                if (outcome === "queued") {
                  expect(result).toBeUndefined();
                  expect(runState.admission).toEqual({
                    status: "accepted",
                    mode: "followup",
                    reason: "requester-mismatch",
                  });
                  expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledOnce();
                  expect(vi.mocked(enqueueFollowupRun).mock.calls[0]?.[1]).toBe(
                    incoming.followupRun,
                  );
                } else {
                  expect(result).toMatchObject({
                    isError: true,
                    text: expect.stringContaining("The answer was not sent"),
                  });
                  expect(runState.admission).toEqual({
                    status: "skipped",
                    reason: "question-response-refused",
                  });
                  expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
                }
              }
            } finally {
              question.dispose();
            }
          },
        );
      } finally {
        admission.close();
      }
    },
  );

  it("runs one queued fallback after Gateway rejects injection", async () => {
    using delivery = vi
      .spyOn(routedReplies, "routeReply")
      .mockResolvedValue({ ok: true, delivered: true });
    state.beforeAgentReplyHasHooksMock.mockImplementation(
      (hookName) => hookName === "before_agent_reply",
    );
    state.beforeAgentReplyRunMock.mockResolvedValue(undefined);
    state.runEmbeddedAgentMock.mockImplementationOnce(runHookBackedEmbeddedAgent);
    const onBlockReply = vi.fn();
    const runState: ReplyOperationRunState = {};
    const { followupRun, run } = createMinimalRun({
      opts: {
        messageInjectionDisposition: "rejected",
        onBlockReply,
        [REPLY_OPERATION_RUN_STATE]: runState,
      },
      isActive: true,
      shouldSteer: true,
      resolvedQueueMode: "steer",
      sessionCtx: {
        Provider: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:24680",
        MessageSid: "steer-pre-attempted",
        SenderId: "bob",
      },
      runOverrides: { agentId: "main", messageProvider: "discord" },
    });

    expect(getSessionControllerOperation("main")).toBeUndefined();
    await expect(run()).resolves.toBeUndefined();

    expect(state.backendQueueMessageMock).not.toHaveBeenCalled();
    expect(state.beforeAgentReplyRunMock).not.toHaveBeenCalled();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledOnce();
    expect(vi.mocked(enqueueFollowupRun).mock.calls[0]?.[1]).toBe(followupRun);
    expect(vi.mocked(enqueueFollowupRun).mock.calls[0]?.[1]).toMatchObject({
      originatingChannel: "discord",
      run: { senderId: "bob" },
    });
    expect(runState.admission).toEqual({
      status: "accepted",
      mode: "followup",
      reason: "steering-unavailable",
    });
    expect(vi.mocked(scheduleFollowupDrain)).toHaveBeenCalledOnce();
    await requireScheduledFollowupRunner()(followupRun);
    expect(state.beforeAgentReplyRunMock).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({ senderId: "bob" });
    expect(delivery).toHaveBeenCalledOnce();
    expect(delivery).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        to: "channel:24680",
        replyKind: "final",
        payload: expect.objectContaining({ text: "model reply" }),
      }),
    );
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it.for([
    {
      name: "keeps a queued followup owned after the pending tool delivery idle bound",
      elapsedMs: 30_000,
      owned: true,
    },
    {
      name: "keeps a queued followup owned until pending tool delivery settles",
      elapsedMs: 29_999,
      owned: true,
    },
  ])("$name", async ({ elapsedMs, owned }, { signal }) => {
    vi.useFakeTimers();
    const toolResultStarted = createDeferred();
    const toolResultReleased = createDeferred();
    const drainStarted = createDeferred();
    const originalDrain = pendingToolTaskDrain.drainPendingToolTasks;
    const drainSpy = vi
      .spyOn(pendingToolTaskDrain, "drainPendingToolTasks")
      .mockImplementation((options) => {
        const draining = originalDrain(options);
        if (options.tasks.size > 0) {
          drainStarted.resolve();
        }
        return draining;
      });
    runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      void params.onToolResult?.({ text: "pending tool result" });
      return { payloads: [{ text: "followup complete" }], meta: {} };
    });
    const { followupRun, run } = createMinimalRun({
      isActive: true,
      isRunActive: () => false,
      shouldFollowup: true,
      resolvedQueueMode: "collect",
      opts: {
        forceToolResultProgress: true,
        onToolResult: async () => {
          toolResultStarted.resolve();
          await toolResultReleased.promise;
        },
      },
    });
    let followup: Promise<void> | undefined;
    try {
      await run();
      followup = requireScheduledFollowupRunner()(followupRun);
      // Callback entry precedes execution settlement and the drain's idle timer.
      await withinTest(Promise.all([toolResultStarted.promise, drainStarted.promise]), signal);

      await vi.advanceTimersByTimeAsync(elapsedMs);
      expect(getSessionControllerOperation("main") !== undefined).toBe(owned);

      toolResultReleased.resolve();
      await followup;
      expect(getSessionControllerOperation("main")).toBeUndefined();
    } finally {
      toolResultReleased.resolve();
      try {
        await followup;
      } finally {
        drainSpy.mockRestore();
        vi.useRealTimers();
      }
    }
  });
}
