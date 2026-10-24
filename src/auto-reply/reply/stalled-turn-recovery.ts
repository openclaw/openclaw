import type { ReplyOperation } from "../../sessions/session-controller.js";
import type { FollowupRun } from "./queue/types.js";
import { buildTranscriptFollowupRun } from "./transcript-followup-run.js";

/** Last-resort feedback once no continuation can answer a stalled turn. */
export const STALLED_TURN_NOTICE_TEXT =
  "⚠️ This turn was interrupted because it stopped making progress. Please try again.";
export const STALLED_TURN_GUIDANCE =
  "Your previous turn stopped making progress and was stopped before you replied, so the " +
  "user's request from that turn is still unanswered. Answer it now, together with any newer " +
  "message, from what the transcript already contains. " +
  "Keep further tool use to a minimum, do not repeat actions that already ran, and briefly " +
  "say what you could not verify.";

/** A stale watchdog expired this operation before it delivered output: the user saw nothing. */
export function isReplyOperationStalledBeforeOutput(
  operation: ReplyOperation | undefined,
): boolean {
  return (
    operation?.result?.kind === "failed" &&
    !operation.sourceReplyDelivered &&
    operation.result.code === "run_stalled" &&
    (operation.staleExpiryReason === "no_activity" ||
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
