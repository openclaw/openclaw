import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { appendTranscriptEvent, persistSessionTranscriptTurn } from "./session-accessor.js";
import { readTranscriptRawDelta } from "./session-accessor.sqlite-delta.js";
import { readSessionTranscriptHistoryEventPage } from "./session-accessor.sqlite-history-events.js";
import {
  readTranscriptDisplayDelta,
  readRecentSessionTranscriptHistoryEvents,
} from "./session-accessor.sqlite-history-events.test-support.js";
import {
  historyEventId,
  readSessionTranscriptHistoryEventCount,
  insertSyntheticHistory,
  readSessionTranscriptHistoryEvents,
  readSessionTranscriptHistoryEventById,
  readSessionTranscriptHistoryAnchorPage,
  useHistoryEventScope,
} from "./session-accessor.sqlite-history.test-support.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { transcriptMessage } from "./transcript-message.test-support.js";
import { createTranscriptEventInserter } from "./transcript-payload.js";

function messageEvent(
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  content: string,
) {
  return { type: "message", id, parentId, message: { role, content } };
}

function message(
  id: string,
  parentId: string | null,
  role: "user" | "assistant" | "toolResult",
  content: string,
) {
  return transcriptMessage(id, parentId, { role, content });
}

function boundary(type: "reset" | "compaction", id: string, parentId: string, fields = {}) {
  return { type, id, parentId, timestamp: "2026-09-07T00:00:00.000Z", ...fields };
}

function expectEvents(
  events: { event: unknown; seq: number }[],
  ids: readonly string[],
  seqs?: readonly number[],
) {
  expect(events.map(historyEventId)).toEqual(ids);
  if (seqs) {
    expect(events.map(({ seq }) => seq)).toEqual(seqs);
  }
}

const REGRESSION_SQLITE_VARIABLE_LIMIT = 64;

function enforceSqliteVariableLimit(
  database: OpenClawAgentDatabase,
  limit = REGRESSION_SQLITE_VARIABLE_LIMIT,
): void {
  const nativeDb = requireNativeSqliteDatabase(database.db);
  const prepare = nativeDb.prepare.bind(nativeDb);
  vi.spyOn(nativeDb, "prepare").mockImplementation((source) => {
    const variableCount = source.match(/\?/gu)?.length ?? 0;
    if (variableCount > limit) {
      throw new Error("too many SQL variables");
    }
    return prepare(source);
  });
}

