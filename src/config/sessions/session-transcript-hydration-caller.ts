import { AsyncContext } from "../../shared/async-context.js";

// Fixed owner names keep reader metrics independent of session and request data.
export type SessionTranscriptHydrationCaller =
  | "session-manager"
  | "model-open"
  | "model-reload"
  | "model-complete"
  | "committed-reload"
  | "compaction"
  | "preview"
  | "parent-fork"
  | "raw-events"
  | "correction"
  | "worker-input"
  | "worker-result"
  | "workspace-result"
  | "companion"
  | "cli-context"
  | "maintenance"
  | "memory-flush"
  | "export"
  | "reset-hook"
  | "btw"
  | "history-mutation"
  | "doctor"
  | "usage-diagnostic"
  | "cron-model"
  | "subagent-model";

const context = new AsyncContext<SessionTranscriptHydrationCaller>(
  Symbol.for("openclaw.sessionTranscriptHydrationCaller"),
);

export function getSessionTranscriptHydrationCaller(
  fallback: SessionTranscriptHydrationCaller = "session-manager",
): SessionTranscriptHydrationCaller {
  return context.getStore() ?? fallback;
}

export function withSessionTranscriptHydrationCaller<T>(
  caller: SessionTranscriptHydrationCaller,
  read: () => T,
): T {
  return context.run(caller, read);
}
