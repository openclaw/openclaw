import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { trimTranscriptForManualCompact } from "./session-accessor.sqlite-compaction.js";
import type {
  SessionTranscriptRuntimeScope,
  SessionTranscriptManualTrimResult,
  SessionTranscriptManualTrimPreflightResult,
} from "./session-accessor.types.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import { selectManualCompactTranscriptLines } from "./session-manual-compact-selection.js";
import { trimSessionTranscriptInWorker } from "./session-manual-compact.js";
import {
  prepareSessionSourceAuthority,
  releaseSessionSourceAuthorities,
  type SessionSourceAssertion,
} from "./session-source-authority.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";
import { readTranscriptStatsAsync } from "./session-transcript-stats.js";
import { resolveSessionWorkStartError } from "./session-work-start.js";
import { SessionWorkStartChangedError } from "./work-start-error.js";
export { persistCompactionBoundaryWithSessionEntrySync } from "./session-accessor.sqlite-compaction.js";
export { persistCompactionBoundaryWithSessionEntryAsync } from "./session-accessor.sqlite-compaction-runtime.js";
export { readTranscriptRawDelta } from "./session-accessor.sqlite-delta.js";
export { resolveSessionKeyBySessionId as resolveTranscriptSessionKeyBySessionId } from "./session-accessor.sqlite-entry.js";
export { publishTranscriptUpdate } from "./session-accessor.sqlite-events.js";
export {
  hasSessionTranscriptEventsSync,
  readTranscriptMutationAtSync,
  readTranscriptMutationStateSync,
} from "./session-accessor.sqlite-metadata-read.js";
export {
  inspectTranscriptEventsSync,
  loadLatestAssistantText as readLatestTranscriptAssistantText,
  loadTranscriptEventRowsAfterSeqSync,
  loadTranscriptEventsSync,
  loadTranscriptHeaderSync,
  readTranscriptExportSnapshotReadOnlySync,
  readTranscriptStatsBatchReadOnlySync,
  readTranscriptStatsSync,
  validatePreparedAssistantAppendSync,
  readTranscriptEventAtSeqSync,
  readTranscriptIdentityByEventId,
} from "./session-accessor.sqlite-read.js";
export { hasSessionTranscriptMessage } from "./session-transcript-message-presence.js";
export { loadTranscriptEvents } from "./session-transcript-events.js";
export {
  loadTranscriptSuffixEventsBoundedSync,
  readPreviousIndexedTranscriptEventSync,
} from "./session-accessor.sqlite-suffix-read.js";
export {
  rewriteAssistantTranscriptMessageForRun,
  rewriteTranscriptMessageAtAnchor,
} from "./session-accessor.sqlite-transcript-message-rewrite.js";
export { readSessionTranscriptMessageByEventId } from "./session-accessor.sqlite-transcript-store.js";
export {
  appendTranscriptEvent,
  appendTranscriptEventSync,
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  replaceTranscriptEvents,
  replaceTranscriptEventsSync,
  replaceSessionWithBranchedTranscript,
  replaceTranscriptSuffixEventsSync,
  rewriteTranscriptEventRowsExact,
  withTranscriptWriteLock,
  withTranscriptWriteTransaction,
} from "./session-accessor.sqlite-transcript-write.js";

export { emitSessionTranscriptUpdate as emitTranscriptUpdate } from "../../sessions/transcript-events.js";

/**
 * Trims a transcript for manual sessions.compact and clears stale token metadata.
 * This is one storage-sized mutation: future stores can trim transcript rows and
 * update entry metadata inside the same backend transaction.
 */
export async function preflightSessionTranscriptForManualCompact(
  scope: SessionTranscriptRuntimeScope,
  params: { maxLines: number; sessionFile?: string },
): Promise<SessionTranscriptManualTrimPreflightResult> {
  const { eventCount } = await readTranscriptStatsAsync(scope);
  if (eventCount === 0) {
    return { compacted: false, reason: "no transcript" };
  }

  const maxLines = Math.max(1, Math.floor(params.maxLines));
  return eventCount > maxLines ? { compacted: true } : { compacted: false, kept: eventCount };
}

type ManualCompactAuthority = {
  source: SessionSourceAssertion;
  assertHostCurrent: () => void;
  expectedLifecycleRevision: string | undefined;
  expectedSource?: CapturedSessionEntryReadSource;
};

