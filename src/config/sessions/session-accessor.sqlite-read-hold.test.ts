import path from "node:path";
import type { StatementSync } from "node:sqlite";
import type { Message } from "openclaw/plugin-sdk/llm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { readActiveTranscriptEntryAnchor, replaceSessionEntry } from "./session-accessor.js";
import {
  readTranscriptExportSnapshotReadOnlySync,
  readTranscriptStatsSync,
} from "./session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessage } from "./session-accessor.sqlite-transcript-write.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { collectSessionMemoryEntries } from "./session-memory-entry.worker.test-support.js";

const sliceBudget = vi.hoisted(() => ({ bytes: undefined as number | undefined }));
const transactionLog = vi.hoisted(() => ({
  entries: [] as string[],
  afterFirst: undefined as (() => void) | undefined,
  depth: 0,
}));

vi.mock("./session-transcript-read-bytes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-transcript-read-bytes.js")>();
  return {
    ...actual,
    get TRANSCRIPT_PAYLOAD_SLICE_BYTES() {
      return sliceBudget.bytes ?? actual.TRANSCRIPT_PAYLOAD_SLICE_BYTES;
    },
  };
});

vi.mock("../../infra/sqlite-transaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/sqlite-transaction.js")>();
  const logged = (label: string | undefined) => {
    if (label?.startsWith("session transcript")) {
      transactionLog.entries.push("transaction");
      const afterFirst = transactionLog.afterFirst;
      transactionLog.afterFirst = undefined;
      afterFirst?.();
    }
  };
  return {
    ...actual,
    runSqliteReadSnapshotSync: ((db, operation, options) => {
      const result = actual.runSqliteReadSnapshotSync(
        db,
        () => {
          transactionLog.depth++;
          try {
            return operation();
          } finally {
            transactionLog.depth--;
          }
        },
        options,
      );
      logged(options?.operationLabel);
      return result;
    }) as typeof actual.runSqliteReadSnapshotSync,
  };
});

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-transcript-hold-");
const MARKER = "hold-probe-marker";
const MIB = 1024 * 1024;
// Rows decode to at most 4 MiB each; two of these push a transcript past the 4 MiB snapshot limit.
const LARGE_ROWS = [Math.floor(2.5 * MIB), Math.floor(2.5 * MIB)];
// Above the 2 MiB slice budget and below the 4 MiB snapshot limit.
const MEDIUM_ROWS = [3 * MIB];

afterEach(() => {
  sliceBudget.bytes = undefined;
  transactionLog.entries = [];
  transactionLog.afterFirst = undefined;
  transactionLog.depth = 0;
  vi.restoreAllMocks();
});

function userMessage(content: string): Message {
  return { role: "user", content, timestamp: 1 };
}

