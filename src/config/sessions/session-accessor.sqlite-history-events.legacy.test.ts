import { afterAll, beforeEach, expect, it } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { appendTranscriptEvent } from "./session-accessor.js";
import { readRecentSessionTranscriptHistoryEvents } from "./session-accessor.sqlite-history-events.test-support.js";
import {
  historyEventId,
  historyMessage as messageEvent,
  historyActivity,
  persistHistory,
  readActiveTranscriptStats,
  readSessionTranscriptHistoryEventCount,
  readSessionTranscriptHistoryAnchorPage,
  readSessionTranscriptHistoryEvents,
  readSessionTranscriptHistoryEventById,
  useHistoryEventScope,
} from "./session-accessor.sqlite-history.test-support.js";
import { seedUnindexedTranscriptForTest } from "./session-accessor.sqlite-import.test-support.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

afterAll(clearRuntimeConfigSnapshot);
const scope = useHistoryEventScope();
beforeEach(() => setRuntimeConfigSnapshot({}));

async function seedRows(jsonRows: string[], updatedAt = 100) {
  const events = jsonRows.map((event_json, seq) => ({
    session_id: scope.sessionId,
    seq,
    created_at: seq,
    event_json,
  }));
  await seedUnindexedTranscriptForTest({
    ...scope,
    entry: { sessionId: scope.sessionId, updatedAt },
    events,
  });
  return events;
}

function toolResult(id: string, parentId: string, content: string, details?: unknown) {
  return {
    type: "message",
    id,
    parentId,
    message: {
      role: "toolResult",
      toolCallId: id === "kept-result" ? "call-1" : id,
      toolName: "read",
      content: [{ type: "text", text: content }],
      isError: false,
      timestamp: id === "kept-result" ? 1 : 2,
      ...(details === undefined ? {} : { details }),
    },
  };
}

const openDatabase = () => openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
const historyIds = () => readSessionTranscriptHistoryEvents(scope).map(historyEventId);
const page = (messageId: string, maxMessages = 20) =>
  readSessionTranscriptHistoryAnchorPage(scope, { messageId, maxMessages });
const notice = (id: string, parentId: string, content: string, display = true) => ({
  type: "custom_message",
  id,
  parentId,
  customType: "notice",
  display,
  content,
});

it("resolves large anchor sets without parsing unrelated non-object legacy rows", async () => {
  const ignored = [null, 0, [], "ignored"];
  const anchors = Array.from({ length: 33 }, (_, index) => `anchor-${index}`);
  const activities = anchors.map((afterEntryId, index) => ({
    type: "message",
    id: `activity-${index}`,
    parentId: index === 0 ? anchors.at(-1) : `activity-${index - 1}`,
    message: historyActivity({
      scopeId: `scope-${index}`,
      afterEntryId,
      startOrder: index,
      toolCallId: `call-${index}`,
    }),
  }));
  const events = await seedRows(
    [
      ...ignored,
      ...anchors.map((id, index) =>
        messageEvent(id, index === 0 ? null : anchors[index - 1]!, id, "assistant"),
      ),
      ...activities,
    ].map((event) => JSON.stringify(event)),
    1,
  );
  const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
  // The retained projection predates these SQLite-valid, JS-invalid raw bytes.
  for (let seq = 0; seq < ignored.length; seq++) {
    const eventJson = `${events[seq]!.event_json}\0`;
    expect(db.prepare("SELECT json_valid(?) AS valid").get(eventJson)).toEqual({ valid: 1 });
    db.prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = ?").run(
      eventJson,
      scope.sessionId,
      seq,
    );
  }
  const rawBefore = db.prepare("SELECT * FROM transcript_events ORDER BY seq").all();
  const history = readSessionTranscriptHistoryEvents(scope);
  expect(history.map(historyEventId)).toEqual([...anchors, ...activities.map(({ id }) => id)]);
  expect(history.slice(anchors.length).map((row) => row.displayPosition?.activity)).toEqual(
    anchors.map((_, index) => ({
      afterRawSeq: ignored.length + index,
      scopeId: `scope-${index}`,
      startOrder: index,
    })),
  );
  expect(db.prepare("SELECT * FROM transcript_events ORDER BY seq").all()).toEqual(rawBefore);
  expect(db.prepare("SELECT * FROM transcript_event_identities").all()).toEqual([]);
});

