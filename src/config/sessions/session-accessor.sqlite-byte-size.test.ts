import assert from "node:assert/strict";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureRuntimeConfigAsyncReader } from "../io.js";
import {
  loadTranscriptEventsSync as loadEvents,
  persistSessionTranscriptTurn as persistTurn,
  readTranscriptStatsSync as readStats,
} from "./session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore as readContext } from "./session-accessor.sqlite-active-context.js";
import {
  readRecentSessionTranscriptMessageEvents as readRecent,
  readSessionTranscriptBoundedMessageTailPage as readTail,
  readSessionTranscriptVisibleMessageDeltaCore as readVisible,
} from "./session-accessor.sqlite-active-events.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import { readTranscriptRawDelta as readRaw } from "./session-accessor.sqlite-delta.js";
import {
  readRecentSessionTranscriptHistoryEvents as readHistory,
  readTranscriptDisplayDelta,
} from "./session-accessor.sqlite-history-events.test-support.js";
import { readActiveTranscriptStats } from "./session-accessor.sqlite-history.test-support.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import type { SessionTranscriptRuntimeScope } from "./session-accessor.types.js";
import {
  shouldRebuildSessionTranscriptIndexSynchronously as shouldRebuild,
  SYNC_REBUILD_MAX_BYTES,
  SYNC_REBUILD_MAX_ROWS,
} from "./session-transcript-index.js";
import {
  transcriptMessage,
  messageEvent as createMessageEvent,
} from "./transcript-message.test-support.js";

type SqliteInstruction = {
  opcode: string;
  p1: number;
  p2: number;
  p4: string | null;
  p5: number;
};

const budgetDatabases: ReturnType<typeof openNodeSqliteDatabase>[] = [];
afterEach(() => {
  for (const db of budgetDatabases.splice(0)) {
    db.close();
  }
});
const page = (events: unknown[], hasMore: boolean, sizes: Record<string, number> = {}) => ({
  kind: "page",
  events,
  hasMore,
  ...sizes,
});
function budgetDatabase() {
  const db = openNodeSqliteDatabase(":memory:");
  budgetDatabases.push(db);
  db.exec(
    "CREATE TABLE transcript_events (session_id TEXT, event_json TEXT, event_utf8_bytes INTEGER)",
  );
  return db;
}
const messageEvent = (id: string, parentId: string | null, content: string, role = "user") =>
  createMessageEvent(id, parentId, { role, content });
const eventBytes = (event: unknown) => Buffer.byteLength(JSON.stringify(event)) + 1;
function countMetadata(
  scope: SessionTranscriptRuntimeScope & { agentId: string },
  ...terms: string[]
) {
  return trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(openOpenClawAgentDatabase(scope).db),
    ["metadata"],
    (sql) =>
      [...terms, "serialized_bytes"].every((term) => sql.includes(term)) ? "metadata" : null,
  );
}

const readers: Array<
  [string, (scope: SessionTranscriptReadScope & { agentId: string }) => unknown]
> = [
  ["raw stats", readStats],
  ["active stats", readActiveTranscriptStats],
  ["display delta", (scope) => readTranscriptDisplayDelta(scope, { maxBytes: 1024 })],
  ["visible delta", (scope) => readVisible(scope, { maxBytes: 1024 })],
  ["active context", (scope) => readContext(scope, { maxBytes: 1024, maxEvents: 10 })],
  ["message tail", (scope) => readTail(scope, { maxBytes: 1024, maxMessages: 10, offset: 0 })],
  [
    "recent usage tail",
    (scope) => readRecent(scope, { maxBytes: 1024, maxLines: 10, maxMessages: 10 }),
  ],
];

async function withByteSizeScope(
  run: (scope: SessionTranscriptRuntimeScope & { agentId: string }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "transcript-byte-size" }, async (state) => {
    await captureRuntimeConfigAsyncReader()();
    await run({
      agentId: "main",
      env: state.env,
      sessionId: "byte-size",
      sessionKey: "agent:main:byte-size",
    });
  });
}

