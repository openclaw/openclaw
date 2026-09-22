import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  replaceTranscriptEvents,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as chatDisplayProjection from "./chat-display-projection.core.js";
import {
  readChatHistoryMessageId,
  readChatHistoryMessageSeq,
  readIncrementalChatHistoryTail,
} from "./session-history-tail.js";
import * as sessionTranscriptReaders from "./session-transcript-readers.js";

it("applies the head byte budget before loading an older malformed row", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const readScope = {
      agentId: "main",
      sessionId: "head-cursor-byte-budget",
      sessionKey: "agent:main:head-cursor-byte-budget",
      storePath: `${state.sessionsDir()}/sessions.json`,
    };
    const newestText = "x".repeat(1024 * 1024 + 1);
    await replaceTranscriptEvents(readScope, [
      { type: "session", version: 3, id: readScope.sessionId },
      {
        type: "message",
        id: "older",
        parentId: null,
        message: { role: "user", content: "Old question" },
      },
      {
        type: "message",
        id: "newest",
        parentId: "older",
        message: { role: "assistant", content: newestText },
      },
    ]);
    await waitForSessionTranscriptProjection(readScope);
    const { db } = openOpenClawAgentDatabase({ agentId: readScope.agentId, env: state.env });
    expect(
      db
        .prepare(
          "UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = (SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?)",
        )
        .run("{", readScope.sessionId, readScope.sessionId, "older").changes,
    ).toBe(1);

    const tail = await readIncrementalChatHistoryTail({
      readers: sessionTranscriptReaders,
      entry: undefined,
      readScope,
      beforeSeq: 99,
      preserveProjectionContext: true,
      effectiveMaxChars: 8_000,
      max: 1,
      maxBytes: 1024,
    });

    expect(tail.readPage.totalMessages).toBe(2);
    expect(tail.rawMessages).toMatchObject([
      { content: newestText, __openclaw: { id: "newest", seq: 2 } },
    ]);
    expect(tail.projected.map(readChatHistoryMessageId)).toEqual(["newest"]);
  });
});

it("keeps a sparse tail below its first snapshot when messages append between pages", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const readScope = {
      agentId: "main",
      sessionId: "sparse-tail-append",
      sessionKey: "agent:main:sparse-tail-append",
      storePath: `${state.sessionsDir()}/sessions.json`,
    };
    const ids = Array.from({ length: 101 }, (_, index) => `row-${index + 1}`);
    await replaceTranscriptEvents(readScope, [
      { type: "session", version: 3, id: readScope.sessionId },
      ...ids.map((id, index) => ({
        type: "message",
        id,
        parentId: ids[index - 1] ?? null,
        message:
          index === 0
            ? { role: "user", content: "Original question" }
            : { role: "assistant", content: "NO_REPLY" },
      })),
    ]);
    const readRecent = sessionTranscriptReaders.readRecentSessionMessagesWithStatsAsync;
    const recentSpy = vi
      .spyOn(sessionTranscriptReaders, "readRecentSessionMessagesWithStatsAsync")
      .mockImplementationOnce(async (...args) => {
        const page = await readRecent(...args);
        for (const seq of [102, 103]) {
          await appendTranscriptMessage(readScope, {
            eventId: `row-${seq}`,
            message: { role: "assistant", content: "NO_REPLY" },
          });
        }
        return page;
      });
    try {
      const tail = await readIncrementalChatHistoryTail({
        readers: sessionTranscriptReaders,
        entry: undefined,
        readScope,
        effectiveMaxChars: 8_000,
        max: 1,
        maxBytes: 1024 * 1024,
      });

      expect(await sessionTranscriptReaders.readSessionMessageCountAsync(readScope)).toBe(103);
      expect(tail.rawMessages.map(readChatHistoryMessageId)).toEqual(ids);
      expect(tail.rawPageMessages).toBe(101);
      expect(tail.readPage.totalMessages).toBe(101);
      expect(tail.projected).toMatchObject([
        { role: "user", content: "Original question", __openclaw: { id: "row-1", seq: 1 } },
      ]);
    } finally {
      recentSpy.mockRestore();
    }
  });
});

