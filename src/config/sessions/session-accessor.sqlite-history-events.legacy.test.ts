import { describe, expect, it } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { createNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { appendTranscriptEvent, persistSessionTranscriptTurn } from "./session-accessor.js";
import { readRecentSessionTranscriptHistoryEvents } from "./session-accessor.sqlite-history-events.test-support.js";
import {
  historyEventId,
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

describe("SQLite imported transcript history", () => {
  const scope = useHistoryEventScope();

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

  function messageEvent(
    id: string,
    parentId: string | null,
    content: string,
    role: "user" | "assistant" = "user",
  ) {
    return { type: "message", id, parentId, message: { role, content } };
  }

  it("resolves large anchor sets without parsing unrelated non-object legacy rows", async () => {
    const ignored = [null, 0, [], "ignored"];
    const anchors = Array.from({ length: 33 }, (_, index) => `anchor-${index}`);
    const activities = anchors.map((afterEntryId, index) => ({
      type: "message",
      id: `activity-${index}`,
      parentId: index === 0 ? anchors.at(-1) : `activity-${index - 1}`,
      message: createNestedToolActivity({
        runId: "run",
        scopeId: `scope-${index}`,
        afterEntryId,
        startOrder: index,
        toolCallId: `call-${index}`,
        toolName: "read",
        input: {},
        result: { content: [] },
        isError: false,
        startedAt: 1,
        timestamp: 2,
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
      db.prepare(
        "UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = ?",
      ).run(eventJson, scope.sessionId, seq);
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
        {
          type: "message",
          id: "kept-result",
          parentId: "kept-assistant",
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            content: [{ type: "text", text: "Completed result." }],
            isError: false,
            timestamp: 1,
            ...(overdepth === "paired-result" ? { details: deep } : {}),
          },
        },
        {
          type: "message",
          id: "orphan",
          parentId: "kept-result",
          message: {
            role: "toolResult",
            toolCallId: "orphan",
            toolName: "read",
            content: [{ type: "text", text: "Discard this unpaired result." }],
            isError: false,
            timestamp: 2,
          },
        },
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
      const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
      expect(
        database.db
          .prepare("SELECT json_valid(?) AS valid")
          .get(rows[overdepth === "boundary" ? 6 : 4]!.event_json),
      ).toEqual({ valid: 0 });
      const rawBefore = database.db.prepare("SELECT * FROM transcript_events ORDER BY seq").all();

      expect(readSessionTranscriptHistoryEvents(scope).map(historyEventId)).toEqual([
        "kept-user",
        "kept-assistant",
        "reset",
        "fresh",
      ]);
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
        { ...scope, storePath: database.path },
        {
          maxBytes: 64 * 1024,
          maxEvents: 20,
        },
      ).buildSessionContext().messages;
      expect(messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "toolResult",
        "user",
      ]);
      expect(messages[2]).toMatchObject({ role: "toolResult", toolCallId: "call-1" });
      expect(database.db.prepare("SELECT * FROM transcript_events ORDER BY seq").all()).toEqual(
        rawBefore,
      );
      expect(database.db.prepare("SELECT * FROM transcript_event_identities").all()).toEqual([]);
    },
  );

  it.each([false, true])(
    "reads previously imported reset windows without acquiring identity ownership (appended=%s)",
    async (appended) => {
      const events = [
        { type: "session", version: 3, id: scope.sessionId },
        messageEvent("old-user", null, "Old question."),
        messageEvent("old-assistant", "old-user", "Old answer.", "assistant"),
        { type: "custom", id: "old-hidden", parentId: "old-assistant", customType: "hidden" },
        { type: "reset", id: "reset", parentId: "old-hidden", reason: "new" },
        messageEvent("current-user", "reset", "Current question.".repeat(40)),
        {
          type: "custom_message",
          id: "notice",
          parentId: "current-user",
          customType: "notice",
          display: true,
          content: "Visible notice.",
        },
        {
          type: "custom_message",
          id: "hidden-notice",
          parentId: "notice",
          customType: "notice",
          display: false,
          content: "Hidden notice.",
        },
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
      if (appended) {
        await appendTranscriptEvent(scope, {
          type: "custom_message",
          id: "later-notice",
          parentId: "current-assistant",
          customType: "notice",
          display: true,
          content: "Appended notice.",
        });
        await persistSessionTranscriptTurn(scope, {
          messages: [
            transcriptMessage("later-assistant", "later-notice", {
              role: "assistant",
              content: "Appended answer.",
            }),
          ],
          touchSessionEntry: false,
        });
      }
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
        ...(appended ? ["later-notice", "later-assistant"] : []),
      ];

      expect(readSessionTranscriptHistoryEvents(scope).map(historyEventId)).toEqual(currentIds);
      expect(readSessionTranscriptHistoryEventCount(scope)).toBe(currentIds.length);
      expect(
        readSessionTranscriptHistoryAnchorPage(scope, {
          messageId: "current-user",
          maxMessages: 20,
        }).events.map(historyEventId),
      ).toEqual(currentIds);
      const historical = readSessionTranscriptHistoryAnchorPage(scope, {
        messageId: "old-user",
        maxMessages: 20,
      });
      expect(historical).toMatchObject({ found: true, totalMessages: 3 });
      expect(historical.events.map(historyEventId)).toEqual(["old-user", "old-assistant", "reset"]);
      expect(
        readSessionTranscriptHistoryAnchorPage(scope, {
          messageId: "hidden-notice",
          maxMessages: 20,
        }).found,
      ).toBe(false);
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
      expect(readSessionTranscriptHistoryEvents(scope).map(historyEventId)).toEqual([
        "replacement",
      ]);
      expect(
        readSessionTranscriptHistoryAnchorPage(scope, { messageId: "replacement", maxMessages: 2 })
          .found,
      ).toBe(true);
      expect(
        readSessionTranscriptHistoryAnchorPage(scope, { messageId: "old-user", maxMessages: 2 })
          .found,
      ).toBe(false);
    },
  );

  it("anchors the active occurrence of duplicate IDs in byte-preserving imported rows", async () => {
    const rows = [
      JSON.stringify({ type: "session", version: 3, id: scope.sessionId }),
      '{"type":"message","id":"duplicate","parentId":null,"message":{"role":"user","content":"Inactive earlier occurrence."}}',
      '{"type":"message","id":"ignored-property","id":"duplicate","parentId":null,"message":{"role":"user","content":"Active latest occurrence."}}',
    ];
    await seedRows(rows);
    const page = readSessionTranscriptHistoryAnchorPage(scope, {
      messageId: "duplicate",
      maxMessages: 20,
    });
    expect(page).toMatchObject({ found: true, totalMessages: 1 });
    expect(page.events).toMatchObject([
      {
        eventSeq: 2,
        event: { id: "duplicate", message: { content: "Active latest occurrence." } },
      },
    ]);
    expect(
      readSessionTranscriptHistoryAnchorPage(scope, {
        messageId: "ignored-property",
        maxMessages: 20,
      }).found,
    ).toBe(false);
  });

  it.each([
    ["compaction", "custom", ["user", "assistant"]],
    ["custom", "compaction", ["user", "control", "assistant"]],
  ] as const)(
    "uses the last imported root type for %s then %s history",
    async (firstType, lastType, expectedIds) => {
      const rows = [
        JSON.stringify({ type: "session", version: 3, id: scope.sessionId }),
        '{"type":"message","id":"user","parentId":null,"message":{"role":"user","content":"Imported question."}}',
        `{"type":"${firstType}","type":"${lastType}","id":"control","parentId":"user","summary":"Imported summary.","firstKeptEntryId":"user","tokensBefore":100,"customType":"hidden-metadata"}`,
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
      const anchor = readSessionTranscriptHistoryAnchorPage(scope, {
        messageId: "control",
        maxMessages: 10,
      });
      const visible = lastType === "compaction";
      expect(anchor.found).toBe(visible);
      expect(anchor.events.map(historyEventId)).toEqual(visible ? expectedIds : []);

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
    },
  );

  it("continues imported history when an append has no explicit parent", async () => {
    const events = [
      { type: "session", version: 3, id: scope.sessionId },
      messageEvent("imported-answer", null, "Original migrated answer.", "assistant"),
    ];
    await seedRows(events.map((event) => JSON.stringify(event)));
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "next-question",
          message: { role: "user", content: "Continue the existing conversation." },
        },
      ],
      touchSessionEntry: false,
    });
    const history = readSessionTranscriptHistoryEvents(scope);
    expect(history.map(historyEventId)).toEqual(["imported-answer", "next-question"]);
    expect(history[1]?.event).toMatchObject({ parentId: "imported-answer" });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    expect(
      database.db
        .prepare(
          "SELECT event_id FROM transcript_event_identities WHERE session_id = ? ORDER BY seq",
        )
        .all(scope.sessionId),
    ).toEqual([{ event_id: "next-question" }]);
  });

  it.each([" kept ", "kept"])(
    "retains imported reset context only for the exact first-kept ID %j",
    async (firstKeptEntryId) => {
      const events = [
        { type: "session", version: 3, id: scope.sessionId },
        messageEvent(" kept ", null, "Retained question."),
        { type: "reset", id: "reset", parentId: " kept ", reason: "new", firstKeptEntryId },
        messageEvent("current", "reset", "Current question."),
      ];
      await seedRows(events.map((event) => JSON.stringify(event)));
      expect(readSessionTranscriptHistoryEvents(scope).map(historyEventId)).toEqual([
        ...(firstKeptEntryId === " kept " ? [" kept "] : []),
        "reset",
        "current",
      ]);
    },
  );

  it("finds an imported ID containing escaped whitespace and a surrogate pair", async () => {
    const encodedId = String.raw`" \t\ud83e\udd9e-escape\n"`;
    const rows = [
      JSON.stringify({ type: "session", version: 3, id: scope.sessionId }),
      `{"type":"message","id":${encodedId},"parentId":null,"message":{"role":"user","content":"Encoded imported identity."}}`,
    ];
    await seedRows(rows);
    const page = readSessionTranscriptHistoryAnchorPage(scope, {
      messageId: "🦞-escape",
      maxMessages: 2,
    });
    expect(page).toMatchObject({ found: true, totalMessages: 1 });
    expect(page.events[0]?.event).toEqual(JSON.parse(rows[1]!));
  });
});