export async function trimSessionTranscriptForManualCompact(
  scope: SessionTranscriptRuntimeScope,
  params: {
    maxLines: number;
    nowMs?: number;
    sessionFile?: string;
    authority?: ManualCompactAuthority;
  },
): Promise<SessionTranscriptManualTrimResult> {
  const authority = params.authority;
  if (!authority) {
    return withSessionTranscriptReadSource(
      scope,
      (captured) =>
        trimPreparedSessionTranscriptForManualCompact(
          { ...captured, sessionKey: scope.sessionKey },
          params,
        ),
      async ({ scope: captured, resolved, expectedIdentity, assertCurrent }) => {
        const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
        assertCurrent();
        await restoreSessionColdTranscript(captured, assertCurrent);
        assertCurrent();
        return trimSessionTranscriptInWorker(
          {
            ...resolved,
            sessionKey: resolved.sessionKey ?? scope.sessionKey,
            path: captured.storePath,
          },
          params,
          {
            assertCurrent,
            databaseIdentity: expectedIdentity?.key.slice("file:".length),
          },
        );
      },
    );
  }
  const assertEntryCurrent = (entry: Parameters<typeof resolveSessionWorkStartError>[1]) => {
    if (
      !entry ||
      entry.sessionId !== scope.sessionId ||
      entry.lifecycleRevision !== authority.expectedLifecycleRevision ||
      resolveSessionWorkStartError(scope.sessionKey, entry)
    ) {
      throw new SessionWorkStartChangedError("Session changed before compaction. Retry.");
    }
  };
  return withSessionTranscriptReadSource(
    scope,
    (captured) =>
      trimPreparedSessionTranscriptForManualCompact(
        { ...captured, sessionKey: scope.sessionKey },
        params,
        {
          assertEntryCurrent,
          assertCurrent: authority.source,
          assertCommitCurrent: authority.source,
          restore: async () => {
            const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
            authority.source();
            await restoreSessionColdTranscript(captured, authority.assertHostCurrent);
            authority.source();
          },
        },
      ),
    async ({ scope: captured, resolved, owner, expectedIdentity, assertCurrent: assertReader }) => {
      const expectedSource = authority.expectedSource;
      const assertPhysicalSource = () => {
        if (expectedSource && typeof expectedSource.databaseIdentity === "string") {
          if (captured.storePath !== expectedSource.path) {
            throw new Error("Session compaction changed its physical store");
          }
          assertExistingDatabaseIdentity(
            captured.storePath,
            `file:${expectedSource.databaseIdentity}`,
            expectedSource.databaseBirthtime,
          );
        }
      };
      assertPhysicalSource();
      const source = await prepareSessionSourceAuthority(authority.source);
      const nativeCommit = source.nativeSource || source.hasOpaqueCheck;
      try {
        const assertCurrent = () => {
          assertReader();
          assertPhysicalSource();
          authority.assertHostCurrent();
          if (source.assertPreparedCurrent) {
            source.assertPreparedCurrent();
          } else if (!nativeCommit) {
            source.assertCurrent();
          }
        };
        assertCurrent();
        const sources = source.checks.map(({ predicate }) => predicate);
        const read = await owner.readExactEntries({
          sessionKeys: [scope.sessionKey],
          projection: "exact",
          expectedIdentity: expectedIdentity && {
            ...expectedIdentity,
            canonicalPath: captured.storePath,
          },
          env: captured.env,
          manualCompact: { sessionId: resolved.sessionId, sources },
        });
        assertCurrent();
        const refused = read.manualCompact?.refusedSource;
        if (refused) {
          source.checks[refused.index]!.refuse(refused.facts);
        }
        assertEntryCurrent(read.entries[0]?.entry);
        if (nativeCommit) {
          authority.source();
        }
        const preparation = {
          snapshot: read.entries,
          assertEntryCurrent,
          assertCurrent,
          // Released opaque callbacks require their native transaction-local fence.
          assertCommitCurrent: () => {
            assertCurrent();
            authority.source();
          },
          restore: async () => {
            const {
              restoreSessionColdTranscript,
              SessionColdSourceReboundError,
              SessionColdTurnReboundError,
            } = await import("./session-cold-storage.js");
            assertCurrent();
            try {
              await restoreSessionColdTranscript(
                captured,
                assertCurrent,
                {
                  target: resolved,
                  readMetadata: async (phase) =>
                    phase === "initial"
                      ? read.manualCompact?.archive
                      : (
                          await owner.readColdMetadata({
                            sessionId: resolved.sessionId,
                            env: captured.env,
                          })
                        ).archive,
                },
                {
                  kind: "turn",
                  agentId: resolved.agentId,
                  sessionKey: scope.sessionKey,
                  options: {
                    keyFormat: "agent-qualified",
                    expectedSessionId: resolved.sessionId,
                    selectedSessionId: resolved.sessionId,
                    selectedLifecycleRevision: authority.expectedLifecycleRevision ?? null,
                  },
                  sources,
                  requireActive: true,
                },
              );
            } catch (error) {
              if (error instanceof SessionColdTurnReboundError) {
                throw new SessionWorkStartChangedError(error.message);
              }
              if (error instanceof SessionColdSourceReboundError) {
                source.checks[error.refusal.index]!.refuse(error.refusal.facts);
              }
              throw error;
            }
            assertCurrent();
          },
        };
        if (nativeCommit) {
          return await trimPreparedSessionTranscriptForManualCompact(
            { ...captured, sessionKey: scope.sessionKey },
            params,
            preparation,
          );
        }
        await preparation.restore();
        assertCurrent();
        return await trimSessionTranscriptInWorker(
          {
            ...resolved,
            sessionKey: resolved.sessionKey ?? scope.sessionKey,
            path: captured.storePath,
          },
          { maxLines: params.maxLines, nowMs: params.nowMs, entries: read.entries },
          {
            assertCurrent,
            source,
            databaseIdentity: expectedIdentity?.key.slice("file:".length),
          },
        );
      } finally {
        await releaseSessionSourceAuthorities([source]);
      }
    },
  );
}

async function trimPreparedSessionTranscriptForManualCompact(
  scope: SessionTranscriptRuntimeScope,
  params: { maxLines: number; nowMs?: number; sessionFile?: string },
  preparation?: NonNullable<Parameters<typeof trimTranscriptForManualCompact>[2]>["preparation"],
): Promise<SessionTranscriptManualTrimResult> {
  let declined: SessionTranscriptManualTrimResult = { compacted: false, reason: "no transcript" };
  const trimmed = await trimTranscriptForManualCompact(
    scope,
    (lines) => {
      const selected = selectManualCompactTranscriptLines(lines, params.maxLines);
      declined = selected.result;
      return selected.result.compacted ? selected.lines : null;
    },
    { nowMs: params.nowMs, preparation },
  );
  if (!trimmed.trimmed) {
    return declined;
  }

  return { compacted: true, kept: trimmed.kept };
}

export { findTranscriptEvent } from "./session-transcript-match.js";
