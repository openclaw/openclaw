import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { trimTranscriptForManualCompact } from "./session-accessor.sqlite-transcript-write.js";
import type {
  SessionTranscriptRuntimeScope,
  SessionTranscriptManualTrimResult,
  SessionTranscriptManualTrimPreflightResult,
} from "./session-accessor.types.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import {
  prepareSessionSourceAuthority,
  releaseSessionSourceAuthorities,
  type SessionSourceAssertion,
} from "./session-source-authority.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";
import { readTranscriptStatsAsync } from "./session-transcript-stats.js";
import { resolveSessionWorkStartError } from "./session-work-start.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";
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
    return trimPreparedSessionTranscriptForManualCompact(scope, params);
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
      try {
        const assertCurrent = () => {
          assertReader();
          assertPhysicalSource();
          authority.assertHostCurrent();
          if (source.assertPreparedCurrent) {
            source.assertPreparedCurrent();
          } else if (!source.nativeSource) {
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
        if (source.nativeSource) {
          authority.source();
        }
        return await trimPreparedSessionTranscriptForManualCompact(
          { ...captured, sessionKey: scope.sessionKey },
          params,
          {
            snapshot: read.entries,
            assertEntryCurrent,
            assertCurrent,
            // maxLines still writes natively; released callbacks remain on that transaction.
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
  const maxLines = Math.max(1, Math.floor(params.maxLines));
  const maxTailLines = Math.max(0, maxLines - 1);
  let declined: SessionTranscriptManualTrimResult = { compacted: false, reason: "no transcript" };
  const trimmed = await trimTranscriptForManualCompact(
    scope,
    (lines) => {
      if (lines.length === 0) {
        declined = { compacted: false, reason: "no transcript" };
        return null;
      }
      if (lines.length <= maxLines) {
        declined = { compacted: false, kept: lines.length };
        return null;
      }
      const tailLines = lines.slice(1);
      const retainedLines = normalizeManualCompactTranscriptLines(
        lines[0],
        maxTailLines > 0 ? tailLines.slice(-maxTailLines) : [],
      );
      if (!retainedLines) {
        declined = { compacted: false, kept: 0 };
        return null;
      }
      return retainedLines;
    },
    { nowMs: params.nowMs, preparation },
  );
  if (!trimmed.trimmed) {
    return declined;
  }

  return { compacted: true, kept: trimmed.kept };
}

function normalizeManualCompactTranscriptLines(
  headerLine: string | undefined,
  tailLines: readonly string[],
): string[] | null {
  if (!headerLine) {
    return null;
  }
  const header = safeParseJsonRecord(headerLine);
  if (header?.type !== "session" || typeof header.id !== "string") {
    return null;
  }

  const records = tailLines
    .map(safeParseJsonRecord)
    .filter((record): record is Record<string, unknown> => record !== undefined);
  const retainedIds = new Set<string>();
  const transparentParents = new Map<string, string | null>();
  const normalizedRecords: Record<string, unknown>[] = [];
  for (const record of records) {
    let parentId = record.parentId;
    const seenTransparentParents = new Set<string>();
    while (
      typeof parentId === "string" &&
      transparentParents.has(parentId) &&
      !seenTransparentParents.has(parentId)
    ) {
      seenTransparentParents.add(parentId);
      parentId = transparentParents.get(parentId) ?? null;
    }
    let next =
      typeof parentId === "string" && !retainedIds.has(parentId)
        ? { ...record, parentId: null }
        : parentId !== record.parentId
          ? { ...record, parentId }
          : record;
    if (next.type === "leaf") {
      const targetId = next.targetId;
      const validTargetId =
        targetId === null || (typeof targetId === "string" && targetId.trim().length > 0);
      if (!validTargetId && typeof next.id === "string") {
        transparentParents.set(
          next.id,
          next.parentId === null || typeof next.parentId === "string" ? next.parentId : null,
        );
      }
      if (typeof targetId === "string" && targetId.trim() && !retainedIds.has(targetId)) {
        // The selected branch fell outside the retained window. Select an
        // empty root instead of accidentally activating abandoned or side rows.
        next = { ...next, targetId: null, appendParentId: null };
      } else if (
        validTargetId &&
        typeof next.appendParentId === "string" &&
        !retainedIds.has(next.appendParentId)
      ) {
        next = { ...next, appendParentId: targetId };
      }
    }
    if ((next.type === "compaction" || next.type === "reset") && typeof next.id === "string") {
      const firstKeptEntryId = next.firstKeptEntryId;
      if (typeof firstKeptEntryId === "string" && firstKeptEntryId !== next.id) {
        const tree = scanSessionTranscriptTree([...normalizedRecords, next]);
        const branchPath = selectSessionTranscriptTreePathNodes(tree, next.id);
        if (!branchPath.some((node) => node.id === firstKeptEntryId)) {
          // Replay starts at the earliest retained entry on this compaction's
          // normalized branch, never at an abandoned row earlier in file order.
          next = { ...next, firstKeptEntryId: branchPath[0]?.id ?? next.id };
        }
      }
    }
    normalizedRecords.push(next);
    if (typeof next.id === "string" && next.id.trim()) {
      retainedIds.add(next.id);
    }
  }
  return [JSON.stringify(header), ...normalizedRecords.map((record) => JSON.stringify(record))];
}

export { findTranscriptEvent } from "./session-transcript-match.js";
