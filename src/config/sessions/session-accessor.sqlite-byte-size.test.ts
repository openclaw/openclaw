import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  loadTranscriptEventsSync,
  persistSessionTranscriptTurn,
  readTranscriptStatsSync,
  replaceTranscriptEvents,
} from "./session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import {
  readRecentSessionTranscriptMessageEvents,
  readSessionTranscriptActiveStats,
  readSessionTranscriptBoundedMessageTailPage,
  readSessionTranscriptVisibleMessageDeltaCore,
} from "./session-accessor.sqlite-active-events.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import { readTranscriptRawDelta } from "./session-accessor.sqlite-delta.js";
import {
  readRecentSessionTranscriptHistoryEvents,
  readTranscriptDisplayDelta,
} from "./session-accessor.sqlite-history-events.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import {
  shouldRebuildSessionTranscriptIndexSynchronously,
  SYNC_REBUILD_MAX_BYTES,
  SYNC_REBUILD_MAX_ROWS,
} from "./session-transcript-index.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

type SqliteInstruction = {
  opcode: string;
  p1: number;
  p2: number;
  p5: number;
};

const readers: Array<
  [string, (scope: SessionTranscriptReadScope & { agentId: string }) => unknown]
> = [
  ["usage stats", readTranscriptStatsSync],
  ["active stats", readSessionTranscriptActiveStats],
  [
    "rebuild preflight",
    (scope) =>
      shouldRebuildSessionTranscriptIndexSynchronously(
        openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env }).db,
        scope.sessionId,
      ),
  ],
  ["raw delta", (scope) => readTranscriptRawDelta(scope, { maxBytes: 1024 })],
  ["display delta", (scope) => readTranscriptDisplayDelta(scope, { maxBytes: 1024 })],
  [
    "visible delta",
    (scope) => readSessionTranscriptVisibleMessageDeltaCore(scope, { maxBytes: 1024 }),
  ],
  [
    "active context",
    (scope) =>
      readSessionTranscriptBoundedActiveContextCore(scope, { maxBytes: 1024, maxEvents: 10 }),
  ],
  [
    "message tail",
    (scope) =>
      readSessionTranscriptBoundedMessageTailPage(scope, {
        maxBytes: 1024,
        maxMessages: 10,
        offset: 0,
      }),
  ],
  [
    "recent usage tail",
    (scope) =>
      readRecentSessionTranscriptMessageEvents(scope, {
        maxBytes: 1024,
        maxLines: 10,
        maxMessages: 10,
      }),
  ],
  [
    "history tail",
    (scope) =>
      readRecentSessionTranscriptHistoryEvents(scope, {
        maxBytes: 1024,
        maxLines: 10,
        maxMessages: 10,
      }),
  ],
];

