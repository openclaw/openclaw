import fs from "node:fs";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import { hasErrnoCode } from "./errno.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { readSqlitePageCacheResidency } from "./sqlite-page-cache-residency.js";
import type { SqliteReadOnlyOperationContext } from "./sqlite-readonly-operation-types.js";

const CHUNK_BYTES = 1024 * 1024;
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const PAYLOAD_RECENT_MS = 48 * 60 * 60 * 1000;
const MAX_PROJECTION_BYTES = 256 * 1024;
const PAYLOAD_BATCH_MESSAGES = 8;
const MAX_PAYLOAD_MESSAGES = 32;
const MAX_PAYLOAD_BYTES = 64 * 1024;
// A keyset/index row is a rowid, a small integer payload and page overhead. Kernels built
// without CONFIG_TASKSTATS expose no /proc/self/io, so the warm counts what it reads itself;
// the per-row allowance is deliberately generous so an index-heavy pass cannot overshoot.
const INDEX_ROW_BYTES = 32;

type PayloadWarmStats = { payloadBytes: number; payloadMessages: number };

/** Bytes the warm read itself; used where the kernel exposes no I/O accounting. */
type ReadCounter = { bytes: number };

function countIndexRows(counter: ReadCounter, rows: readonly unknown[]): void {
  counter.bytes += rows.length * INDEX_ROW_BYTES;
}

function countTextBytes(counter: ReadCounter, value: string | null | undefined): void {
  counter.bytes += value ? Buffer.byteLength(value) : 0;
}

export type PageCacheProgress = PayloadWarmStats & {
  residency: ReturnType<typeof readSqlitePageCacheResidency>;
  residencyAfter?: ReturnType<typeof readSqlitePageCacheResidency>;
  /** With /proc/self/io this is the kernel delta; otherwise the bytes the warm counted. */
  readBytes: number;
  diskBytes: number;
  /** True when /proc/self/io is absent and readBytes comes from the warm's own counting. */
  ioCountersUnavailable: boolean;
  elapsedMs: number;
  queryBeforeMs?: number;
  queryAfterMs?: number;
  complete: boolean;
  limited: boolean;
};

type IoCounters = { readBytes: number; diskBytes: number };

