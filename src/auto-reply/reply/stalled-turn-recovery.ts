import type { ReplyOperation } from "../../sessions/session-controller.js";
import type { FollowupRun } from "./queue/types.js";
import { buildTranscriptFollowupRun } from "./transcript-followup-run.js";

const STALLED_TURN_NOTICE_TEXT =
  "⚠️ This turn was interrupted because it stopped making progress. Please try again.";
const RATE_LIMITED_TURN_NOTICE_TEXT =
  "⚠️ This turn was stopped while the model provider was rate-limiting requests. Please try again in a few minutes.";

/** Last-resort feedback once no continuation can answer a stalled turn. */
export function resolveStalledTurnNoticeText(operation: ReplyOperation | undefined): string {
  return operation?.staleExpiryReason === "rate_limited"
    ? RATE_LIMITED_TURN_NOTICE_TEXT
    : STALLED_TURN_NOTICE_TEXT;
}

export const STALLED_TURN_GUIDANCE =
  "Your previous turn stopped making progress and was interrupted. Resume the user's " +
  "unfinished request from the transcript, honoring any newer instructions and current " +
  "tool permissions. First reconcile pending tool calls and actions whose outcomes are " +
  "unknown; do not repeat completed actions. Use the tools needed to finish and verify " +
  "the remaining work instead of ending with an incomplete status summary. Do not ask " +
  "the user to say continue merely because the previous turn was interrupted. If the " +
  "request is already complete, provide its result. If a real blocker or required " +
  "approval prevents further work, explain what is needed and what remains unverified.";

/** A stale watchdog expired this operation before it delivered output: the user saw nothing. */
export function isReplyOperationStalledBeforeOutput(
  operation: ReplyOperation | undefined,
): boolean {
  return (
    operation?.result?.kind === "failed" &&
    !operation.sourceReplyDelivered &&
    operation.result.code === "run_stalled" &&
    (operation.staleExpiryReason === "no_activity" ||
      operation.staleExpiryReason === "rate_limited" ||
      operation.staleExpiryReason === "stuck_recovery")
  );
}

/** Builds the one recovery run that answers a stalled turn over its persisted transcript. */
export function buildStalledTurnRecoveryRun(base: FollowupRun, guidance?: string): FollowupRun {
  return {
    ...buildTranscriptFollowupRun(base, {
      prompt: guidance ?? STALLED_TURN_GUIDANCE,
      sourceTool: "stalled-turn-recovery",
      expiredSkillAuthoringMessage:
        "Skill authoring is unavailable while recovering an interrupted turn. Send a fresh message requesting the change.",
    }),
    summaryLine: "stalled-turn-recovery",
    stalledTurnRecovery: true,
    // The aborted dispatch's signal must not cancel its recovery turn.
    abortSignal: undefined,
  };
}
