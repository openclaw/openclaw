import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  hasSessionPendingInputsSchema,
  hasPendingInputConsumptionColumn,
} from "../../state/openclaw-agent-pending-inputs-schema.js";
import {
  parseSessionEntryJson,
  sessionEntryMetadataJson,
} from "./session-accessor.sqlite-status.js";
import { parseSqliteSessionEntryRecord } from "./session-entry-json.js";

/** Cold storage preserves logical owners; only activity and explicit cross-generation references protect bytes. */
export function readSessionColdStorageProtection(
  database: { db: DatabaseSync },
  beforeMs: number,
): Set<string> {
  const db = getNodeSqliteKysely<DB>(database.db);
  const protectedIds = new Set<string>();
  const busyKeys = new Set<string>();
  for (const row of executeSqliteQuerySync(
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
  ).rows) {
    const entry = parseSessionEntryJson(row);
    const record = parseSqliteSessionEntryRecord(row);
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
  for (const row of executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_windows")
      .select(["session_id", "session_key", "updated_at", "transcript_updated_at", "status"]),
  ).rows) {
    if (
      busyKeys.has(row.session_key) ||
      row.status === "running" ||
      Math.max(row.updated_at, row.transcript_updated_at ?? 0) >= beforeMs
    ) {
      protectedIds.add(row.session_id);
    }
  }
  if (hasSessionPendingInputsSchema(database.db)) {
    for (const row of executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_pending_inputs")
        .select("session_id")
        .where("state", "in", ["queued", "interrupted"])
        .$if(hasPendingInputConsumptionColumn(database.db), (query) =>
          query.where("consumed_event_id", "is", null),
        ),
    ).rows) {
      protectedIds.add(row.session_id);
    }
  }
  return protectedIds;
}