it.each(readers)("sizes %s without reading transcript overflow payloads", async (_name, read) => {
  await withByteSizeScope(async (scope) => {
    await persistTurn(scope, {
      messages: [
        transcriptMessage("large", null, { role: "user", content: "🦞".repeat(4096) }),
        transcriptMessage("display", "large", {
          role: "custom",
          customType: "activity",
          excludeFromContext: true,
          display: true,
          content: "🦞".repeat(4096),
        }),
        transcriptMessage("small", "display", { role: "assistant", content: "done" }),
      ],
      touchSessionEntry: false,
    });
    const db = requireNativeSqliteDatabase(openOpenClawAgentDatabase(scope).db);
    const table = db
      .prepare(
        "SELECT rootpage FROM sqlite_schema WHERE name = 'transcript_events' AND type = 'table'",
      )
      .get();
    const column = db
      .prepare("SELECT cid FROM pragma_table_info('transcript_events') WHERE name = 'event_json'")
      .get();
    expect([table, column]).not.toContain(undefined);
    clearNodeSqliteKyselyCacheForDatabase(db);
    const prepare = db.prepare.bind(db);
    const sizingQueries: string[] = [];
    const readinessQueries: string[] = [];
    const spy = vi.spyOn(db, "prepare").mockImplementation((query) => {
      const statement = prepare(query);
      const columns = new Set(statement.columns().map(({ name }) => name));
      if (
        ["sizeBytes", "size_bytes", "serialized_bytes", "event_bytes"].some((name) =>
          columns.has(name),
        )
      ) {
        sizingQueries.push(query);
      }
      if (
        query.includes("context_eligible") &&
        ["session_id", "has_unclassified"].some((name) => columns.has(name))
      ) {
        readinessQueries.push(query);
      }
      return statement;
    });
    try {
      read(scope);
    } finally {
      spy.mockRestore();
    }

    expect(sizingQueries.length).toBeGreaterThan(0);
    if (_name === "active stats" || _name === "active context") {
      expect(readinessQueries.length).toBeGreaterThan(0);
    }
    for (const query of readinessQueries) {
      const plan = prepare(`EXPLAIN QUERY PLAN ${query}`).all();
      expect(plan.map((row) => row.detail).join("\n")).toContain(
        "idx_agent_transcript_context_pending",
      );
      const instructions = prepare(`EXPLAIN ${query}`).all() as SqliteInstruction[];
      expect(instructions.some((op) => op.opcode === "OpenRead" && op.p2 === table?.rootpage)).toBe(
        false,
      );
    }
    for (const query of sizingQueries) {
      const instructions = prepare(`EXPLAIN ${query}`).all() as SqliteInstruction[];
      if (_name === "raw stats" || _name === "active stats") {
        // Event counts and newline-byte accounting must share one per-row accumulator.
        expect(
          instructions.filter((op) => op.opcode === "AggStep" && op.p4?.startsWith("count("))
            .length,
        ).toBeLessThanOrEqual(1);
      }
      const transcriptCursors = new Set(
        instructions
          .filter((op) => op.opcode === "OpenRead" && op.p2 === table?.rootpage)
          .map((op) => op.p1),
      );
      let sizingCalls = 0;
      for (const [index, op] of instructions.entries()) {
        if ((op.opcode !== "Function" && op.opcode !== "PureFunc") || op.p4 !== "octet_length(1)") {
          continue;
        }
        sizingCalls++;
        // Header discovery may also read JSON in this query. The sizing function's input
        // must use SQLite's OPFLAG_BYTELENARG so it never reads overflow payload pages.
        const input = expectDefined(instructions[index - 1], "byte-length input instruction");
        expect(input).toMatchObject({ opcode: "Column", p2: column?.cid, p3: op.p2 });
        expect(transcriptCursors.has(input.p1)).toBe(true);
        expect(input.p5 & 0xc0).toBe(0xc0);
      }
      expect(sizingCalls).toBeGreaterThan(0);
    }
  });
});

