import path from "node:path";
import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  persistSessionTranscriptTurn,
  loadTranscriptEventsSync,
  readTranscriptStatsSync,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import {
  readRecentSessionTranscriptActiveEvents,
  readSessionTranscriptMessageEventPage,
  readSessionTranscriptBoundedMessageTailPage,
} from "./session-accessor.sqlite-active-events.js";
import {
  readActiveTranscriptStats,
  readSessionTranscriptHistoryEventById,
  withRecentActiveTranscriptEvents,
} from "./session-accessor.sqlite-history.test-support.js";
import { seedUnindexedTranscriptForTest } from "./session-accessor.sqlite-import.test-support.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import {
  reconcileSessionTranscriptIndexes,
  waitForSessionTranscriptProjection,
} from "./session-transcript-reconcile.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

const readSessionTranscriptMessageEventCount = (
  scope: Parameters<typeof readSessionTranscriptMessageEventPage>[0],
): number =>
  readSessionTranscriptMessageEventPage(scope, { maxMessages: 0, offset: 0 }).totalMessages;

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

async function seedImportedTranscript(
  scope: Parameters<Parameters<typeof withBoundedContextScope>[0]>[0],
  events: unknown[],
) {
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
}

function readHistory(
  scope: Parameters<typeof readSessionTranscriptBoundedMessageTailPage>[0],
  maxBytes = 1024 * 1024,
) {
  return readSessionTranscriptBoundedMessageTailPage(scope, {
    maxBytes,
    maxMessages: 100,
    offset: 0,
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

it("enforces context count and byte budgets and releases rejected reads for later appends", async () => {
  await withBoundedContextScope(async (scope) => {
    const append = (id: string, parent: string | null, content = id) =>
      persistSessionTranscriptTurn(scope, {
        messages: [transcriptMessage(id, parent, { role: "user", content })],
        touchSessionEntry: false,
      });
    await append("old", null);
    await append("large", "old", "🦞".repeat(1024));
    await append("new", "large");
    const read = (maxBytes: number, maxEvents = 100) =>
      readSessionTranscriptBoundedActiveContextCore(scope, { maxBytes, maxEvents });
    const ids = (context: ReturnType<typeof read>) =>
      context.events.map((event) => (event as { id: string }).id);
    const counted = read(16_384, 2);
    expect(ids(counted)).toEqual([scope.sessionId, "large", "new"]);
    expect(counted).toMatchObject({ activeLeafEntryId: "new", totalEvents: 3, truncated: true });
    expect(counted.serializedBytes).toBe(
      counted.events.reduce<number>(
        (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)) + 1,
        0,
      ),
    );
    expect(counted.serializedBytes).toBeLessThanOrEqual(16_384);
    expect(read(16_384, 3).truncated).toBe(false);
    const headerBytes = Buffer.byteLength(JSON.stringify(counted.events[0])) + 1;
    const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const counter = trackSqliteStatementExecutions(db, ["sizing"], (sql) =>
      sql.includes("serialized_bytes") ? "sizing" : null,
    );
    const bounded = (maxBytes: number, maxRows: number) => {
      const before = counter.rowCounts.sizing;
      const context = read(maxBytes);
      expect(counter.rowCounts.sizing - before).toBeGreaterThan(0);
      expect(counter.rowCounts.sizing - before).toBeLessThanOrEqual(maxRows);
      expect(context.truncated).toBe(true);
      return context;
    };
    try {
      expect(ids(bounded(1024, 3))).toEqual([scope.sessionId, "new"]);
      const exact = bounded(headerBytes, 2);
      expect(ids(exact)).toEqual([scope.sessionId]);
      expect(exact.events[0]).toMatchObject({ type: "session" });
      expect(exact.serializedBytes).toBe(headerBytes);
      await append("oversized", "new", "🦞".repeat(1024));
      expect(ids(bounded(1024, 2))).toEqual([scope.sessionId]);
      await append("next", "oversized");
      expect(ids(bounded(1024, 3))).toEqual([scope.sessionId, "next"]);
    } finally {
      counter.restore();
    }
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

it("omits an oversized latest compaction boundary before acquiring its payload", async () => {
  await withBoundedContextScope(async (scope) => {
    const manager = SessionManager.open(scope);
    const kept = manager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
    const marker = "synthetic-oversized-boundary:";
    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "oversized-boundary",
      parentId: kept,
      timestamp: "2026-08-30T00:00:00.000Z",
      firstKeptEntryId: kept,
      summary: "summary",
      tokensBefore: 100,
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
});

it("selects imported headers and retention anchors before later indexed duplicates", async () => {
  await withBoundedContextScope(async (scope) => {
    const events = [
      {
        type: "message",
        id: "mirror",
        parentId: null,
        message: { role: "assistant", content: "New session started." },
      },
      { type: "session", version: 3, id: scope.sessionId },
      {
        type: "message",
        id: "kept",
        parentId: "mirror",
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
    await seedImportedTranscript(scope, events);
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    expect(
      database.db
        .prepare("SELECT COUNT(*) AS count FROM transcript_event_identities WHERE session_id = ?")
        .get(scope.sessionId),
    ).toEqual({ count: 0 });
    await appendTranscriptMessage(scope, {
      eventId: "kept",
      parentId: "reply",
      message: { role: "assistant", content: "Later indexed duplicate.".repeat(100) },
    });
    const context = readSessionTranscriptBoundedActiveContextCore(scope, {
      maxBytes: 32_768,
      maxEvents: 10,
    });
    expect(context.events[0]).toMatchObject({ type: "session", version: 3, id: scope.sessionId });
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

it("keeps reset history closed across compaction with a warm history cache", async () => {
  await withBoundedContextScope(async (scope) => {
    const manager = SessionManager.open(scope);
    const appendUser = (content: string) =>
      manager.appendMessage({ role: "user", content, timestamp: 1 });
    const settle = async () => {
      manager.flushPendingPersistence();
      await waitForSessionTranscriptProjection(scope);
    };
    const expectHistory = (ids: string[]) => {
      const page = readHistory(scope);
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
    expectHistory([freshUserId]);

    manager.appendCompaction("fresh-only summary", freshUserId, 100);
    await settle();
    expectHistory([freshUserId]);
    expect(manager.buildSessionContext().messages).toMatchObject([
      { role: "compactionSummary", summary: "fresh-only summary" },
      { role: "user", content: "fresh user" },
    ]);
    expect(readActiveTranscriptStats(scope).eventCount).toBe(2);

    const nextUserId = appendUser("after compaction");
    await settle();
    expectHistory([freshUserId, nextUserId]);
    expect(readActiveTranscriptStats(scope).eventCount).toBe(3);

    // A newer reset wins for both scopes; another compaction must not revive older resets.
    manager.appendResetBoundary("new", nextUserId);
    const newestUserId = appendUser("after second reset");
    await settle();
    expectHistory([nextUserId, newestUserId]);
    expect(manager.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "after compaction" },
      { role: "user", content: "after second reset" },
    ]);
    expect(readActiveTranscriptStats(scope).eventCount).toBe(2);

    manager.appendCompaction("newest-only summary", newestUserId, 100);
    await settle();
    expectHistory([nextUserId, newestUserId]);
    const reopened = SessionManager.open(scope);
    expect(reopened.buildSessionContext().messages).toMatchObject([
      { role: "compactionSummary", summary: "newest-only summary" },
      { role: "user", content: "after second reset" },
    ]);
    expect(readActiveTranscriptStats(scope).eventCount).toBe(2);
  });
});

it("counts paired reset tool results without counting discarded orphan results", async () => {
  await withBoundedContextScope(async (scope) => {
    const assistantMessage = makeAgentAssistantMessage({
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
      stopReason: "toolUse",
    });
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

    const stats = readActiveTranscriptStats(scope);
    expect(stats.eventCount).toBe(4);
    expect(stats.sizeBytes).toBeGreaterThan(3_000);
    expect(stats.sizeBytes).toBeLessThan(8_000);
    expect(readHistory(scope).totalMessages).toBe(3);

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
      expect(readActiveTranscriptStats(scope).eventCount).toBe(5);
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
    const history = readHistory(scope);
    expect(history.totalMessages).toBe(4);
    expect(history.events.map(({ event }) => (event as { id: string }).id)).toEqual([
      "kept-user",
      "kept-assistant",
      "post-reset",
      "second-post-reset",
    ]);
    expect(readActiveTranscriptStats(scope).eventCount).toBe(3);
    expect(readActiveTranscriptStats(scope).sizeBytes).toBeLessThan(8_000);
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
      const stats = readActiveTranscriptStats(scope);
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
    await seedImportedTranscript(scope, events);
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

it("keeps usage and bootstrap facts in the rebuilt bounded tail despite display activity", async () => {
  await withBoundedContextScope(async (scope) => {
    await appendTranscriptEvent(scope, {
      type: "custom",
      id: "bootstrap",
      parentId: null,
      customType: "bootstrap-completed",
      data: {},
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        transcriptMessage("usage", "bootstrap", {
          role: "assistant",
          content: "answer",
          usage: { input: 86_000, output: 2_000 },
        }),
        ...Array.from({ length: 513 }, (_, index) => ({
          eventId: `display-${index}`,
          parentId: index === 0 ? "usage" : `display-${index - 1}`,
          message: {
            role: "custom",
            customType: "tool-activity",
            display: true,
            excludeFromContext: true,
            content: "completed",
          },
        })),
      ],
      touchSessionEntry: false,
    });

    openOpenClawAgentDatabase(scope)
      .db.prepare(
        "UPDATE session_transcript_active_events SET context_eligible = NULL WHERE session_id = ?",
      )
      .run(scope.sessionId);
    expect(await reconcileSessionTranscriptIndexes(scope)).toEqual({ reconciledSessions: 1 });
    const tail = readRecentSessionTranscriptActiveEvents(scope, 2);
    expect(tail.map((event) => (event as { id: string }).id)).toEqual(["bootstrap", "usage"]);
    expect(tail[1]).toMatchObject({ message: { usage: { input: 86_000, output: 2_000 } } });
    const visited: unknown[] = [];
    withRecentActiveTranscriptEvents(scope, 2, (visit) => {
      visit((event) => visited.push(event));
    });
    expect(visited).toEqual(tail.toReversed());
    expect(readTranscriptStatsSync(scope).eventCount).toBeGreaterThan(513);
  });
});

it("keeps repeated visits on one snapshot and expires their reader on return", async () => {
  await withBoundedContextScope(async (scope) => {
    await persistSessionTranscriptTurn(scope, {
      messages: [transcriptMessage("seed", null, { role: "user", content: "before" })],
      touchSessionEntry: false,
    });
    const database = openOpenClawAgentDatabase(scope);
    const { DatabaseSync } = requireNodeSqlite();
    const writer = new DatabaseSync(database.path);
    let savedVisit: ((visitor: (event: unknown) => void) => void) | undefined;
    const first: unknown[] = [];
    const second: unknown[] = [];
    try {
      withRecentActiveTranscriptEvents(scope, 1, (visit) => {
        savedVisit = visit;
        visit((event) => first.push(event));
        writer.prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ?").run(
          JSON.stringify({
            type: "message",
            id: "seed",
            parentId: null,
            message: { role: "user", content: "after" },
          }),
          scope.sessionId,
        );
        visit((event) => second.push(event));
      });
    } finally {
      writer.close();
    }
    expect(first).toMatchObject([{ message: { content: "before" } }]);
    expect(second).toEqual(first);
    expect(readRecentSessionTranscriptActiveEvents(scope, 1)).toMatchObject([
      { message: { content: "after" } },
    ]);
    expect(() => savedVisit?.(() => {})).toThrow("outside its read snapshot");
  });
});

it.each(["json", "sql", "consumer"] as const)(
  "preserves %s failure precedence and releases the read cursor",
  async (failureKind) => {
    await withBoundedContextScope(async (scope) => {
      await persistSessionTranscriptTurn(scope, {
        messages: [
          transcriptMessage("oldest", null, { role: "user", content: "oldest" }),
          transcriptMessage("middle", "oldest", { role: "assistant", content: "middle" }),
          transcriptMessage("newest", "middle", { role: "user", content: "newest" }),
        ],
        touchSessionEntry: false,
      });
      const database = openOpenClawAgentDatabase(scope);
      const failure = new Error("consumer stopped");
      const malformed = '{"old":}';
      let parseFailure: Error | undefined;
      try {
        JSON.parse(malformed);
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        parseFailure = error;
      }
      if (failureKind !== "consumer") {
        // The connection-local view corrupts reads without changing canonical rows or projections.
        database.db.exec(`CREATE TEMP VIEW transcript_events AS
        SELECT event.session_id, event.seq, event.created_at,
          event.event_zstd, event.event_utf8_bytes, event.navigation_json,
          CASE identity.event_id
            WHEN 'oldest' THEN ${failureKind === "sql" ? "json_extract('{broken', '$')" : "'{\"old\":}'"}
            WHEN 'middle' THEN '{"newer":}'
            ELSE event.event_json
          END AS event_json
        FROM main.transcript_events AS event
        JOIN transcript_event_identities AS identity
          ON identity.session_id = event.session_id AND identity.seq = event.seq`);
      }
      try {
        if (failureKind === "consumer") {
          expect(() =>
            withRecentActiveTranscriptEvents(scope, 3, (visit) => {
              visit(() => {
                throw failure;
              });
            }),
          ).toThrow(failure);
        } else {
          expect(() => readRecentSessionTranscriptActiveEvents(scope, 3)).toThrow(
            failureKind === "sql" ? "malformed JSON" : parseFailure,
          );
        }
      } finally {
        if (failureKind !== "consumer") {
          database.db.exec("DROP VIEW temp.transcript_events");
        }
      }
      expect(database.db.isTransaction).toBe(false);
      expect(database.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({
        busy: 0,
      });
      expect(readRecentSessionTranscriptActiveEvents(scope, 3)).toHaveLength(3);
      await appendTranscriptEvent(scope, { type: "custom", id: "after", parentId: "newest" });
      expect(readRecentSessionTranscriptActiveEvents(scope, 1)).toMatchObject([{ id: "after" }]);
    });
  },
);

it.each(["unbounded", "reset"] as const)(
  "does not count display-only activity toward %s context pressure",
  async (boundary) => {
    await withBoundedContextScope(async (scope) => {
      const activity = {
        role: "custom",
        customType: "tool-activity",
        display: true,
        excludeFromContext: true,
        content: "",
        details: { output: "x".repeat(32_000) },
        timestamp: 1,
      };
      await persistSessionTranscriptTurn(scope, {
        messages: [
          transcriptMessage("kept-user", null, { role: "user", content: "question" }),
          transcriptMessage("display-prefix", "kept-user", activity),
          transcriptMessage("kept-assistant", "display-prefix", {
            role: "assistant",
            content: "answer",
          }),
        ],
        touchSessionEntry: false,
      });
      if (boundary !== "unbounded") {
        await appendTranscriptEvent(scope, {
          type: boundary,
          id: "boundary",
          parentId: "kept-assistant",
          timestamp: "2026-08-28T00:00:00.000Z",
          firstKeptEntryId: "kept-user",
          reason: "reset",
        });
      }
      const contextIds = new Set(["kept-user", "kept-assistant"]);
      const contextEvents = loadTranscriptEventsSync(scope).filter((event) =>
        contextIds.has((event as { id: string }).id),
      );
      const expected = {
        eventCount: contextEvents.length,
        sizeBytes: contextEvents.reduce<number>(
          (total, event) => total + Buffer.byteLength(JSON.stringify(event), "utf8") + 1,
          0,
        ),
      };
      expect(readActiveTranscriptStats(scope)).toEqual(expected);
      const physicalBefore = readTranscriptStatsSync(scope);
      const historyBefore = readSessionTranscriptMessageEventCount(scope);
      await persistSessionTranscriptTurn(scope, {
        messages: [{ eventId: "display-tail", message: activity }],
        touchSessionEntry: false,
      });

      expect(readActiveTranscriptStats(scope)).toEqual(expected);
      expect(readTranscriptStatsSync(scope).sizeBytes).toBeGreaterThan(
        physicalBefore.sizeBytes + 32_000,
      );
      expect(readSessionTranscriptMessageEventCount(scope)).toBe(historyBefore + 1);
    });
  },
);
