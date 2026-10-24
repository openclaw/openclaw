import { prepareSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  sqliteSessionIdWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { preparePriorWorkspaceRewriteInTransaction } from "./session-accessor.sqlite-prior-workspace.js";
import { readTranscriptEventId } from "./session-accessor.sqlite-read.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import type { TranscriptRewriteOptions } from "./session-accessor.sqlite-transcript-rewrite.types.js";
import {
  readTranscriptMutationStateInTransaction,
  recordTranscriptReplacementMutation,
  rotateTranscriptGenerationInTransaction,
  touchTranscriptMutationInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import { rewriteSessionActorContextStats } from "./session-actor-context-metadata.js";
import { withSessionActorTranscriptRewrite } from "./session-actor-transcript-publication.worker.js";
import { modelContextPageWriteScope } from "./session-model-context-pages.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import {
  markSessionTranscriptIndexDirtyInTransaction,
  sessionTranscriptIndexNeedsReconcile,
  shouldRebuildSessionTranscriptIndexSynchronously,
} from "./session-transcript-index.js";
import { reconcileRewrittenTranscriptIndex } from "./session-transcript-reconcile.js";
import {
  transcriptRewritePreservesAdmission,
  transcriptRewritePreservesProjection,
} from "./session-transcript-rewrite-effects.js";
import { canonicalizeTranscriptEventMedia } from "./transcript-event-media.js";
import {
  createTranscriptPayloadUpdater,
  prepareTranscriptPayload,
  transcriptEventJsonSql,
  transcriptSerializedBytes,
} from "./transcript-payload.js";

/** Rewrite existing transcript rows exactly, without append-time deduplication. */
export function rewriteSqliteTranscriptEventRowsInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  rows: readonly {
    event: TranscriptEvent;
    expectedEventJson: string;
    seq: number;
  }[],
  options: TranscriptRewriteOptions = {},
): string | undefined {
  if (rows.length === 0) {
    return undefined;
  }
  const writeScopes = new Set([resolved.sessionKey, sqliteSessionIdWriteScope(resolved.sessionId)]);
  const rewrites = rows.map((row) => {
    writeScopes.add(modelContextPageWriteScope(resolved.sessionId, row.seq));
    const eventJson = JSON.stringify(canonicalizeTranscriptEventMedia(row.event));
    return {
      ...row,
      eventJson,
      payload: options.legacyTextStorage
        ? undefined
        : prepareTranscriptPayload(database.db, eventJson),
    };
  });
  const projectionUnchanged =
    (options.projectionCurrent ||
      !sessionTranscriptIndexNeedsReconcile(database.db, resolved.sessionId)) &&
    rewrites.every((row) =>
      transcriptRewritePreservesProjection(row.expectedEventJson, row.eventJson),
    );
  const rebuildSynchronously =
    !options.legacyTextStorage &&
    !projectionUnchanged &&
    shouldRebuildSessionTranscriptIndexSynchronously(database.db, resolved.sessionId);
  const admissionUnchanged = rewrites.every((row) =>
    transcriptRewritePreservesAdmission(row.expectedEventJson, row.eventJson),
  );
  const run = () =>
    withSqliteDatabaseWriteScope(database.db, [...writeScopes], () => {
      // Pre-trajectory media repair precedes admission of the current session-row schema.
      const priorWorkspace =
        admissionUnchanged || options.legacyTextStorage
          ? undefined
          : preparePriorWorkspaceRewriteInTransaction(database, resolved);
      const db = getSessionKysely(database.db);
      const rewrite = prepareSqliteQuerySync<(typeof rewrites)[number]>(database.db, (parameter) =>
        db
          .updateTable("transcript_events")
          .set(
            options.legacyTextStorage
              ? { event_json: parameter((row) => row.eventJson) }
              : {
                  event_json: parameter((row) => row.payload!.event_json),
                  event_zstd: parameter((row) => row.payload!.event_zstd),
                  event_utf8_bytes: parameter((row) => row.payload!.event_utf8_bytes),
                  navigation_json: parameter((row) => row.payload!.navigation_json),
                  navigation_type: parameter((row) => row.payload!.navigation_type),
                  navigation_custom_type: parameter((row) => row.payload!.navigation_custom_type),
                  navigation_display: parameter((row) => row.payload!.navigation_display),
                  message_role: parameter((row) => row.payload!.message_role),
                  navigation_last_type: parameter((row) => row.payload!.navigation_last_type),
                  navigation_last_custom_type: parameter(
                    (row) => row.payload!.navigation_last_custom_type,
                  ),
                  navigation_valid: parameter((row) => row.payload!.navigation_valid),
                },
          )
          .where("session_id", "=", resolved.sessionId)
          .where(
            "seq",
            "=",
            parameter((row) => row.seq),
          )
          .where(
            options.legacyTextStorage ? "event_json" : transcriptEventJsonSql(database.db),
            "=",
            parameter((row) => row.expectedEventJson),
          ),
      );
      for (const row of rewrites) {
        const result = rewrite(row);
        if (result.numAffectedRows !== 1n) {
          throw new SqliteTranscriptMutationConflictError(resolved.sessionId);
        }
      }
      rewriteSessionActorContextStats(database, resolved, rewrites, projectionUnchanged);
      // Correlation and identical prompt captures preserve admitted input; other
      // payload rewrites still invalidate admissions and cursors.
      const generation = admissionUnchanged
        ? undefined
        : rotateTranscriptGenerationInTransaction(database, resolved.sessionId);
      if (
        priorWorkspace &&
        generation &&
        rewrites.every(
          (row) =>
            readTranscriptEventId(JSON.parse(row.expectedEventJson)) ===
            readTranscriptEventId(row.event),
        )
      ) {
        priorWorkspace.commit(generation);
      }
      if (!projectionUnchanged) {
        if (options.legacyTextStorage) {
          // Media Doctor rebuilds after the physical storage migration; schema-22 readers
          // cannot inspect an older TEXT-only transcript table during this repair.
          markSessionTranscriptIndexDirtyInTransaction(database.db, resolved.sessionId);
        } else {
          reconcileRewrittenTranscriptIndex(database, resolved.sessionId, rebuildSynchronously);
        }
      }
      if (options.touchMutation !== false) {
        touchTranscriptMutationInTransaction(database, resolved.sessionId);
      }
      return generation;
    });
  return projectionUnchanged && admissionUnchanged
    ? withSessionActorTranscriptRewrite(
        database,
        {
          sessionKey: resolved.sessionKey,
          sessionId: resolved.sessionId,
          rows: rewrites.map((row) => ({
            rawSeq: row.seq,
            event: JSON.parse(row.eventJson),
            serializedBytes: transcriptSerializedBytes(database.db, row.eventJson),
          })),
        },
        run,
      )
    : run();
}

