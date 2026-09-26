import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { assertAgentDatabaseTerminalOpenAllowed } from "../../state/openclaw-agent-db-lifecycle.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import { readSessionTranscriptCurrentTurnEntry } from "./session-accessor.sqlite-current-turn.js";
import { loadTranscriptReadSnapshotSync } from "./session-accessor.sqlite-read.js";
import {
  prepareSqliteTranscriptReadScope,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
  type ResolvedTranscriptReadScope,
} from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import {
  resolveSessionTranscriptReadFence,
  runWithSessionTranscriptReadFence,
} from "./session-transcript-read-fence.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import type {
  PreparedSessionTranscriptHydration,
  SessionHistoryWorkerDatabase,
  SessionTranscriptCurrentTurnEntryRead,
  SessionTranscriptCurrentTurnEntryRequest,
} from "./session-transcript-worker.types.js";
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
  const readInOwner = async <T>(
    readInProcess: () => T,
    readInWorker: (
      owner: SessionHistoryWorkerDatabase,
      resolvedScope: ResolvedTranscriptReadScope,
    ) => Promise<T>,
  ): Promise<T> => {
    signal?.throwIfAborted();
    // Incognito SQLite belongs to this process; never substitute another memory database.
    if (incognitoOptions) {
      return runWithSessionTranscriptReadFence(admission, readInProcess);
    }
    const resolvedScope = await prepareSqliteTranscriptReadScope(target, signal);
    signal?.throwIfAborted();
    const options = toDatabaseOptions(resolvedScope);
    const databasePath = resolveOpenClawAgentSqlitePath(options);
    assertAgentDatabaseTerminalOpenAllowed(databasePath);
    try {
      const result = await withSessionHistoryWorkerDatabase(options, async (owner) => {
        try {
          return await readInWorker(owner, resolvedScope);
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
  const read = (): Promise<PreparedSessionTranscriptHydration> =>
    readInOwner<PreparedSessionTranscriptHydration>(
      () =>
        contextLimits
          ? {
              kind: "bounded",
              snapshot: readSessionTranscriptBoundedActiveContextCore(target, {
                ...contextLimits,
                readOnly: true,
              }),
            }
          : { kind: "full", snapshot: loadTranscriptReadSnapshotSync(target, { readOnly: true }) },
      (owner, resolvedScope) =>
        owner.readTranscript({ target, resolvedScope, limits: contextLimits, admission }, signal),
    );
  const readCurrentTurnEntry = (
    input: SessionTranscriptCurrentTurnEntryRequest,
  ): Promise<SessionTranscriptCurrentTurnEntryRead> => {
    const request = {
      entryId: input.entryId,
      version: { ...input.version },
      includeEntry: input.includeEntry,
    };
    return readInOwner(
      () => readSessionTranscriptCurrentTurnEntry(target, { ...request, readOnly: true }),
      (owner, resolvedScope) =>
        owner.readCurrentTurnEntry({ ...request, target, resolvedScope, admission }, signal),
    );
  };
  return { target, read, readCurrentTurnEntry, assertCurrent };
}
