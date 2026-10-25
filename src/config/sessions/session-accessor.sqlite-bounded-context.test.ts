import assert from "node:assert/strict";
import path from "node:path";
import { expect, it as baseIt, vi } from "vitest";
import { CURRENT_SESSION_VERSION, SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureRuntimeConfigAsyncReader } from "../io.runtime.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  persistSessionTranscriptTurn,
  loadTranscriptEventsSync,
  readTranscriptStatsSync,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore as boundedContext } from "./session-accessor.sqlite-active-context.js";
import {
  readRecentSessionTranscriptActiveEvents as recentEvents,
  readSessionTranscriptMessageEventPage as messagePage,
  readSessionTranscriptBoundedMessageTailPage as tailPage,
} from "./session-accessor.sqlite-active-events.js";
import {
  readActiveTranscriptStats as activeStats,
  readSessionTranscriptHistoryEventById as historyEvent,
  withRecentActiveTranscriptEvents as visitRecentEvents,
} from "./session-accessor.sqlite-history.test-support.js";
import { seedUnindexedTranscriptForTest } from "./session-accessor.sqlite-import.test-support.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { waitForSessionTranscriptProjection as waitProjection } from "./session-transcript-reconcile.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

const readSessionTranscriptMessageEventCount = (scope: Parameters<typeof messagePage>[0]): number =>
  messagePage(scope, { maxMessages: 0, offset: 0 }).totalMessages;

type Scope = { agentId: string; sessionId: string; sessionKey: string; storePath: string };
function persist(
  scope: Scope,
  messages: Parameters<typeof persistSessionTranscriptTurn>[1]["messages"],
) {
  return persistSessionTranscriptTurn(scope, { messages, touchSessionEntry: false });
}

function user(id: string, parent: string | null, content = id) {
  return transcriptMessage(id, parent, { role: "user", content });
}

function assistant(id: string, parent: string | null, content = id) {
  return transcriptMessage(id, parent, { role: "assistant", content });
}

function toolResult(id: string, parent: string, call: string, text: string, second: number) {
  return transcriptMessage(id, parent, {
    role: "toolResult",
    toolCallId: call,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.UTC(2026, 7, 15, 0, 0, second),
  });
}

function storedMessage(
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  content: string,
) {
  return { type: "message", id, parentId, message: { role, content } };
}

function compaction(id: string, parentId: string, firstKeptEntryId: string, summary: string) {
  return {
    type: "compaction",
    id,
    parentId,
    firstKeptEntryId,
    summary,
    timestamp: "2026-08-30T00:00:00.000Z",
    tokensBefore: 100,
  };
}

function reset(id: string, parentId: string, firstKeptEntryId?: string) {
  return {
    type: "reset",
    id,
    parentId,
    firstKeptEntryId,
    reason: "new",
    timestamp: "2026-08-30T00:00:00.000Z",
  };
}

function eventIds(events: unknown[]) {
  return events.map((event) => (event as { id: string }).id);
}

function serializedBytes(events: unknown[]) {
  return events.reduce<number>(
    (total, event) => total + Buffer.byteLength(JSON.stringify(event)) + 1,
    0,
  );
}

function readContext(scope: Scope, maxBytes = 1024, maxEvents = 10) {
  return boundedContext(scope, { maxBytes, maxEvents });
}

