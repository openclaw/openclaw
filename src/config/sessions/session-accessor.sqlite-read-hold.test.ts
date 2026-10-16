import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Message } from "openclaw/plugin-sdk/llm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { readActiveTranscriptEntryAnchor, replaceSessionEntry } from "./session-accessor.js";
import {
  loadTranscriptReadSnapshotSync,
  readTranscriptExportSnapshotFromDatabase,
  readTranscriptExportSnapshotReadOnlySync,
  readTranscriptStatsSync,
} from "./session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessage } from "./session-accessor.sqlite-transcript-write.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { prepareSessionMemoryEntries } from "./session-memory-entry.worker.js";

const chunkBudget = vi.hoisted(() => ({ bytes: undefined as number | undefined }));
const transactionLog = vi.hoisted(() => ({
  entries: [] as string[],
  afterFirst: undefined as (() => void) | undefined,
}));

vi.mock("./session-transcript-payload-chunk.js", async () => {
  const actual = await vi.importActual<typeof import("./session-transcript-payload-chunk.js")>(
    "./session-transcript-payload-chunk.js",
  );
  return {
    ...actual,
    get TRANSCRIPT_PAYLOAD_CHUNK_BYTES() {
      return chunkBudget.bytes ?? actual.TRANSCRIPT_PAYLOAD_CHUNK_BYTES;
    },
  };
});

vi.mock("../../infra/sqlite-transaction.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/sqlite-transaction.js")>(
    "../../infra/sqlite-transaction.js",
  );
  return {
    ...actual,
    runSqliteDeferredTransactionSync: ((db, operation, options) => {
      const result = actual.runSqliteDeferredTransactionSync(db, operation, options);
      const label = options?.operationLabel;
      if (label?.startsWith("session transcript")) {
        transactionLog.entries.push("transaction");
        const afterFirst = transactionLog.afterFirst;
        transactionLog.afterFirst = undefined;
        afterFirst?.();
      }
      return result;
    }) as typeof actual.runSqliteDeferredTransactionSync,
  };
});

const statsReads = vi.hoisted(() => ({ count: 0 }));

vi.mock("./session-accessor.sqlite-transcript-stats.js", async () => {
  const actual = await vi.importActual<
    typeof import("./session-accessor.sqlite-transcript-stats.js")
  >("./session-accessor.sqlite-transcript-stats.js");
  return {
    ...actual,
    readTranscriptStatsFromDatabase: ((...args) => {
      statsReads.count++;
      return actual.readTranscriptStatsFromDatabase(...args);
    }) as typeof actual.readTranscriptStatsFromDatabase,
    readTranscriptExportStatsFromDatabase: ((...args) => {
      statsReads.count++;
      return actual.readTranscriptExportStatsFromDatabase(...args);
    }) as typeof actual.readTranscriptExportStatsFromDatabase,
  };
});

const holdLogger = vi.hoisted(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../logging/subsystem.js", async () => {
  const actual = await vi.importActual<typeof import("../../logging/subsystem.js")>(
    "../../logging/subsystem.js",
  );
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) =>
      subsystem === "sqlite/transaction" ? holdLogger : actual.createSubsystemLogger(subsystem),
  };
});

vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-transcript-hold-");
const MARKER = "hold-probe-marker";
const MIB = 1024 * 1024;
// Rows decode to at most 4 MiB each; two of these push a transcript past the 4 MiB snapshot limit.
const LARGE_ROWS = [Math.floor(2.5 * MIB), Math.floor(2.5 * MIB)];
// Above the 2 MiB slice budget and below the 4 MiB snapshot limit.
const MEDIUM_ROWS = [3 * MIB];

afterEach(() => {
  chunkBudget.bytes = undefined;
  statsReads.count = 0;
  transactionLog.entries = [];
  transactionLog.afterFirst = undefined;
  vi.restoreAllMocks();
  holdLogger.warn.mockClear();
});

function userMessage(content: string): Message {
  return { role: "user", content, timestamp: 1 };
}

