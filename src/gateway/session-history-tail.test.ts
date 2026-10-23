import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import * as chatDisplayProjection from "./chat-display-projection.core.js";
import { readChatHistoryPageKernel } from "./server-methods/chat-history-page-kernel.js";
import { prepareChatHistoryResponsePage } from "./server-methods/chat-history-response-page.js";
import {
  expectMessageIds,
  historyTarget,
  messageEvent,
  withHistoryState,
} from "./session-history-events.test-support.js";
import {
  readChatHistoryMessageSeq,
  readIncrementalChatHistoryTail,
} from "./session-history-tail.js";
import * as sessionTranscriptReaders from "./session-transcript-readers.js";

const tailDefaults = {
  readers: sessionTranscriptReaders,
  entry: undefined,
  effectiveMaxChars: 8_000,
  max: 1,
  maxBytes: 1024 * 1024,
};

function recordingReaders(record: (page: { messages: unknown[] }) => void) {
  return {
    ...sessionTranscriptReaders,
    readRecentSessionMessagesWithStatsAsync: async (
      ...args: Parameters<typeof sessionTranscriptReaders.readRecentSessionMessagesWithStatsAsync>
    ) => {
      const page = await sessionTranscriptReaders.readRecentSessionMessagesWithStatsAsync(...args);
      record(page);
      return page;
    },
    readSessionMessagesPageWithStatsAsync: async (
      ...args: Parameters<typeof sessionTranscriptReaders.readSessionMessagesPageWithStatsAsync>
    ) => {
      const page = await sessionTranscriptReaders.readSessionMessagesPageWithStatsAsync(...args);
      record(page);
      return page;
    },
  };
}

it.each([
  { offset: 0, hiddenHead: 0 },
  { offset: 20, hiddenHead: 160 },
])(
  "stops a byte-full history page before reading the remaining rows ($offset, $hiddenHead)",
  async ({ offset, hiddenHead }) => {
    await withHistoryState(async (state) => {
      const scope = historyTarget(state, "byte-full-history");
      const events = Array.from({ length: 400 }, (_, index) =>
        messageEvent(
          `row-${index}`,
          index >= 400 - hiddenHead
            ? {
                role: "assistant",
                content: "NO_REPLY",
                providerMetadata: { trace: "x".repeat(7_000) },
              }
            : { role: "user", content: `record-${index}: ${"x".repeat(7_000)}` },
          index === 0 ? null : `row-${index - 1}`,
        ),
      );
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: scope.sessionId },
        ...events,
      ]);
      await waitForSessionTranscriptProjection(scope);
      let readRows = 0;
      const readers = recordingReaders((page) => {
        readRows += page.messages.length;
      });
      const params = {
        entry: undefined,
        provider: undefined,
        sessionId: scope.sessionId,
        storePath: scope.storePath,
        sessionAgentId: scope.agentId,
        canonicalKey: scope.sessionKey,
        max: 1_000,
        maxHistoryBytes: 6 * 1024 * 1024,
        responseHistoryBytes: 512 * 1024,
        effectiveMaxChars: 8_000,
        offset,
        messageId: undefined,
      };
      const page = await readChatHistoryPageKernel(params, { readers, readOnly: true });
      const response = prepareChatHistoryResponsePage(page, params);
      // A full response needs less than one source chunk, independent of the requested count.
      expect(readRows).toBeLessThan(hiddenHead ? 300 : 200);
      expect(response.messages.length).toBeGreaterThan(50);
      expect(response.messagesBytes).toBeLessThanOrEqual(params.responseHistoryBytes);
      expect(response.hasMore).toBe(true);
      const first = 400 - Math.max(offset, hiddenHead) - response.messages.length;
      expectMessageIds(
        response.messages,
        Array.from({ length: response.messages.length }, (_, index) => `row-${first + index}`),
      );
      expect(response.nextOffset).toBe(Math.max(offset, hiddenHead) + response.messages.length);
    });
  },
);

it("applies the head byte budget before loading an older malformed row", async () => {
  await withHistoryState(async (state) => {
    const readScope = historyTarget(state, "head-cursor-byte-budget");
    const newestText = "x".repeat(1024 * 1024 + 1);
    await replaceTranscriptEvents(readScope, [
      { type: "session", version: 3, id: readScope.sessionId },
      messageEvent("older", { role: "user", content: "Old question" }),
      messageEvent("newest", { role: "assistant", content: newestText }, "older"),
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
      ...tailDefaults,
      readScope,
      beforeSeq: 99,
      preserveProjectionContext: true,
      maxBytes: 1024,
    });

    expect(tail.readPage.totalMessages).toBe(2);
    expect(tail.rawMessages).toMatchObject([
      { content: newestText, __openclaw: { id: "newest", seq: 2 } },
    ]);
    expectMessageIds(tail.projected, ["newest"]);
  });
});

