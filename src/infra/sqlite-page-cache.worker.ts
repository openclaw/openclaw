import fs from "node:fs";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { setSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import { readSqlitePageCacheResidency } from "./sqlite-page-cache-residency.js";
import type { SqliteReadOnlyOperationContext } from "./sqlite-readonly-operation-types.js";

const CHUNK_BYTES = 1024 * 1024;
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const PAYLOAD_RECENT_MS = 48 * 60 * 60 * 1000;
const MAX_PROJECTION_BYTES = 256 * 1024;
const PAYLOAD_BATCH_MESSAGES = 8;
const MAX_PAYLOAD_MESSAGES = 32;
const MAX_PAYLOAD_BYTES = 64 * 1024;

type PayloadWarmStats = { payloadBytes: number; payloadMessages: number };

export type PageCacheProgress = PayloadWarmStats & {
  residency: ReturnType<typeof readSqlitePageCacheResidency>;
  residencyAfter?: ReturnType<typeof readSqlitePageCacheResidency>;
  readBytes: number;
  diskBytes: number;
  elapsedMs: number;
  queryBeforeMs?: number;
  queryAfterMs?: number;
  complete: boolean;
  limited: boolean;
};

function readIo() {
  const io = fs.readFileSync("/proc/self/io", "utf8");
  return {
    readBytes: Number(/^rchar: (\d+)$/m.exec(io)?.[1] ?? 0),
    diskBytes: Number(/^read_bytes: (\d+)$/m.exec(io)?.[1] ?? 0),
  };
}

/** Keyset reads finish before yielding; no SQLite snapshot survives the returned row. */
function* recentSessions(db: DatabaseSync, since: number) {
  const query = getNodeSqliteKysely<DB>(db);
  const recent = query
    .selectFrom("session_nodes")
    .select(["session_key", "current_session_id", "updated_at"])
    .where("updated_at", ">=", since)
    .orderBy("updated_at", "desc")
    .orderBy("session_key")
    .limit(1);
  let cursor: { updated_at: number; session_key: string } | undefined;
  for (let visited = 0; visited < 4096; visited++) {
    // Separate index seeks avoid rescanning earlier keys when many sessions share a timestamp.
    const sameTimestamp = cursor
      ? executeSqliteQueryTakeFirstSync(
          db,
          recent
            .where("updated_at", "=", cursor.updated_at)
            .where("session_key", ">", cursor.session_key),
        )
      : undefined;
    const row =
      sameTimestamp ??
      executeSqliteQueryTakeFirstSync(
        db,
        cursor ? recent.where("updated_at", "<", cursor.updated_at) : recent,
      );
    if (!row) {
      return;
    }
    cursor = row;
    yield row;
  }
}

function sessionEntryProjection(query: ReturnType<typeof getNodeSqliteKysely<DB>>) {
  return query.selectFrom("session_nodes").select((eb) =>
    eb
      .case()
      .when(eb.fn<number>("octet_length", ["entry_json"]), "<=", MAX_PROJECTION_BYTES)
      .then(eb.ref("entry_json"))
      .else(null)
      .end()
      .as("entry"),
  );
}

function* agentHotPages(
  db: DatabaseSync,
  now: number,
): Generator<PayloadWarmStats | undefined, void> {
  const query = getNodeSqliteKysely<DB>(db);
  for (const row of recentSessions(db, now - RECENT_MS)) {
    executeSqliteQuerySync(
      db,
      sessionEntryProjection(query).where("session_key", "=", row.session_key),
    );
    for (const column of ["active_position", "event_seq", "message_position"] as const) {
      const recent = query
        .selectFrom("session_transcript_active_events")
        .select(column)
        .where("session_id", "=", row.current_session_id);
      executeSqliteQuerySync(
        db,
        (column === "message_position" ? recent.where(column, "is not", null) : recent)
          .orderBy(column, "desc")
          .limit(256),
      );
    }
    for (const messagesOnly of [false, true]) {
      const recent = query
        .selectFrom("transcript_event_identities")
        .select("seq")
        .where("session_id", "=", row.current_session_id);
      executeSqliteQuerySync(
        db,
        (messagesOnly ? recent.where("event_type", "=", "message") : recent)
          .orderBy("seq", "desc")
          .limit(256),
      );
    }
    yield;
  }
  // Finish the metadata pass before spending its remaining budget on recent payload pages.
  for (const row of recentSessions(db, now - PAYLOAD_RECENT_MS)) {
    const { rows: tail } = executeSqliteQuerySync(
      db,
      query
        .selectFrom("session_transcript_active_events")
        .select("event_seq")
        .where("session_id", "=", row.current_session_id)
        .where("message_position", "is not", null)
        .orderBy("message_position", "desc")
        .limit(MAX_PAYLOAD_MESSAGES),
    );
    // Empty selections also consume I/O; admit payload reads only after pacing this lookup.
    yield;
    for (let offset = 0; offset < tail.length; offset += PAYLOAD_BATCH_MESSAGES) {
      const sequences = tail
        .slice(offset, offset + PAYLOAD_BATCH_MESSAGES)
        .map((event) => event.event_seq);
      const { rows: messages } = executeSqliteQuerySync(
        db,
        query
          .selectFrom("transcript_events")
          .select((eb) => {
            const bounded = <Column extends "event_json" | "event_zstd">(column: Column) =>
              eb
                .case()
                .when(eb.fn<number>("octet_length", [column]), "<=", MAX_PAYLOAD_BYTES)
                .then(eb.ref(column))
                .else(null)
                .end();
            return [bounded("event_json").as("json"), bounded("event_zstd").as("compressed")];
          })
          .where("session_id", "=", row.current_session_id)
          .where("seq", "in", sequences),
      );
      const stats = { payloadBytes: 0, payloadMessages: 0 };
      for (const message of messages) {
        stats.payloadBytes += message.json === null ? 0 : Buffer.byteLength(message.json);
        stats.payloadBytes += message.compressed?.byteLength ?? 0;
        stats.payloadMessages += Number(message.json !== null || message.compressed !== null);
      }
      yield stats;
    }
  }
}

function* sharedPages(pathname: string): Generator<void, void> {
  const fd = fs.openSync(pathname, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
      if (fs.readSync(fd, buffer, 0, Math.min(CHUNK_BYTES, size - offset), offset) === 0) {
        break;
      }
      yield;
    }
  } finally {
    fs.closeSync(fd);
  }
}