it("bounds display delta sizing before its byte limit and resumes in order", async () => {
  const read = readTranscriptDisplayDelta;
  await withByteSizeScope(async (scope) => {
    const events = Array.from({ length: 512 }, (_, index) =>
      messageEvent(`event-${index}`, index === 0 ? null : `event-${index - 1}`, `🦞\0-${index}`),
    );
    await replaceTranscriptEvents(scope, events);
    const limits = { maxBytes: 1, maxEvents: 1_000 };
    read(scope, limits);
    const counter = countMetadata(scope, 'from "transcript_events"');
    using _ = { [Symbol.dispose]: counter.restore };
    expect(read(scope, limits)).toMatchObject(
      page([], true, {
        requiredBytes: eventBytes(events[0]),
        serializedBytes: 0,
      }),
    );
    expect(counter.rowCounts.metadata).toBeLessThanOrEqual(128);

    const expected = events.slice(0, 70);
    const maxBytes = expected.reduce((total, event) => total + eventBytes(event), 0);
    const first = read(scope, { ...limits, maxBytes });
    assert(first.kind === "page", "Expected the first delta page");
    expect(first.events.map(({ event }) => event)).toEqual(expected);
    expect(first).toMatchObject({ hasMore: true, serializedBytes: maxBytes });
    expect(first).not.toHaveProperty("requiredBytes");
    expect(counter.rowCounts.metadata).toBeLessThanOrEqual(256);

    const rest = read(scope, { cursor: first.cursor, maxEvents: 1_000, maxBytes: 1_000_000 });
    assert(rest.kind === "page", "Expected the remaining delta page");
    expect(rest.events.map(({ event }) => event)).toEqual(events.slice(expected.length));
    expect(rest.hasMore).toBe(false);
    expect(read(scope, { cursor: rest.cursor })).toMatchObject(page([], false));
  });
});

it.each(["incoming", "stored"])(
  "defers a rebuild when %s UTF-8 bytes exceed the synchronous budget",
  (source) => {
    const db = budgetDatabase();
    const event = { message: { role: "user", content: "🦞".repeat(SYNC_REBUILD_MAX_BYTES / 4) } };
    const serialized = JSON.stringify(event);
    expect(serialized.length).toBeLessThan(SYNC_REBUILD_MAX_BYTES);
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(SYNC_REBUILD_MAX_BYTES);
    expect(shouldRebuild(db, "budget", [{ message: "small" }])).toBe(true);
    if (source === "stored") {
      db.prepare("INSERT INTO transcript_events (session_id, event_json) VALUES (?, ?)").run(
        "budget",
        serialized,
      );
    }
    expect(shouldRebuild(db, "budget", source === "incoming" ? [event] : [])).toBe(false);
  },
);