it.each(["boundary", "paired-result"])(
  "reads imported reset history with SQLite-overdepth %s JSON",
  async (overdepth) => {
    const deep: unknown = JSON.parse("[".repeat(1001) + "0" + "]".repeat(1001));
    const events = [
      { type: "session", version: 3, id: scope.sessionId },
      messageEvent("discarded", null, "Discard this older question."),
      messageEvent("kept-user", "discarded", "Keep this question and its completed tool call."),
      {
        type: "message",
        id: "kept-assistant",
        parentId: "kept-user",
        message: makeAgentAssistantMessage({
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
          stopReason: "toolUse",
        }),
      },
      toolResult(
        "kept-result",
        "kept-assistant",
        "Completed result.",
        overdepth === "paired-result" ? deep : undefined,
      ),
      toolResult("orphan", "kept-result", "Discard this unpaired result."),
      {
        type: "reset",
        id: "reset",
        parentId: "orphan",
        reason: "new",
        firstKeptEntryId: "kept-user",
        ...(overdepth === "boundary" ? { details: deep } : {}),
      },
      messageEvent("fresh", "reset", "A fresh turn."),
      ...(overdepth === "boundary"
        ? [{ id: "unknown-entry", type: { toString: 0, valueOf: 0 }, details: deep }]
        : []),
    ];
    const rows = await seedRows(events.map((event) => JSON.stringify(event)));
    const store = openDatabase();
    expect(
      store.db
        .prepare("SELECT json_valid(?) AS valid")
        .get(rows[overdepth === "boundary" ? 6 : 4]!.event_json),
    ).toEqual({ valid: 0 });
    const raw = store.db.prepare("SELECT * FROM transcript_events ORDER BY seq");
    const rawBefore = raw.all();

    expect(historyIds()).toEqual(["kept-user", "kept-assistant", "reset", "fresh"]);
    const retained = new Set(["kept-user", "kept-assistant", "kept-result", "fresh"]);
    expect(readActiveTranscriptStats(scope)).toEqual({
      eventCount: retained.size,
      sizeBytes: rows.reduce(
        (bytes, row, seq) =>
          bytes + (retained.has(events[seq]!.id) ? Buffer.byteLength(row.event_json) + 1 : 0),
        0,
      ),
    });
    const messages = SessionManager.openBounded(
      { ...scope, storePath: store.path },
      { maxBytes: 64 * 1024, maxEvents: 20 },
    ).buildSessionContext().messages;
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "user",
    ]);
    expect(messages[2]).toMatchObject({ role: "toolResult", toolCallId: "call-1" });
    expect(raw.all()).toEqual(rawBefore);
    expect(store.db.prepare("SELECT * FROM transcript_event_identities").all()).toEqual([]);
  },
);

it("reads appended imported reset windows without acquiring identity ownership", async () => {
  const events = [
    { type: "session", version: 3, id: scope.sessionId },
    messageEvent("old-user", null, "Old question."),
    messageEvent("old-assistant", "old-user", "Old answer.", "assistant"),
    { type: "custom", id: "old-hidden", parentId: "old-assistant", customType: "hidden" },
    { type: "reset", id: "reset", parentId: "old-hidden", reason: "new" },
    messageEvent("current-user", "reset", "Current question.".repeat(40)),
    notice("notice", "current-user", "Visible notice."),
    notice("hidden-notice", "notice", "Hidden notice.", false),
    {
      type: "compaction",
      id: "compaction",
      parentId: "hidden-notice",
      firstKeptEntryId: "current-user",
      summary: "Retained context.",
    },
    messageEvent("current-assistant", "compaction", "Current answer.", "assistant"),
  ];
  await seedRows(events.map((event) => JSON.stringify(event, null, 2)));
  await appendTranscriptEvent(
    scope,
    notice("later-notice", "current-assistant", "Appended notice."),
  );
  await persistHistory(scope, [
    transcriptMessage("later-assistant", "later-notice", {
      role: "assistant",
      content: "Appended answer.",
    }),
  ]);
  const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
  const identities = database.db.prepare(
    "SELECT * FROM transcript_event_identities WHERE session_id = ? ORDER BY seq",
  );
  const raw = database.db.prepare(
    "SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq",
  );
  const identitiesBefore = identities.all(scope.sessionId);
  const rawBefore = raw.all(scope.sessionId);
  const currentIds = [
    "reset",
    "current-user",
    "notice",
    "compaction",
    "current-assistant",
    "later-notice",
    "later-assistant",
  ];

  expect(historyIds()).toEqual(currentIds);
  expect(readSessionTranscriptHistoryEventCount(scope)).toBe(currentIds.length);
  expect(page("current-user").events.map(historyEventId)).toEqual(currentIds);
  const historical = page("old-user");
  expect(historical).toMatchObject({ found: true, totalMessages: 3 });
  expect(historical.events.map(historyEventId)).toEqual(["old-user", "old-assistant", "reset"]);
  expect(page("hidden-notice").found).toBe(false);
  expect(
    readSessionTranscriptHistoryEventById(scope, "current-user", {
      currentOnly: true,
      maxBytes: 100,
    }),
  ).toBeUndefined();
  expect(identities.all(scope.sessionId)).toEqual(identitiesBefore);
  expect(raw.all(scope.sessionId)).toEqual(rawBefore);

  await replaceTranscriptEvents(scope, [
    events[0],
    messageEvent("replacement", null, "New canonical generation."),
  ]);
  expect(historyIds()).toEqual(["replacement"]);
  expect(page("replacement", 2).found).toBe(true);
  expect(page("old-user", 2).found).toBe(false);
});

