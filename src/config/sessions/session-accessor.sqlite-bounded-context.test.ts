import path from "node:path";
import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import {
  readSessionTranscriptActiveStats,
  readSessionTranscriptBoundedMessageTailPage,
} from "./session-accessor.sqlite-active-events.js";
import { readSessionTranscriptHistoryEventById } from "./session-accessor.sqlite-history.test-support.js";
import { seedUnindexedTranscriptForTest } from "./session-accessor.sqlite-import.test-support.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import {
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
  waitForSessionTranscriptProjection,
} from "./session-transcript-reconcile.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

async function withBoundedContextScope(
  run: (scope: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState({ label: "bounded-transcript-context" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "bounded-context",
      sessionKey: "agent:main:bounded-context",
      storePath: path.join(state.sessionsDir("main"), "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await run(scope);
  });
}

function countAcquiredTranscriptPayloadBytes(
  db: ReturnType<typeof openOpenClawAgentDatabase>["db"],
  marker: string,
  read: () => void,
): number {
  clearNodeSqliteKyselyCacheForDatabase(db);
  const prepare = db.prepare.bind(db);
  const restoreStatements: Array<() => void> = [];
  let acquiredBytes = 0;
  const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((query) => {
    const statement = prepare(query);
    const iterate = statement.iterate.bind(statement);
    // Observe SQLite result acquisition, including payloads rejected before JSON.parse.
    const iterateSpy = vi.spyOn(statement, "iterate").mockImplementation(function* (...params) {
      for (const row of iterate(...params)) {
        for (const value of Object.values(row)) {
          if (typeof value === "string" && value.includes(marker)) {
            acquiredBytes += Buffer.byteLength(value);
          }
        }
        yield row;
      }
      return undefined;
    });
    restoreStatements.push(() => iterateSpy.mockRestore());
    return statement;
  });
  try {
    read();
  } finally {
    prepareSpy.mockRestore();
    for (const restore of restoreStatements) {
      restore();
    }
  }
  return acquiredBytes;
}

it("reads only the newest bounded active context and accounts for its header", async () => {
  await withBoundedContextScope(async (scope) => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        transcriptMessage("old", null, { role: "user", content: "old" }),
        transcriptMessage("middle", "old", { role: "assistant", content: "middle" }),
        transcriptMessage("new", "middle", { role: "user", content: "new" }),
      ],
      touchSessionEntry: false,
    });

    const context = readSessionTranscriptBoundedActiveContextCore(scope, {
      maxBytes: 1024,
      maxEvents: 2,
    });

    expect(context.events.map((event) => (event as { id?: string }).id)).toEqual([
      scope.sessionId,
      "middle",
      "new",
    ]);
    expect(context.activeLeafEntryId).toBe("new");
    expect(context.totalEvents).toBe(3);
    expect(context.truncated).toBe(true);
    expect(context.serializedBytes).toBeLessThanOrEqual(1024);
    expect(context.serializedBytes).toBeGreaterThan(
      Buffer.byteLength(JSON.stringify(context.events.slice(1)), "utf8"),
    );
    expect(
      readSessionTranscriptBoundedActiveContextCore(scope, { maxBytes: 1024, maxEvents: 3 })
        .truncated,
    ).toBe(false);
  });
});

