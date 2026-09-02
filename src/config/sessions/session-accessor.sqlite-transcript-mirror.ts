/* oxlint-disable eslint/curly -- Keep bounded fallback scans and guards compact. */
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  readTranscriptEventMessage,
  readTranscriptEventRows,
} from "./session-accessor.sqlite-read.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchorInTransaction } from "./session-accessor.sqlite-transcript-anchor.js";
import { resolveTranscriptMessageAppendParent } from "./session-accessor.sqlite-transcript-parent.js";
import { readTranscriptGenerationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import {
  readMessageIdempotencyKey,
  readTranscriptEventIdentity,
} from "./session-accessor.sqlite-transcript-store.js";
import { visitSessionTranscriptProjection } from "./session-transcript-projection-rebuild.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

// Keep supplied-key probes below SQLite's conservative variable ceiling.
const TRANSCRIPT_MIRROR_KEY_QUERY_BATCH_SIZE = 900;

type TranscriptMirrorFacts = {
  activeAppendParentId: string | null;
  anchorsByIdempotencyKey: Map<string, TranscriptEntryAnchor>;
  existingIdempotencyKeys: Set<string>;
  messagesByIdempotencyKey: Map<string, unknown>;
  validationToken: TranscriptMirrorValidationToken;
};
export type TranscriptMirrorValidationToken = ReturnType<typeof readValidationToken>;

function readValidationToken(database: OpenClawAgentDatabase, sessionId: string) {
  const latest = executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("transcript_events")
      .select("seq")
      .where("session_id", "=", sessionId)
      .orderBy("seq", "desc")
      .limit(1),
  );
  return {
    generation: readTranscriptGenerationInTransaction(database, sessionId) ?? null,
    latestSeq: latest?.seq ?? -1,
  };
}

export function isTranscriptMirrorValidationTokenCurrent(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  expected: TranscriptMirrorValidationToken,
): boolean {
  const current = readValidationToken(database, resolved.sessionId);
  return current.generation === expected.generation && current.latestSeq === expected.latestSeq;
}

function needsFallback(
  database: OpenClawAgentDatabase,
  sessionId: string,
  latestSeq: number,
): boolean {
  if (latestSeq < 0) return true;
  const db = getSessionKysely(database.db);
  const state = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_transcript_index_state")
      .select(["indexed_seq", "needs_rebuild"])
      .where("session_id", "=", sessionId),
  );
  const identity = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_event_identities")
      .select("event_id")
      .where("session_id", "=", sessionId)
      .limit(1),
  );
  return !identity || !state || state.needs_rebuild !== 0 || state.indexed_seq !== latestSeq;
}

/** Reads the bounded identity facts needed by transcript mirrors. */
export function readTranscriptMirrorFacts(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  idempotencyKeys: readonly string[],
): TranscriptMirrorFacts {
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const requestedKeys = [...new Set(idempotencyKeys)];
      const validationToken = readValidationToken(database, resolved.sessionId);
      const db = getSessionKysely(database.db);
      const facts: TranscriptMirrorFacts = {
        activeAppendParentId: null,
        anchorsByIdempotencyKey: new Map(),
        existingIdempotencyKeys: new Set(),
        messagesByIdempotencyKey: new Map(),
        validationToken,
      };
      if (needsFallback(database, resolved.sessionId, validationToken.latestSeq)) {
        const rows =
          validationToken.latestSeq < 0
            ? []
            : readTranscriptEventRows(database, resolved.sessionId);
        const activePositions = new Map<number, number | null>();
        const projection = visitSessionTranscriptProjection(database.db, resolved.sessionId, {
          activeRow: (row) => activePositions.set(row.eventSeq, row.messagePosition),
          ftsRow: () => undefined,
        });
        facts.activeAppendParentId = projection?.leafEventId ?? null;
        const wanted = new Set(requestedKeys);
        for (const row of rows) {
          // SAFETY: eventJson is written from the canonical TranscriptEvent serialization path.
          const event = JSON.parse(row.eventJson) as TranscriptEvent;
          const message = readTranscriptEventMessage(event);
          const key = readMessageIdempotencyKey(message);
          if (!key || !wanted.has(key)) continue;
          facts.existingIdempotencyKeys.add(key);
          if (message !== undefined) facts.messagesByIdempotencyKey.set(key, message);
          const identity = readTranscriptEventIdentity(event);
          const position = activePositions.get(row.seq);
          if (identity && validationToken.generation && position != null) {
            facts.anchorsByIdempotencyKey.set(key, {
              agentId: resolved.agentId,
              sessionId: resolved.sessionId,
              sessionKey: resolved.sessionKey,
              storePath: database.path,
              generation: validationToken.generation,
              entryId: identity.eventId,
              rawSeq: row.seq,
              effectiveParentId: identity.parentId,
              activeMessagePosition: position,
              idempotencyKey: key,
            });
          }
        }
        return facts;
      }
      facts.activeAppendParentId = resolveTranscriptMessageAppendParent(
        database,
        resolved.sessionId,
        {},
      );
      for (
        let offset = 0;
        offset < requestedKeys.length;
        offset += TRANSCRIPT_MIRROR_KEY_QUERY_BATCH_SIZE
      ) {
        const batch = requestedKeys.slice(offset, offset + TRANSCRIPT_MIRROR_KEY_QUERY_BATCH_SIZE);
        const rows = executeSqliteQuerySync(
          database.db,
          db
            .selectFrom("transcript_event_identities as identity")
            .innerJoin("transcript_events as event", (join) =>
              join
                .onRef("event.session_id", "=", "identity.session_id")
                .onRef("event.seq", "=", "identity.seq"),
            )
            .select(["identity.event_id", "identity.message_idempotency_key", "event.event_json"])
            .where("identity.session_id", "=", resolved.sessionId)
            .where("identity.message_idempotency_key", "in", batch)
            .orderBy("identity.seq", "asc"),
        ).rows;
        for (const row of rows) {
          const key = row.message_idempotency_key;
          if (!key) continue;
          facts.existingIdempotencyKeys.add(key);
          const anchor = readActiveTranscriptEntryAnchorInTransaction({
            database,
            resolved,
            entryId: row.event_id,
          });
          if (anchor) facts.anchorsByIdempotencyKey.set(key, anchor);
          // SAFETY: event_json is the canonical TranscriptEvent column selected above.
          const message = readTranscriptEventMessage(JSON.parse(row.event_json) as TranscriptEvent);
          if (message !== undefined) facts.messagesByIdempotencyKey.set(key, message);
        }
      }
      return facts;
    },
    {
      databaseLabel: database.path,
      operationLabel: "session.transcript.mirror-facts",
    },
  );
}
