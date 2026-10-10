import {
  QuestionAnswerUnconfirmedError,
  QuestionDispatchRefusedError,
  QuestionDispatchUnsupportedError,
} from "../../agents/harness/gateway-question-dispatch.js";
import { claimPendingAgentQuestionAnswerFromCaller } from "../../agents/harness/gateway-question.js";
import { readQuestionRejection } from "../../agents/tools/gateway-question-lifecycle.js";
import { logVerbose } from "../../globals.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type { RunReplyAgentParams } from "./agent-runner-core.js";
import { admitFollowupRunLifecycle, completeFollowupRunLifecycle } from "./queue/lifecycle.js";
import { resolveFollowupAbortSignal } from "./queue/types.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import { resolveInboundReplyToolAuthorityOverlay } from "./reply-tool-authority.js";

type ReplyQuestionInputParams = Pick<
  RunReplyAgentParams,
  | "commandBody"
  | "transcriptCommandBody"
  | "followupRun"
  | "opts"
  | "resetTriggered"
  | "sessionCtx"
  | "sessionEntry"
  | "sessionKey"
>;

type ReplyQuestionInputResult =
  | { handled: false }
  | { handled: true; payload: ReplyPayload | undefined };

function questionErrorReply(text: string): ReplyQuestionInputResult {
  return {
    handled: true,
    payload: markReplyPayloadForSourceSuppressionDelivery({ text, isError: true }),
  };
}

/** Question-only runtimes accept answers without exposing ordinary steering. */
export async function runReplyQuestionInput(
  params: ReplyQuestionInputParams,
): Promise<ReplyQuestionInputResult> {
  const { followupRun, opts, sessionKey } = params;
  const external =
    followupRun.run.inputProvenance === undefined ||
    followupRun.run.inputProvenance.kind === "external_user";
  const text = (
    params.transcriptCommandBody ??
    followupRun.transcriptPrompt ??
    params.commandBody
  ).trim();
  if (
    !sessionKey ||
    opts?.isHeartbeat ||
    params.resetTriggered ||
    opts?.messageInjectionDisposition === "accepted" ||
    !external ||
    !text ||
    followupRun.images?.length ||
    followupRun.media?.length
  ) {
    return { handled: false };
  }

  const caller = resolveInboundReplyToolAuthorityOverlay({
    ctx: params.sessionCtx,
    sessionEntry: params.sessionEntry,
    senderIsOwner: followupRun.run.senderIsOwner === true,
    operatorAuthority: followupRun.operatorAuthority,
    toolsAllow: followupRun.toolsAllow,
    disableTools: followupRun.disableTools === true,
  });
  const sourceAbort = opts?.abortSignal;
  const queuedAbort = resolveFollowupAbortSignal(followupRun);
  const assertSourceCurrent = () => {
    sourceAbort?.throwIfAborted();
    queuedAbort?.throwIfAborted();
    followupRun.operatorAuthority?.assertCurrent();
  };
  const state = resolveReplyOperationRunState(opts);
  let unconfirmedAnswer: string | undefined;
  try {
    const claimed = await claimPendingAgentQuestionAnswerFromCaller({
      sessionKey,
      text,
      caller,
      assertSourceCurrent,
      sourceRecorder: followupRun.userTurnTranscriptRecorder,
      onAnswerProcessed: () => {
        if (state) {
          state.questionInputHandled = true;
        }
      },
    });
    if (!claimed) {
      return { handled: false };
    }
  } catch (error) {
    if (error instanceof QuestionDispatchUnsupportedError) {
      assertSourceCurrent();
      return { handled: false };
    }
    if (error instanceof QuestionDispatchRefusedError) {
      if (state) {
        state.admission = { status: "skipped", reason: "question-response-refused" };
      }
      return questionErrorReply(
        `The answer was not sent: ${error.message}. Use the question controls in the Control UI, or check the active run and your permissions before retrying.`,
      );
    }
    // Validation precedes commitment: keep the question open and explain how to retry.
    const rejection = readQuestionRejection(error);
    if (rejection?.code === "INVALID_REQUEST" && rejection.reason === "QUESTION_INVALID_ANSWER") {
      const detail = error instanceof Error ? error.message.trim() : "";
      if (state) {
        state.admission = { status: "skipped", reason: "question-response-rejected" };
      }
      return questionErrorReply(
        `${
          detail
            ? `The answer was not accepted: ${detail}.`
            : "The answer was not accepted because a question is still unanswered."
        } The question is still open, so reply again and answer every question by number or question id.`,
      );
    }
    if (!(error instanceof QuestionAnswerUnconfirmedError)) {
      throw error;
    }
    unconfirmedAnswer = error.message;
  }

  // Publish custody before adoption can fail or cancel this incoming dispatch.
  // Neither outcome permits replay or aborting the independent question creator.
  if (state) {
    state.admission =
      unconfirmedAnswer !== undefined
        ? { status: "skipped", reason: "question-response-indeterminate" }
        : { status: "accepted", mode: "steer" };
  }
  try {
    await admitFollowupRunLifecycle(followupRun);
  } catch (error) {
    logVerbose(`question input adoption failed after custody transferred: ${String(error)}`);
  } finally {
    completeFollowupRunLifecycle(followupRun, "consumed");
  }
  return unconfirmedAnswer !== undefined
    ? questionErrorReply(unconfirmedAnswer)
    : { handled: true, payload: undefined };
}