it.each([false, true])("bounds context sizing with newest oversized=%s", async (oversized) => {
  await withBoundedContextScope(async (scope) => {
    await persistSessionTranscriptTurn(scope, {
      messages: ["old", "large", "new"].map((eventId, index, ids) =>
        transcriptMessage(eventId, ids[index - 1] ?? null, {
          role: "user",
          content:
            eventId === "large" || (oversized && eventId === "new") ? "🦞".repeat(1024) : eventId,
        }),
      ),
      touchSessionEntry: false,
    });
    const options = { maxBytes: 1024, maxEvents: 100 };
    readSessionTranscriptBoundedActiveContextCore(scope, options);
    const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const counter = trackSqliteStatementExecutions(db, ["sizing"], (sql) =>
      sql.includes("serialized_bytes") ? "sizing" : null,
    );
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const context = readSessionTranscriptBoundedActiveContextCore(scope, options);
        expect(context.events.map((event) => (event as { id: string }).id)).toEqual([
          scope.sessionId,
          ...(oversized ? [] : ["new"]),
        ]);
        expect(context.truncated).toBe(true);
      }
      // Each read sizes its header and stops at the first event that cannot fit.
      expect(counter.rowCounts.sizing).toBeGreaterThan(0);
      expect(counter.rowCounts.sizing).toBeLessThanOrEqual(oversized ? 6 : 9);
      await persistSessionTranscriptTurn(scope, {
        messages: [transcriptMessage("next", "new", { role: "user", content: "next" })],
        touchSessionEntry: false,
      });
      expect(
        readSessionTranscriptBoundedActiveContextCore(scope, options).events.at(-1),
      ).toMatchObject({
        id: "next",
      });
    } finally {
      counter.restore();
    }
  });
});