it("uses the last imported root type for custom then compaction history", async () => {
  const expectedIds = ["user", "control", "assistant"];
  const rows = [
    JSON.stringify({ type: "session", version: 3, id: scope.sessionId }),
    '{"type":"message","id":"user","parentId":null,"message":{"role":"user","content":"Imported question."}}',
    '{"type":"custom","type":"compaction","id":"control","parentId":"user","summary":"Imported summary.","firstKeptEntryId":"user","tokensBefore":100,"customType":"hidden-metadata"}',
    '{"type":"message","id":"assistant","parentId":"control","message":{"role":"assistant","content":"Imported answer."}}',
  ];
  await seedRows(rows);

  expect(readSessionTranscriptHistoryEventCount(scope)).toBe(expectedIds.length);
  const tail = readRecentSessionTranscriptHistoryEvents(scope, {
    maxBytes: 4096,
    maxLines: 2,
    maxMessages: 2,
  });
  expect(tail.events.map(historyEventId)).toEqual(expectedIds.slice(-2));
  expect(tail.totalMessages).toBe(expectedIds.length);
  const anchor = page("control", 10);
  expect(anchor.found).toBe(true);
  expect(anchor.events.map(historyEventId)).toEqual(expectedIds);

  const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
  expect(
    database.db
      .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
      .all(scope.sessionId),
  ).toEqual(rows.map((event_json) => ({ event_json })));
  expect(
    database.db
      .prepare("SELECT * FROM transcript_event_identities WHERE session_id = ?")
      .all(scope.sessionId),
  ).toEqual([]);
});

it("counts imported compaction bytes using the last root type across an append", async () => {
  const rows = [
    JSON.stringify({ type: "session", version: 3, id: scope.sessionId }),
    JSON.stringify(messageEvent("discarded", null, "Discard this older question.")),
    JSON.stringify(messageEvent("kept-user", "discarded", "Retained question.")),
    '{"type":"custom","type":"message","id":"kept-assistant","parentId":"kept-user","message":{"role":"assistant","content":"Retained answer."}}',
    JSON.stringify({
      type: "compaction",
      id: "compaction",
      parentId: "kept-assistant",
      firstKeptEntryId: "kept-user",
      summary: "Retained context.",
    }),
  ];
  await seedRows(rows);
  const retainedBytes = rows.slice(2).reduce((total, row) => total + Buffer.byteLength(row) + 1, 0);
  expect(readActiveTranscriptStats(scope)).toEqual({ eventCount: 3, sizeBytes: retainedBytes });

  await persistHistory(scope, [
    transcriptMessage("fresh", "compaction", { role: "user", content: "A fresh question." }),
  ]);
  const stored = openDatabase()
    .db.prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
    .all(scope.sessionId) as { event_json: string }[];
  expect(stored.slice(0, rows.length)).toEqual(rows.map((event_json) => ({ event_json })));
  expect(stored).toHaveLength(rows.length + 1);
  const appended = stored.at(-1)!.event_json;
  expect(readActiveTranscriptStats(scope)).toEqual({
    eventCount: 4,
    sizeBytes: retainedBytes + Buffer.byteLength(appended) + 1,
  });
});

it("continues imported history when an append has no explicit parent", async () => {
  const events = [
    { type: "session", version: 3, id: scope.sessionId },
    messageEvent("imported-answer", null, "Original migrated answer.", "assistant"),
  ];
  await seedRows(events.map((event) => JSON.stringify(event)));
  await persistHistory(scope, [
    {
      eventId: "next-question",
      message: { role: "user", content: "Continue the existing conversation." },
    },
  ]);
  const history = readSessionTranscriptHistoryEvents(scope);
  expect(history.map(historyEventId)).toEqual(["imported-answer", "next-question"]);
  expect(history[1]?.event).toMatchObject({ parentId: "imported-answer" });
  const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
  expect(
    database.db
      .prepare("SELECT event_id FROM transcript_event_identities WHERE session_id = ? ORDER BY seq")
      .all(scope.sessionId),
  ).toEqual([{ event_id: "next-question" }]);
});

it("retains imported reset context only for the exact first-kept ID", async () => {
  const events = [
    { type: "session", version: 3, id: scope.sessionId },
    messageEvent(" kept ", null, "Retained question."),
    { type: "reset", id: "reset", parentId: " kept ", reason: "new", firstKeptEntryId: "kept" },
    messageEvent("current", "reset", "Current question."),
  ];
  await seedRows(events.map((event) => JSON.stringify(event)));
  expect(historyIds()).toEqual(["reset", "current"]);
});

it("finds an imported ID containing escaped whitespace and a surrogate pair", async () => {
  const encodedId = String.raw`" \t\ud83e\udd9e-escape\n"`;
  const rows = [
    JSON.stringify({ type: "session", version: 3, id: scope.sessionId }),
    `{"type":"message","id":${encodedId},"parentId":null,"message":{"role":"user","content":"Encoded imported identity."}}`,
  ];
  await seedRows(rows);
  const result = page("🦞-escape", 2);
  expect(result).toMatchObject({ found: true, totalMessages: 1 });
  expect(result.events[0]?.event).toEqual(JSON.parse(rows[1]!));
});