it("keeps a sparse tail below its first snapshot when messages append between pages", async () => {
  await withHistoryState(async (state) => {
    const readScope = historyTarget(state, "sparse-tail-append");
    const ids = Array.from({ length: 101 }, (_, index) => `row-${index + 1}`);
    await replaceTranscriptEvents(readScope, [
      { type: "session", version: 3, id: readScope.sessionId },
      ...ids.map((id, index) =>
        messageEvent(
          id,
          index === 0
            ? { role: "user", content: "Original question" }
            : { role: "assistant", content: "NO_REPLY" },
          ids[index - 1] ?? null,
        ),
      ),
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
        ...tailDefaults,
        readScope,
      });

      expect(await sessionTranscriptReaders.readSessionMessageCountAsync(readScope)).toBe(103);
      expectMessageIds(tail.rawMessages, ids);
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
  await withHistoryState(async (state) => {
    const readScope = historyTarget(state, "sparse-tail-projection-work");
    const events = Array.from({ length: 1_500 }, (_, index) =>
      messageEvent(
        `row-${index}`,
        {
          role: index % 50 === 0 ? "user" : "assistant",
          content: index % 50 === 0 ? `visible ${index / 50}` : "NO_REPLY",
        },
        index === 0 ? null : `row-${index - 1}`,
      ),
    );
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
        ...tailDefaults,
        readScope,
        max: 25,
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
  await withHistoryState(async (state) => {
    const sessionId = "history-byte-accounting";
    const readScope = historyTarget(state, sessionId);
    // Wide records exceed the initial 1 MiB byte cap, so the ordinary window
    // needs additional pages even though it stays below the message-count limit.
    const events = Array.from({ length: 400 }, (_, index) =>
      messageEvent(
        `row-${index}`,
        {
          role: "toolResult",
          toolName: "exec",
          toolCallId: `call-${index}`,
          content: [{ type: "text", text: "output ".repeat(600) }],
        },
        index === 0 ? null : `row-${index - 1}`,
      ),
    );
    await replaceTranscriptEvents(readScope, [
      { type: "session", version: 3, id: sessionId },
      ...events,
    ]);

    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const tail = await readIncrementalChatHistoryTail({
        ...tailDefaults,
        readScope,
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

it.each(["offset", "sparse"] as const)(
  "preserves ordered %s history while bounding each wide transcript read",
  async (kind) => {
    await withHistoryState(async (state) => {
      const readScope = historyTarget(state, `bounded-wide-${kind}`);
      // Stay below the 4 MiB asynchronous rebuild threshold; this fixture tests reader chunking.
      const ids = Array.from({ length: 18 }, (_, index) => `row-${index}`);
      await replaceTranscriptEvents(readScope, [
        { type: "session", version: 3, id: readScope.sessionId },
        ...ids.map((id, index) =>
          messageEvent(
            id,
            {
              role: kind === "sparse" && index > 0 ? "assistant" : "user",
              content: kind === "sparse" && index > 0 ? "NO_REPLY" : `Visible ${index}`,
              providerMetadata: { trace: "x".repeat(index === 12 ? 1024 * 1024 + 1 : 128 * 1024) },
            },
            ids[index - 1] ?? null,
          ),
        ),
      ]);
      await waitForSessionTranscriptProjection(readScope);
      const pages: Array<{ bytes: number; rows: number }> = [];
      const readers = recordingReaders((page) => {
        pages.push({
          bytes: page.messages.reduce<number>(
            (bytes, message) => bytes + Buffer.byteLength(JSON.stringify(message)) + 1,
            0,
          ),
          rows: page.messages.length,
        });
      });
      const tail = await readIncrementalChatHistoryTail({
        ...tailDefaults,
        readers,
        readScope,
        max: kind === "sparse" ? 1 : ids.length,
        ...(kind === "offset" ? { offset: 1 } : {}),
        readOnly: true,
        deferProfileDisplay: true,
      });
      const expected = kind === "offset" ? ids.slice(0, -1) : ids;
      expectMessageIds(tail.rawMessages, expected);
      expect(tail.rawPageMessages).toBe(expected.length);
      expect(tail.readPage.totalMessages).toBe(ids.length);
      expectMessageIds(tail.projected, kind === "sparse" ? [ids[0]] : expected);
      expect(pages.length).toBeGreaterThan(1);
      expect(pages.some((page) => page.bytes > 1024 * 1024)).toBe(true);
      expect(pages.every((page) => page.bytes <= 1024 * 1024 || page.rows === 1)).toBe(true);
    });
  },
);
