// Loads covered-aggregate facts from the temporary history index in bounded batches.
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  droppedCoveredAggregateIds,
  type LocalCoverageUser,
} from "./cli-session-history.merge-aggregates.js";

const INDEX_TEXT_BATCH_ROWS = 65;
const COVERAGE_TURN_BATCH = 8;

type CoverageTextRow = {
  id: number;
  local_seq: number | null;
  text: string | null;
  timestamp: number | null;
  external_key: string | null;
  role: string | null;
  consumed: number;
};

type CoverageDatabase = {
  messages: CoverageTextRow;
  imports: { id: number; text: string | null };
  coverage_aggregates: { message_id: number };
  coverage_segments: { import_id: number; turn: number };
};

function decodeIndexedHistoryText(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const parsed = JSON.parse(value) as unknown;
  return typeof parsed === "string" ? parsed : null;
}

function greatestUserIdAtMost(userIds: readonly number[], aggregateId: number): number | undefined {
  let lo = 0;
  let hi = userIds.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((userIds[mid] ?? Number.POSITIVE_INFINITY) <= aggregateId) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return userIds[lo - 1];
}

function readIndexedTexts(
  database: DatabaseSync,
  table: "messages" | "imports",
  ids: readonly number[],
): Map<number, string> {
  const db = getNodeSqliteKysely<CoverageDatabase>(database);
  const texts = new Map<number, string>();
  for (let offset = 0; offset < ids.length; offset += INDEX_TEXT_BATCH_ROWS) {
    const slice = ids.slice(offset, offset + INDEX_TEXT_BATCH_ROWS);
    if (slice.length === 0) {
      continue;
    }
    const rows = executeSqliteQuerySync(
      database,
      db.selectFrom(table).select(["id", "text"]).where("id", "in", slice),
    ).rows;
    for (const row of rows) {
      const text = decodeIndexedHistoryText(row.text);
      if (text) {
        texts.set(row.id, text);
      }
    }
  }
  return texts;
}

export function readCliHistoryCoverageUsers(database: DatabaseSync): LocalCoverageUser[] {
  const db = getNodeSqliteKysely<CoverageDatabase>(database);
  const rows = executeSqliteQuerySync(
    database,
    db
      .selectFrom("messages")
      .select(["id", "text", "timestamp", "external_key"])
      .where("local_seq", "is not", null)
      .where("role", "=", "user")
      .where("consumed", "=", 0)
      .where("text", "is not", null)
      .orderBy("id"),
  ).rows;
  const users: LocalCoverageUser[] = [];
  for (const row of rows) {
    const text = decodeIndexedHistoryText(row.text);
    if (!text) {
      continue;
    }
    users.push({
      id: row.id,
      text,
      timestamp: row.timestamp,
      externalIdentity: row.external_key !== null,
    });
  }
  return users;
}

export function readCoveredCliAggregateIds(database: DatabaseSync): Set<number> {
  const db = getNodeSqliteKysely<CoverageDatabase>(database);
  const userIds = executeSqliteQuerySync(
    database,
    db
      .selectFrom("messages")
      .select("id")
      .where("local_seq", "is not", null)
      .where("role", "=", "user")
      .orderBy("id"),
  ).rows.map((row) => row.id);
  const aggregateIds = executeSqliteQuerySync(
    database,
    db.selectFrom("coverage_aggregates").select("message_id").orderBy("message_id"),
  ).rows.map((row) => row.message_id);
  const segmentRows = executeSqliteQuerySync(
    database,
    db.selectFrom("coverage_segments").select(["import_id", "turn"]).orderBy("import_id"),
  ).rows;
  if (aggregateIds.length === 0 || segmentRows.length === 0) {
    return new Set();
  }
  const segmentsByTurn = new Map<number, number[]>();
  for (const row of segmentRows) {
    const existing = segmentsByTurn.get(row.turn);
    if (existing) {
      existing.push(row.import_id);
    } else {
      segmentsByTurn.set(row.turn, [row.import_id]);
    }
  }
  const aggregatesByTurn = new Map<number, number[]>();
  for (const aggregateId of aggregateIds) {
    const turn = greatestUserIdAtMost(userIds, aggregateId);
    if (turn === undefined || !segmentsByTurn.has(turn)) {
      continue;
    }
    const existing = aggregatesByTurn.get(turn);
    if (existing) {
      existing.push(aggregateId);
    } else {
      aggregatesByTurn.set(turn, [aggregateId]);
    }
  }
  const dropped = new Set<number>();
  const turns = [...aggregatesByTurn.keys()];
  for (let offset = 0; offset < turns.length; offset += COVERAGE_TURN_BATCH) {
    const batch = turns.slice(offset, offset + COVERAGE_TURN_BATCH);
    const aggregateSlice = batch.flatMap((turn) => aggregatesByTurn.get(turn) ?? []);
    const segmentSlice = batch.flatMap((turn) => segmentsByTurn.get(turn) ?? []);
    const aggregateTexts = readIndexedTexts(database, "messages", aggregateSlice);
    const segmentTexts = readIndexedTexts(database, "imports", segmentSlice);
    for (const turn of batch) {
      const aggregates = (aggregatesByTurn.get(turn) ?? []).flatMap((id) => {
        const text = aggregateTexts.get(id);
        return text ? [{ id, text }] : [];
      });
      const segments = (segmentsByTurn.get(turn) ?? []).flatMap((id) => {
        const text = segmentTexts.get(id);
        return text ? [{ text }] : [];
      });
      for (const id of droppedCoveredAggregateIds({ aggregates, segments })) {
        dropped.add(id);
      }
    }
  }
  return dropped;
}