it("reserves the transcript header inside the exact byte limit", async () => {
  await withBoundedContextScope(async (scope) => {
    await persistSessionTranscriptTurn(scope, {
      messages: [transcriptMessage("new", null, { role: "user", content: "new" })],
      touchSessionEntry: false,
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const header = database.db
      .prepare(
        "SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq ASC LIMIT 1",
      )
      .get(scope.sessionId) as { event_json: string };
    const headerBytes = Buffer.byteLength(header.event_json, "utf8") + 1;

    const context = readSessionTranscriptBoundedActiveContextCore(scope, {
      maxBytes: headerBytes,
      maxEvents: 10,
    });

    expect(context.events).toHaveLength(1);
    expect(context.events[0]).toMatchObject({ id: scope.sessionId, type: "session" });
    expect(context.serializedBytes).toBe(headerBytes);
    expect(context.truncated).toBe(true);
  });
});

it("rejects an oversized header before acquiring its payload", async () => {
  await withBoundedContextScope(async (scope) => {
    const marker = "synthetic-oversized-header:";
    await appendTranscriptEvent(scope, {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: scope.sessionId,
      cwd: marker + "x".repeat(4096),
    });
    const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const acquiredBytes = countAcquiredTranscriptPayloadBytes(db, marker, () => {
      expect(() =>
        readSessionTranscriptBoundedActiveContextCore(scope, { maxBytes: 1024, maxEvents: 10 }),
      ).toThrow("Session transcript header exceeds the active-context byte limit");
    });
    expect(acquiredBytes).toBe(0);
  });
});

it.each(["compaction", "reset"] as const)(
  "omits an oversized latest %s boundary before acquiring its payload",
  async (type) => {
    await withBoundedContextScope(async (scope) => {
      const manager = SessionManager.open(scope);
      const kept = manager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
      const marker = "synthetic-oversized-boundary:";
      await appendTranscriptEvent(scope, {
        type,
        id: "oversized-boundary",
        parentId: kept,
        timestamp: "2026-08-30T00:00:00.000Z",
        firstKeptEntryId: kept,
        ...(type === "compaction" ? { summary: "summary", tokensBefore: 100 } : { reason: "new" }),
        details: { payload: marker + "x".repeat(4096) },
      });
      await appendTranscriptMessage(scope, {
        eventId: "tail",
        message: { role: "user", content: "latest", timestamp: 2 },
      });
      await waitForSessionTranscriptProjection(scope);
      const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
      const acquiredBytes = countAcquiredTranscriptPayloadBytes(db, marker, () => {
        const context = readSessionTranscriptBoundedActiveContextCore(scope, {
          maxBytes: 1024,
          maxEvents: 1,
        });
        expect(context.events.map((event) => (event as { id: string }).id)).toEqual([
          scope.sessionId,
          "tail",
        ]);
        expect(context.truncated).toBe(true);
        expect(context.boundaryCount).toBe(1);
        expect(context.serializedBytes).toBe(
          context.events.reduce<number>(
            (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)) + 1,
            0,
          ),
        );
      });
      expect(acquiredBytes).toBe(0);
    });
  },
);

it("selects the session header by type when a mirror row precedes it", async () => {
  await withBoundedContextScope(async (scope) => {
    const mirror = await appendTranscriptMessage(scope, {
      message: { role: "assistant", content: [{ type: "text", text: "New session started." }] },
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [transcriptMessage("new", mirror.messageId, { role: "user", content: "new" })],
      touchSessionEntry: false,
    });
    // Settle the projection first, then reproduce the file-era import row order (delivery
    // mirror ahead of the header), which current writers never emit, directly in the store.
    startSessionTranscriptIndexReconcile({
      agentId: scope.agentId,
      preferredSessionId: scope.sessionId,
    });
    await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    database.db.exec("BEGIN; PRAGMA defer_foreign_keys = ON;");
    for (const [table, column] of [
      ["transcript_events", "seq"],
      ["transcript_event_identities", "seq"],
      ["session_transcript_active_events", "event_seq"],
    ] as const) {
      // Swap seq 0 (header) and seq 1 (mirror) through a spare slot.
      for (const [from, to] of [
        [0, 99],
        [1, 0],
        [99, 1],
      ] as const) {
        database.db
          .prepare(`UPDATE ${table} SET ${column} = ? WHERE session_id = ? AND ${column} = ?`)
          .run(to, scope.sessionId, from);
      }
    }
    database.db.exec("COMMIT;");
    const order = database.db
      .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq ASC")
      .all(scope.sessionId) as Array<{ event_json: string }>;
    expect(order.map((row) => JSON.parse(row.event_json).type)).toEqual([
      "message",
      "session",
      "message",
    ]);

    const context = readSessionTranscriptBoundedActiveContextCore(scope, {
      maxBytes: 4096,
      maxEvents: 10,
    });

    expect(context.events.map((event) => (event as { id?: string }).id)).toEqual([
      scope.sessionId,
      mirror.messageId,
      "new",
    ]);
    expect(context.events[0]).toMatchObject({ type: "session" });
  });
});

it("selects the session header when an exact migrated transcript has no identity rows", async () => {
  await withOpenClawTestState({ label: "bounded-transcript-exact-import" }, async (state) => {
    const scope = {
      agentId: "ops",
      env: state.env,
      sessionId: "exact-import-session",
      sessionKey: "agent:ops:main",
      storePath: path.join(state.sessionsDir("ops"), "sessions.json"),
    };
    await seedUnindexedTranscriptForTest({
      ...scope,
      entry: { sessionId: scope.sessionId, updatedAt: 1 },
      events: [
        {
          session_id: scope.sessionId,
          seq: 0,
          created_at: 1,
          event_json: JSON.stringify({ type: "session", version: 3, id: scope.sessionId }),
        },
        {
          session_id: scope.sessionId,
          seq: 1,
          created_at: 2,
          event_json: JSON.stringify({
            type: "message",
            id: "message-1",
            parentId: null,
            message: { role: "user", content: "hello" },
          }),
        },
      ],
    });

    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    const identityCount = database.db
      .prepare("SELECT COUNT(*) AS count FROM transcript_event_identities WHERE session_id = ?")
      .get(scope.sessionId) as { count: number };
    expect(identityCount.count).toBe(0);

    const context = readSessionTranscriptBoundedActiveContextCore(scope, {
      maxBytes: 4096,
      maxEvents: 10,
    });

    expect(context.events.map((event) => (event as { id?: string }).id)).toEqual([
      scope.sessionId,
      "message-1",
    ]);
    expect(context.events[0]).toMatchObject({ type: "session", version: 3 });
  });
});

it("keeps an imported retention anchor before a later indexed duplicate", async () => {
  await withBoundedContextScope(async (scope) => {
    const events = [
      { type: "session", version: 3, id: scope.sessionId },
      {
        type: "message",
        id: "kept",
        parentId: null,
        message: { role: "user", content: "Imported kept question." },
      },
      {
        type: "compaction",
        id: "cut",
        parentId: "kept",
        firstKeptEntryId: "kept",
        summary: "Summary.",
      },
      {
        type: "message",
        id: "reply",
        parentId: "cut",
        message: { role: "assistant", content: "Original reply." },
      },
    ];
    await seedUnindexedTranscriptForTest({
      ...scope,
      entry: { sessionId: scope.sessionId, updatedAt: 1 },
      events: events.map((event, seq) => ({
        session_id: scope.sessionId,
        seq,
        created_at: seq,
        event_json: JSON.stringify(event),
      })),
    });
    await appendTranscriptMessage(scope, {
      eventId: "kept",
      parentId: "reply",
      message: { role: "assistant", content: "Later indexed duplicate.".repeat(100) },
    });
    const context = readSessionTranscriptBoundedActiveContextCore(scope, {
      maxBytes: 32_768,
      maxEvents: 10,
    });
    const range = context.firstKeptRanges.get("cut");
    expect(range).toBeDefined();
    expect(context.events.slice(range!.startIndex, range!.endIndex)).toEqual([
      expect.objectContaining({
        id: "kept",
        message: { role: "user", content: "Imported kept question." },
      }),
    ]);
    expect(
      readSessionTranscriptHistoryEventById(scope, "kept", { currentOnly: true, maxBytes: 100 }),
    ).toBeUndefined();
  });
});

it("retains the latest boundary and counts earlier resets before a truncated tail", async () => {
  await withBoundedContextScope(async (scope) => {
    await persistSessionTranscriptTurn(scope, {
      messages: [transcriptMessage("old", null, { role: "user", content: "old" })],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "prior-reset",
      parentId: "old",
      timestamp: "2026-08-24T00:00:00.000Z",
      reason: "new",
    });
    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "summary",
      parentId: "prior-reset",
      timestamp: "2026-08-25T00:00:00.000Z",
      summary: "earlier work",
      firstKeptEntryId: "old",
      tokensBefore: 100,
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        transcriptMessage("middle", "summary", { role: "user", content: "middle" }),
        transcriptMessage("new", "middle", { role: "assistant", content: "new" }),
      ],
      touchSessionEntry: false,
    });

    const context = readSessionTranscriptBoundedActiveContextCore(scope, {
      maxBytes: 2048,
      maxEvents: 1,
    });

    expect(context.events.map((event) => (event as { id?: string }).id)).toEqual([
      scope.sessionId,
      "summary",
      "new",
    ]);
    expect(context.events.at(-1)).toMatchObject({ parentId: "middle" });
    expect(context.opaqueParents.get("middle")).toBe("summary");
    expect(context.boundaryCount).toBe(2);
  });
});

