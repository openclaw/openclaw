import { expect, it, vi, type Mock } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { prepareConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { projectConversationToolNames } from "../../agents/conversation-tool-policy-pipeline.js";
import { expectPendingQuestionAnswerClaimable } from "../../agents/harness/gateway-question-claim.test-support.js";
import { registerPendingAgentQuestion } from "../../agents/harness/gateway-question.js";
import {
  callGatewayTool,
  withQuestionGateway,
} from "../../agents/harness/gateway-question.test-support.js";
import { awaitGatewayQuestionAnswer } from "../../agents/tools/gateway-question-lifecycle.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { getSessionControllerEntryForOperation } from "../../sessions/session-controller.state.js";
import type { TemplateContext } from "../templating.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { reserveSteerCandidate, scheduleFollowupDrain, type FollowupRun } from "./queue.js";
import { clearSessionQueues } from "./queue/cleanup.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { withQuestionCreator } from "./reply-run-question.test-support.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { createQueueTestRun } from "./reply-tool-authority.test-support.js";
import * as routedReplies from "./route-reply.js";

type SteeringRequesterFixture = {
  createMinimalRun: (params: {
    opts?: InternalGetReplyOptions;
    isActive?: boolean;
    shouldSteer?: boolean;
    resolvedQueueMode?: string;
    sessionCtx?: Partial<TemplateContext>;
    runOverrides?: Partial<FollowupRun["run"]>;
    bindActiveAuthority?: boolean;
  }) => { followupRun: FollowupRun; run: () => Promise<unknown> };
  state: { backendQueueMessageMock: Mock; runEmbeddedAgentMock: Mock };
};

async function observeRealFollowups(): Promise<Promise<void>[]> {
  const actualQueue = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  const tasks: Promise<void>[] = [];
  const observe =
    (runFollowup: Parameters<typeof scheduleFollowupDrain>[1]) => (queued: FollowupRun) => {
      const task = runFollowup(queued);
      tasks.push(task.catch(() => {}));
      return task;
    };
  vi.mocked(reserveSteerCandidate).mockImplementation((key, queued, settings, runFollowup) =>
    actualQueue.reserveSteerCandidate(key, queued, settings, observe(runFollowup)),
  );
  vi.mocked(scheduleFollowupDrain).mockImplementation((key, runFollowup) =>
    actualQueue.scheduleFollowupDrain(key, observe(runFollowup)),
  );
  return tasks;
}

export function registerSteeringRequesterCases({
  createMinimalRun,
  state,
}: SteeringRequesterFixture): void {
  it.for([
    { reason: "privilege facts differ", unknown: "neither", collaboration: false },
    { reason: "the active requester is unknown", unknown: "active", collaboration: false },
    { reason: "the incoming requester is unknown", unknown: "incoming", collaboration: false },
    {
      reason: "collaboration cannot identify the active requester",
      unknown: "active",
      collaboration: true,
    },
    { reason: "an identified source is redelivered", unknown: "active", collaboration: false },
  ])(
    "queues instead of steering when $reason",
    async ({ reason, unknown, collaboration }, { signal }) => {
      const followupTasks = await observeRealFollowups();
      const routeReply = vi.spyOn(routedReplies, "routeReply").mockResolvedValue({
        ok: true,
        delivered: true,
      });
      const queued = createDeferred();
      const onDeferred = vi.fn(() => queued.resolve());
      const settled = createDeferred();
      const onSettled = vi.fn(() => settled.resolve());
      const onAdopted = vi.fn();
      const onBlockReply = vi.fn();
      const runState: ReplyOperationRunState = {};
      const active = createReplyOperation({
        sessionKey: "main",
        sessionId: "session",
        resetTriggered: false,
      });
      const duplicateState: ReplyOperationRunState = {};
      const duplicateLifecycle = {
        onAdopted: vi.fn(),
        onDeferred: vi.fn(),
        onSettled: vi.fn(),
      };
      const duplicateReply = vi.fn();
      const createCandidate = (
        opts: InternalGetReplyOptions = {
          [REPLY_OPERATION_RUN_STATE]: runState,
          onBlockReply,
          turnAdoptionLifecycle: { onAdopted, onDeferred, onSettled },
        },
      ) => {
        const candidate = createMinimalRun({
          isActive: true,
          shouldSteer: true,
          resolvedQueueMode: "steer",
          sessionCtx: {
            Provider: "telegram",
            SenderId: unknown === "incoming" ? undefined : "alice",
            AccountId: "primary",
            OriginatingTo: "chat:test-requesters",
            MessageSid: "requester-input",
          },
          runOverrides: {
            messageProvider: "telegram",
            config: {
              ...(collaboration
                ? { messages: { queue: { allowCollaborativeSteering: true } } }
                : {}),
              ...(unknown === "neither" ? { tools: { profile: "minimal" as const } } : {}),
            },
          },
          bindActiveAuthority: false,
          opts,
        });
        Object.assign(candidate.followupRun, {
          messageId: "requester-input",
          originatingAccountId: "primary",
          originatingThreadId: "test-thread",
          originatingChatType: "direct",
        });
        return candidate;
      };
      const { followupRun, run } = createCandidate();
      const incumbentRun = {
        ...followupRun.run,
        senderId: unknown === "active" ? undefined : "alice",
        ...(unknown === "neither"
          ? { runtimePluginToolGrant: { pluginId: "workboard", toolNames: ["workboard_complete"] } }
          : {}),
      };
      const effectiveTools = async (execution: FollowupRun["run"]) =>
        projectConversationToolNames({
          capabilityProfile: await prepareConversationCapabilityProfile({
            ...execution,
            modelProvider: execution.provider,
            modelId: execution.model,
          }),
          toolNames: ["session_status", "exec", "workboard_complete"],
          toolMeta: ({ name }) =>
            name === "workboard_complete" ? { pluginId: "workboard" } : undefined,
          warn: () => {},
        });
      await active.bindToolAuthoritySnapshotAsync(
        prepareReplyToolAuthority({ ...followupRun, run: incumbentRun }),
      );
      await active.bindToolAuthorityRouteAsync({ provider: "openai", model: "gpt-fallback" });
      active.setPhase("running");
      try {
        await expect(run()).resolves.toBeUndefined();
        await withinTest(
          awaitGateBeforeSettlement(
            queued.promise,
            settled.promise,
            "followup settled before queue acceptance",
          ),
          signal,
        );
        expect(onDeferred).toHaveBeenCalledOnce();
        expect(runState.admission).toEqual({
          status: "accepted",
          mode: "followup",
          reason: unknown !== "neither" ? "requester-mismatch" : "steering-unavailable",
        });
        if (reason === "an identified source is redelivered") {
          expect(followupRun.sourceTurnId).toMatch(/^channel-user:v1:/);
          const input = followupRun.controllerInput;
          const redelivery = createCandidate({
            [REPLY_OPERATION_RUN_STATE]: duplicateState,
            onBlockReply: duplicateReply,
            turnAdoptionLifecycle: duplicateLifecycle,
          });
          expect(redelivery.followupRun).not.toBe(followupRun);
          expect(redelivery.followupRun.sourceTurnId).toBe(followupRun.sourceTurnId);
          await expect(redelivery.run()).resolves.toBeUndefined();
          // Redelivery retires its own unadopted input, without replacing the parked original.
          expect(redelivery.followupRun.controllerInput).not.toBe(input);
          expect(redelivery.followupRun.controllerInput?.phase).toBe("consumed");
          expect(input?.phase).toBe("waiting");
          expect(duplicateState.admission).toBeUndefined();
          expect(duplicateLifecycle.onDeferred).not.toHaveBeenCalled();
          expect(duplicateLifecycle.onAdopted).not.toHaveBeenCalled();
          expect(duplicateLifecycle.onSettled).toHaveBeenCalledOnce();
          expect(onDeferred).toHaveBeenCalledOnce();
          expect(onSettled).not.toHaveBeenCalled();
        }
        expect(getExistingFollowupQueue("main")?.items).toEqual([followupRun]);
        expect(state.backendQueueMessageMock).not.toHaveBeenCalled();
        expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
        expect(onAdopted).not.toHaveBeenCalled();
        expect(onBlockReply).not.toHaveBeenCalled();
        expect(routeReply).not.toHaveBeenCalled();

        active.complete();
        await withinTest(settled.promise, signal);
        await Promise.all(followupTasks);
        expect(onAdopted).toHaveBeenCalledOnce();
        expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
        expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
          prompt: "hello",
          senderId: followupRun.run.senderId,
        });
        if (unknown === "neither") {
          expect(await effectiveTools(incumbentRun)).toEqual([
            "session_status",
            "workboard_complete",
          ]);
          expect(await effectiveTools(state.runEmbeddedAgentMock.mock.calls[0]![0])).toEqual([
            "session_status",
          ]);
          expect(
            state.runEmbeddedAgentMock.mock.calls[0]![0].runtimePluginToolGrant,
          ).toBeUndefined();
        }
        expect(onSettled).toHaveBeenCalledOnce();
        expect(duplicateLifecycle.onDeferred).not.toHaveBeenCalled();
        expect(duplicateLifecycle.onAdopted).not.toHaveBeenCalled();
        if (reason === "an identified source is redelivered") {
          expect(duplicateLifecycle.onSettled).toHaveBeenCalledOnce();
        }
        expect(duplicateReply).not.toHaveBeenCalled();
        expect(onBlockReply).not.toHaveBeenCalled();
        expect(routeReply).toHaveBeenCalledOnce();
        expect(routeReply).toHaveBeenCalledWith(
          expect.objectContaining({
            payload: expect.objectContaining({ text: "final" }),
            channel: "telegram",
            to: "chat:test-requesters",
            accountId: "primary",
            threadId: "test-thread",
            requesterSenderId: followupRun.run.senderId,
          }),
        );
      } finally {
        active.complete();
        clearSessionQueues(["main"], getSessionControllerEntryForOperation(active).target);
        await Promise.all(followupTasks);
        routeReply.mockRestore();
      }
    },
  );

  it("queues an unknown requester's answer without consuming the incumbent question", async ({
    signal,
  }) => {
    const followupTasks = await observeRealFollowups();
    const key = "main";
    const id = "ask_unknown_requester";
    const creator = createQueueTestRun({ prompt: "incumbent", messageId: "creator" });
    const settled = createDeferred();
    const onDeferred = vi.fn();
    const onAdopted = vi.fn();
    const onBlockReply = vi.fn();
    const runState: ReplyOperationRunState = {};
    await withQuestionGateway(async (fixture) => {
      let claim: ReturnType<typeof registerPendingAgentQuestion> | undefined;
      let answerOutcome: Promise<unknown> | undefined;
      try {
        await withQuestionCreator(key, creator, async (active) => {
          const question = { header: "Answer", question: "Continue?", isOther: true, options: [] };
          claim = registerPendingAgentQuestion({
            questionId: id,
            sessionKey: key,
            questions: [{ id: "answer", ...question }],
          });
          const registration = callGatewayTool(
            "question.request",
            {},
            {
              id,
              sessionKey: key,
              timeoutMs: 60_000,
              questions: [{ questionId: "answer", ...question }],
            },
          );
          claim.attachRegistration(registration);
          await withinTest(registration, signal);
          const answer = awaitGatewayQuestionAnswer({
            gatewayCall: callGatewayTool,
            questionId: id,
            timeoutMs: 60_000,
          });
          answerOutcome = answer.catch(() => undefined);
          claim.setAnswer(answer);
          await withinTest(fixture.waitStarted, signal);
          const { followupRun, run } = createMinimalRun({
            isActive: true,
            shouldSteer: true,
            resolvedQueueMode: "steer",
            sessionCtx: { Provider: "telegram", SenderId: undefined },
            runOverrides: { sessionId: creator.run.sessionId, messageProvider: "telegram" },
            bindActiveAuthority: false,
            opts: {
              [REPLY_OPERATION_RUN_STATE]: runState,
              onBlockReply,
              turnAdoptionLifecycle: { onDeferred, onAdopted, onSettled: settled.resolve },
            },
          });
          active.setPhase("running");
          await expect(run()).resolves.toBeUndefined();
          expect(runState.admission).toEqual({
            status: "accepted",
            mode: "followup",
            reason: "requester-mismatch",
          });
          expect(getExistingFollowupQueue(key)?.items).toEqual([followupRun]);
          expect(followupRun.controllerInput?.phase).toBe("waiting");
          expect(followupRun.controllerInput?.abortSignal.aborted).toBe(false);
          expect(onDeferred).toHaveBeenCalledOnce();
          expect(onAdopted).not.toHaveBeenCalled();
          expect(onBlockReply).not.toHaveBeenCalled();
          expect(state.backendQueueMessageMock).not.toHaveBeenCalled();
          expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
          expect(fixture.manager.get(id)?.status).toBe("pending");
          expect(
            fixture.requests.filter((request) => request.method === "question.resolve"),
          ).toEqual([]);
          await expectPendingQuestionAnswerClaimable(key, true);
          active.complete();
        });
        // Release the creator's execution lease before awaiting its successor.
        await withinTest(settled.promise, signal);
        await Promise.all(followupTasks);
        expect(onAdopted).toHaveBeenCalledOnce();
        expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
        expect(state.runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
          prompt: "hello",
          senderId: undefined,
        });
        expect(onBlockReply).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ text: "final" }),
        );
        expect(fixture.manager.get(id)?.status).toBe("pending");
      } finally {
        fixture.manager.cancel(id, "test-cleanup");
        await answerOutcome;
        claim?.dispose();
        clearSessionQueues([key]);
        await Promise.all(followupTasks);
      }
    });
  });
}
