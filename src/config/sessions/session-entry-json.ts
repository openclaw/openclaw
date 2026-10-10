import { isRecord } from "@openclaw/normalization-core/record-coerce";

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

export function parseSqliteSessionEntryRecord(row: {
  current_session_id?: string;
  entry_json: string;
  updated_at?: number;
}): (Record<string, unknown> & { sessionId: string; updatedAt: number }) | null {
  try {
    const record: unknown = JSON.parse(row.entry_json);
    if (!isRecord(record)) {
      return null;
    }
    if (!hasValidSessionEntryIdentity(record)) {
      return null;
    }
    if (
      (row.current_session_id !== undefined && row.current_session_id !== record.sessionId) ||
      (row.updated_at !== undefined && row.updated_at !== record.updatedAt)
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}