it.each(readers)("sizes %s without reading transcript overflow payloads", async (_name, read) => {
  await withOpenClawTestState({ label: "transcript-byte-size" }, async (state) => {
    const scope = {
      agentId: "main",
      env: state.env,
      sessionId: "byte-size",
      sessionKey: "agent:main:byte-size",
    };
    await persistSessionTranscriptTurn(scope, {
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
    const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId, env: state.env });
    const table = db
      .prepare(
        "SELECT rootpage FROM sqlite_schema WHERE type = 'table' AND name = 'transcript_events'",
      )
      .get();
    const column = db
      .prepare("SELECT cid FROM pragma_table_info('transcript_events') WHERE name = 'event_json'")
      .get();
    expect(table).toBeDefined();
    expect(column).toBeDefined();
    clearNodeSqliteKyselyCacheForDatabase(db);
    const prepare = db.prepare.bind(db);
    const sizingQueries: string[] = [];
    const readinessQueries: string[] = [];
    const spy = vi.spyOn(db, "prepare").mockImplementation((query) => {
      const statement = prepare(query);
      if (
        statement
          .columns()
          .some(
            ({ name }) =>
              name === "size_bytes" || name === "serialized_bytes" || name === "event_bytes",
          )
      ) {
        sizingQueries.push(query);
      }
      if (
        query.includes("context_eligible") &&
        statement.columns().some(({ name }) => name === "session_id" || name === "has_unclassified")
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
      const transcriptCursors = new Set(
        instructions
          .filter((op) => op.opcode === "OpenRead" && op.p2 === table?.rootpage)
          .map((op) => op.p1),
      );
      const payloadReads = instructions.filter(
        (op) => op.opcode === "Column" && transcriptCursors.has(op.p1) && op.p2 === column?.cid,
      );
      expect(payloadReads.length).toBeGreaterThan(0);
      // SQLite's OPFLAG_BYTELENARG (sqliteInt.h) tells OP_Column to skip overflow pages.
      // Inspect the executed production query, not a hand-copied SQL expression or timing threshold.
      expect(payloadReads.every((op) => (op.p5 & 0xc0) === 0xc0)).toBe(true);
    }
  });
});

it.each([
  { name: "raw", read: readTranscriptRawDelta },
  { name: "display", read: readTranscriptDisplayDelta },
])("bounds $name delta sizing before its byte limit and resumes in order", async ({ read }) => {
  await withOpenClawTestState({ label: "delta-byte-budget" }, async (state) => {
    const scope = {
      agentId: "main",
      env: state.env,
      sessionId: "delta-byte-budget",
      sessionKey: "agent:main:delta-byte-budget",
    };
    const events = Array.from({ length: 512 }, (_, index) => ({
      type: "message",
      id: `event-${index}`,
      parentId: index === 0 ? null : `event-${index - 1}`,
      message: { role: "user", content: `🦞\0-${index}` },
    }));
    await replaceTranscriptEvents(scope, events);
    const limits = { maxBytes: 1, maxEvents: 1_000 };
    read(scope, limits);
    const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    const counter = trackSqliteStatementExecutions(db, ["metadata"], (query) =>
      query.includes('from "transcript_events"') && query.includes("serialized_bytes")
        ? "metadata"
        : null,
    );
    try {
      const blocked = read(scope, limits);
      expect(blocked).toMatchObject({
        kind: "page",
        events: [],
        hasMore: true,
        requiredBytes: Buffer.byteLength(JSON.stringify(events[0])) + 1,
        serializedBytes: 0,
      });
      expect(counter.rowCounts.metadata).toBeLessThanOrEqual(128);

      const expected = events.slice(0, 70);
      const maxBytes = expected.reduce(
        (total, event) => total + Buffer.byteLength(JSON.stringify(event)) + 1,
        0,
      );
      const first = read(scope, { ...limits, maxBytes });
      if (first.kind !== "page") {
        throw new Error("Expected the first delta page");
      }
      expect(first.events.map(({ event }) => event)).toEqual(expected);
      expect(first).toMatchObject({ hasMore: true, serializedBytes: maxBytes });
      expect(first).not.toHaveProperty("requiredBytes");
      expect(counter.rowCounts.metadata).toBeLessThanOrEqual(256);

      const rest = read(scope, { cursor: first.cursor, maxEvents: 1_000, maxBytes: 1_000_000 });
      if (rest.kind !== "page") {
        throw new Error("Expected the remaining delta page");
      }
      expect(rest.events.map(({ event }) => event)).toEqual(events.slice(expected.length));
      expect(rest.hasMore).toBe(false);
      expect(read(scope, { cursor: rest.cursor })).toMatchObject({
        kind: "page",
        events: [],
        hasMore: false,
      });
    } finally {
      counter.restore();
    }
  });
});

it.each(["incoming", "stored"])(
  "defers a rebuild when %s UTF-8 bytes exceed the synchronous budget",
  (source) => {
    const db = openNodeSqliteDatabase(":memory:");
    try {
      db.exec(
        "CREATE TABLE transcript_events (session_id TEXT, event_json TEXT, event_utf8_bytes INTEGER)",
      );
      const event = { message: { role: "user", content: "🦞".repeat(SYNC_REBUILD_MAX_BYTES / 4) } };
      const serialized = JSON.stringify(event);
      expect(serialized.length).toBeLessThan(SYNC_REBUILD_MAX_BYTES);
      expect(Buffer.byteLength(serialized)).toBeGreaterThan(SYNC_REBUILD_MAX_BYTES);
      expect(
        shouldRebuildSessionTranscriptIndexSynchronously(db, "budget", [{ message: "small" }]),
      ).toBe(true);
      if (source === "stored") {
        db.prepare("INSERT INTO transcript_events (session_id, event_json) VALUES (?, ?)").run(
          "budget",
          serialized,
        );
      }
      expect(
        shouldRebuildSessionTranscriptIndexSynchronously(
          db,
          "budget",
          source === "incoming" ? [event] : [],
        ),
      ).toBe(false);
    } finally {
      db.close();
    }
  },
);

it("admits compressed transcript bytes before decoding and preserves canonical snapshot text", async () => {
  await withOpenClawTestState({ label: "compressed-transcript-byte-budget" }, async (state) => {
    const scope = {
      agentId: "main",
      env: state.env,
      sessionId: "compressed-byte-budget",
      sessionKey: "agent:main:compressed-byte-budget",
    };
    const events = [
      {
        type: "message",
        id: "large",
        parentId: null,
        message: { role: "user", content: "雪🦞".repeat(4096) },
      },
      {
        type: "message",
        id: "small",
        parentId: "large",
        message: { role: "assistant", content: "done" },
      },
    ];
    await replaceTranscriptEvents(scope, events);
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: state.env });
    const compressed = database.db
      .prepare("SELECT seq FROM transcript_events WHERE session_id = ? AND event_zstd IS NOT NULL")
      .get(scope.sessionId);
    expect(compressed).toBeDefined();
    const canonical = events.map((event) => JSON.stringify(event));
    const sizeBytes = Buffer.byteLength(canonical.join("\n"));
    expect(readTranscriptStatsSync(scope).sizeBytes).toBe(sizeBytes);
    expect(loadTranscriptEventsSync({ ...scope, maxEventBytes: sizeBytes })).toEqual(events);
    expect(readTranscriptEventRows(database, scope.sessionId).map((row) => row.eventJson)).toEqual(
      canonical,
    );

    database.db
      .prepare(
        "UPDATE transcript_events SET event_zstd = x'010203' WHERE session_id = ? AND seq = ?",
      )
      .run(scope.sessionId, compressed!.seq!);
    expect(readTranscriptStatsSync(scope).sizeBytes).toBe(sizeBytes);
    expect(readTranscriptRawDelta(scope, { maxBytes: 1 })).toMatchObject({
      kind: "page",
      events: [],
      hasMore: true,
      requiredBytes: Buffer.byteLength(canonical[0]!) + 1,
      serializedBytes: 0,
    });
    expect(() => loadTranscriptEventsSync({ ...scope, maxEventBytes: sizeBytes - 1 })).toThrow(
      /transcript store is too large to export/u,
    );
    expect(() => loadTranscriptEventsSync({ ...scope, maxEventBytes: sizeBytes })).toThrow();
  });
});