// Preserves seq, created_at, session_key, and session activity recency; rotates the transcript
// generation and rebuilds bounded projections immediately or defers large projections.
// `indexUnchanged` is for rewrites that keep every indexed fact (searchable text, tree links,
// active events, context eligibility); the index stays current and is not rebuilt.
export function updateSqliteTranscriptEventJsonInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
  updates: ReadonlyArray<{ seq: number; eventJson: string }>,
  options: { indexUnchanged?: boolean } = {},
): void {
  if (updates.length === 0) {
    return;
  }
  return withSqliteDatabaseWriteScope(database.db, [sqliteSessionIdWriteScope(sessionId)], () => {
    const priorWorkspace = preparePriorWorkspaceRewriteInTransaction(database, { sessionId });
    const rebuildSynchronously =
      !options.indexUnchanged &&
      shouldRebuildSessionTranscriptIndexSynchronously(database.db, sessionId);
    const update = createTranscriptPayloadUpdater(database.db, sessionId);
    for (const row of updates) {
      update({ seq: row.seq, ...prepareTranscriptPayload(database.db, row.eventJson) });
    }
    const generation = rotateTranscriptGenerationInTransaction(database, sessionId);
    priorWorkspace?.commit(generation);
    if (!options.indexUnchanged) {
      reconcileRewrittenTranscriptIndex(database, sessionId, rebuildSynchronously);
    }
    recordTranscriptReplacementMutation(
      database,
      sessionId,
      readTranscriptMutationStateInTransaction(database, sessionId).updatedAt,
    );
  });
}