let active: { path: string; steps: Generator<PageCacheProgress, void> } | undefined;

function* warm(
  pathname: string,
  input: { kind: "agent" | "state"; maxBytes: number; now: number },
): Generator<PageCacheProgress, void> {
  const started = performance.now();
  const initial = readIo();
  const progress: PageCacheProgress = {
    residency: readSqlitePageCacheResidency(pathname),
    readBytes: 0,
    diskBytes: 0,
    elapsedMs: 0,
    complete: false,
    limited: false,
    payloadBytes: 0,
    payloadMessages: 0,
  };
  let db: DatabaseSync | undefined;
  let measureQuery: (() => number) | undefined;
  const update = () => {
    const io = readIo();
    progress.readBytes = io.readBytes - initial.readBytes;
    progress.diskBytes = io.diskBytes - initial.diskBytes;
    progress.elapsedMs = performance.now() - started;
    return { ...progress };
  };
  try {
    if (input.kind === "agent") {
      db = openNodeSqliteDatabase(pathname, { readOnly: true });
      setSqliteBusyTimeout(db, 0);
      db.exec("PRAGMA cache_size = -1024; PRAGMA mmap_size = 0;"); // sqlite-allow-raw -- Bound the private cache and account for pread bytes.
      const query = getNodeSqliteKysely<DB>(db);
      const hotQuery = sessionEntryProjection(query)
        .where("updated_at", ">=", input.now - RECENT_MS)
        .orderBy("updated_at", "desc")
        .limit(8);
      const database = db;
      measureQuery = () => {
        database.exec("PRAGMA shrink_memory"); // sqlite-allow-raw -- Compare OS residency without this reader's private cache.
        const before = performance.now();
        executeSqliteQuerySync(database, hotQuery);
        return performance.now() - before;
      };
      progress.queryBeforeMs = measureQuery();
    }
    yield update();
    if ((progress.residency?.residentRatio ?? 1) < 0.8 || (progress.queryBeforeMs ?? 0) > 10) {
      const pages = db ? agentHotPages(db, input.now) : sharedPages(pathname);
      try {
        for (const chunk of pages) {
          if (chunk) {
            progress.payloadBytes += chunk.payloadBytes;
            progress.payloadMessages += chunk.payloadMessages;
          }
          update();
          if (Math.max(progress.readBytes, progress.diskBytes) >= input.maxBytes) {
            progress.limited = true;
            break;
          }
          yield update();
        }
      } finally {
        pages.return();
      }
      progress.queryAfterMs = measureQuery?.();
      progress.residencyAfter = readSqlitePageCacheResidency(pathname);
    }
    progress.complete = true;
    yield update();
  } finally {
    db?.close();
  }
}

function advance(pathname: string): PageCacheProgress {
  if (!active || active.path !== pathname) {
    throw new Error("Database page-cache warm is no longer active");
  }
  try {
    const result = active.steps.next();
    if (result.done) {
      throw new Error("Database page-cache warm ended without progress");
    }
    if (result.value.complete) {
      active.steps.return();
      active = undefined;
    }
    return result.value;
  } catch (error) {
    active = undefined;
    throw error;
  }
}

export const pageCacheReadOperations = {
  "pageCache.begin": (
    input: { kind: "agent" | "state"; maxBytes: number; now: number },
    context: SqliteReadOnlyOperationContext,
  ): PageCacheProgress => {
    active?.steps.return();
    active = { path: context.path, steps: warm(context.path, input) };
    return advance(context.path);
  },
  "pageCache.step": (_input: null, context: SqliteReadOnlyOperationContext): PageCacheProgress => {
    return advance(context.path);
  },
};