it("fills sparse pages without repeatedly projecting scanned transcript rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const readScope = {
      agentId: "main",
      sessionId: "sparse-tail-projection-work",
      sessionKey: "agent:main:sparse-tail-projection-work",
      storePath: `${state.sessionsDir()}/sessions.json`,
    };
    const events = Array.from({ length: 1_500 }, (_, index) => ({
      type: "message",
      id: `row-${index}`,
      parentId: index === 0 ? null : `row-${index - 1}`,
      message: {
        role: index % 50 === 0 ? "user" : "assistant",
        content: index % 50 === 0 ? `visible ${index / 50}` : "NO_REPLY",
      },
    }));
    await replaceTranscriptEvents(readScope, [
      { type: "session", version: 3, id: readScope.sessionId },
      ...events,
    ]);
    await waitForSessionTranscriptProjection(readScope);

    let projectedRows = 0;
    const project = chatDisplayProjection.projectChatDisplayMessagesWithState;
    const projectionSpy = vi
      .spyOn(chatDisplayProjection, "projectChatDisplayMessagesWithState")
      .mockImplementation((messages, options) => {
        projectedRows += messages.length;
        return project(messages, options);
      });
    try {
      const tail = await readIncrementalChatHistoryTail({
        readers: sessionTranscriptReaders,
        entry: undefined,
        readScope,
        effectiveMaxChars: 8_000,
        max: 25,
        maxBytes: 1024 * 1024,
        offset: 0,
        readOnly: true,
        deferProfileDisplay: true,
      });

      expect(tail.readPage.totalMessages).toBe(events.length);
      expect(tail.projected.map(readChatHistoryMessageSeq)).toEqual(
        Array.from({ length: 25 }, (_, index) => (index + 5) * 50 + 1),
      );
      expect(projectedRows).toBeGreaterThan(0);
      expect(projectedRows).toBeLessThanOrEqual(events.length * 2);
    } finally {
      projectionSpy.mockRestore();
    }
  });
});

it("does not serialize transcript batches when the extended sparse byte guard is unused", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionId = "history-byte-accounting";
    const readScope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath: `${state.sessionsDir()}/sessions.json`,
    };
    // Wide records exceed the initial 1 MiB byte cap, so the ordinary window
    // needs additional pages even though it stays below the message-count limit.
    const events = Array.from({ length: 400 }, (_, index) => ({
      type: "message",
      id: `row-${index}`,
      parentId: index === 0 ? null : `row-${index - 1}`,
      message: {
        role: "toolResult",
        toolName: "exec",
        toolCallId: `call-${index}`,
        content: [{ type: "text", text: "output ".repeat(600) }],
      },
    }));
    await replaceTranscriptEvents(readScope, [
      { type: "session", version: 3, id: sessionId },
      ...events,
    ]);

    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const tail = await readIncrementalChatHistoryTail({
        readers: sessionTranscriptReaders,
        entry: undefined,
        readScope,
        effectiveMaxChars: 8000,
        max: 800,
        maxBytes: 1024,
      });
      expect(tail.readPage.messages.length).toBeLessThan(events.length);
      expect(tail.rawPageMessages).toBe(events.length);
      expect(tail.projected).toHaveLength(events.length);
      expect(tail.projected.at(-1)).toMatchObject({ __openclaw: { id: "row-399", seq: 400 } });
      const serializedRows = stringify.mock.calls.reduce(
        (count, [value]) =>
          count + (Array.isArray(value) && asOptionalRecord(value[0])?.role ? value.length : 0),
        0,
      );
      expect(serializedRows).toBe(0);
    } finally {
      stringify.mockRestore();
    }
  });
});
