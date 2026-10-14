import { cliBackendSupportsSessionFork } from "../agents/cli-backends.js";
import { buildMainSessionRecoveryClearPatch } from "../agents/main-session-recovery/main-session-recovery-clear.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { forkCliSessionBindings } from "../config/sessions/cli-session-binding.js";

export function buildForkedGatewaySessionEntry(
  entry: SessionEntry,
  fork: { sessionId: string; sessionFile: string },
  parent: { sessionKey: string; entry: SessionEntry },
  previousEntry?: SessionEntry,
): SessionEntry {
  // Replacing the transcript identity also replaces the recovery episode owned by the old row.
  return {
    ...entry,
    ...buildMainSessionRecoveryClearPatch(entry),
    sessionId: fork.sessionId,
    lifecycleRunId: undefined,
    lastRunId: undefined,
    forkSource: previousEntry?.forkSource ?? {
      sessionKey: parent.sessionKey,
      sessionId: parent.entry.sessionId,
    },
    ...(previousEntry?.sessionId && previousEntry.sessionId !== fork.sessionId
      ? { previousSessionId: previousEntry.sessionId }
      : {}),
    totalTokens: undefined,
    totalTokensFresh: false,
    totalTokensVersion: undefined,
    // Native CLI backends keep their own context; branch it alongside the transcript.
    // Legacy ids are dropped too, so a reused target cannot resume an unrelated session.
    cliSessionBindings: forkCliSessionBindings(parent.entry, cliBackendSupportsSessionFork),
    cliSessionIds: undefined,
    claudeCliSessionId: undefined,
  };
}