it("counts the retained tail instead of compacted transcript bytes", async () => {
  await withBoundedContextScope(async (scope) => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        transcriptMessage("discarded-old", null, {
          role: "user",
          content: `discarded ${"x".repeat(20_000)}`,
        }),
        transcriptMessage("kept-user", "discarded-old", {
          role: "user",
          content: `kept ${"k".repeat(3_000)}`,
        }),
        transcriptMessage("kept-assistant", "kept-user", {
          role: "assistant",
          content: "kept answer",
        }),
      ],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "compaction-boundary",
      parentId: "kept-assistant",
      timestamp: "2026-08-15T00:00:00.000Z",
      summary: `earlier ${"s".repeat(4_000)}`,
      firstKeptEntryId: "kept-user",
      tokensBefore: 10_000,
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        transcriptMessage("post-compaction", "compaction-boundary", {
          role: "user",
          content: "fresh turn",
        }),
      ],
      touchSessionEntry: false,
    });

    const stats = readSessionTranscriptActiveStats(scope);
    expect(stats.eventCount).toBe(4);
    expect(stats.sizeBytes).toBeGreaterThan(7_000);
    expect(stats.sizeBytes).toBeLessThan(12_000);
    const history = readSessionTranscriptBoundedMessageTailPage(scope, {
      maxBytes: 1024 * 1024,
      maxMessages: 100,
      offset: 0,
    });
    expect(history.events.map(({ event }) => (event as { id: string }).id)).toEqual([
      "discarded-old",
      "kept-user",
      "kept-assistant",
      "post-compaction",
    ]);
  });
});

