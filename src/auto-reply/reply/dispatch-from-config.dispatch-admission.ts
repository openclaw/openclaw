import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
} from "../../sessions/session-controller.mailbox.js";
import { isNativeCommandTurn, resolveCommandTurnContext } from "../command-turn-context.js";
import type { PrepareDispatchOperationReadyState } from "./dispatch-from-config.prepare-operation.js";
import { readReplySourceInput } from "./reply-source-binding.js";
import { resolveReplyTurnKind } from "./reply-turn-kind.js";

/** Only an eligible ACP takeover may consume an answer before acquiring a normal turn. */
export async function resolveAcpQuestionTakeover(state: PrepareDispatchOperationReadyState) {
  const sessionKey = state.acpDispatchSessionKey;
  if (
    state.dispatchKind !== "acp" ||
    !state.allowInboundHandlers ||
    state.sendPolicyDenied ||
    !sessionKey ||
    !state.hookRunner?.hasHooks("reply_dispatch", { dispatchKind: "acp" })
  ) {
    return undefined;
  }
  const { tryAnswerBoundAcpQuestion } = await import("./acp-channel-question-input.js");
  const answer = await state.runWithDispatchLifecycleAdmission(() =>
    tryAnswerBoundAcpQuestion(state, sessionKey),
  );
  if (!answer) {
    return undefined;
  }
  return {
    payload: answer.error ? { text: answer.error, isError: true } : {},
    deliveryId: "acp-question-input",
    recordProcessed: () =>
      state.recordProcessed(answer.error ? "error" : "completed", { reason: answer.reason }),
  };
}

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
