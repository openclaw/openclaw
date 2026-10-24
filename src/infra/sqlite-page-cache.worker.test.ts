import fs from "node:fs";
import path from "node:path";
import { constants } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { pageCacheReadOperations, type PageCacheProgress } from "./sqlite-page-cache.worker.js";

const observed = vi.hoisted(() => ({
  readers: [] as import("node:sqlite").DatabaseSync[],
  busyTimeoutPragmas: [] as (string | null)[],
}));

vi.mock("./node-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./node-sqlite.js")>();
  return {
    ...actual,
    openNodeSqliteDatabase: (...args: Parameters<typeof actual.openNodeSqliteDatabase>) => {
      const database = actual.openNodeSqliteDatabase(...args);
      if (args[1]?.readOnly) {
        observed.readers.push(database);
        expect(database.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 0 });
        database.setAuthorizer((action, table, column) => {
          if (action === constants.SQLITE_PRAGMA && table === "busy_timeout") {
            observed.busyTimeoutPragmas.push(column);
          }
          return action === constants.SQLITE_READ &&
            ([
              "trajectory_runtime_events",
              "session_transcript_archives",
              "session_transcript_cold_archives",
            ].includes(table ?? "") ||
              (table === "session_entry_snapshots" && column === "value_json"))
            ? constants.SQLITE_DENY
            : constants.SQLITE_OK;
        });
      }
      return database;
    },
  };
});

vi.mock("./sqlite-page-cache-residency.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sqlite-page-cache-residency.js")>()),
  readSqlitePageCacheResidency: () => ({
    scope: "file-sample" as const,
    sampledPages: 256,
    residentRatio: 0,
    pageSize: 4096,
    sizeBytes: 0,
  }),
}));

const MiB = 1024 * 1024;
const now = Date.UTC(2026, 8, 30);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createAgentDatabase() {
  const pathname = path.join(tempDirs.make("sqlite-hot-set-"), "agent.sqlite");
  const message = JSON.stringify({ text: "x".repeat(2048) });
  const expanded = JSON.stringify({ text: "z".repeat(128 * 1024) });
  const compressed = zstdCompressSync(expanded);
  const cutoffMessage = JSON.stringify({ text: "exactly 48 hours old" });
  const database = openNodeSqliteDatabase(pathname);
  try {
    database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; BEGIN;");
    database.exec(
      fs.readFileSync(new URL("../state/openclaw-agent-schema.sql", import.meta.url), "utf8"),
    );
    const node = database.prepare(`INSERT INTO session_nodes
      (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)`);
    const snapshot = database.prepare(`INSERT INTO session_entry_snapshots
      (session_key, field, value_json) VALUES (?, 'skillsSnapshot', ?)`);
    const small = JSON.stringify({ data: "x".repeat(48 * 1024) });
    for (let index = 0; index < 24; index++) {
      const key = `recent-${index}`;
      node.run(key, key, small, now - index);
      snapshot.run(key, small);
    }
    const oversized = JSON.stringify({ data: "x".repeat(4 * MiB) });
    node.run("old", "old", oversized, now - 30 * 24 * 60 * 60 * 1000);
    snapshot.run("old", oversized);
    node.run("oversized-snapshot", "oversized-snapshot", "{}", now);
    snapshot.run("oversized-snapshot", oversized);
    node.run("oversized-entry", "oversized-entry", oversized, now);
    const window = database.prepare(`INSERT INTO session_windows
      (session_id, session_key, created_at, updated_at) VALUES (?, ?, ?, ?)`);
    const event = database.prepare(`INSERT INTO transcript_events
      (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)`);
    const active = database.prepare(`INSERT INTO session_transcript_active_events
      (session_id, active_position, event_seq, message_position) VALUES (?, ?, ?, ?)`);
    const identity = database.prepare(`INSERT INTO transcript_event_identities
      (session_id, event_id, seq, event_type, created_at) VALUES (?, ?, ?, 'message', ?)`);
    const addMessage = (
      sessionId: string,
      seq: number,
      content: string,
      position?: number | null,
    ) => {
      event.run(sessionId, seq, content, now);
      identity.run(sessionId, `event-${seq}`, seq, now);
      if (position !== undefined) {
        active.run(sessionId, position ?? seq, seq, position);
      }
    };
    window.run("old", "old", now, now);
    addMessage("old", 1, JSON.stringify({ data: "x".repeat(8 * MiB) }), 0);
    window.run("recent-0", "recent-0", now, now);
    for (let position = 0; position < 40; position++) {
      const content =
        position < 8
          ? small
          : position === 39
            ? JSON.stringify({ text: "x".repeat(65537) })
            : message;
      addMessage("recent-0", 1000 - position, content, position);
    }
    const expandedBytes = Buffer.byteLength(expanded);
    database
      .prepare(`UPDATE transcript_events
        SET event_json = NULL, event_zstd = ?, event_utf8_bytes = ?, navigation_json = ?
        WHERE session_id = 'recent-0' AND seq = 962`)
      .run(
        compressed,
        expandedBytes,
        JSON.stringify({
          version: 1,
          report: { kind: "canonical" },
          navigation: {},
          reset: {},
          model: {},
          modelBytes: expandedBytes,
          modelWithoutCheckpointBytes: expandedBytes,
          withoutCustomDataBytes: expandedBytes,
        }),
      );
    addMessage("recent-0", 2000, message);
    addMessage("recent-0", 2001, message, null);
    window.run("retired", "recent-0", now, now);
    addMessage("retired", 1, message, 0);

    const cutoff = now - 48 * 60 * 60 * 1000;
    node.run("at-cutoff", "at-cutoff", "{}", cutoff);
    window.run("at-cutoff", "at-cutoff", cutoff, cutoff);
    addMessage("at-cutoff", 1, cutoffMessage, 0);
    node.run("outside-cutoff", "outside-cutoff", "{}", cutoff - 1);
    window.run("outside-cutoff", "outside-cutoff", cutoff - 1, cutoff - 1);
    for (let position = 0; position < 64; position++) {
      addMessage("outside-cutoff", position, small, position);
    }
    database.exec("COMMIT;");
  } finally {
    database.close();
  }
  return {
    pathname,
    payloadBytes:
      30 * Buffer.byteLength(message) + compressed.length + Buffer.byteLength(cutoffMessage),
  };
}