it.each(["cold", "warm"])(
  "keeps reset history closed across compaction with a %s history cache",
  async (cache) => {
    await withBoundedContextScope(async (scope) => {
      const manager = SessionManager.open(scope);
      const appendUser = (content: string) =>
        manager.appendMessage({ role: "user", content, timestamp: 1 });
      const readHistory = () =>
        readSessionTranscriptBoundedMessageTailPage(scope, {
          maxBytes: 1024 * 1024,
          maxMessages: 100,
          offset: 0,
        });
      const settle = async () => {
        manager.flushPendingPersistence();
        await waitForSessionTranscriptProjection(scope);
      };
      const expectHistory = (ids: string[]) => {
        const page = readHistory();
        expect(page.totalMessages).toBe(ids.length);
        expect(page.events.map(({ event }) => (event as { id: string }).id)).toEqual(ids);
      };

      appendUser("before-reset user");
      manager.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "before-reset assistant" }],
        }),
      );
      manager.appendResetBoundary("new");
      const freshUserId = appendUser("fresh user");
      await settle();
      if (cache === "warm") {
        expectHistory([freshUserId]);
      }

      manager.appendCompaction("fresh-only summary", freshUserId, 100);
      await settle();
      expectHistory([freshUserId]);
      expect(manager.buildSessionContext().messages).toMatchObject([
        { role: "compactionSummary", summary: "fresh-only summary" },
        { role: "user", content: "fresh user" },
      ]);
      expect(readSessionTranscriptActiveStats(scope).eventCount).toBe(2);

      const nextUserId = appendUser("after compaction");
      await settle();
      expectHistory([freshUserId, nextUserId]);
      expect(readSessionTranscriptActiveStats(scope).eventCount).toBe(3);

      // A newer reset wins for both scopes; another compaction must not revive older resets.
      manager.appendResetBoundary("new", nextUserId);
      const newestUserId = appendUser("after second reset");
      await settle();
      expectHistory([nextUserId, newestUserId]);
      expect(manager.buildSessionContext().messages).toMatchObject([
        { role: "user", content: "after compaction" },
        { role: "user", content: "after second reset" },
      ]);
      expect(readSessionTranscriptActiveStats(scope).eventCount).toBe(2);

      manager.appendCompaction("newest-only summary", newestUserId, 100);
      await settle();
      expectHistory([nextUserId, newestUserId]);
      const reopened = SessionManager.open(scope);
      expect(reopened.buildSessionContext().messages).toMatchObject([
        { role: "compactionSummary", summary: "newest-only summary" },
        { role: "user", content: "after second reset" },
      ]);
      expect(readSessionTranscriptActiveStats(scope).eventCount).toBe(2);
    });
  },
);