function readIo(): IoCounters | null {
  try {
    const io = fs.readFileSync("/proc/self/io", "utf8");
    return {
      readBytes: Number(/^rchar: (\d+)$/m.exec(io)?.[1] ?? 0),
      diskBytes: Number(/^read_bytes: (\d+)$/m.exec(io)?.[1] ?? 0),
    };
  } catch (error) {
    // /proc/<pid>/io requires CONFIG_TASKSTATS; stock Microsoft WSL kernels omit it.
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

/** Keyset reads finish before yielding; no SQLite snapshot survives the returned row. */
function* recentSessions(db: DatabaseSync, since: number, counter: ReadCounter) {
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
    counter.bytes += INDEX_ROW_BYTES;
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
  counter: ReadCounter,
): Generator<PayloadWarmStats, void> {
  const query = getNodeSqliteKysely<DB>(db);
  for (const row of recentSessions(db, now - RECENT_MS, counter)) {
    const { rows: entries } = executeSqliteQuerySync(
      db,
      sessionEntryProjection(query).where("session_key", "=", row.session_key),
    );
    countIndexRows(counter, entries);
    for (const entry of entries) {
      countTextBytes(counter, entry.entry);
    }
    for (const column of ["active_position", "event_seq", "message_position"] as const) {
      const recent = query
        .selectFrom("session_transcript_active_events")
        .select(column)
        .where("session_id", "=", row.current_session_id);
      const { rows } = executeSqliteQuerySync(
        db,
        (column === "message_position" ? recent.where(column, "is not", null) : recent)
          .orderBy(column, "desc")
          .limit(256),
      );
      countIndexRows(counter, rows);
    }
    for (const messagesOnly of [false, true]) {
      const recent = query
        .selectFrom("transcript_event_identities")
        .select("seq")
        .where("session_id", "=", row.current_session_id);
      const { rows } = executeSqliteQuerySync(
        db,
        (messagesOnly ? recent.where("event_type", "=", "message") : recent)
          .orderBy("seq", "desc")
          .limit(256),
      );
      countIndexRows(counter, rows);
    }
    yield { payloadBytes: 0, payloadMessages: 0 };
  }
  // Finish the metadata pass before spending its remaining budget on recent payload pages.
  for (const row of recentSessions(db, now - PAYLOAD_RECENT_MS, counter)) {
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
    countIndexRows(counter, tail);
    // Empty selections also consume I/O; admit payload reads only after pacing this lookup.
    yield { payloadBytes: 0, payloadMessages: 0 };
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
      countIndexRows(counter, messages);
      counter.bytes += stats.payloadBytes;
      yield stats;
    }
  }
}

function* sharedPages(pathname: string, counter: ReadCounter): Generator<PayloadWarmStats, void> {
  const fd = fs.openSync(pathname, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(CHUNK_BYTES, size - offset), offset);
      if (bytesRead === 0) {
        break;
      }
      counter.bytes += bytesRead;
      yield { payloadBytes: 0, payloadMessages: 0 };
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
  // Probe once per pass: on kernels without task IO accounting every later read would throw
  // too, and the answer cannot change while the pass runs.
  const initial = readIo();
  const countersAvailable = initial !== null;
  const counter: ReadCounter = { bytes: 0 };
  const progress: PageCacheProgress = {
    residency: readSqlitePageCacheResidency(pathname),
    readBytes: 0,
    diskBytes: 0,
    ioCountersUnavailable: !countersAvailable,
    elapsedMs: 0,
    complete: false,
    limited: false,
    payloadBytes: 0,
    payloadMessages: 0,
  };
  let db: DatabaseSync | undefined;
  let measureQuery: (() => number) | undefined;
  const update = () => {
    if (initial) {
      const io = readIo();
      if (io) {
        progress.readBytes = io.readBytes - initial.readBytes;
        progress.diskBytes = io.diskBytes - initial.diskBytes;
      }
    } else {
      // Without procfs, the warm's own count is the only byte figure available.
      progress.readBytes = counter.bytes;
    }
    progress.elapsedMs = performance.now() - started;
    return progress;
  };
  try {
    if (
      input.kind === "state" &&
      progress.residency &&
      progress.residency.sizeBytes > input.maxBytes
    ) {
      // A partial sequential scan repeats the same prefix without warming the whole store.
      // Leave that I/O budget for the remaining databases instead.
      progress.complete = true;
      progress.limited = true;
      yield { ...update() };
      return;
    }
    if (input.kind === "agent") {
      db = openNodeSqliteDatabase(pathname, { readOnly: true, timeout: 0 });
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
        const { rows } = executeSqliteQuerySync(database, hotQuery);
        countIndexRows(counter, rows);
        for (const row of rows) {
          countTextBytes(counter, row.entry);
        }
        return performance.now() - before;
      };
      progress.queryBeforeMs = measureQuery();
    }
    yield { ...update() };
    if ((progress.residency?.residentRatio ?? 1) < 0.8 || (progress.queryBeforeMs ?? 0) > 10) {
      const pages = db ? agentHotPages(db, input.now, counter) : sharedPages(pathname, counter);
      let reportedBytes = Math.max(progress.readBytes, progress.diskBytes);
      try {
        for (const chunk of pages) {
          if (chunk) {
            progress.payloadBytes += chunk.payloadBytes;
            progress.payloadMessages += chunk.payloadMessages;
          }
          update();
          const bytes = Math.max(progress.readBytes, progress.diskBytes);
          if (bytes >= input.maxBytes) {
            progress.limited = true;
            break;
          }
          // Pace bytes, not sessions: small index reads need no individual IPC round trip.
          if (bytes - reportedBytes >= CHUNK_BYTES) {
            reportedBytes = bytes;
            yield { ...progress };
          }
        }
      } finally {
        pages.return();
      }
      progress.queryAfterMs = measureQuery?.();
      progress.residencyAfter = readSqlitePageCacheResidency(pathname);
    }
    progress.complete = true;
    yield { ...update() };
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