describe("SQLite transcript readers release the read snapshot before parsing", () => {
  /** `shared` adds a tagged session to an existing store instead of a new one. */
  async function seedSession(
    encoding: "UTF-8" | "UTF-16le" = "UTF-8",
    shared?: { storePath: string; tag: string },
    /** Decoded payload bytes of extra user rows appended after the four small ones. */
    extraRows: number[] = [],
  ) {
    const tempDir = shared ? path.dirname(shared.storePath) : sessionDirs.make();
    const storePath =
      shared?.storePath ??
      path.join(tempDir, encoding === "UTF-8" ? "sessions.json" : `${encoding}.sqlite`);
    if (!shared && encoding !== "UTF-8") {
      const seed = new DatabaseSync(storePath);
      try {
        seed.exec(
          `PRAGMA encoding = '${encoding}'; CREATE TABLE encoding_seed (id INTEGER); DROP TABLE encoding_seed;`,
        );
      } finally {
        seed.close();
      }
    }
    const sessionId = shared ? `session-hold-${shared.tag}` : "session-hold";
    const sessionKey = shared ? `agent:main:hold-${shared.tag}` : "agent:main:hold";
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      { sessionId, updatedAt: 1 },
    );
    const events = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-04-01T05:46:39.000Z",
        cwd: tempDir,
      },
      // Large and repetitive so the stored form is zstd; small rows stay plain JSON.
      ...Array.from({ length: 4 }, (_, index) => ({
        type: "message",
        id: `entry-${index}`,
        parentId: index === 0 ? null : `entry-${index - 1}`,
        timestamp: "2026-04-01T05:46:40.000Z",
        message: userMessage(
          index % 2 === 0
            ? `${MARKER} ${"lobster ".repeat(600)}`
            : `${MARKER} short${shared ? ` ${shared.tag}` : ""}`,
        ),
      })),
      ...extraRows.map((bytes, index) => ({
        type: "message",
        id: `entry-${4 + index}`,
        parentId: `entry-${3 + index}`,
        timestamp: "2026-04-01T05:46:41.000Z",
        message: userMessage(`${MARKER} ${"lobster ".repeat(Math.floor(bytes / 8))}`),
      })),
    ];
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await replaceTranscriptEvents(scope, events);
    return { events, scope };
  }

  /** Each parse and projection advances a virtual clock, so work inside a transaction logs a hold. */
  function chargeWorkToClock(millisecondsPerStep: number) {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const realParse = JSON.parse.bind(JSON);
    vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (typeof text === "string" && text.includes(MARKER)) {
        now += millisecondsPerStep;
      }
      return realParse(text, reviver);
    });
    return () => {
      now += millisecondsPerStep;
    };
  }

  function slowHolds() {
    return holdLogger.warn.mock.calls.filter(
      ([message]) => message === "slow SQLite transaction hold",
    );
  }

  it("parses and projects export snapshot payloads outside the read transaction", async () => {
    const { events, scope } = await seedSession();
    const charge = chargeWorkToClock(2_000);
    const projectEvent = vi.fn((event: unknown) => {
      charge();
      return event;
    });
    const snapshot = readTranscriptExportSnapshotReadOnlySync(scope, { projectEvent });
    expect(snapshot?.events).toEqual(events);
    expect(projectEvent.mock.calls.map(([event]) => event)).toEqual(events);
    expect(slowHolds()).toEqual([]);
  });

  it("parses fenced read payloads outside the read transaction", async () => {
    const { events, scope } = await seedSession();
    chargeWorkToClock(2_000);
    const snapshot = loadTranscriptReadSnapshotSync(scope, { readOnly: true });
    expect(snapshot.events).toEqual(events);
    expect(slowHolds()).toEqual([]);
  });

  it.each([
    [
      "export snapshot",
      (scope: Parameters<typeof loadTranscriptReadSnapshotSync>[0]) =>
        readTranscriptExportSnapshotReadOnlySync(scope),
    ],
    [
      "fenced read",
      (scope: Parameters<typeof loadTranscriptReadSnapshotSync>[0]) =>
        loadTranscriptReadSnapshotSync(scope, { readOnly: true }),
    ],
  ])(
    "surfaces the payload length error from a corrupt compressed row (%s)",
    async (_name, read) => {
      const { scope } = await seedSession();
      const { db } = openOpenClawAgentDatabase(
        toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
      );
      db.prepare(
        "UPDATE transcript_events SET event_utf8_bytes = event_utf8_bytes + 1 WHERE session_id = ? AND event_zstd IS NOT NULL",
      ).run(scope.sessionId);
      expect(() => read(scope)).toThrow(/Compressed transcript payload length does not match/u);
      // The same error from a later slice, after earlier slices committed and were parsed.
      chunkBudget.bytes = 1;
      expect(() => read(scope)).toThrow(/Compressed transcript payload length does not match/u);
    },
  );
  const readers = [
    [
      "export snapshot",
      (
        scope: Parameters<typeof loadTranscriptReadSnapshotSync>[0],
        projectEvent?: (event: unknown) => unknown,
      ) => readTranscriptExportSnapshotReadOnlySync(scope, { projectEvent })?.events,
    ],
    [
      "fenced read",
      (scope: Parameters<typeof loadTranscriptReadSnapshotSync>[0]) =>
        loadTranscriptReadSnapshotSync(scope, { readOnly: true }).events,
    ],
  ] as const;

  it("captures one slice of payloads per read transaction and parses it in between", async () => {
    const { events, scope } = await seedSession();
    chunkBudget.bytes = 1;
    const projectEvent = vi.fn((event: unknown) => {
      transactionLog.entries.push("parse");
      return event;
    });
    expect(readers[0][1](scope, projectEvent)).toEqual(events);
    // One row per transaction; the last transaction finds no further rows.
    expect(transactionLog.entries).toEqual([
      ...events.flatMap(() => ["transaction", "parse"]),
      "transaction",
    ]);
    transactionLog.entries = [];
    expect(readers[1][1](scope)).toEqual(events);
    expect(transactionLog.entries).toEqual([...events.map(() => "transaction"), "transaction"]);
  });

  it.each(readers)(
    "rereads in one transaction when the transcript changes between chunks (%s)",
    async (_name, read) => {
      const { events, scope } = await seedSession();
      chunkBudget.bytes = 1;
      const { db } = openOpenClawAgentDatabase(
        toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
      );
      // An in-place rewrite of the already parsed first row, with the update time writers bump.
      transactionLog.afterFirst = () => {
        db.prepare(
          `UPDATE transcript_events SET event_json = json_set(event_json, '$.cwd', 'rewritten')
           WHERE session_id = ? AND seq = (SELECT min(seq) FROM transcript_events WHERE session_id = ?)`,
        ).run(scope.sessionId, scope.sessionId);
        db.prepare(
          "UPDATE session_windows SET transcript_updated_at = coalesce(transcript_updated_at, 0) + 1 WHERE session_id = ?",
        ).run(scope.sessionId);
      };
      expect(read(scope)).toEqual([{ ...events[0], cwd: "rewritten" }, ...events.slice(1)]);
      // First slice, the transaction that saw the new version, then one whole reread.
      expect(transactionLog.entries).toEqual(["transaction", "transaction", "transaction"]);
    },
  );
  // UTF-8 stores CJK at 3 bytes per character and UTF-16 stores every unit in 2 bytes, so a
  // string-length budget undercounts the copied column in both database encodings.
  it.each(["UTF-8", "UTF-16le"] as const)(
    "budgets slices by payload bytes, not string length, for plain Unicode rows in %s",
    async (encoding) => {
      const { events: seeded, scope } = await seedSession(encoding);
      // 250 CJK characters stay plain JSON, so their stored size is at least twice their length.
      const unicode = Array.from({ length: 3 }, (_, index) => ({
        type: "message",
        id: `unicode-${index}`,
        parentId: index === 0 ? "entry-3" : `unicode-${index - 1}`,
        timestamp: "2026-04-01T05:46:41.000Z",
        message: userMessage("漢".repeat(250)),
      }));
      const events = [...seeded, ...unicode];
      await replaceTranscriptEvents(scope, events);
      const { db } = openOpenClawAgentDatabase(
        toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
      );
      expect(db.prepare("PRAGMA encoding").get()).toEqual({ encoding });
      const stored = db
        .prepare(
          "SELECT octet_length(event_json) AS bytes, length(event_json) AS units FROM transcript_events WHERE session_id = ? AND event_json LIKE '%unicode-%' ORDER BY seq",
        )
        .all(scope.sessionId) as Array<{ bytes: number; units: number }>;
      expect(stored).toHaveLength(3);
      // Every Unicode row alone fills the slice by stored size, but not by string length.
      chunkBudget.bytes = Math.min(...stored.map((row) => row.bytes));
      for (const row of stored) {
        expect(row.units).toBeLessThan(chunkBudget.bytes);
      }
      const projectEvent = vi.fn((event: { id?: string }) => {
        transactionLog.entries.push(`parse ${event.id}`);
        return event;
      });
      expect(readers[0][1](scope, projectEvent as (event: unknown) => unknown)).toEqual(events);
      // Each Unicode row alone reaches the budget, so each one ends its slice.
      const entries = transactionLog.entries;
      for (const { id } of unicode) {
        expect(entries[entries.indexOf(`parse ${id}`) + 1]).toBe("transaction");
      }
      expect(projectEvent.mock.calls.map(([event]) => event)).toEqual(events);
      // The fenced read captures through the same slices.
      const exportTransactions = entries.filter((entry) => entry === "transaction").length;
      transactionLog.entries = [];
      expect(readers[1][1](scope)).toEqual(events);
      expect(transactionLog.entries).toHaveLength(exportTransactions);
    },
  );

  // A zstd row decodes to far more text than it stores; the slice holds that text.
  it("budgets compressed rows by their decoded payload bytes, not their stored size", async () => {
    const { events, scope } = await seedSession();
    const { db } = openOpenClawAgentDatabase(
      toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
    );
    const compressed = db
      .prepare(
        "SELECT octet_length(event_zstd) AS stored, event_utf8_bytes AS payload FROM transcript_events WHERE session_id = ? AND event_zstd IS NOT NULL ORDER BY seq",
      )
      .all(scope.sessionId) as Array<{ stored: number; payload: number }>;
    expect(compressed).toHaveLength(2);
    // Each compressed row alone fills the slice by its decoded size, but not by its stored size.
    chunkBudget.bytes = Math.min(...compressed.map((row) => row.payload));
    for (const row of compressed) {
      expect(row.stored).toBeLessThan(chunkBudget.bytes);
    }
    const projectEvent = vi.fn((event: { id?: string }) => {
      transactionLog.entries.push(`parse ${event.id}`);
      return event;
    });
    expect(readers[0][1](scope, projectEvent as (event: unknown) => unknown)).toEqual(events);
    const entries = transactionLog.entries;
    for (const id of ["entry-0", "entry-2"]) {
      expect(entries[entries.indexOf(`parse ${id}`) + 1]).toBe("transaction");
    }
  });

  it("continues an incremental export after the previous projection in slices", async () => {
    const { events, scope } = await seedSession();
    const first = readTranscriptExportSnapshotReadOnlySync(scope, { previous: null });
    expect(first?.events).toEqual(events);
    expect(first?.generation).toEqual(expect.any(String));
    const { db } = openOpenClawAgentDatabase(
      toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
    );
    const seqs = (
      db
        .prepare("SELECT seq FROM transcript_events WHERE session_id = ? ORDER BY seq")
        .all(scope.sessionId) as Array<{ seq: number }>
    ).map((row) => row.seq);
    chunkBudget.bytes = 1;
    transactionLog.entries = [];
    const projectEvent = vi.fn((event: unknown) => event);
    const previous = {
      events: events.slice(0, 3),
      generation: first!.generation!,
      throughSeq: seqs[2]!,
    };
    const next = readTranscriptExportSnapshotReadOnlySync(scope, { previous, projectEvent });
    expect(next?.events).toEqual(events);
    expect(next?.throughSeq).toBe(seqs.at(-1));
    // Only rows after the previous projection are read, one per transaction.
    expect(projectEvent.mock.calls.map(([event]) => event)).toEqual(events.slice(3));
    expect(transactionLog.entries).toEqual([
      ...events.slice(3).map(() => "transaction"),
      "transaction",
    ]);

    transactionLog.entries = [];
    projectEvent.mockClear();
    const unchanged = readTranscriptExportSnapshotReadOnlySync(scope, {
      previous: { events, generation: first!.generation!, throughSeq: seqs.at(-1)! },
      projectEvent,
    });
    expect(unchanged?.events).toEqual(events);
    expect(projectEvent).not.toHaveBeenCalled();
    expect(transactionLog.entries).toEqual(["transaction"]);
  });

  function memoryEntry(scope: Awaited<ReturnType<typeof seedSession>>["scope"]) {
    return {
      absPath: path.join(path.dirname(scope.storePath), `${scope.sessionId}.jsonl`),
      options: scope,
    };
  }

  function entryContent(result: Awaited<ReturnType<typeof prepareSessionMemoryEntries>>[number]) {
    return "entry" in result ? result.entry?.content : undefined;
  }

  it("reads a transcript above the snapshot limit in slices after the memory export batch transaction", async () => {
    const batched = await seedSession();
    const sliced = await seedSession("UTF-8", undefined, LARGE_ROWS);
    expect(readTranscriptStatsSync(sliced.scope).sizeBytes).toBeGreaterThan(4 * MIB);
    const [inBatch] = await prepareSessionMemoryEntries([memoryEntry(batched.scope)]);
    // Within the retained-snapshot limit the transcript is read inside the one batch transaction.
    expect(transactionLog.entries).toEqual(["transaction"]);
    transactionLog.entries = [];
    chunkBudget.bytes = 1;
    const [afterBatch] = await prepareSessionMemoryEntries([memoryEntry(sliced.scope)]);
    // The batch transaction reads the statistics only; the rows follow one per transaction.
    expect(transactionLog.entries).toEqual([
      "transaction",
      ...sliced.events.map(() => "transaction"),
      "transaction",
    ]);
    expect(entryContent(afterBatch!)).toContain(MARKER);
    expect(entryContent(inBatch!)).toContain(MARKER);
  });

  it("matches the batch head while unchanged and rereads it after a write", async () => {
    const { scope, events } = await seedSession("UTF-8", undefined, LARGE_ROWS);
    const { db, path: databasePath } = openOpenClawAgentDatabase(
      toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
    );
    const readBatchHead = () => {
      const snapshot = readTranscriptExportSnapshotFromDatabase(
        { db, path: databasePath },
        resolveSqliteTranscriptReadScope(scope),
        scope,
        {},
        { sliceAboveBytes: 0 },
      );
      if (!("sliced" in snapshot)) {
        throw new Error("expected a sliced export");
      }
      return snapshot.sliced;
    };
    chunkBudget.bytes = 1;
    const unchanged = readBatchHead();
    statsReads.count = 0;
    const same = readTranscriptExportSnapshotReadOnlySync(scope, {}, unchanged);
    expect(statsReads.count).toBe(0);
    expect(same?.stats).toEqual(unchanged.head.stats);
    expect(same?.events).toHaveLength(events.length);

    const stale = readBatchHead();
    await expect(
      appendTranscriptMessage(scope, { message: userMessage(`${MARKER} appended`) }),
    ).resolves.toMatchObject({ appended: true });
    statsReads.count = 0;
    const changed = readTranscriptExportSnapshotReadOnlySync(scope, {}, stale);
    expect(statsReads.count).toBe(1);
    expect(changed?.stats.eventCount).toBe(stale.head.stats.eventCount + 1);
    expect(changed?.events).toHaveLength(events.length + 1);
    expect(JSON.stringify(changed?.events.at(-1))).toContain(`${MARKER} appended`);
  });

  /** Bumps the update time writers bump, so the transcript context version changes. */
  function touchTranscript(scope: { agentId: string; sessionId: string; storePath: string }) {
    const { db } = openOpenClawAgentDatabase(
      toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
    );
    return () => {
      db.prepare(
        "UPDATE session_windows SET transcript_updated_at = coalesce(transcript_updated_at, 0) + 1 WHERE session_id = ?",
      ).run(scope.sessionId);
    };
  }

  // A transcript changed after the batch transaction rereads its head under the same fence.
  it.each([false, true])(
    "keeps the current-turn fence on a transcript read after the batch transaction (changed: %s)",
    async (changed) => {
      const { scope } = await seedSession();
      const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: "entry-2" });
      if (!anchor) {
        throw new Error("missing admission anchor");
      }
      // Rows appended after the fenced entry take the transcript past the snapshot limit.
      for (const bytes of LARGE_ROWS) {
        await appendTranscriptMessage(scope, {
          message: userMessage(`${MARKER} ${"lobster ".repeat(Math.floor(bytes / 8))}`),
        });
      }
      expect(readTranscriptStatsSync(scope).sizeBytes).toBeGreaterThan(4 * MIB);
      chunkBudget.bytes = 1;
      transactionLog.afterFirst = changed ? touchTranscript(scope) : undefined;
      statsReads.count = 0;
      const [result] = await prepareSessionMemoryEntries([
        { ...memoryEntry(scope), admission: { ...anchor, logicalTurnId: "fenced", role: "user" } },
      ]);
      expect(transactionLog.entries.length).toBeGreaterThan(1);
      expect(statsReads.count).toBe(changed ? 2 : 1);
      // entry-1 and entry-3 carry the same short text; the fence stops before entry-2.
      expect(entryContent(result!)?.split(`${MARKER} short`)).toHaveLength(2);
    },
  );

  it("reads transcripts within the retained-snapshot limit inside the batch transaction and larger ones after it, keeping entry order", async () => {
    const first = await seedSession();
    const { storePath } = first.scope;
    const second = await seedSession("UTF-8", { storePath, tag: "two" }, LARGE_ROWS);
    const third = await seedSession("UTF-8", { storePath, tag: "three" });
    const largeSize = readTranscriptStatsSync(second.scope).sizeBytes;
    expect(largeSize).toBeGreaterThan(4 * MIB);
    // The large transcript fits one slice, so it takes exactly one transaction after the batch.
    chunkBudget.bytes = 2 * largeSize;
    const results = await prepareSessionMemoryEntries(
      [first, second, third].map(({ scope }) => memoryEntry(scope)),
    );
    expect(transactionLog.entries).toEqual(["transaction", "transaction"]);
    expect(results.map((result) => entryContent(result)?.includes(`${MARKER} short two`))).toEqual([
      false,
      true,
      false,
    ]);
    expect(
      results.map((result) => entryContent(result)?.includes(`${MARKER} short three`)),
    ).toEqual([false, false, true]);
  });

  it("reads a transcript above the slice budget but within the snapshot limit inside the batch transaction", async () => {
    const { scope } = await seedSession("UTF-8", undefined, MEDIUM_ROWS);
    const size = readTranscriptStatsSync(scope).sizeBytes;
    expect(size).toBeGreaterThan(2 * MIB);
    expect(size).toBeLessThanOrEqual(4 * MIB);
    transactionLog.entries = [];
    const [result] = await prepareSessionMemoryEntries([memoryEntry(scope)]);
    expect(transactionLog.entries).toEqual(["transaction"]);
    expect(entryContent(result!)).toContain(MARKER);
  });

  it.each([false, true])(
    "keeps the incremental projection for a transcript read after the batch transaction (changed: %s)",
    async (changed) => {
      // Retained while within the snapshot limit; the append pushes it past the limit.
      const { scope } = await seedSession("UTF-8", undefined, MEDIUM_ROWS);
      chunkBudget.bytes = 1;
      const [first] = await prepareSessionMemoryEntries([memoryEntry(scope)]);
      expect(entryContent(first!)).toContain(MARKER);
      const appended = `${MARKER} appended ${"lobster ".repeat((2 * MIB) / 8)}`;
      await expect(
        appendTranscriptMessage(scope, { message: userMessage(appended) }),
      ).resolves.toMatchObject({ appended: true });
      expect(readTranscriptStatsSync(scope).sizeBytes).toBeGreaterThan(4 * MIB);
      transactionLog.entries = [];
      const parsed: string[] = [];
      const realParse = JSON.parse.bind(JSON);
      vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
        if (typeof text === "string" && text.includes(MARKER)) {
          parsed.push(text);
        }
        return realParse(text, reviver);
      });
      transactionLog.afterFirst = changed ? touchTranscript(scope) : undefined;
      statsReads.count = 0;
      const [next] = await prepareSessionMemoryEntries([memoryEntry(scope)]);
      // The batch transaction, then only the appended row after the retained projection.
      expect(transactionLog.entries).toEqual(["transaction", "transaction", "transaction"]);
      expect(statsReads.count).toBe(changed ? 2 : 1);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toContain(`${MARKER} appended`);
      expect(entryContent(next!)).toContain(`${MARKER} appended`);
      expect(entryContent(next!)).toContain(entryContent(first!));
    },
  );

  it("reports a cold transcript from the batch transaction and from a read after it", async () => {
    const { scope } = await seedSession("UTF-8", undefined, LARGE_ROWS);
    const archive = () => {
      const { db } = openOpenClawAgentDatabase(
        toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
      );
      db.prepare(
        `INSERT INTO session_transcript_cold_archives
         (session_id, generation, archive_name, archive_sha256, event_count,
          raw_bytes, archive_bytes, last_seq, archived_at, storage)
         VALUES (?, 'archive-generation', 'synthetic', ?, 5, 0, 0, 4, 1, 'file')`,
      ).run(scope.sessionId, "0".repeat(64));
    };
    chunkBudget.bytes = 1;
    // Archived after the batch transaction deferred it, before its own read.
    transactionLog.afterFirst = archive;
    await expect(prepareSessionMemoryEntries([memoryEntry(scope)])).resolves.toEqual([
      { cold: true },
    ]);
    transactionLog.entries = [];
    await expect(prepareSessionMemoryEntries([memoryEntry(scope)])).resolves.toEqual([
      { cold: true },
    ]);
    expect(transactionLog.entries).toEqual(["transaction"]);
  });
});