it("counts paired reset tool results without counting discarded orphan results", async () => {
  await withBoundedContextScope(async (scope) => {
    const assistantMessage = {
      role: "assistant" as const,
      api: "openai-responses" as const,
      provider: "openai",
      model: "gpt-5.6-sol",
      content: [{ type: "toolCall" as const, id: "call-1", name: "read", arguments: {} }],
      stopReason: "toolUse" as const,
      timestamp: Date.parse("2026-08-15T00:00:00.000Z"),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    await persistSessionTranscriptTurn(scope, {
      messages: [
        transcriptMessage("discarded-old", null, {
          role: "user",
          content: `discarded ${"x".repeat(12_000)}`,
        }),
        transcriptMessage("kept-user", "discarded-old", { role: "user", content: "kept question" }),
        transcriptMessage("kept-assistant", "kept-user", assistantMessage),
        transcriptMessage("kept-result", "kept-assistant", {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: `paired ${"p".repeat(3_000)}` }],
          isError: false,
          timestamp: Date.parse("2026-08-15T00:00:01.000Z"),
        }),
        transcriptMessage("discarded-orphan", "kept-result", {
          role: "toolResult",
          toolCallId: "orphan-call",
          toolName: "read",
          content: [{ type: "text", text: `orphan ${"o".repeat(20_000)}` }],
          isError: false,
          timestamp: Date.parse("2026-08-15T00:00:02.000Z"),
        }),
      ],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset-boundary",
      parentId: "discarded-orphan",
      timestamp: "2026-08-15T00:00:03.000Z",
      reason: "new",
      firstKeptEntryId: "kept-user",
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        transcriptMessage("post-reset", "reset-boundary", { role: "user", content: "fresh turn" }),
      ],
      touchSessionEntry: false,
    });

    const stats = readSessionTranscriptActiveStats(scope);
    expect(stats.eventCount).toBe(4);
    expect(stats.sizeBytes).toBeGreaterThan(3_000);
    expect(stats.sizeBytes).toBeLessThan(8_000);
    expect(
      readSessionTranscriptBoundedMessageTailPage(scope, {
        maxBytes: 1024 * 1024,
        maxMessages: 100,
        offset: 0,
      }).totalMessages,
    ).toBe(3);

    await persistSessionTranscriptTurn(scope, {
      messages: [
        transcriptMessage("second-post-reset", "post-reset", {
          role: "assistant",
          content: "fresh answer",
        }),
      ],
      touchSessionEntry: false,
    });
    const parseSpy = vi.spyOn(JSON, "parse");
    try {
      expect(readSessionTranscriptActiveStats(scope).eventCount).toBe(5);
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }

    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "fresh-compaction",
      parentId: "second-post-reset",
      timestamp: "2026-08-15T00:00:04.000Z",
      summary: "fresh-only summary",
      firstKeptEntryId: "post-reset",
      tokensBefore: 100,
    });
    const history = readSessionTranscriptBoundedMessageTailPage(scope, {
      maxBytes: 1024 * 1024,
      maxMessages: 100,
      offset: 0,
    });
    expect(history.totalMessages).toBe(4);
    expect(history.events.map(({ event }) => (event as { id: string }).id)).toEqual([
      "kept-user",
      "kept-assistant",
      "post-reset",
      "second-post-reset",
    ]);
    expect(readSessionTranscriptActiveStats(scope).eventCount).toBe(3);
  });
});

it("resolves reset history and raw-byte stats without acquiring unrelated reset fields", async () => {
  await withBoundedContextScope(async (scope) => {
    const manager = SessionManager.open(scope);
    manager.appendMessage({ role: "user", content: "discarded", timestamp: 1 });
    const kept = manager.appendMessage({ role: "user", content: "retained", timestamp: 2 });
    const marker = "synthetic-reset-only-payload:";
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset-with-extra-fields",
      parentId: kept,
      timestamp: "2026-08-30T00:00:00.000Z",
      reason: "new",
      firstKeptEntryId: kept,
      details: { payload: marker + "x".repeat(4096) },
    });
    await waitForSessionTranscriptProjection(scope);
    const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const acquiredBytes = countAcquiredTranscriptPayloadBytes(db, marker, () => {
      const history = readSessionTranscriptBoundedMessageTailPage(scope, {
        maxBytes: 1024,
        maxMessages: 100,
        offset: 0,
      });
      expect(history.totalMessages).toBe(1);
      expect(history.events.map(({ event }) => (event as { id: string }).id)).toEqual([kept]);
      expect(readSessionTranscriptActiveStats(scope)).toEqual({
        eventCount: 1,
        sizeBytes: history.serializedBytes,
      });
    });
    expect(acquiredBytes).toBe(0);
  });
});

