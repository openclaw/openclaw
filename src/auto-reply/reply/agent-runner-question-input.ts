import {
  QuestionAnswerUnconfirmedError,
  QuestionDispatchRefusedError,
  QuestionDispatchUnsupportedError,
} from "../../agents/harness/gateway-question-dispatch.js";
import { claimPendingAgentQuestionAnswerFromCaller } from "../../agents/harness/gateway-question.js";
import { readQuestionRejection } from "../../agents/tools/gateway-question-lifecycle.js";
import { logVerbose } from "../../globals.js";
import { beginSessionControllerSourceInjection } from "../../sessions/session-controller.mailbox.js";
import { isExplicitFollowupCommandTurn } from "../command-turn-context.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { SourceQuestionAnswerReceiptV1 } from "../source-question.types.js";
import type { ReplyPayload } from "../types.js";
import type { RunReplyAgentParams } from "./agent-runner-core.js";
import { admitFollowupRunLifecycle, completeFollowupRunLifecycle } from "./queue/lifecycle.js";
import { resolveFollowupAbortSignal } from "./queue/types.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import { resolveInboundReplyToolAuthorityOverlay } from "./reply-tool-authority.js";

type ReplyQuestionInputParams = Pick<
  RunReplyAgentParams,
  | "steeringIntent"
  | "commandBody"
  | "transcriptCommandBody"
  | "followupRun"
  | "opts"
  | "resetTriggered"
  | "sessionCtx"
  | "sessionEntry"
  | "sessionKey"
>;

/** Question-only runtimes accept answers without exposing ordinary steering. */
export async function runReplyQuestionInput(
  params: ReplyQuestionInputParams,
): Promise<
  | { handled: false; requesterMismatch?: true }
  | { handled: true; payload: ReplyPayload | undefined }
