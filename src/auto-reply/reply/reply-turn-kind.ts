import type { ReplyTurnKind } from "../../sessions/session-controller.js";

export function resolveReplyTurnKind(opts?: {
  isHeartbeat?: boolean;
  internalEventExecution?: unknown;
}): ReplyTurnKind {
  return opts?.isHeartbeat === true
    ? "heartbeat"
    : opts?.internalEventExecution
      ? "queued_followup"
      : "visible";
}

export function resolveReplyRunTrigger(turn: {
  isHeartbeat: boolean;
  followupRun: { run: { internalEventExecution?: unknown; scheduledAutomation?: unknown } };
}) {
  return turn.isHeartbeat
    ? "heartbeat"
    : turn.followupRun.run.scheduledAutomation
      ? "cron"
      : turn.followupRun.run.internalEventExecution
        ? "event"
        : "user";
}
