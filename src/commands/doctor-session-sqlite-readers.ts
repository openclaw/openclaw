/** Read-only diagnostic readers used by the session SQLite doctor mode. */
import fs from "node:fs";
import { TextDecoder } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TranscriptEvent } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";

export type ReadOnlySqliteSessionSummary = {
  entry: SessionEntry;
  sessionKey: string;
};

export type ReadOnlySqliteSessionEntriesResult =
  | { exists: false; ok: true; summaries: [] }
  | { exists: true; ok: true; summaries: ReadOnlySqliteSessionSummary[] }
  | { error: unknown; exists: true; ok: false };

export type ReadOnlySqliteExactSessionEntryResult =
  | { entry?: ReadOnlySqliteSessionSummary; ok: true }
  | { error: unknown; ok: false };

export type ReadOnlySqliteTranscriptEventCountResult =
  | { events: number; exists: boolean; ok: true }
  | { error: unknown; exists: true; ok: false };

export type TranscriptEventCountResult =
  | { status: "ok"; events: number }
  | { status: "missing" }
  | { status: "malformed"; message: string };

const JSONL_READ_CHUNK_BYTES = 64 * 1024;

export function countTranscriptEventsForPath(
  transcriptPath: string | undefined,
): TranscriptEventCountResult {
  if (!transcriptPath) {
    return { status: "ok", events: 0 };
  }
  if (!fs.existsSync(transcriptPath)) {
    return { status: "missing" };
  }
  let events = 0;
  try {
    for (const line of iterateJsonlLinesSync(transcriptPath)) {
      JSON.parse(line.text);
      events += 1;
    }
    return { status: "ok", events };
  } catch (err) {
    return { status: "malformed", message: String(err) };
  }
}

export function createTranscriptEventReader(
  transcriptPath: string,
): (append: (event: TranscriptEvent) => void) => void {
  return (append) => {
    for (const line of iterateJsonlLinesSync(transcriptPath)) {
      append(JSON.parse(line.text) as TranscriptEvent);
    }
  };
}

export function readSqliteEntryCount(target: SessionStoreTarget): number {
  const result = readOnlySqliteSessionEntries(target);
  return result.ok ? result.summaries.length : 0;
}

export function readOnlySqliteExactSessionEntry(
  target: SessionStoreTarget,
  sessionKey: string,
): ReadOnlySqliteExactSessionEntryResult {
  const result = readOnlySqliteSessionEntries(target);
  if (!result.ok) {
    return { error: result.error, ok: false };
  }
  return {
    entry: result.summaries.find((summary) => summary.sessionKey === sessionKey),
    ok: true,
  };
}

export function readOnlySqliteSessionEntries(
  target: SessionStoreTarget,
): ReadOnlySqliteSessionEntriesResult {
  const sqlitePath = resolveTargetSqlitePath(target);
  if (!fs.existsSync(sqlitePath)) {
    return { exists: false, ok: true, summaries: [] };
  }
  const sqlite = requireNodeSqlite();
  let database: InstanceType<typeof sqlite.DatabaseSync> | undefined;
  try {
    database = new sqlite.DatabaseSync(sqlitePath, { readOnly: true });
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("session_entries");
    if (!table) {
      return { exists: true, ok: true, summaries: [] };
    }
    const rows = database
      .prepare("SELECT session_key, entry_json FROM session_entries ORDER BY session_key ASC")
      .all() as Array<{ entry_json?: unknown; session_key?: unknown }>;
    return {
      exists: true,
      ok: true,
      summaries: rows.flatMap((row) => {
        if (typeof row.session_key !== "string" || typeof row.entry_json !== "string") {
          return [];
        }
        const entry = parseSqliteSessionEntry(row.entry_json);
        return entry ? [{ entry, sessionKey: row.session_key }] : [];
      }),
    };
  } catch (error) {
    return { error, exists: true, ok: false };
  } finally {
    database?.close();
  }
}

export function readOnlySqliteTranscriptEventCount(
  target: SessionStoreTarget,
  sessionId: string,
): ReadOnlySqliteTranscriptEventCountResult {
  const sqlitePath = resolveTargetSqlitePath(target);
  if (!fs.existsSync(sqlitePath)) {
    return { events: 0, exists: false, ok: true };
  }
  const sqlite = requireNodeSqlite();
  let database: InstanceType<typeof sqlite.DatabaseSync> | undefined;
  try {
    database = new sqlite.DatabaseSync(sqlitePath, { readOnly: true });
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("transcript_events");
    if (!table) {
      return { events: 0, exists: true, ok: true };
    }
    const row = database
      .prepare("SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ?")
      .get(sessionId) as { count?: unknown } | undefined;
    const count = row?.count;
    return {
      events: typeof count === "number" && Number.isFinite(count) ? count : 0,
      exists: true,
      ok: true,
    };
  } catch (error) {
    return { error, exists: true, ok: false };
  } finally {
    database?.close();
  }
}

export function resolveTargetSqlitePath(target: SessionStoreTarget): string {
  const sqliteTarget = resolveSqliteTargetFromSessionStorePath(target.storePath, {
    agentId: target.agentId,
  });
  return resolveOpenClawAgentSqlitePath({
    agentId: sqliteTarget.agentId ?? target.agentId,
    ...(sqliteTarget.path ? { path: sqliteTarget.path } : {}),
  });
}

function parseSqliteSessionEntry(entryJson: string): SessionEntry | undefined {
  try {
    const parsed = JSON.parse(entryJson) as unknown;
    return isRecord(parsed) ? (parsed as SessionEntry) : undefined;
  } catch {
    return undefined;
  }
}

function* iterateJsonlLinesSync(filePath: string): Generator<{ lineNumber: number; text: string }> {
  const fd = fs.openSync(filePath, "r");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.allocUnsafe(JSONL_READ_CHUNK_BYTES);
  let carry = "";
  let lineNumber = 0;
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      carry += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      const parts = carry.split(/\r?\n/);
      carry = parts.pop() ?? "";
      for (const part of parts) {
        lineNumber += 1;
        const text = part.trim();
        if (text) {
          yield { lineNumber, text };
        }
      }
    }
    carry += decoder.decode();
    const text = carry.trim();
    if (text) {
      yield { lineNumber: lineNumber + 1, text };
    }
  } catch (err) {
    throw new Error(`${filePath}:${lineNumber + 1}: ${String(err)}`, { cause: err });
  } finally {
    fs.closeSync(fd);
  }
}
