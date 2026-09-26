import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { assertAgentDatabaseTerminalOpenAllowed } from "../../state/openclaw-agent-db-lifecycle.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import { loadTranscriptReadSnapshotSync } from "./session-accessor.sqlite-read.js";
import {
  prepareSqliteTranscriptReadScope,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import {
  resolveSessionTranscriptReadFence,
  runWithSessionTranscriptReadFence,
} from "./session-transcript-read-fence.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import type { PreparedSessionTranscriptHydration } from "./session-transcript-worker.types.js";
import { captureSessionTranscriptTargetBinding } from "./transcript-target-binding.js";

/** Capture identity before queueing; a missing file remains the creation owner's responsibility. */
export function prepareSessionTranscriptHydration(
  source: SessionTranscriptRuntimeTarget & { env?: NodeJS.ProcessEnv },
  limits?: { maxBytes: number; maxEvents: number },
  signal?: AbortSignal,
) {
  const target = captureSessionTranscriptTargetBinding(source);
  const contextLimits = limits
    ? { maxBytes: limits.maxBytes, maxEvents: limits.maxEvents }
    : undefined;
  const receipt = resolveSessionTranscriptReadFence(target);
  const admission = receipt ? { ...receipt } : undefined;
  signal?.throwIfAborted();
  const incognitoOptions = isIncognitoSessionKey(target.sessionKey)
    ? toDatabaseOptions(resolveSqliteTranscriptReadScope(target))
    : undefined;
  const incognitoOwner = incognitoOptions
    ? getOpenClawAgentDatabaseIfOpen(incognitoOptions)
    : undefined;
  const assertCurrent = () => {
    if (incognitoOptions && getOpenClawAgentDatabaseIfOpen(incognitoOptions) !== incognitoOwner) {
      throw new Error("Session transcript incognito database owner is no longer current");
    }
  };
  const read = async (): Promise<PreparedSessionTranscriptHydration> => {
    signal?.throwIfAborted();
    // Incognito SQLite belongs to this process; never substitute another memory database.
    if (incognitoOptions) {
      return runWithSessionTranscriptReadFence(admission, () =>
        contextLimits
          ? {
              kind: "bounded",
              snapshot: readSessionTranscriptBoundedActiveContextCore(target, {
                ...contextLimits,
                readOnly: true,
              }),
            }
          : { kind: "full", snapshot: loadTranscriptReadSnapshotSync(target, { readOnly: true }) },
      );
    }
    const resolvedScope = await prepareSqliteTranscriptReadScope(target, signal);
    signal?.throwIfAborted();
    const options = toDatabaseOptions(resolvedScope);
    const databasePath = resolveOpenClawAgentSqlitePath(options);
    assertAgentDatabaseTerminalOpenAllowed(databasePath);
    try {
      const result = await withSessionHistoryWorkerDatabase(options, async (owner) => {
        try {
          return await owner.readTranscript(
            { target, resolvedScope, limits: contextLimits, admission },
            signal,
          );
        } finally {
          // An absent-store reply must not hide a revoked read owner.
          owner.assertCurrent();
        }
      });
      signal?.throwIfAborted();
      return result;
    } finally {
      assertAgentDatabaseTerminalOpenAllowed(databasePath);
    }
  };
  return { target, read, assertCurrent };
}