it("admits compressed transcript bytes before decoding and preserves canonical snapshot text", async () => {
  await withByteSizeScope(async (scope) => {
    const events = [
      messageEvent("large", null, "雪🦞".repeat(4096)),
      messageEvent("small", "large", "done", "assistant"),
    ];
    await replaceTranscriptEvents(scope, events);
    const database = openOpenClawAgentDatabase(scope);
    const compressed = database.db
      .prepare("SELECT seq FROM transcript_events WHERE session_id = ? AND event_zstd IS NOT NULL")
      .get(scope.sessionId);
    expect(compressed).toBeDefined();
    const canonical = events.map((event) => JSON.stringify(event));
    const sizeBytes = Buffer.byteLength(canonical.join("\n"));
    expect(readStats(scope).sizeBytes).toBe(sizeBytes);
    expect(loadEvents({ ...scope, maxEventBytes: sizeBytes })).toEqual(events);
    expect(readTranscriptEventRows(database, scope.sessionId).map((row) => row.eventJson)).toEqual(
      canonical,
    );
    const raw = (maxBytes: number) => readRaw(scope, { maxBytes });
    expect(raw(sizeBytes + events.length)).toMatchObject(
      page(
        events.map((event, seq) => ({ event, seq })),
        false,
        { serializedBytes: sizeBytes + 1 },
      ),
    );

    database.db
      .prepare(
        "UPDATE transcript_events SET event_zstd = x'010203' WHERE session_id = ? AND seq = ?",
      )
      .run(scope.sessionId, compressed!.seq!);
    expect(readStats(scope).sizeBytes).toBe(sizeBytes);
    expect(raw(1)).toMatchObject(
      page([], true, { requiredBytes: Buffer.byteLength(canonical[0]!) + 1, serializedBytes: 0 }),
    );
    expect(() => raw(sizeBytes + events.length)).toThrow();
    expect(() => loadEvents({ ...scope, maxEventBytes: sizeBytes - 1 })).toThrow(
      /transcript store is too large to export/u,
    );
    expect(() => loadEvents({ ...scope, maxEventBytes: sizeBytes })).toThrow();
  });
});

it.each([
  { incomingRows: 1, storedRows: SYNC_REBUILD_MAX_ROWS * 2, synchronous: false },
  { incomingRows: SYNC_REBUILD_MAX_ROWS + 1, storedRows: 1, synchronous: false },
])(
  "bounds rebuild preflight with $storedRows stored and $incomingRows incoming rows",
  ({ incomingRows, storedRows, synchronous }) => {
    const db = budgetDatabase();
    const event = { message: { role: "user", content: "small" } };
    const serialized = JSON.stringify(event);
    const insert = db.prepare(
      "INSERT INTO transcript_events (session_id, event_json) VALUES (?, ?)",
    );
    for (let index = 0; index < storedRows; index++) {
      insert.run("budget", serialized);
    }
    let sizedRows = 0;
    db.function("octet_length", (value) => {
      sizedRows++;
      return Buffer.byteLength(String(value));
    });
    expect(
      shouldRebuild(
        db,
        "budget",
        Array.from({ length: incomingRows }, () => event),
      ),
    ).toBe(synchronous);
    const remainingRows = SYNC_REBUILD_MAX_ROWS - incomingRows;
    expect(sizedRows).toBeLessThanOrEqual(Math.max(0, remainingRows + 1));
  },
);

it("bounds history tail sizing while retaining an oversized newest event", async () => {
  const read = readHistory;
  await withByteSizeScope(async (scope) => {
    await persistTurn(scope, {
      messages: [
        ...Array.from({ length: 1_000 }, (_, index) => `old-${index}`),
        "large",
        "new",
      ].map((eventId, index, ids) => ({
        eventId,
        parentId: ids[index - 1] ?? null,
        message: {
          role: "assistant",
          content: eventId === "large" || eventId === "new" ? "🦞".repeat(1024) : eventId,
        },
      })),
      touchSessionEntry: false,
    });
    const options = { maxBytes: 1024, maxLines: 1_000, maxMessages: 1_000 };
    read(scope, options);
    const counter = countMetadata(scope, "session_transcript_active_events", "message_position");
    using _ = { [Symbol.dispose]: counter.restore };
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = read(scope, options);
      expect(result.totalMessages).toBe(1_002);
      expect(result.events).toEqual([
        expect.objectContaining({ event: expect.objectContaining({ id: "new" }) }),
      ]);
    }
    // Each read sizes the newest event and its rejecting predecessor, then releases
    // its SQLite iterator so the same connection can commit the next transcript write.
    expect(counter.rowCounts.metadata).toBeLessThanOrEqual(6);
    await persistTurn(scope, {
      messages: [transcriptMessage("next", "new", { role: "user", content: "next" })],
      touchSessionEntry: false,
    });
    expect(read(scope, options).events.at(-1)?.event).toMatchObject({ id: "next" });
  });
});
