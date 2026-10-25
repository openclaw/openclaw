import type { ReplyTurnKind } from "../../sessions/session-controller.js";

export function resolveReplyTurnKind(opts?: { internalEventExecution?: unknown }): ReplyTurnKind {
  return opts?.internalEventExecution ? "queued_followup" : "visible";
}

export function resolveReplyRunTrigger(turn: {
  followupRun: { run: { internalEventExecution?: unknown; scheduledAutomation?: unknown } };
}) {
  return turn.followupRun.run.scheduledAutomation
    ? "cron"
    : turn.followupRun.run.internalEventExecution
      ? "event"
      : "user";
}
