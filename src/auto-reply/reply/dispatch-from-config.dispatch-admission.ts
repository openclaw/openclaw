import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
} from "../../sessions/session-controller.mailbox.js";
import { isNativeCommandTurn, resolveCommandTurnContext } from "../command-turn-context.js";
import type { SourceQuestionInputV1 } from "../source-question.types.js";
import type { PrepareDispatchOperationReadyState } from "./dispatch-from-config.prepare-operation.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import { readReplySourceInput } from "./reply-source-binding.js";
import { resolveReplyTurnKind } from "./reply-turn-kind.js";

/** Acquires the dispatch-phase reply operation, or returns the refused dispatch result. */
export async function acquireDispatchTurn(state: PrepareDispatchOperationReadyState) {
  const phase = state.activeRunSafeCommandTurn ? "command_resolution" : "dispatch";
  const acquisition = await state.traceReplyPhase(`reply.admit_${phase}`, () =>
    state.ensureDispatchReplyOperation(phase),
  );
  if (acquisition.status === "aborted") {
    return { status: "complete" as const, result: state.finishReplyOperationAbortedDispatch() };
  }
  if (acquisition.status === "busy") {
    return {
      status: "complete" as const,
      result: state.finishReplyOperationBusyDispatch({ dedupeDisposition: "release" }),
    };
  }
  return undefined;
}

/**
 * The ACP takeover runs its turn, so it is admitted before the takeover. Admission leaves a
 * busy session's source unclaimed for queue policy, which ACP does not apply; the source
 * waits for its own mailbox claim instead, so its turn never queues behind it.
 */
export async function acquireAcpDispatchTurn(state: PrepareDispatchOperationReadyState) {
  const sourceInput = state.params.replyOptions?.sourceQuestionInput;
  if (sourceInput?.mode === "answer-only") {
    return {
      status: "source-question-refused" as const,
      result: await refuseReplyHookQuestionInput(state, sourceInput),
    };
  }
  const refusal = await acquireDispatchTurn(state);
  const replyOptions = state.params.replyOptions;
  const input = readReplySourceInput(replyOptions);
  // Controls resolve before any target turn; releasing a speculative claim would retire their source.
  if (
    refusal ||
    state.activeRunSafeCommandTurn ||
    isNativeCommandTurn(resolveCommandTurnContext(state.ctx)) ||
    state.getDispatchReplyOperation() ||
    input?.phase !== "preparing"
  ) {
    return refusal;
  }
  try {
    await claimSessionControllerTask(input, () => {}, resolveReplyTurnKind(replyOptions));
  } catch {
    return { status: "complete" as const, result: state.finishReplyOperationAbortedDispatch() };
  }
  const claimedRefusal = await acquireDispatchTurn(state);
  // A claim no operation adopted would hold the mailbox after this dispatch ends.
  if (!state.getDispatchReplyOperation() && input.claim) {
    releaseSessionControllerClaim(input.claim);
  }
  return claimedRefusal;
}

/** A hook without the native source seam must consume refusal before acquiring an execution. */
export async function refuseReplyHookQuestionInput(
  state: PrepareDispatchOperationReadyState,
  input: Extract<SourceQuestionInputV1, { mode: "answer-only" }>,
) {
  const runState = resolveReplyOperationRunState(state.params.replyOptions);
  if (runState) {
    runState.questionInputHandled = true;
    runState.admission = { status: "skipped", reason: "question-response-refused" };
  }
  await input.onReceipt({ status: "refused", reason: "unsupported" });
  state.recordProcessed("error", { reason: "source_question_takeover_unsupported" });
  state.markIdle("message_error");
  return { handled: true as const, queuedFinal: false, counts: state.dispatcher.getQueuedCounts() };
}
