import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { projectSessionEntryNumericSnapshot } from "./session-entry-numeric-snapshot.js";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";
import type { SessionEntry } from "./types.js";

export function hasValidSessionEntryIdentity(entry: {
  sessionId?: unknown;
  updatedAt?: unknown;
}): entry is { sessionId: string; updatedAt: number } {
  return (
    typeof entry.sessionId === "string" &&
    typeof entry.updatedAt === "number" &&
    Number.isFinite(entry.updatedAt)
  );
}

type SessionEntryJsonRow = {
  current_session_id?: string;
  entry_json: string;
  updated_at?: number;
};

/** Identity-only decoding lets migrations inspect legacy fields before canonical admission. */
export function parseSqliteSessionEntryRecord(
  row: SessionEntryJsonRow,
): (Record<string, unknown> & { sessionId: string; updatedAt: number }) | null {
  let record: unknown;
  try {
    record = JSON.parse(row.entry_json);
  } catch {
    return null;
  }
  if (!isRecord(record) || !hasValidSessionEntryIdentity(record)) {
    return null;
  }
  if (
    (row.current_session_id !== undefined && row.current_session_id !== record.sessionId) ||
    (row.updated_at !== undefined && row.updated_at !== record.updatedAt)
  ) {
    return null;
  }
  return record;
}

/** Admit unknown persisted or imported metadata once, before typed consumers use it. */
export function admitCanonicalSessionEntry(value: Record<string, unknown>): SessionEntry {
  const entry = projectCanonicalSessionEntryShape(value);
  return { ...entry, ...projectSessionEntryNumericSnapshot(entry) };
}

export function parseCanonicalSqliteSessionEntry(row: SessionEntryJsonRow): SessionEntry | null {
  const record = parseSqliteSessionEntryRecord(row);
  return record ? admitCanonicalSessionEntry(record) : null;
}

export function normalizeSessionEntryTimestamp(entry: SessionEntry): SessionEntry {
  const hasLegacyDeliveryFields = [
    "route",
    "deliveryContext",
    "origin",
    "channel",
    "lastChannel",
    "lastTo",
    "lastAccountId",
    "lastThreadId",
  ].some((key) => key in entry);
  const delivery =
    entry.delivery ?? (hasLegacyDeliveryFields ? undefined : { kind: "none" as const });
  if (asFiniteNumber(entry.updatedAt) !== undefined) {
    if (entry.delivery === delivery) {
      return entry;
    }
    return delivery ? { ...entry, delivery } : entry;
  }
  const updatedAt = asFiniteNumber(entry.sessionStartedAt) ?? Date.now();
  return delivery ? { ...entry, delivery, updatedAt } : { ...entry, updatedAt };
}
