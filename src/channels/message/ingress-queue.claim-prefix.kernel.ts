import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  channelIngressPrefixRowFingerprint,
  foldChannelIngressPrefixFingerprints,
} from "./ingress-queue.codec.js";
import type { ChannelIngressClaimCursor, ChannelIngressRow } from "./ingress-queue.types.js";

const getQueue = (db: EngineConnection) =>
  getNodeSqliteKysely<Pick<DB, "channel_ingress_events">>(db);

const FINGERPRINT_COLUMNS = [
  "event_id",
  "received_at",
  "lane_key",
  "status",
  "payload_json",
] as const;

/**
 * Authoritative count and membership fingerprint of the scan-visible pending rows
 * strictly before a keyset cursor, read in one pinned query. A retained direct-scan
 * resume cursor is only valid while these are unchanged; a write from any handle
 * that inserted, removed, or replaced a row before the cursor changes one of them.
 * The fingerprint detects offsetting writes (one row removed, another inserted)
 * that preserve the count, which count alone cannot observe. The cursor row itself
 * is validated separately: the strict-before prefix cannot observe an
 * equal-position replacement of it (same id and received time, different
 * lane-policy inputs). When includeRows is set the materialized prefix rows are
 * returned so the host can re-evaluate their lanes under the current callback
 * policy, which callback identity alone cannot prove unchanged.
 */
export function readChannelIngressPrefixInDatabase(
  db: EngineConnection,
  input: {
    queueName: string;
    candidateIds?: string[];
    blockedLaneKeys: string[];
    reconcileStoredLaneKey?: boolean;
    orderBy?: "received" | "id";
    claimAfter: ChannelIngressClaimCursor;
    includeRows?: boolean;
  },
): {
  count: number;
  fingerprint: string;
  cursorRowFingerprint?: string;
  cursorRow?: ChannelIngressRow;
  rows?: ChannelIngressRow[];
} {
  const cursor = input.claimAfter;
  let filtered = getQueue(db)
    .selectFrom("channel_ingress_events")
    .where("queue_name", "=", input.queueName)
    .where("status", "=", "pending");
  if (input.candidateIds) {
    filtered = filtered.where("event_id", "in", input.candidateIds);
  }
  if (!input.reconcileStoredLaneKey && input.blockedLaneKeys.length) {
    filtered = filtered.where((eb) =>
      eb.or([
        eb("lane_key", "is", null),
        eb("lane_key", "not in", sqliteStringSet(input.blockedLaneKeys)),
      ]),
    );
  }
  filtered =
    input.orderBy === "id"
      ? filtered.where("event_id", "<", cursor.eventId)
      : filtered.where((eb) =>
          eb.or([
            eb("received_at", "<", cursor.receivedAt),
            eb.and([
              eb("received_at", "=", cursor.receivedAt),
              eb("event_id", "<", cursor.eventId),
            ]),
          ]),
        );
  const cursorRowQuery = () =>
    getQueue(db)
      .selectFrom("channel_ingress_events")
      .where("queue_name", "=", input.queueName)
      .where("event_id", "=", cursor.eventId)
      .where("status", "=", "pending");
  if (input.includeRows) {
    const rows = executeSqliteQuerySync(db, filtered.selectAll()).rows;
    // The cursor row rides along so the host can re-evaluate its lane under the
    // current callback policy too; the strict-before prefix excludes it.
    const cursorRow = executeSqliteQuerySync(db, cursorRowQuery().selectAll()).rows[0];
    return {
      count: rows.length,
      fingerprint: foldChannelIngressPrefixFingerprints(rows),
      ...(cursorRow
        ? { cursorRowFingerprint: channelIngressPrefixRowFingerprint(cursorRow), cursorRow }
        : {}),
      rows,
    };
  }
  const cursorRow = executeSqliteQuerySync(db, cursorRowQuery().select(FINGERPRINT_COLUMNS))
    .rows[0];
  const cursorPart = cursorRow
    ? { cursorRowFingerprint: channelIngressPrefixRowFingerprint(cursorRow) }
    : {};
  const prefixRows = executeSqliteQuerySync(db, filtered.select(FINGERPRINT_COLUMNS)).rows;
  return {
    count: prefixRows.length,
    // Fold in a bounded loop: the retained cursor can advance across arbitrarily
    // many calls, and spreading one argument per row would exceed V8's
    // function-argument limit on a sufficiently large derived blocked backlog.
    fingerprint: foldChannelIngressPrefixFingerprints(prefixRows),
    ...cursorPart,
  };
}
