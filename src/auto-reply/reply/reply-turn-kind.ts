import type { ReplyTurnKind } from "./reply-run-registry.js";

export function resolveReplyTurnKind(opts?: {
  scheduledAutomation?: { job: { idleOnly?: boolean } };
  internalEventExecution?: unknown;
}): ReplyTurnKind {
  return opts?.scheduledAutomation?.job.idleOnly
    ? "background"
    : opts?.internalEventExecution
      ? "queued_followup"
      : "visible";
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
