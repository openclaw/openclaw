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
}));

vi.mock("./node-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./node-sqlite.js")>();
  return {
    ...actual,
    openNodeSqliteDatabase: (...args: Parameters<typeof actual.openNodeSqliteDatabase>) => {
      const database = actual.openNodeSqliteDatabase(...args);
      if (args[1]?.readOnly) {
        observed.readers.push(database);
        database.setAuthorizer((action, table, column) =>
          action === constants.SQLITE_READ &&
          ([
            "trajectory_runtime_events",
            "session_transcript_archives",
            "session_transcript_cold_archives",
          ].includes(table ?? "") ||
            (table === "session_entry_snapshots" && column === "value_json"))
            ? constants.SQLITE_DENY
            : constants.SQLITE_OK,
        );
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
    residentPages: 0,
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
    messageBytes: Buffer.byteLength(message),
    compressedBytes: compressed.length,
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
    const { pathname, messageBytes, compressedBytes, payloadBytes } = createAgentDatabase();
    const context = { path: pathname, env: {} };
    const input = { kind: "agent" as const, maxBytes: 3 * MiB, now };
    const initial = pageCacheReadOperations["pageCache.begin"](input, context);
    const first = pageCacheReadOperations["pageCache.step"](null, context);
    let payloadProgress = first;
    for (
      let step = 0;
      !payloadProgress.complete && payloadProgress.payloadMessages === 0 && step < 64;
      step++
    ) {
      payloadProgress = pageCacheReadOperations["pageCache.step"](null, context);
    }
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
    const progress = finish(pathname, payloadProgress);
    const result = progress.at(-1)!;

    pageCacheReadOperations["pageCache.begin"](input, context);
    const previousReader = observed.readers.at(-1)!;
    const restarted = pageCacheReadOperations["pageCache.begin"](input, context);
    const replacedReaderClosed = !previousReader.isOpen;
    finish(pathname, restarted);
    expect(initial.complete).toBe(false);
    expect(first.complete).toBe(false);
    expect(payloadProgress.complete).toBe(false);
    expect(payloadProgress.payloadMessages).toBeGreaterThan(0);
    expect(payloadProgress.payloadBytes).toBe(
      (payloadProgress.payloadMessages - 1) * messageBytes + compressedBytes,
    );
    expect(first.readBytes).toBeGreaterThan(0);
    expect(readerOpenDuringWarm).toBe(true);
    expect(checkpointBusy).toBe(0);
    expect(replacedReaderClosed).toBe(true);
    expect(result).toMatchObject({
      complete: true,
      limited: false,
      payloadMessages: 32,
      payloadBytes,
    });
    expect(result.readBytes).toBeGreaterThan(MiB);
    expect(result.readBytes).toBeLessThan(3 * MiB);
    expect(result.queryBeforeMs).toBeGreaterThanOrEqual(0);
    expect(result.queryAfterMs).toBeGreaterThanOrEqual(0);
    expect(observed.readers.every((database) => !database.isOpen)).toBe(true);
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
    for (let index = 1; index < progress.length; index++) {
      expect(progress[index]!.readBytes - progress[index - 1]!.readBytes).toBeLessThan(1.1 * MiB);
    }
    const result = progress.at(-1)!;
    expect(result).toMatchObject({ complete: true, limited: true });
    expect(result.readBytes).toBeGreaterThanOrEqual(2 * MiB);
    expect(result.readBytes).toBeLessThan(3 * MiB);
    expect(result.readBytes).toBeLessThan(fs.statSync(pathname).size);
  });
});
