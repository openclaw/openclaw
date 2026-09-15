import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getNodeSqliteKysely, iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  hasSessionPendingInputsSchema,
  hasPendingInputConsumptionColumn,
} from "../../state/openclaw-agent-pending-inputs-schema.js";
import { sessionEntryMetadataJson } from "./session-accessor.sqlite-status.js";
import { parseSqliteSessionEntryRecord } from "./session-entry-json.js";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";

/** Cold storage preserves logical owners; only activity and explicit cross-generation references protect bytes. */
export function readSessionColdStorageProtection(
  database: { db: DatabaseSync },
  beforeMs: number,
): Set<string> {
  const db = getNodeSqliteKysely<DB>(database.db);
  const protectedIds = new Set<string>();
  const busyKeys = new Set<string>();
  // Keep only protection facts, not a second store-wide array of serialized metadata.
  for (const row of iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select([
        "session_key",
        "current_session_id",
        "updated_at",
        "status",
        "last_activity_at",
        "last_interaction_at",
        sessionEntryMetadataJson,
      ]),
  )) {
    const record = parseSqliteSessionEntryRecord(row);
    const entry = record ? projectCanonicalSessionEntryShape(record) : null;
    const recovery = record?.mainRestartRecovery;
    const recoveryPending =
      entry?.restartRecoveryBeforeAgentReplyState === "admitted" ||
      entry?.restartRecoveryBeforeAgentReplyState === "pending" ||
      entry?.restartRecoveryBeforeAgentReplyState === "continue" ||
      entry?.restartRecoveryDeliveryReceiptState === "terminal-pending" ||
      (isRecord(recovery) && (Boolean(recovery.reservation) || Boolean(recovery.foregroundClaims)));
    if (!entry || recoveryPending) {
      busyKeys.add(row.session_key);
    }
    if (
      row.status === "running" ||
      Math.max(row.updated_at, row.last_activity_at ?? 0, row.last_interaction_at ?? 0) >= beforeMs
    ) {
      protectedIds.add(row.current_session_id);
    }
    if (!entry) {
      continue;
    }
    if (entry.previousSessionId) {
      protectedIds.add(entry.previousSessionId);
    }
    for (const id of entry.usageFamilySessionIds ?? []) {
      if (id !== row.current_session_id) {
        protectedIds.add(id);
      }
    }
    for (const checkpoint of entry.compactionCheckpoints ?? []) {
      protectedIds.add(checkpoint.sessionId);
      protectedIds.add(checkpoint.preCompaction.sessionId);
      protectedIds.add(checkpoint.postCompaction.sessionId);
    }
  }
  for (const row of iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_windows")
      .select(["session_id", "session_key", "updated_at", "transcript_updated_at", "status"])
      // Recovery or unreadable nodes protect all their generations. Otherwise, leave
      // old idle windows in SQLite instead of hydrating them just to reject them.
      .$if(busyKeys.size === 0, (query) =>
        query.where((eb) =>
          eb.or([
            eb("status", "=", "running"),
            eb("updated_at", ">=", beforeMs),
            eb(eb.fn.coalesce("transcript_updated_at", eb.val(0)), ">=", beforeMs),
          ]),
        ),
      ),
  )) {
    if (
      busyKeys.has(row.session_key) ||
      row.status === "running" ||
      Math.max(row.updated_at, row.transcript_updated_at ?? 0) >= beforeMs
    ) {
      protectedIds.add(row.session_id);
    }
  }
  if (hasSessionPendingInputsSchema(database.db)) {
    for (const row of iterateSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_pending_inputs")
        .select("session_id")
        .where("state", "in", ["queued", "interrupted"])
        .$if(hasPendingInputConsumptionColumn(database.db), (query) =>
          query.where("consumed_event_id", "is", null),
        ),
    )) {
      protectedIds.add(row.session_id);
    }
  }
  return protectedIds;
}
