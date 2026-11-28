import { resolveAcpDispatchPolicyError } from "../../acp/policy.js";
import {
  PreparedQuestionAnswerRefusedError,
  QuestionAnswerUnconfirmedError,
} from "../../agents/harness/gateway-question-dispatch.js";
import { capturePendingChannelQuestion } from "../../agents/harness/gateway-question.js";
import { readQuestionRejection } from "../../agents/tools/gateway-question-lifecycle.js";
import { beginSessionControllerSourceInjection } from "../../sessions/session-controller.mailbox.js";
import { recordAcceptedSessionParticipantInput } from "../../sessions/session-participant-input-recording.js";
import { bindUserTurnInput } from "../../sessions/user-turn-transcript-runtime-context.js";
import { isNativeCommandTurn, resolveCommandTurnContext } from "../command-turn-context.js";
import { resolveAcpChannelAnswerScope } from "./acp-channel-answer-scope.js";
import { shouldBypassAcpDispatchForCommand } from "./dispatch-acp-command-bypass.js";
import type { PrepareDispatchOperationReadyState } from "./dispatch-from-config.prepare-operation.js";
import { hasInboundMedia } from "./inbound-media.js";
import { readReplySourceInput } from "./reply-source-binding.js";

/** Answer a channel-owned form without acquiring the turn that is waiting for it. */
export async function tryAnswerBoundAcpQuestion(
  state: PrepareDispatchOperationReadyState,
  sessionKey: string,
): Promise<{ reason: string; error?: string } | undefined> {
  const {
    cfg,
    ctx,
    params: { replyOptions },
  } = state;
  const source = readReplySourceInput(replyOptions);
  const text = ctx.agentText.trim();
  if (
    !source ||
    source.claim ||
    !text ||
    ctx.InternalTurnSource ||
    ctx.InboundEventKind === "room_event" ||
    replyOptions?.images?.length ||
    hasInboundMedia(ctx) ||
    isNativeCommandTurn(resolveCommandTurnContext(ctx)) ||
    shouldBypassAcpDispatchForCommand(ctx, cfg) ||
    resolveAcpDispatchPolicyError(cfg)
  ) {
    return undefined;
  }
  const scope = resolveAcpChannelAnswerScope(ctx);
  const claim = scope && capturePendingChannelQuestion(sessionKey, scope);
  if (!claim) {
    return undefined;
  }
  // Captured answers must not replay as prompts, even when persistence or adoption fails.
  state.markInboundDedupeReplayUnsafe();
  const stale = {
    reason: "acp_question_answer_refused",
    error: "The question is no longer available for this answer.",
  };
  const injection = beginSessionControllerSourceInjection(source, { keepOrderOnDecline: true });
  if (!(await injection.admit())) {
    return stale;
  }
  let consumed = false;
  try {
    const recorder = replyOptions?.userTurnTranscriptRecorder;
    const input = bindUserTurnInput(recorder, () => {
      source.abortSignal.throwIfAborted();
      state.getPreDispatchAbortSignal()?.throwIfAborted();
      state.turnAdoption?.assertCurrent();
    });
    let outcome: { reason: string; error?: string };
    try {
      const answered = await claim(
        {
          text,
          sourceRecorder: recorder,
          authority: { kind: "run", assertCurrent: input.assertNativeCurrent },
        },
        state.assertCurrentBindingRoute,
      );
      outcome = answered ? { reason: "acp_question_answer" } : stale;
      if (answered && state.sessionStoreEntry.storePath) {
        recordAcceptedSessionParticipantInput(ctx, {
          agentId: state.sessionAgentId,
          sessionKey,
          storePath: state.sessionStoreEntry.storePath,
        });
      }
    } catch (error) {
      if (error instanceof PreparedQuestionAnswerRefusedError) {
        outcome = { reason: "acp_question_answer_refused", error: error.message };
      } else if (error instanceof QuestionAnswerUnconfirmedError) {
        outcome = { reason: "acp_question_answer_unconfirmed", error: error.message };
      } else if (readQuestionRejection(error)?.reason === "QUESTION_INVALID_ANSWER") {
        outcome = {
          reason: "acp_question_answer_rejected",
          error: "The answer was not accepted. The question is still open.",
        };
      } else {
        throw error;
      }
    }
    consumed = true;
    injection.accepted(true);
    state.replyOperationRunState.questionInputHandled = true;
    await state.turnAdoption?.adopt();
    return outcome;
  } finally {
    injection.finish(consumed);
  }
}