function finish(pathname: string, initial: PageCacheProgress): PageCacheProgress[] {
  const progress = [initial];
  for (let step = 0; !progress.at(-1)!.complete && step < 64; step++) {
    progress.push(pageCacheReadOperations["pageCache.step"](null, { path: pathname, env: {} }));
  }
  expect(progress.at(-1)?.complete).toBe(true);
  return progress;
}

describe.skipIf(process.platform !== "linux")("SQLite page-cache worker", () => {
  it("warms recent projections and the latest bounded active payloads without retaining WAL snapshots", () => {
    const { pathname, payloadBytes } = createAgentDatabase();
    const context = { path: pathname, env: {} };
    const input = { kind: "agent" as const, maxBytes: 3 * MiB, now };
    const initial = pageCacheReadOperations["pageCache.begin"](input, context);
    const first = pageCacheReadOperations["pageCache.step"](null, context);
    const readerOpenDuringWarm = observed.readers.at(-1)!.isOpen;

    const writer = openNodeSqliteDatabase(pathname);
    let checkpointBusy: unknown;
    try {
      writer.exec("PRAGMA busy_timeout=0;");
      writer
        .prepare("UPDATE session_nodes SET updated_at = ? WHERE session_key = 'recent-0'")
        .run(now + 1);
      checkpointBusy = writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy;
    } finally {
      writer.close();
    }
    const progress = finish(pathname, first);
    const result = progress.at(-1)!;

    pageCacheReadOperations["pageCache.begin"](input, context);
    const previousReader = observed.readers.at(-1)!;
    const restarted = pageCacheReadOperations["pageCache.begin"](input, context);
    const replacedReaderClosed = !previousReader.isOpen;
    finish(pathname, restarted);
    expect(initial.complete).toBe(false);
    expect(first.complete).toBe(false);
    expect(progress.length).toBeLessThanOrEqual(5);
    if (first.ioCountersUnavailable) {
      expect(first.readBytes).toBe(0);
      expect(first.estimatedReadBytes).toBeGreaterThan(0);
    } else {
      expect(first.readBytes).toBeGreaterThan(0);
    }
    if (!first.ioCountersUnavailable) {
      expect(readerOpenDuringWarm).toBe(true);
    }
    expect(checkpointBusy).toBe(0);
    expect(replacedReaderClosed).toBe(true);
    if (result.ioCountersUnavailable) {
      // Conservative estimates consume this artificial 3 MiB budget before payloads.
      expect(result).toMatchObject({ complete: true, limited: true });
      expect(result.estimatedReadBytes).toBeGreaterThanOrEqual(3 * MiB);
    } else {
      expect(result).toMatchObject({
        complete: true,
        limited: false,
        payloadMessages: 32,
        payloadBytes,
      });
      expect(result.readBytes).toBeGreaterThan(MiB);
      expect(result.readBytes).toBeLessThan(3 * MiB);
    }
    expect(result.queryBeforeMs).toBeGreaterThanOrEqual(0);
    expect(result.queryAfterMs).toBeGreaterThanOrEqual(0);
    expect(observed.readers.every((database) => !database.isOpen)).toBe(true);
    expect(observed.busyTimeoutPragmas).toEqual([]);
  });

  it("yields between shared-state reads and stops at the byte budget", () => {
    const pathname = path.join(tempDirs.make("sqlite-state-warm-"), "state.sqlite");
    const database = openNodeSqliteDatabase(pathname);
    try {
      database.exec("CREATE TABLE payload (value BLOB);");
      database.prepare("INSERT INTO payload VALUES (zeroblob(?))").run(6 * MiB);
    } finally {
      database.close();
    }
    const progress = finish(
      pathname,
      pageCacheReadOperations["pageCache.begin"](
        { kind: "state", maxBytes: 2 * MiB, now },
        { path: pathname, env: {} },
      ),
    );
    expect(progress.length).toBeGreaterThan(2);
    const readStat = (value: PageCacheProgress) =>
      value.ioCountersUnavailable
        ? value.estimatedReadBytes
        : Math.max(value.readBytes, value.diskBytes);
    for (let index = 1; index < progress.length; index++) {
      expect(readStat(progress[index]!) - readStat(progress[index - 1]!)).toBeLessThan(1.1 * MiB);
    }
    const result = progress.at(-1)!;
    expect(result).toMatchObject({ complete: true, limited: true });
    expect(readStat(result)).toBeGreaterThanOrEqual(2 * MiB);
    expect(readStat(result)).toBeLessThan(3 * MiB);
    expect(readStat(result)).toBeLessThan(fs.statSync(pathname).size);
  });

  it("completes an agent warm when /proc/self/io is unavailable, using bounded estimates", () => {
    const originalReadFileSync = fs.readFileSync;
    const procfsSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((
      filePath: unknown,
      ...args: unknown[]
    ) => {
      if (filePath === "/proc/self/io") {
        const error = new Error(
          `ENOENT: no such file or directory, open '${filePath}'`,
        ) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return (originalReadFileSync as (...args: unknown[]) => unknown)(filePath, ...args);
    }) as typeof fs.readFileSync);
    try {
      const { pathname } = createAgentDatabase();
      const context = { path: pathname, env: {} };
      const input = { kind: "agent" as const, maxBytes: 256 * MiB, now };
      const initial = pageCacheReadOperations["pageCache.begin"](input, context);
      expect(initial.ioCountersUnavailable).toBe(true);
      expect(initial.readBytes).toBe(0);
      expect(initial.estimatedReadBytes).toBeGreaterThan(0);
      const result = finish(pathname, initial).at(-1)!;
      expect(result).toMatchObject({ complete: true, ioCountersUnavailable: true });
      expect(result.readBytes).toBe(0);
      expect(result.estimatedReadBytes).toBeGreaterThan(0);
      expect(observed.readers.every((database) => !database.isOpen)).toBe(true);
    } finally {
      procfsSpy.mockRestore();
    }
  });

  it("enforces the state byte budget via estimates when /proc/self/io is unavailable", () => {
    const originalReadFileSync = fs.readFileSync;
    const procfsSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((
      filePath: unknown,
      ...args: unknown[]
    ) => {
      if (filePath === "/proc/self/io") {
        const error = new Error(
          `ENOENT: no such file or directory, open '${filePath}'`,
        ) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return (originalReadFileSync as (...args: unknown[]) => unknown)(filePath, ...args);
    }) as typeof fs.readFileSync);
    try {
      const pathname = path.join(tempDirs.make("sqlite-state-warm-noio-"), "state.sqlite");
      const database = openNodeSqliteDatabase(pathname);
      try {
        database.exec("CREATE TABLE payload (value BLOB);");
        database.prepare("INSERT INTO payload VALUES (zeroblob(?))").run(6 * MiB);
      } finally {
        database.close();
      }
      const progress = finish(
        pathname,
        pageCacheReadOperations["pageCache.begin"](
          { kind: "state", maxBytes: 2 * MiB, now },
          { path: pathname, env: {} },
        ),
      );
      const result = progress.at(-1)!;
      expect(progress.every((value) => value.ioCountersUnavailable)).toBe(true);
      expect(result).toMatchObject({ complete: true, limited: true });
      expect(result.estimatedReadBytes).toBeGreaterThanOrEqual(2 * MiB);
      expect(result.estimatedReadBytes).toBeLessThan(3 * MiB);
      expect(result.estimatedReadBytes).toBeLessThan(fs.statSync(pathname).size);
    } finally {
      procfsSpy.mockRestore();
    }
  });
});
