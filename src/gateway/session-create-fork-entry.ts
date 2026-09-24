import { buildMainSessionRecoveryClearPatch } from "../agents/main-session-recovery/main-session-recovery-clear.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { forkCliSessionBindings } from "../config/sessions/cli-session-binding.js";

export function buildForkedGatewaySessionEntry(
  entry: SessionEntry,
  fork: { sessionId: string; sessionFile: string },
  forkSource: NonNullable<SessionEntry["forkSource"]>,
  previousEntry?: SessionEntry,
  parentEntry?: SessionEntry,
): SessionEntry {
  // Replacing the transcript identity also replaces the recovery episode owned by the old row.
  return {
    ...entry,
    ...buildMainSessionRecoveryClearPatch(entry),
    sessionId: fork.sessionId,
    lifecycleRunId: undefined,
    lastRunId: undefined,
    forkSource: previousEntry?.forkSource ?? forkSource,
    ...(previousEntry?.sessionId && previousEntry.sessionId !== fork.sessionId
      ? { previousSessionId: previousEntry.sessionId }
      : {}),
    totalTokens: undefined,
    totalTokensFresh: false,
    totalTokensVersion: undefined,
    // Native CLI backends keep their own context; branch it alongside the transcript.
    // Legacy ids are dropped too, so a reused target cannot resume an unrelated session.
    ...(parentEntry
      ? {
          cliSessionBindings: forkCliSessionBindings(parentEntry),
          cliSessionIds: undefined,
          claudeCliSessionId: undefined,
        }
      : {}),
  };
}
