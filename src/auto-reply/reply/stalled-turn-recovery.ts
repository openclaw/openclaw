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
  "Your previous turn was interrupted. Continue the user's request from the transcript " +
  "and any newer message. Reconcile pending actions before retrying; do not repeat " +
  "completed work. Finish and verify the remaining work, or explain the blocker.";

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