describe("SQLite transcript readers release the read snapshot before parsing", () => {
  /** `shared` adds a tagged session to an existing store instead of a new one. */
  async function seedSession(
    shared?: { storePath: string; tag: string },
    /** Decoded payload bytes of extra user rows appended after the four small ones. */
    extraRows: number[] = [],
  ) {
    const tempDir = shared ? path.dirname(shared.storePath) : sessionDirs.make();
    const storePath = shared?.storePath ?? path.join(tempDir, "sessions.json");
    const sessionId = shared ? `session-hold-${shared.tag}` : "session-hold";
    const sessionKey = shared ? `agent:main:hold-${shared.tag}` : "agent:main:hold";
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      { sessionId, updatedAt: 1 },
    );
    const contents = [
      ...Array.from({ length: 4 }, (_, index) =>
        index % 2 === 0
          ? `${MARKER} ${"lobster ".repeat(600)}`
          : `${MARKER} short${shared ? ` ${shared.tag}` : ""}`,
      ),
      ...extraRows.map((bytes) => `${MARKER} ${"lobster ".repeat(Math.floor(bytes / 8))}`),
    ];
    const events = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-04-01T05:46:39.000Z",
        cwd: tempDir,
      },
      // Alternating compressed/plain rows, followed by optional oversized payloads.
      ...contents.map((content, index) => ({
        type: "message",
        id: `entry-${index}`,
        parentId: index === 0 ? null : `entry-${index - 1}`,
        timestamp: `2026-04-01T05:46:${index < 4 ? "40" : "41"}.000Z`,
        message: userMessage(content),
      })),
    ];
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await replaceTranscriptEvents(scope, events);
    return { events, scope };
  }

  function openStore(scope: { agentId: string; sessionId: string; storePath: string }) {
    return openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteTranscriptReadScope(scope))).db;
  }

  function readEvents(
    scope: Awaited<ReturnType<typeof seedSession>>["scope"],
    projectEvent?: (event: unknown) => unknown,
  ) {
    return readTranscriptExportSnapshotReadOnlySync(scope, { projectEvent })?.events;
  }

  it.each([undefined, 1])(
    "parses and projects outside each read snapshot (budget=%s)",
    async (bytes) => {
      const { events, scope } = await seedSession();
      sliceBudget.bytes = bytes;
      const prototype = requireNodeSqlite().StatementSync.prototype;
      const iterate = vi.spyOn(prototype, "iterate");
      let expandedPayloadBytes = 0;
      prototype.iterate = function* (this: StatementSync, ...params) {
        const rows: ReturnType<StatementSync["iterate"]> = Reflect.apply(iterate, this, params);
        for (const row of rows) {
          for (const value of Object.values(row)) {
            // Compressed fixture bodies must not round-trip through SQLite as expanded text.
            if (typeof value === "string" && value.includes(MARKER) && value.length > 1024) {
              expandedPayloadBytes += Buffer.byteLength(value);
            }
          }
          yield row;
        }
        return undefined;
      };
      const realParse = JSON.parse.bind(JSON);
      vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
        if (typeof text === "string" && text.includes(MARKER)) {
          expect(transactionLog.depth).toBe(0);
        }
        return realParse(text, reviver);
      });
      const projectEvent = vi.fn((event: unknown) => {
        expect(transactionLog.depth).toBe(0);
        transactionLog.entries.push("parse");
        return event;
      });
      expect(readEvents(scope, projectEvent)).toEqual(events);
      expect(expandedPayloadBytes).toBe(0);
      expect(projectEvent.mock.calls.map(([event]) => event)).toEqual(events);
      expect(transactionLog.entries).toEqual(
        bytes === 1
          ? [...events.flatMap(() => ["transaction", "parse"]), "transaction"]
          : ["transaction", ...events.map(() => "parse")],
      );
    },
  );

  it("surfaces the payload length error from a corrupt compressed row in a later slice", async () => {
    const { scope } = await seedSession();
    openStore(scope)
      .prepare(
        "UPDATE transcript_events SET event_utf8_bytes = event_utf8_bytes + 1 WHERE session_id = ? AND event_zstd IS NOT NULL",
      )
      .run(scope.sessionId);
    // The header fills the first slice; the corrupt row is read after it committed and was parsed.
    sliceBudget.bytes = 1;
    expect(() => readEvents(scope)).toThrow(/Compressed transcript payload length does not match/u);
  });

  it("rereads in one transaction when the transcript changes between slices", async () => {
    const { events, scope } = await seedSession();
    sliceBudget.bytes = 1;
    const db = openStore(scope);
    // An in-place rewrite of the already parsed first row, with the update time writers bump.
    transactionLog.afterFirst = () => {
      db.prepare(
        `UPDATE transcript_events SET event_json = json_set(event_json, '$.cwd', 'rewritten')
         WHERE session_id = ? AND seq = (SELECT min(seq) FROM transcript_events WHERE session_id = ?)`,
      ).run(scope.sessionId, scope.sessionId);
      touchTranscript(scope)();
    };
    expect(readEvents(scope)).toEqual([{ ...events[0], cwd: "rewritten" }, ...events.slice(1)]);
    // First slice, the transaction that saw the new version, then one whole reread.
    expect(transactionLog.entries).toEqual(["transaction", "transaction", "transaction"]);
  });

  // A string-length budget undercounts multibyte text (UTF-8 stores CJK at 3 bytes per
  // character), and a stored-size budget undercounts zstd rows, which decode to far more text.
  it("budgets slices by decoded payload bytes, not string length or stored size", async () => {
    const { events: seeded, scope } = await seedSession();
    // 250 CJK characters stay plain JSON, so their payload is at least twice their length.
    const unicode = Array.from({ length: 3 }, (_, index) => ({
      type: "message",
      id: `unicode-${index}`,
      parentId: index === 0 ? "entry-3" : `unicode-${index - 1}`,
      timestamp: "2026-04-01T05:46:41.000Z",
      message: userMessage("漢".repeat(250)),
    }));
    const events = [...seeded, ...unicode];
    await replaceTranscriptEvents(scope, events);
    const rows = openStore(scope)
      .prepare(
        `SELECT event_utf8_bytes AS payload, coalesce(octet_length(event_zstd), length(event_json)) AS measured
         FROM transcript_events
         WHERE session_id = ? AND (event_zstd IS NOT NULL OR event_json LIKE '%unicode-%')
         ORDER BY seq`,
      )
      .all(scope.sessionId) as Array<{ payload: number; measured: number }>;
    expect(rows).toHaveLength(5);
    // Each of these rows alone fills the slice by decoded payload bytes, but not by its stored
    // size (zstd) or its string length (CJK).
    sliceBudget.bytes = Math.min(...rows.map((row) => row.payload));
    for (const row of rows) {
      expect(row.measured).toBeLessThan(sliceBudget.bytes);
    }
    const projectEvent = vi.fn((event: { id?: string }) => {
      transactionLog.entries.push(`parse ${event.id}`);
      return event;
    });
    expect(readEvents(scope, projectEvent as (event: unknown) => unknown)).toEqual(events);
    const entries = transactionLog.entries;
    for (const id of ["entry-0", "entry-2", ...unicode.map((event) => event.id)]) {
      expect(entries[entries.indexOf(`parse ${id}`) + 1]).toBe("transaction");
    }
  });

  it("continues an incremental export after the previous projection in slices", async () => {
    const { events, scope } = await seedSession();
    const first = readTranscriptExportSnapshotReadOnlySync(scope, { previous: null });
    expect(first?.events).toEqual(events);
    expect(first?.generation).toEqual(expect.any(String));
    const seqs = (
      openStore(scope)
        .prepare("SELECT seq FROM transcript_events WHERE session_id = ? ORDER BY seq")
        .all(scope.sessionId) as Array<{ seq: number }>
    ).map((row) => row.seq);
    sliceBudget.bytes = 1;
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

  function entryContent(result: Awaited<ReturnType<typeof collectSessionMemoryEntries>>[number]) {
    return "entry" in result ? result.entry?.content : undefined;
  }

  /** Bumps the update time writers bump, so the transcript context version changes. */
  function touchTranscript(scope: { agentId: string; sessionId: string; storePath: string }) {
    const db = openStore(scope);
    return () => {
      db.prepare(
        "UPDATE session_windows SET transcript_updated_at = coalesce(transcript_updated_at, 0) + 1 WHERE session_id = ?",
      ).run(scope.sessionId);
    };
  }

  // Unchanged, the read after the batch keeps the batch head; changed, it reads the head again.
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
      sliceBudget.bytes = 1;
      transactionLog.afterFirst = changed ? touchTranscript(scope) : undefined;
      const [result] = await collectSessionMemoryEntries([
        { ...memoryEntry(scope), admission: { ...anchor, logicalTurnId: "fenced", role: "user" } },
      ]);
      expect(transactionLog.entries.length).toBeGreaterThan(1);
      // entry-1 and entry-3 carry the same short text; the fence stops before entry-2.
      expect(entryContent(result!)?.split(`${MARKER} short`)).toHaveLength(2);
    },
  );

  it("reads transcripts within the retained-snapshot limit inside the batch transaction and larger ones after it, keeping entry order", async () => {
    const first = await seedSession();
    const { storePath } = first.scope;
    const second = await seedSession({ storePath, tag: "two" }, LARGE_ROWS);
    const third = await seedSession({ storePath, tag: "three" });
    const largeSize = readTranscriptStatsSync(second.scope).sizeBytes;
    expect(largeSize).toBeGreaterThan(4 * MIB);
    // The large transcript fits one slice, so it takes exactly one transaction after the batch.
    sliceBudget.bytes = 2 * largeSize;
    const results = await collectSessionMemoryEntries(
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

  it.each([false, true])(
    "keeps the incremental projection for a transcript read after the batch transaction (changed: %s)",
    async (changed) => {
      // Above the slice budget but within the snapshot limit: read and retained inside the batch.
      const { scope } = await seedSession(undefined, MEDIUM_ROWS);
      const size = readTranscriptStatsSync(scope).sizeBytes;
      expect(size).toBeGreaterThan(2 * MIB);
      expect(size).toBeLessThanOrEqual(4 * MIB);
      sliceBudget.bytes = 1;
      transactionLog.entries = [];
      const [first] = await collectSessionMemoryEntries([memoryEntry(scope)]);
      expect(transactionLog.entries).toEqual(["transaction"]);
      expect(entryContent(first!)).toContain(MARKER);
      // The append pushes it past the limit.
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
      const [next] = await collectSessionMemoryEntries([memoryEntry(scope)]);
      // The batch transaction, then only the appended row after the retained projection.
      expect(transactionLog.entries).toEqual(["transaction", "transaction", "transaction"]);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toContain(`${MARKER} appended`);
      expect(entryContent(next!)).toContain(`${MARKER} appended`);
      expect(entryContent(next!)).toContain(entryContent(first!));
    },
  );

  it("reports a transcript archived after the batch transaction deferred it as cold", async () => {
    const { scope } = await seedSession(undefined, LARGE_ROWS);
    sliceBudget.bytes = 1;
    transactionLog.afterFirst = () => {
      openStore(scope)
        .prepare(
          `INSERT INTO session_transcript_cold_archives
           (session_id, generation, archive_name, archive_sha256, event_count,
            raw_bytes, archive_bytes, last_seq, archived_at, storage)
           VALUES (?, 'archive-generation', 'synthetic', ?, 5, 0, 0, 4, 1, 'file')`,
        )
        .run(scope.sessionId, "0".repeat(64));
    };
    await expect(collectSessionMemoryEntries([memoryEntry(scope)])).resolves.toEqual([
      { cold: true },
    ]);
  });
});