describe("SQLite transcript history events", () => {
  const scope = useHistoryEventScope();
  beforeEach(() => setRuntimeConfigSnapshot({}));
  afterEach(() => clearRuntimeConfigSnapshot());

  const persist = (messages: Parameters<typeof persistSessionTranscriptTurn>[1]["messages"]) =>
    persistSessionTranscriptTurn(scope, { messages, touchSessionEntry: false });
  const anchor = (messageId: string, maxMessages = 10) =>
    readSessionTranscriptHistoryAnchorPage(scope, { messageId, maxMessages });
  const openDatabase = () => openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
  const recent = (maxMessages: number, maxBytes = 65_536, maxLines = maxMessages) =>
    readRecentSessionTranscriptHistoryEvents(scope, { maxMessages, maxBytes, maxLines });
  const historyPage = (offset: number, maxMessages: number, maxBytes?: number) =>
    readSessionTranscriptHistoryEventPage(scope, { offset, maxMessages, maxBytes });
  const appendReset = (id: string, parentId: string, fields = {}) =>
    appendTranscriptEvent(scope, boundary("reset", id, parentId, { reason: "new", ...fields }));
  const expectEmptyDelta = (cursor: string | undefined, activeLeafEntryId: string | null) => {
    expect(readTranscriptDisplayDelta(scope, { cursor })).toEqual({
      kind: "page",
      cursor,
      activeLeafEntryId,
      events: [],
      hasMore: false,
      serializedBytes: 0,
    });
  };

  it("reads fresh generations and rows across empty and populated sessions", async () => {
    const limits = { maxMessages: 20, maxLines: 20, maxBytes: 64 * 1024 };
    expect(readRecentSessionTranscriptHistoryEvents(scope, limits)).toMatchObject({
      events: [],
      totalMessages: 0,
    });
    expect(readTranscriptDisplayDelta(scope)).toEqual({ kind: "missing" });
    await replaceTranscriptEvents(scope, [{ type: "session", version: 3, id: scope.sessionId }]);
    await replaceTranscriptEvents(scope, []);
    const empty = readRecentSessionTranscriptHistoryEvents(scope, limits);
    expect(empty).toMatchObject({
      deltaCursor: expect.any(String),
      displaySource: expect.any(String),
    });
    expectEmptyDelta(empty.deltaCursor, null);

    await persist([message("after-empty", null, "user", "new")]);
    const delta = readTranscriptDisplayDelta(scope, { cursor: empty.deltaCursor });
    expect(delta.kind).toBe("page");
    if (delta.kind !== "page") {
      throw new Error("missing appended history delta");
    }
    expect(delta.events.map(historyEventId)).toContain("after-empty");
    expectEmptyDelta(delta.cursor, "after-empty");

    const other = { ...scope, sessionId: "other-empty", sessionKey: "agent:main:other-empty" };
    await replaceTranscriptEvents(other, []);
    const otherEmpty = readRecentSessionTranscriptHistoryEvents(other, limits);
    expect(otherEmpty).toMatchObject({ events: [], totalMessages: 0 });
    expect(otherEmpty.deltaCursor).toBeUndefined();
    expect(readTranscriptDisplayDelta(other)).toEqual({ kind: "missing" });
    await persistSessionTranscriptTurn(other, {
      messages: ["other-first", "other-middle", "other-last"].map((eventId, index, ids) =>
        message(eventId, index === 0 ? null : ids[index - 1]!, "user", eventId),
      ),
      touchSessionEntry: false,
    });
    expect(
      readRecentSessionTranscriptHistoryEvents(other, limits).events.map(historyEventId),
    ).toEqual(["other-first", "other-middle", "other-last"]);
    expect(
      readSessionTranscriptHistoryEventPage(other, {
        maxMessages: 1,
        offset: 1,
        maxBytes: limits.maxBytes,
      }).events.map(historyEventId),
    ).toEqual(["other-middle"]);
    expect(
      readRecentSessionTranscriptHistoryEvents(scope, limits).events.map(historyEventId),
    ).toEqual(["after-empty"]);
    expect(readTranscriptDisplayDelta(other, { cursor: delta.cursor })).toMatchObject({
      kind: "reset",
      reason: "scope_mismatch",
    });
    await replaceTranscriptEvents(scope, []);
    expect(readTranscriptDisplayDelta(scope, { cursor: delta.cursor })).toMatchObject({
      kind: "reset",
      reason: "generation_mismatch",
    });
  });

  it.each([false, true])(
    "preserves physical dispatch cuts across history pages and deltas (legacy=%s)",
    async (legacy) => {
      await persist([message("exec", null, "assistant", "exec")]);
      await appendTranscriptEvent(scope, {
        type: "custom",
        id: "control",
        parentId: "exec",
        customType: "test",
      });
      await appendTranscriptEvent(scope, {
        type: "custom_message",
        id: "notice",
        parentId: "control",
        customType: "run-failed-before-reply",
        content: "This turn ended before a reply.",
        display: true,
        timestamp: "2026-09-08T00:00:00.000Z",
      });
      await persist([
        message("wait", "notice", "assistant", "wait"),
        ...["control", "first"].map((afterEntryId, startOrder) => {
          const id = startOrder === 0 ? "first" : "later";
          return {
            eventId: id,
            parentId: startOrder === 0 ? "wait" : "first",
            message: createNestedToolActivity({
              runId: "run",
              scopeId: "attempt",
              afterEntryId,
              startOrder,
              parentToolCallId: "exec",
              toolCallId: id,
              toolName: "read",
              input: {},
              result: { content: [{ type: "text", text: "done" }] },
              isError: false,
              startedAt: 1,
              timestamp: 2,
            }),
          };
        }),
      ]);
      runOpenClawAgentWriteTransaction(
        (database) => {
          database.db
            .prepare(`UPDATE transcript_events
          SET navigation_type = NULL, navigation_custom_type = NULL,
              navigation_display = 0, message_role = NULL, navigation_last_type = NULL,
              navigation_last_custom_type = NULL, navigation_valid = 1
          WHERE session_id = ?`)
            .run(scope.sessionId);
          if (legacy) {
            database.db
              .prepare("DELETE FROM transcript_event_identities WHERE session_id = ?")
              .run(scope.sessionId);
          }
        },
        { agentId: scope.agentId, env: scope.env },
      );
      const raw = readTranscriptRawDelta(scope);
      const delta = readTranscriptDisplayDelta(scope);
      expect(raw.kind).toBe("page");
      expect(delta.kind).toBe("page");
      if (raw.kind !== "page" || delta.kind !== "page") {
        throw new Error("missing transcript page");
      }
      const rawSeq = new Map(raw.events.map((row) => [historyEventId(row), row.seq]));
      const history = readSessionTranscriptHistoryEvents(scope);
      expectEvents(history, ["exec", "notice", "wait", "first", "later"], [1, 2, 3, 4, 5]);
      expect(readSessionTranscriptHistoryEventCount(scope)).toBe(5);
      expect(delta.events.find((row) => historyEventId(row) === "notice")).toMatchObject({
        messageSeq: 2,
        displayPosition: { rawSeq: rawSeq.get("notice") },
      });
      expect(delta.events.find((row) => historyEventId(row) === "wait")).toMatchObject({
        messageSeq: 3,
      });
      const source = history[0]?.displayPosition?.source;
      expect(source).toEqual(expect.any(String));
      for (const [id, afterId, startOrder] of [
        ["first", "control", 0],
        ["later", "first", 1],
      ] as const) {
        const position = {
          source,
          rawSeq: rawSeq.get(id),
          activity: { afterRawSeq: rawSeq.get(afterId), scopeId: "attempt", startOrder },
        };
        const expected = { displayPosition: position };
        expect(history.find((row) => historyEventId(row) === id)).toMatchObject(expected);
        expect(delta.events.find((row) => historyEventId(row) === id)).toMatchObject(expected);
        expect(readSessionTranscriptHistoryEventById(scope, id)).toMatchObject(expected);
        expect(historyPage(id === "later" ? 0 : 1, 1)).toMatchObject({
          events: [expected],
          totalMessages: 5,
        });
        expect(recent(1).events[0]).toMatchObject({
          displayPosition: { rawSeq: rawSeq.get("later") },
        });
      }
      expect(delta.cursor).toBe(raw.cursor);
      expect(delta.serializedBytes).toBe(raw.serializedBytes);
      expect(delta.events.map(({ event, seq }) => ({ event, seq }))).toEqual(raw.events);
      const blocked = readTranscriptDisplayDelta(scope, { maxBytes: 1 });
      expect(blocked.kind).toBe("page");
      if (blocked.kind !== "page") {
        throw new Error("missing byte-blocked transcript page");
      }
      expect(blocked).toMatchObject({
        activeLeafEntryId: "later",
        events: [],
        hasMore: true,
        requiredBytes: Buffer.byteLength(JSON.stringify(raw.events[0]?.event), "utf8") + 1,
        serializedBytes: 0,
      });
      expect(readTranscriptDisplayDelta(scope, { cursor: blocked.cursor })).toEqual(delta);
      expectEmptyDelta(delta.cursor, "later");
    },
  );

  it("retains an oversized newest message without parsing excluded older payloads", async () => {
    await persist([message("older", null, "user", "older")]);
    await appendTranscriptEvent(
      scope,
      boundary("compaction", "excluded-boundary", "older", {
        summary: "excluded",
        timestamp: "2026-08-15T00:00:00.000Z",
      }),
    );
    await persist([
      message("oversized-newest", "excluded-boundary", "assistant", "x".repeat(16_384)),
    ]);
    openDatabase()
      .db.prepare(
        `UPDATE transcript_events
         SET event_json = '{'
         WHERE session_id = ? AND seq IN (
           SELECT seq FROM transcript_event_identities
           WHERE session_id = ? AND event_id IN ('older', 'excluded-boundary')
         )`,
      )
      .run(scope.sessionId, scope.sessionId);

    const newest = recent(3, 1024);
    expect(newest.totalMessages).toBe(3);
    expectEvents(newest.events, ["oversized-newest"], [3]);
    expect(historyPage(0, 1, 1024)).toMatchObject({
      events: [],
      totalMessages: 3,
      omittedOversized: true,
      olderOffset: 1,
    });
  });

  it("excludes pre-reset custom metadata while retaining the reset prefix and later markers", async () => {
    // Valid transcript JSON can exceed SQLite's 1,000-level JSON nesting limit.
    const details: unknown = JSON.parse(`${"[".repeat(1_001)}0${"]".repeat(1_001)}`);
    const oldNotice = {
      type: "custom_message",
      id: "old-notice",
      parentId: null,
      customType: "display-report",
      content: "old report",
      display: true,
      details,
      timestamp: "2026-09-07T00:00:00.000Z",
    };
    const events = [
      { type: "session", version: 3, id: scope.sessionId },
      oldNotice,
      messageEvent("kept-user", "old-notice", "user", "retained prompt"),
      { ...oldNotice, id: "shallow-notice", parentId: "kept-user", details: {} },
      messageEvent("kept-assistant", "shallow-notice", "assistant", "retained reply"),
      boundary("reset", "reset", "kept-assistant", {
        firstKeptEntryId: "kept-user",
        reason: "new",
        timestamp: "2026-09-07T01:00:00.000Z",
      }),
      boundary("compaction", "compaction", "reset", {
        summary: "current summary",
        timestamp: "2026-09-07T02:00:00.000Z",
      }),
    ];
    await replaceTranscriptEvents(scope, events);

    const history = readSessionTranscriptHistoryEvents(scope);
    const kept = ["kept-user", "kept-assistant", "reset", "compaction"];
    expectEvents(history, kept, [1, 2, 3, 4]);
    expect(readSessionTranscriptHistoryEventCount(scope)).toBe(4);

    const newest = recent(2);
    expect(newest.totalMessages).toBe(4);
    expectEvents(newest.events, ["reset", "compaction"], [3, 4]);
    const older = historyPage(2, 2);
    expect(older.totalMessages).toBe(4);
    expectEvents(older.events, ["kept-user", "kept-assistant"], [1, 2]);

    const anchored = anchor("reset", 4);
    expect(anchored).toMatchObject({ found: true, totalMessages: 4 });
    expectEvents(anchored.events, kept);
    for (const [messageId, direction, maxMessages, ids, seqs, offset] of [
      ["kept-user", "older", 4, ["kept-user"], [1], 3],
      ["compaction", "newer", 4, ["compaction"], [4], 0],
      ["reset", "older", 2, ["kept-assistant", "reset"], [2, 3], 1],
      ["reset", "newer", 2, ["reset", "compaction"], [3, 4], 0],
      ["reset", "older", 1, ["reset"], [3], 1],
      ["reset", "newer", 1, ["reset"], [3], 1],
    ] as const) {
      const directional = readSessionTranscriptHistoryAnchorPage(scope, {
        messageId,
        direction,
        maxMessages,
      });
      expect(directional).toMatchObject({
        found: true,
        totalMessages: 4,
        hasOverreadContext: false,
        offset,
        displaySource: anchored.displaySource,
      });
      expectEvents(directional.events, ids, seqs);
    }

    expect(() => anchor("old-notice", 3)).toThrow(/malformed JSON/i);

    await replaceTranscriptEvents(scope, [
      ...events,
      { ...oldNotice, id: "current-notice", parentId: "compaction" },
    ]);
    expect(() => readSessionTranscriptHistoryEvents(scope)).toThrow(/malformed JSON/i);
  });

  it("excludes inactive deeply nested custom messages after ANALYZE", async () => {
    await persist([message("seed", null, "user", "seed")]);
    const db = openDatabase().db;
    const boundaryEvents = [
      [
        1,
        boundary("compaction", "active-boundary-2", "seed", {
          timestamp: "2026-08-15T00:00:01.000Z",
          summary: "active",
        }),
      ],
      [
        undefined,
        {
          type: "custom_message",
          id: "candidate-boundary",
          parentId: "seed",
          timestamp: "2026-08-15T00:00:01.000Z",
          customType: "boundary-notice",
          content: "boundary",
          display: true,
          // SQLite rejects valid JSON beyond its nesting limit.
          details: JSON.parse("[".repeat(1001) + "0" + "]".repeat(1001)),
        },
      ],
      [
        2,
        boundary("compaction", "active-boundary-4", "active-boundary-2", {
          timestamp: "2026-08-15T00:00:02.000Z",
          summary: "active",
        }),
      ],
    ] as const;
    const insertEvent = createTranscriptEventInserter(db, scope.sessionId);
    const insertIdentity = db.prepare(
      `INSERT INTO transcript_event_identities
         (session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
    );
    const insertActive = db.prepare(
      `INSERT INTO session_transcript_active_events
         (session_id, active_position, event_seq, message_position, context_eligible)
       VALUES (?, ?, ?, NULL, 1)`,
    );
    for (const [index, [activePosition, event]] of boundaryEvents.entries()) {
      const seq = index + 2;
      insertEvent({ seq, eventJson: JSON.stringify(event), createdAt: seq });
      insertIdentity.run(scope.sessionId, event.id, seq, event.type, seq);
      if (activePosition !== undefined) {
        insertActive.run(scope.sessionId, activePosition, seq);
      }
    }
    db.prepare(
      `UPDATE session_transcript_index_state
         SET indexed_seq = 4, leaf_event_id = 'active-boundary-4', active_event_count = ?
         WHERE session_id = ?`,
    ).run(3, scope.sessionId);
    db.exec("ANALYZE");

    expect(readSessionTranscriptHistoryEventCount(scope)).toBe(3);
    const events = readSessionTranscriptHistoryEvents(scope);

    expect(events.map(historyEventId)).toEqual(["seed", "active-boundary-2", "active-boundary-4"]);
  });

  it("reads recent messages beyond the metadata binding limit", async () => {
    const maxMessages = REGRESSION_SQLITE_VARIABLE_LIMIT + 1;
    await persist([message("seed", null, "user", "seed")]);
    const db = openDatabase();
    const bindingCount = Math.max(REGRESSION_SQLITE_VARIABLE_LIMIT, maxMessages);
    insertSyntheticHistory(db, scope.sessionId, bindingCount);
    enforceSqliteVariableLimit(db);

    const page = recent(maxMessages, 1_000_000, bindingCount + 1);

    expect(page.totalMessages).toBe(bindingCount + 1);
    expect(page.events).toHaveLength(maxMessages);
    expect(historyEventId(page.events[0])).toBe(
      `synthetic-message-${String(bindingCount - maxMessages + 2)}`,
    );
    expect(historyEventId(page.events.at(-1))).toBe(
      `synthetic-message-${String(bindingCount + 1)}`,
    );
  });

  it("batches sparse reset history without reviving discarded tool results", async () => {
    const keptIds = Array.from({ length: 1_001 }, (_, index) => `kept-${index}`);
    await persist(
      keptIds.flatMap((eventId, index) => [
        message(eventId, index === 0 ? null : `tool-${index - 1}`, "user", eventId),
        message(`tool-${index}`, eventId, "toolResult", "discarded orphan result"),
      ]),
    );
    await appendReset("reset", "tool-1000", {
      timestamp: "2026-08-30T00:00:00.000Z",
      firstKeptEntryId: keptIds[0],
    });
    await persist([message("fresh", "reset", "user", "fresh")]);
    enforceSqliteVariableLimit(openDatabase(), 999);

    const newest = recent(keptIds.length + 2, 1_000_000, 2_010);
    expect(newest.totalMessages).toBe(keptIds.length + 2);
    expectEvents(
      newest.events,
      [...keptIds, "reset", "fresh"],
      Array.from({ length: keptIds.length + 2 }, (_, index) => index + 1),
    );
    expectEvents(historyPage(500, 2).events, ["kept-501", "kept-502"]);
  });

  it("opens a pre-reset active-path anchor in the same physical session", async () => {
    await persist([
      message("before-user", null, "user", "synthetic charger handshake"),
      message("before-assistant", "before-user", "assistant", "handshake captured"),
      message("before-tool", "before-assistant", "toolResult", "scan result"),
    ]);
    await appendReset("first-reset", "before-tool");
    await persist([message("middle-user", "first-reset", "user", "middle window")]);
    await appendReset("second-reset", "middle-user", {
      timestamp: "2026-09-07T01:00:00.000Z",
    });
    await persist([message("fresh-user", "second-reset", "user", "fresh after reset")]);

    expect(readSessionTranscriptHistoryEvents(scope).map(historyEventId)).toEqual([
      "second-reset",
      "fresh-user",
    ]);
    expect(readSessionTranscriptHistoryEventById(scope, "fresh-user")).toMatchObject({
      seq: 2,
    });
    expect(readSessionTranscriptHistoryEventById(scope, "before-user")).toMatchObject({
      seq: 1,
    });
    expect(historyEventId(readSessionTranscriptHistoryEventById(scope, "before-user"))).toBe(
      "before-user",
    );
    expect(historyEventId(readSessionTranscriptHistoryEventById(scope, "first-reset"))).toBe(
      "first-reset",
    );
    expect(readSessionTranscriptHistoryEventById(scope, "missing-anchor")).toBeUndefined();

    const firstWindow = anchor("before-user");
    expect(firstWindow).toMatchObject({ found: true, totalMessages: 4 });
    const firstIds = ["before-user", "before-assistant", "before-tool", "first-reset"];
    expectEvents(firstWindow.events, firstIds);
    for (const [messageId, maxMessages, ids, seqs, offset, hasOverreadContext] of [
      ["before-user", 1, ["before-user"], [1], 3, false],
      [
        "before-assistant",
        2,
        ["before-user", "before-assistant", "before-tool"],
        [1, 2, 3],
        1,
        true,
      ],
      [
        "before-tool",
        3,
        ["before-user", "before-assistant", "before-tool", "first-reset"],
        [1, 2, 3, 4],
        0,
        true,
      ],
      ["first-reset", 1, ["before-tool", "first-reset"], [3, 4], 0, true],
    ] as const) {
      const page = readSessionTranscriptHistoryAnchorPage(scope, { messageId, maxMessages });
      expect(page).toMatchObject({ found: true, totalMessages: 4, offset, hasOverreadContext });
      expectEvents(page.events, ids, seqs);
    }
    expectEvents(anchor("first-reset").events, firstIds);

    const middleWindow = anchor("middle-user");
    expect(middleWindow.events.map(historyEventId)).toEqual(["middle-user", "second-reset"]);

    const currentWindow = anchor("fresh-user");
    expect(currentWindow.events.map(historyEventId)).toEqual(["second-reset", "fresh-user"]);

    expect(anchor("missing-anchor")).toMatchObject({
      found: false,
      events: [],
      totalMessages: 2,
    });
  });

  it("bounds a closed reset interval before hydrating excluded payloads", async () => {
    await persist([
      message("oversized-older", null, "user", "older"),
      message("fitting-newer", "oversized-older", "assistant", "newer"),
    ]);
    await appendReset("closing-reset", "fitting-newer", {
      summary: "x".repeat(4_096),
    });
    const db = openDatabase().db;
    const corruptPayload = (id: string, assignments: string) =>
      db
        .prepare(
          `UPDATE transcript_events
         SET ${assignments}, event_utf8_bytes = 16384
         WHERE session_id = ? AND seq = (
           SELECT seq FROM transcript_event_identities
           WHERE session_id = ? AND event_id = ?
         )`,
        )
        .run(scope.sessionId, scope.sessionId, id);

    const closedPage = () =>
      readSessionTranscriptHistoryAnchorPage(scope, {
        closedResetInterval: true,
        direction: "older",
        maxBytes: 1_024,
        maxMessages: 10,
        messageId: "closing-reset",
      });

    for (const [id, assignments] of [
      ["oversized-older", "event_json = '{', event_zstd = NULL"],
      ["closing-reset", "event_json = NULL, event_zstd = X'00'"],
    ] as const) {
      corruptPayload(id, assignments);
      const page = closedPage();
      expectEvents(page.events, ["fitting-newer"]);
      expect(page).toMatchObject({ found: true, totalMessages: 2 });
    }
  });
});
