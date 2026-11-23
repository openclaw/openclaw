import type { SessionRunStatus } from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
import { isSessionRunStateActive } from "../lib/session-run-state.ts";
export type ComposerRunOutcome = "ok" | "error" | "aborted";
export type ComposerActivity = "idle" | "busy" | "offline";

// The most recently active session with a terminal status decides how the
// pet reacts when the busy state clears: failures earn sympathy, not cheers.
export function resolveComposerRunOutcome(
  sessions:
    | ReadonlyArray<{
        status?: SessionRunStatus;
        endedAt?: number | null;
        lastActivityAt?: number | null;
        updatedAt?: number | null;
      }>
    | null
    | undefined,
): ComposerRunOutcome {
  let latest: { at: number; outcome: ComposerRunOutcome } | null = null;
  for (const row of sessions ?? []) {
    if (!row.status || row.status === "running") {
      continue;
    }
    // endedAt is the run-completion timestamp; activity/updated stamps also
    // move on unrelated events (reads, renames) and only serve as fallbacks.
    const at = row.endedAt ?? row.lastActivityAt ?? row.updatedAt ?? 0;
    if (!latest || at > latest.at) {
      const outcome: ComposerRunOutcome =
        row.status === "failed" || row.status === "timeout"
          ? "error"
          : row.status === "killed"
            ? "aborted"
            : "ok";
      latest = { at, outcome };
    }
  }
  return latest?.outcome ?? "ok";
}

export function resolveComposerActivity(
  connected: boolean,
  sessions: ReadonlyArray<{ hasActiveRun?: boolean; status?: SessionRunStatus }> | null | undefined,
): ComposerActivity {
  if (!connected) {
    return "offline";
  }
  return sessions?.some(isSessionRunStateActive) ? "busy" : "idle";
}

/** Both the new-session projection and the decoration input use the same session facts. */
export function composerDecorationFacts(
  context: import("../app/context.ts").ApplicationContext | undefined,
) {
  const rows = context?.sessions.state.result?.sessions;
  return {
    mode: resolveComposerActivity(!context?.gateway.snapshot.offlineStable, rows),
    runOutcome: resolveComposerRunOutcome(rows),
  };
}