it("counts retained raw bytes without hydrating private native payloads", async () => {
  await withBoundedContextScope(async (scope) => {
    const marker = "synthetic-retained-native-payload:";
    const privateText = marker + "x".repeat(1024 * 1024);
    const manager = SessionManager.open(scope);
    const kept = manager.appendMessage({
      role: "user",
      content: "kept",
      timestamp: 1,
      __openclaw: { upstreamUserText: privateText },
    } as Parameters<SessionManager["appendMessage"]>[0]);
    manager.appendResetBoundary("new", kept);
    await waitForSessionTranscriptProjection(scope);
    const originalParse = JSON.parse;
    let privateBytes = 0;
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (typeof text === "string" && text.includes(marker)) {
        privateBytes += text.length;
      }
      return originalParse(text, reviver);
    });
    try {
      const stats = readSessionTranscriptActiveStats(scope);
      expect(stats.eventCount).toBe(1);
      expect(stats.sizeBytes).toBeGreaterThan(privateText.length);
      expect(privateBytes).toBe(0);
    } finally {
      parseSpy.mockRestore();
    }
  });
});

it("keeps later unindexed feedback payloads outside an admitted context read", async () => {
  await withBoundedContextScope(async (scope) => {
    const events = [
      { type: "session", version: CURRENT_SESSION_VERSION, id: scope.sessionId },
      {
        type: "message",
        id: "imported-user",
        parentId: null,
        message: { role: "user", content: "Imported conversation." },
      },
    ];
    await seedUnindexedTranscriptForTest({
      ...scope,
      entry: { sessionId: scope.sessionId, updatedAt: 1 },
      events: events.map((event, seq) => ({
        session_id: scope.sessionId,
        seq,
        created_at: seq,
        event_json: JSON.stringify(event),
      })),
    });
    const admitted = await appendTranscriptMessage(scope, {
      eventId: "current-user",
      parentId: "imported-user",
      message: { role: "user", content: "Current request.", timestamp: 2 },
    });
    const anchor = admitted.anchor;
    if (!anchor) {
      throw new Error("missing admission anchor");
    }
    const marker = "synthetic-later-feedback-payload:";
    const privateText = marker + "x".repeat(4096);
    const details: unknown = JSON.parse(
      `${"[".repeat(1_001)}${JSON.stringify(privateText)}${"]".repeat(1_001)}`,
    );
    const { recordChannelFeedbackEvent } = await import("openclaw/plugin-sdk/channel-inbound");
    expect(
      await recordChannelFeedbackEvent({
        cfg: { session: { store: scope.storePath } },
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        event: {
          type: "custom_message",
          customType: "synthetic-feedback",
          content: "Later feedback.",
          display: true,
          details,
        },
      }),
    ).toBe(true);
    await waitForSessionTranscriptProjection(scope);
    const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const acquiredBytes = countAcquiredTranscriptPayloadBytes(db, marker, () => {
      runWithSessionTranscriptReadFence(
        { ...anchor, logicalTurnId: "current", role: "user" },
        () => {
          const context = readSessionTranscriptBoundedActiveContextCore(scope, {
            maxBytes: 1024,
            maxEvents: 10,
          });
          expect(context.events.map((event) => (event as { id: string }).id)).toEqual([
            scope.sessionId,
            "imported-user",
          ]);
          expect(context.activeLeafEntryId).toBe("imported-user");
        },
      );
    });
    expect(acquiredBytes).toBe(0);
  });
});