it.each([
  { incomingRows: 0, storedRows: SYNC_REBUILD_MAX_ROWS, synchronous: true },
  { incomingRows: 0, storedRows: SYNC_REBUILD_MAX_ROWS * 2, synchronous: false },
  { incomingRows: 1, storedRows: SYNC_REBUILD_MAX_ROWS - 1, synchronous: true },
  { incomingRows: 1, storedRows: SYNC_REBUILD_MAX_ROWS * 2, synchronous: false },
  { incomingRows: SYNC_REBUILD_MAX_ROWS + 1, storedRows: 1, synchronous: false },
])(
  "bounds rebuild preflight with $storedRows stored and $incomingRows incoming rows",
  ({ incomingRows, storedRows, synchronous }) => {
    const db = openNodeSqliteDatabase(":memory:");
    try {
      db.exec(
        "CREATE TABLE transcript_events (session_id TEXT, event_json TEXT, event_utf8_bytes INTEGER)",
      );
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
        shouldRebuildSessionTranscriptIndexSynchronously(
          db,
          "budget",
          Array.from({ length: incomingRows }, () => event),
        ),
      ).toBe(synchronous);
      const remainingRows = SYNC_REBUILD_MAX_ROWS - incomingRows;
      expect(sizedRows).toBeLessThanOrEqual(Math.max(0, remainingRows + 1));
    } finally {
      db.close();
    }
  },
);

it.each(
  [
    { name: "usage", read: readRecentSessionTranscriptMessageEvents },
    { name: "history", read: readRecentSessionTranscriptHistoryEvents },
  ].flatMap((reader) =>
    [false, true].map((oversized) => ({ name: reader.name, read: reader.read, oversized })),
  ),
)("bounds $name tail sizing with newest oversized=$oversized", async ({ read, oversized }) => {
  await withOpenClawTestState({ label: "usage-tail-budget" }, async (state) => {
    const scope = {
      agentId: "main",
      env: state.env,
      sessionId: "usage-tail",
      sessionKey: "agent:main:usage-tail",
    };
    await persistSessionTranscriptTurn(scope, {
      messages: [
        ...Array.from({ length: 1_000 }, (_, index) => `old-${index}`),
        "large",
        "new",
      ].map((eventId, index, ids) => ({
        eventId,
        parentId: ids[index - 1] ?? null,
        message: {
          role: "assistant",
          content:
            eventId === "large" || (oversized && eventId === "new") ? "🦞".repeat(1024) : eventId,
        },
      })),
      touchSessionEntry: false,
    });
    const options = { maxBytes: 1024, maxLines: 1_000, maxMessages: 1_000 };
    read(scope, options);
    const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    const counter = trackSqliteStatementExecutions(db, ["metadata"], (sql) =>
      sql.includes("session_transcript_active_events") &&
      sql.includes("message_position") &&
      sql.includes("serialized_bytes")
        ? "metadata"
        : null,
    );
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const page = read(scope, options);
        expect(page.totalMessages).toBe(1_002);
        expect(page.events).toEqual([
          expect.objectContaining({ event: expect.objectContaining({ id: "new" }) }),
        ]);
      }
      // Each read sizes the newest event and its rejecting predecessor, then releases
      // its SQLite iterator so the same connection can commit the next transcript write.
      expect(counter.rowCounts.metadata).toBeLessThanOrEqual(6);
      await persistSessionTranscriptTurn(scope, {
        messages: [transcriptMessage("next", "new", { role: "user", content: "next" })],
        touchSessionEntry: false,
      });
      expect(read(scope, options).events.at(-1)?.event).toMatchObject({ id: "next" });
    } finally {
      counter.restore();
    }
  });
});