> {
  const { followupRun, opts, sessionKey } = params;
  const source = opts?.sourceQuestionInput;
  const answerOnly = source?.mode === "answer-only" ? source : undefined;
  const state = resolveReplyOperationRunState(opts);
  const finishAnswer = async (receipt: SourceQuestionAnswerReceiptV1) => {
    if (state) {
      state.questionInputHandled = true;
      if (receipt.status !== "confirmed") {
        state.admission = { status: "skipped", reason: "question-response-refused" };
      }
    }
    await answerOnly?.onReceipt(receipt);
    return { handled: true as const, payload: undefined };
  };
  if (source?.mode === "new-task") {
    return { handled: false };
  }
  const external =
    followupRun.run.inputProvenance === undefined ||
    followupRun.run.inputProvenance.kind === "external_user";
  const rawText =
    params.transcriptCommandBody ?? followupRun.transcriptPrompt ?? params.commandBody;
  const text = answerOnly ? rawText : rawText.trim();
  if (
    !sessionKey ||
    params.steeringIntent?.kind === "new-execution" ||
    params.resetTriggered ||
    isExplicitFollowupCommandTurn(params.sessionCtx) ||
    opts?.messageInjectionDisposition === "accepted" ||
    !external ||
    (!text && !answerOnly) ||
    followupRun.images?.length ||
    followupRun.media?.length
  ) {
    return answerOnly
      ? finishAnswer({ status: "refused", reason: "source-refused" })
      : { handled: false };
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
    opts?.assertChannelAuthority?.();
    followupRun.controllerInput?.abortSignal.throwIfAborted();
    sourceAbort?.throwIfAborted();
    queuedAbort?.throwIfAborted();
    followupRun.operatorAuthority?.assertCurrent();
  };
  const injection =
    followupRun.controllerInput && !followupRun.controllerInput.claim
      ? beginSessionControllerSourceInjection(followupRun.controllerInput, {
          // A negative question probe can still continue into ordinary steering.
          // Keep this source's FIFO barrier until that final injection decision.
          keepOrderOnDecline: true,
        })
      : undefined;
  let consumed = false;
  let confirmedResolutionId: string | undefined;
  try {
    if (injection && !(await injection.admit())) {
      // Only a cancelled source is finished here; one whose steer was declined stays queued input.
      const controllerSource = followupRun.controllerInput;
      if (answerOnly) {
        return finishAnswer({ status: "refused", reason: "source-refused" });
      }
      return controllerSource?.retirementRequested || controllerSource?.abortSignal.aborted
        ? { handled: true, payload: undefined }
        : { handled: false };
    }
    let outcome: { status: "answered" } | { status: "indeterminate"; errorMessage: string };
    try {
      const claimed = await claimPendingAgentQuestionAnswerFromCaller({
        sessionKey,
        text,
        caller,
        assertSourceCurrent,
        sourceRecorder: followupRun.userTurnTranscriptRecorder,
        sourceQuestion: answerOnly?.question,
        onConfirmed: (resolutionId) => {
          confirmedResolutionId = resolutionId;
        },
        onAnswerProcessed: () => {
          consumed = true;
          injection?.accepted(true);
          if (state) {
            state.questionInputHandled = true;
          }
        },
      });
      if (claimed === "requester-mismatch") {
        return answerOnly
          ? finishAnswer({ status: "refused", reason: "source-refused" })
          : { handled: false, requesterMismatch: true };
      }
      if (!claimed) {
        return answerOnly
          ? finishAnswer({ status: "refused", reason: "stale-question" })
          : { handled: false };
      }
      outcome = { status: "answered" };
    } catch (error) {
      if (error instanceof QuestionDispatchUnsupportedError) {
        if (answerOnly) {
          return finishAnswer({ status: "refused", reason: "unsupported" });
        }
        assertSourceCurrent();
        return { handled: false };
      }
      if (error instanceof QuestionDispatchRefusedError) {
        if (answerOnly) {
          return finishAnswer({ status: "refused", reason: "source-refused" });
        }
        if (state) {
          state.admission = { status: "skipped", reason: "question-response-refused" };
        }
        return {
          handled: true,
          payload: markReplyPayloadForSourceSuppressionDelivery({
            text: `The answer was not sent: ${error.message}. Use the question controls in the Control UI, or check the active run and your permissions before retrying.`,
            isError: true,
          }),
        };
      }
      // Validation precedes commitment: keep the question open and explain how to retry.
      const rejection = readQuestionRejection(error);
      if (rejection?.code === "INVALID_REQUEST" && rejection.reason === "QUESTION_INVALID_ANSWER") {
        if (answerOnly) {
          return finishAnswer({ status: "refused", reason: "invalid-answer" });
        }
        const detail = error instanceof Error ? error.message.trim() : "";
        if (state) {
          state.admission = { status: "skipped", reason: "question-response-rejected" };
        }
        return {
          handled: true,
          payload: markReplyPayloadForSourceSuppressionDelivery({
            text: `${
              detail
                ? `The answer was not accepted: ${detail}.`
                : "The answer was not accepted because a question is still unanswered."
            } The question is still open, so reply again and answer every question by number or question id.`,
            isError: true,
          }),
        };
      }
      if (!(error instanceof QuestionAnswerUnconfirmedError)) {
        if (answerOnly) {
          return finishAnswer({ status: "unconfirmed" });
        }
        throw error;
      }
      outcome = { status: "indeterminate", errorMessage: error.message };
    }
    consumed = true;

    // Publish custody before adoption can fail or cancel this incoming dispatch.
    // Neither outcome permits replay or aborting the independent question creator.
    if (state) {
      state.admission =
        outcome.status === "indeterminate"
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
    if (answerOnly) {
      return finishAnswer(
        confirmedResolutionId
          ? { status: "confirmed", resolutionId: confirmedResolutionId }
          : { status: "unconfirmed" },
      );
    }
    return {
      handled: true,
      payload:
        outcome.status === "indeterminate"
          ? markReplyPayloadForSourceSuppressionDelivery({
              text: outcome.errorMessage,
              isError: true,
            })
          : undefined,
    };
  } finally {
    // claimPendingAgentQuestionAnswerFromCaller owns the real dispatch and
    // transcript receipt. Source cancellation cannot settle that work early.
    injection?.finish(consumed);
  }
}