async function withBoundedContextScope(run: (scope: Scope) => Promise<void>): Promise<void> {
  await withOpenClawTestState({ label: "bounded-transcript-context" }, async (state) => {
    await captureRuntimeConfigAsyncReader()();
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

const it = baseIt.extend<{ scope: Scope }>({
  scope: async ({ task: _task }, use) => withBoundedContextScope(use),
});

async function seedImportedTranscript(scope: Scope, events: unknown[]) {
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

function readHistory(scope: Scope) {
  return tailPage(scope, { maxBytes: 1024 * 1024, maxMessages: 100, offset: 0 });
}

function observePayloadAcquisition(
  connection: ReturnType<typeof openOpenClawAgentDatabase>["db"],
  marker: string,
  read: () => void,
) {
  const db = requireNativeSqliteDatabase(connection);
  clearNodeSqliteKyselyCacheForDatabase(db);
  const prepare = db.prepare.bind(db);
  const parse = JSON.parse;
  const restoreStatements: Array<() => void> = [];
  const pending = new Map<string, number>();
  let acquiredBytes = 0;
  let largestRowBytes = 0;
  let peakPendingBytes = 0;
  let decodedRows = 0;
  const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((query) => {
    const statement = prepare(query);
    const iterate = statement.iterate.bind(statement);
    // Observe SQLite result acquisition, including payloads rejected before JSON.parse.
    const iterateSpy = vi.spyOn(statement, "iterate").mockImplementation(function* (...params) {
      for (const row of iterate(...params)) {
        for (const value of Object.values(row)) {
          if (typeof value === "string" && value.includes(marker)) {
            const bytes = Buffer.byteLength(value);
            acquiredBytes += bytes;
            pending.set(value, bytes);
            largestRowBytes = Math.max(largestRowBytes, bytes);
            peakPendingBytes = Math.max(
              peakPendingBytes,
              [...pending.values()].reduce((a, b) => a + b, 0),
            );
          }
        }
        yield row;
      }
      return undefined;
    });
    restoreStatements.push(() => iterateSpy.mockRestore());
    return statement;
  });
  const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
    if (pending.delete(text)) {
      decodedRows++;
    }
    return parse(text, reviver);
  });
  try {
    read();
  } finally {
    parseSpy.mockRestore();
    prepareSpy.mockRestore();
    for (const restore of restoreStatements) {
      restore();
    }
  }
  return {
    acquiredBytes,
    largestRowBytes,
    peakPendingBytes,
    decodedRows,
    pendingRows: pending.size,
  };
}

it("enforces context count and byte budgets and releases rejected reads for later appends", async ({
  scope,
}) => {
  const append = (id: string, parent: string | null, content = id) =>
    persist(scope, [user(id, parent, content)]);
  await append("old", null);
  await append("large", "old", "🦞".repeat(1024));
  await append("new", "large");
  const read = (maxBytes: number, maxEvents = 100) => readContext(scope, maxBytes, maxEvents);
  const ids = (context: ReturnType<typeof read>) => eventIds(context.events);
  const counted = read(16_384, 2);
  expect(ids(counted)).toEqual([scope.sessionId, "large", "new"]);
  expect(counted).toMatchObject({ activeLeafEntryId: "new", totalEvents: 3, truncated: true });
  expect(counted.serializedBytes).toBe(serializedBytes(counted.events));
  expect(counted.serializedBytes).toBeLessThanOrEqual(16_384);
  expect(read(16_384, 3).truncated).toBe(false);
  const headerBytes = Buffer.byteLength(JSON.stringify(counted.events[0])) + 1;
  const bounded = (maxBytes: number) => {
    const context = read(maxBytes);
    expect(context.truncated).toBe(true);
    return context;
  };
  expect(ids(bounded(1024))).toEqual([scope.sessionId, "new"]);
  const exact = bounded(headerBytes);
  expect(ids(exact)).toEqual([scope.sessionId]);
  expect(exact.events[0]).toMatchObject({ type: "session" });
  expect(exact.serializedBytes).toBe(headerBytes);
  await append("oversized", "new", "🦞".repeat(1024));
  expect(ids(bounded(1024))).toEqual([scope.sessionId]);
  await append("next", "oversized");
  expect(ids(bounded(1024))).toEqual([scope.sessionId, "next"]);
});

it("decodes context payloads without buffering the whole encoded window", async ({ scope }) => {
  const marker = "synthetic-context-payload:";
  const content = marker + "🦞".repeat(256);
  await persist(scope, [
    user("a", null, content),
    assistant("b", "a", content),
    user("c", "b", content),
  ]);
  const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
  const acquisition = observePayloadAcquisition(db, marker, () => {
    const context = readContext(scope, 16_384);
    expect(eventIds(context.events)).toEqual([scope.sessionId, "a", "b", "c"]);
    expect(context.serializedBytes).toBe(serializedBytes(context.events));
  });
  expect(acquisition.decodedRows).toBe(3);
  expect(acquisition.pendingRows).toBe(0);
  expect(acquisition.peakPendingBytes).toBeLessThanOrEqual(acquisition.largestRowBytes);
});

it.for(["header", "compaction"] as const)(
  "bounds oversized %s before acquiring its payload",
  async (kind, { scope }) => {
    const marker = "synthetic-oversized-payload:";
    const payload = marker + "x".repeat(4096);
    if (kind === "header") {
      await appendTranscriptEvent(scope, {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: scope.sessionId,
        cwd: payload,
      });
    } else {
      const kept = SessionManager.open(scope).appendMessage({
        role: "user",
        content: "retained",
        timestamp: 1,
      });
      await appendTranscriptEvent(scope, {
        ...compaction("oversized-boundary", kept, kept, "summary"),
        details: { payload },
      });
      await appendTranscriptMessage(scope, {
        eventId: "tail",
        message: { role: "user", content: "latest", timestamp: 2 },
      });
      await waitProjection(scope);
    }
    runOpenClawAgentWriteTransaction(
      (database) => {
        database.db
          .prepare(`UPDATE transcript_events
            SET navigation_type = NULL, navigation_custom_type = NULL,
                navigation_display = 0, message_role = NULL, navigation_last_type = NULL,
                navigation_last_custom_type = NULL, navigation_valid = 1
            WHERE session_id = ?`)
          .run(scope.sessionId);
      },
      { agentId: scope.agentId },
    );
    const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const acquisition = observePayloadAcquisition(db, marker, () => {
      if (kind === "header") {
        expect(() => readContext(scope)).toThrow(
          "Session transcript header exceeds the active-context byte limit",
        );
      } else {
        const context = readContext(scope, 1024, 1);
        expect(eventIds(context.events)).toEqual([scope.sessionId, "tail"]);
        expect(context).toMatchObject({ truncated: true, boundaryCount: 1 });
        expect(context.serializedBytes).toBe(serializedBytes(context.events));
      }
    });
    expect(acquisition.acquiredBytes).toBe(0);
  },
);

it("selects imported headers and retention anchors before later indexed duplicates", async ({
  scope,
}) => {
  const events = [
    storedMessage("mirror", null, "assistant", "New session started."),
    { type: "session", version: 3, id: scope.sessionId },
    storedMessage("kept", "mirror", "user", "Imported kept question."),
    {
      type: "compaction",
      id: "cut",
      parentId: "kept",
      firstKeptEntryId: "kept",
      summary: "Summary.",
    },
    storedMessage("reply", "cut", "assistant", "Original reply."),
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
  const context = readContext(scope, 32_768, 10);
  expect(context.events[0]).toMatchObject({ type: "session", version: 3, id: scope.sessionId });
  const range = context.firstKeptRanges.get("cut");
  expect(range).toBeDefined();
  expect(context.events.slice(range!.startIndex, range!.endIndex)).toEqual([
    expect.objectContaining({
      id: "kept",
      message: { role: "user", content: "Imported kept question." },
    }),
  ]);
  expect(historyEvent(scope, "kept", { currentOnly: true, maxBytes: 100 })).toBeUndefined();
});

it("retains the latest boundary and counts earlier resets before a truncated tail", async ({
  scope,
}) => {
  await persist(scope, [user("old", null)]);
  await appendTranscriptEvent(scope, reset("prior-reset", "old"));
  await appendTranscriptEvent(scope, compaction("summary", "prior-reset", "old", "earlier work"));
  await persist(scope, [user("middle", "summary"), assistant("new", "middle")]);

  const context = readContext(scope, 2048, 1);

  expect(eventIds(context.events)).toEqual([scope.sessionId, "summary", "new"]);
  expect(context.events.at(-1)).toMatchObject({ parentId: "middle" });
  expect(context.parents).toEqual(
    new Map([
      ["summary", "prior-reset"],
      ["new", "middle"],
    ]),
  );
  expect(context.opaqueParents.get("middle")).toBe("summary");
  expect(context.boundaryCount).toBe(2);
});

it("keeps reset history closed across compaction with a warm history cache", async ({ scope }) => {
  const manager = SessionManager.open(scope);
  const appendUser = (content: string) =>
    manager.appendMessage({ role: "user", content, timestamp: 1 });
  const settle = async () => {
    manager.flushPendingPersistence();
    await waitProjection(scope);
  };
  const expectHistory = (ids: string[]) => {
    const page = readHistory(scope);
    expect(page.totalMessages).toBe(ids.length);
    expect(page.events.map(({ event }) => (event as { id: string }).id)).toEqual(ids);
  };
  const expectContext = (messages: unknown[]) => {
    expect(manager.buildSessionContext().messages).toMatchObject(messages);
    expect(activeStats(scope).eventCount).toBe(messages.length);
  };
  const summary = (text: string) => ({ role: "compactionSummary", summary: text });
  const message = (content: string) => ({ role: "user", content });

  appendUser("before-reset user");
  manager.appendMessage(
    makeAgentAssistantMessage({ content: [{ type: "text", text: "before-reset assistant" }] }),
  );
  manager.appendResetBoundary("new");
  const freshUserId = appendUser("fresh user");
  await settle();
  expectHistory([freshUserId]);

  manager.appendCompaction("fresh-only summary", freshUserId, 100);
  await settle();
  expectHistory([freshUserId]);
  expectContext([summary("fresh-only summary"), message("fresh user")]);

  const nextUserId = appendUser("after compaction");
  await settle();
  expectHistory([freshUserId, nextUserId]);
  expect(activeStats(scope).eventCount).toBe(3);

  manager.appendResetBoundary("new", nextUserId);
  const newestUserId = appendUser("after second reset");
  await settle();
  expectHistory([nextUserId, newestUserId]);
  expectContext([message("after compaction"), message("after second reset")]);

  manager.appendCompaction("newest-only summary", newestUserId, 100);
  await settle();
  expectHistory([nextUserId, newestUserId]);
  const reopened = SessionManager.open(scope);
  expect(reopened.buildSessionContext().messages).toMatchObject([
    summary("newest-only summary"),
    message("after second reset"),
  ]);
  expect(activeStats(scope).eventCount).toBe(2);
});

it("counts paired reset tool results without counting discarded orphan results", async ({
  scope,
}) => {
  const assistantMessage = makeAgentAssistantMessage({
    content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
    stopReason: "toolUse",
  });
  await persist(scope, [
    user("discarded-old", null, `discarded ${"x".repeat(12_000)}`),
    user("kept-user", "discarded-old", "kept question"),
    transcriptMessage("kept-assistant", "kept-user", assistantMessage),
    toolResult("kept-result", "kept-assistant", "call-1", `paired ${"p".repeat(3_000)}`, 1),
    toolResult("discarded-orphan", "kept-result", "orphan-call", `orphan ${"o".repeat(20_000)}`, 2),
  ]);
  await appendTranscriptEvent(scope, reset("reset-boundary", "discarded-orphan", "kept-user"));
  await persist(scope, [user("post-reset", "reset-boundary", "fresh turn")]);

  const stats = activeStats(scope);
  expect(stats.eventCount).toBe(4);
  expect(stats.sizeBytes).toBeGreaterThan(3_000);
  expect(stats.sizeBytes).toBeLessThan(8_000);
  expect(readHistory(scope).totalMessages).toBe(3);

  await persist(scope, [assistant("second-post-reset", "post-reset", "fresh answer")]);
  expect(activeStats(scope).eventCount).toBe(5);

  await appendTranscriptEvent(
    scope,
    compaction("fresh-compaction", "second-post-reset", "post-reset", "fresh-only summary"),
  );
  const history = readHistory(scope);
  expect(history.totalMessages).toBe(4);
  expect(history.events.map(({ event }) => (event as { id: string }).id)).toEqual([
    "kept-user",
    "kept-assistant",
    "post-reset",
    "second-post-reset",
  ]);
  expect(activeStats(scope).eventCount).toBe(3);
  expect(activeStats(scope).sizeBytes).toBeLessThan(8_000);
});

it("keeps later unindexed feedback payloads outside an admitted context read", async ({
  scope,
}) => {
  const events = [
    { type: "session", version: CURRENT_SESSION_VERSION, id: scope.sessionId },
    storedMessage("imported-user", null, "user", "Imported conversation."),
  ];
  await seedImportedTranscript(scope, events);
  const admitted = await appendTranscriptMessage(scope, {
    eventId: "current-user",
    parentId: "imported-user",
    message: { role: "user", content: "Current request.", timestamp: 2 },
  });
  const anchor = admitted.anchor;
  assert(anchor, "missing admission anchor");
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
  await waitProjection(scope);
  const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
  const acquisition = observePayloadAcquisition(db, marker, () => {
    runWithSessionTranscriptReadFence({ ...anchor, logicalTurnId: "current", role: "user" }, () => {
      const context = readContext(scope, 1024, 10);
      expect(eventIds(context.events)).toEqual([scope.sessionId, "imported-user"]);
      expect(context.activeLeafEntryId).toBe("imported-user");
    });
  });
  expect(acquisition.acquiredBytes).toBe(0);
});

it("keeps repeated visits on one snapshot and expires their reader on return", async ({
  scope,
}) => {
  await persist(scope, [user("seed", null, "before")]);
  const database = openOpenClawAgentDatabase(scope);
  const { DatabaseSync } = requireNodeSqlite();
  const writer = new DatabaseSync(database.path);
  let savedVisit: ((visitor: (event: unknown) => void) => void) | undefined;
  const first: unknown[] = [];
  const second: unknown[] = [];
  try {
    visitRecentEvents(scope, 1, (visit) => {
      savedVisit = visit;
      visit((event) => first.push(event));
      writer
        .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ?")
        .run(JSON.stringify(storedMessage("seed", null, "user", "after")), scope.sessionId);
      visit((event) => second.push(event));
    });
  } finally {
    writer.close();
  }
  expect(first).toMatchObject([{ message: { content: "before" } }]);
  expect(second).toEqual(first);
  expect(recentEvents(scope, 1)).toMatchObject([{ message: { content: "after" } }]);
  expect(() => savedVisit?.(() => {})).toThrow("outside its read snapshot");
});

it.for(["json", "sql", "consumer"] as const)(
  "preserves %s failure precedence and releases the read cursor",
  async (failureKind, { scope }) => {
    await persist(scope, [
      user("oldest", null),
      assistant("middle", "oldest"),
      user("newest", "middle"),
    ]);
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
          visitRecentEvents(scope, 3, (visit) => {
            visit(() => {
              throw failure;
            });
          }),
        ).toThrow(failure);
      } else {
        expect(() => recentEvents(scope, 3)).toThrow(
          failureKind === "sql" ? "malformed JSON" : parseFailure,
        );
      }
    } finally {
      if (failureKind !== "consumer") {
        database.db.exec("DROP VIEW temp.transcript_events");
      }
    }
    expect(database.db.isTransaction).toBe(false);
    expect(database.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({ busy: 0 });
    expect(recentEvents(scope, 3)).toHaveLength(3);
    await appendTranscriptEvent(scope, { type: "custom", id: "after", parentId: "newest" });
    expect(recentEvents(scope, 1)).toMatchObject([{ id: "after" }]);
  },
);

it.for(["unbounded", "reset"] as const)(
  "does not count display-only activity toward %s context pressure",
  async (boundary, { scope }) => {
    const activity = {
      role: "custom",
      customType: "tool-activity",
      display: true,
      excludeFromContext: true,
      content: "",
      details: { output: "x".repeat(32_000) },
      timestamp: 1,
    };
    await persist(scope, [
      user("kept-user", null, "question"),
      transcriptMessage("display-prefix", "kept-user", activity),
      assistant("kept-assistant", "display-prefix", "answer"),
    ]);
    if (boundary === "reset") {
      await appendTranscriptEvent(scope, {
        ...reset("boundary", "kept-assistant", "kept-user"),
        reason: "reset",
      });
    }
    const contextIds = new Set(["kept-user", "kept-assistant"]);
    const contextEvents = loadTranscriptEventsSync(scope).filter((event) =>
      contextIds.has((event as { id: string }).id),
    );
    const expected = {
      eventCount: contextEvents.length,
      sizeBytes: serializedBytes(contextEvents),
    };
    expect(activeStats(scope)).toEqual(expected);
    const physicalBefore = readTranscriptStatsSync(scope);
    const historyBefore = readSessionTranscriptMessageEventCount(scope);
    await persist(scope, [{ eventId: "display-tail", message: activity }]);

    expect(activeStats(scope)).toEqual(expected);
    expect(readTranscriptStatsSync(scope).sizeBytes).toBeGreaterThan(
      physicalBefore.sizeBytes + 32_000,
    );
    expect(readSessionTranscriptMessageEventCount(scope)).toBe(historyBefore + 1);
  },
);
