import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../config/config.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { serializeGatewayFrame } from "../serialized-json.js";
import { readChatHistoryMessageId } from "../session-history-tail.js";
import {
  expectHistoryError,
  historyPayload,
  historyRpc,
  seedHistorySession,
  seedHistoryTranscript,
  withHistoryState,
} from "./chat-history-fixture.test-support.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";

const scope = {
  agentId: "main",
  sessionKey: "agent:main:anchored-page-cursor",
  sessionId: "anchored-page-cursor",
};
const makeMessage = (content: string, extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content,
  ...extra,
});

async function seedHistory(
  messages: Record<string, unknown>[],
  entryOptions: { sessionStartedAt?: number } = {},
) {
  await captureRuntimeConfigAsyncReader()();
  await seedHistorySession(scope.sessionId, entryOptions);
  await seedHistoryTranscript(
    scope,
    messages.map((message, index) => [`message-${index}`, message]),
  );
  const context = await createHistoryReadContext();
  const request = historyRpc(context, scope.sessionKey);
  const send = (params: Record<string, unknown>) =>
    request("chat.history", params, { acceptsSerializedJson: true });
  const read = async (params: Record<string, unknown>) => {
    const response = await request("chat.history", params, { acceptsSerializedJson: true });
    const payload = historyPayload(response);
    const frame = serializeGatewayFrame({ type: "res", payload }).toString();
    expect(Buffer.byteLength(frame)).toBeLessThan(1_000_000);
    return expectDefined(asOptionalRecord(JSON.parse(frame).payload), "history response");
  };
  return { send, read };
}

function messageIds(page: Record<string, unknown>) {
  expect(Array.isArray(page.messages)).toBe(true);
  return (page.messages as unknown[]).map(readChatHistoryMessageId);
}

async function walkPages(
  initial: Record<string, unknown>,
  direction: "olderCursor" | "newerCursor",
  read: Awaited<ReturnType<typeof seedHistory>>["read"],
  params: Record<string, unknown>,
  maxPages: number,
) {
  const used = new Set<string>();
  const ids: Array<string | undefined> = [];
  let emptyPages = 0;
  let page = initial;
  while (typeof page[direction] === "string") {
    const cursor = page[direction];
    expect(used.has(cursor)).toBe(false);
    used.add(cursor);
    expect(used.size).toBeLessThan(maxPages);
    page = await read({ cursor, ...params });
    const next = messageIds(page);
    emptyPages += Number(next.length === 0);
    ids.push(...next);
  }
  return { ids, emptyPages };
}

it("keeps every source fragment when a one-message tail is followed by older history", async () => {
  await withHistoryState(async () => {
    const segment = (id: string, text: string, phase: string) => ({
      type: "text",
      text,
      textSignature: JSON.stringify({ v: 1, id, phase }),
    });
    const { read } = await seedHistory([
      { role: "user", content: "Earlier question" },
      {
        role: "assistant",
        content: [
          segment("fragment-a", "Commentary A", "commentary"),
          segment("fragment-b", "Commentary B", "commentary"),
          segment("final", "Final answer", "final_answer"),
        ],
      },
    ]);
    const tail = await read({ limit: 1 });
    expect(tail.nextOffset).toBe(1);
    const older = await read({ offset: tail.nextOffset, limit: 1 });
    expect(tail.messages).toMatchObject([
      {
        role: "assistant",
        content: [{ type: "text", text: "Commentary A" }],
        openclawStreamFallback: { itemId: "fragment-a" },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Commentary B" }],
        openclawStreamFallback: { itemId: "fragment-b" },
      },
      { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
    ]);
    expect(older.messages).toMatchObject([{ role: "user", content: "Earlier question" }]);
    expect(older.hasMore).toBe(false);
  });
});

it.each(["anchor", "tail", "offset"] as const)(
  "walks both sides of a byte-limited %s page without gaps and rejects replaced transcripts",
  async (selector) => {
    await withHistoryState(async () => {
      const { read, send } = await seedHistory(
        Array.from({ length: 13 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: `Message ${index}: ${"x".repeat(100_000)}`,
        })),
      );
      const before = await loadTranscriptEvents(scope);
      const initial = await read({
        ...(selector === "anchor"
          ? { messageId: "message-6" }
          : selector === "offset"
            ? { offset: 4 }
            : {}),
        limit: 13,
        maxChars: 200_000,
      });
      const initialIds = messageIds(initial);
      expect(initialIds.length).toBeGreaterThan(0);
      expect(initial.olderCursor).toEqual(expect.any(String));
      if (selector === "anchor") {
        expect(initialIds).toContain("message-6");
      }
      expect(Boolean(initial.newerCursor)).toBe(selector !== "tail");
      const seen = [...initialIds];
      for (const direction of ["olderCursor", "newerCursor"] as const) {
        const page = await walkPages(
          initial,
          direction,
          read,
          { limit: 13, maxChars: 200_000, maxBytes: 2_000_000 },
          13,
        );
        seen.push(...page.ids);
      }
      const expectedIds = Array.from({ length: 13 }, (_, index) => `message-${index}`);
      const compareIds = (a: string | undefined, b: string | undefined) =>
        String(a).localeCompare(String(b));
      expect(seen.toSorted(compareIds)).toEqual(expectedIds.toSorted(compareIds));
      expect(await loadTranscriptEvents(scope)).toEqual(before);

      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:unrelated" },
        { sessionId: "unrelated", updatedAt: 1 },
      );
      expectHistoryError(
        await send({
          sessionKey: "agent:main:unrelated",
          cursor: initial.olderCursor,
        }),
        {
          code: "INVALID_REQUEST",
          message: "sessionId does not belong to sessionKey",
        },
      );

      await seedHistoryTranscript(scope, [
        ["message-4", makeMessage("A different transcript generation", { role: "user" })],
      ]);
      expect(await read({ cursor: initial.olderCursor })).toMatchObject({
        messages: [],
        windowReset: true,
      });
    });
  },
);

it.each([false, true])("terminates a hidden prefix with tool-only tail=%s", async (toolOnly) => {
  await withHistoryState(async () => {
    const { read } = await seedHistory([
      ...Array.from({ length: 50 }, () => makeMessage("Hidden", { display: false })),
      ...(toolOnly ? [makeMessage("Synthetic file contents", { role: "toolResult" })] : []),
    ]);
    const tail = await read({ limit: 2 });
    expect(tail).toMatchObject({ hasMore: false });
    expect(tail.messages).toHaveLength(toolOnly ? 1 : 0);
    expect([tail.olderCursor, tail.newerCursor, tail.nextOffset]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});

it.each([undefined, 0, 4])(
  "issues append-stable, reversible cursors for an ordinary offset %s page",
  async (offset) => {
    await withHistoryState(async () => {
      const { read } = await seedHistory(
        Array.from({ length: 9 }, (_, index) =>
          makeMessage(`Message ${index}`, { role: index % 2 ? "assistant" : "user" }),
        ),
      );
      const end = 9 - (offset ?? 0);
      const initial = await read({ limit: 2, ...(offset === undefined ? {} : { offset }) });
      expect(messageIds(initial)).toEqual([`message-${end - 2}`, `message-${end - 1}`]);
      expect(initial.olderCursor).toEqual(expect.any(String));
      expect(Boolean(initial.newerCursor)).toBe((offset ?? 0) > 0);
      await appendTranscriptMessage(scope, {
        eventId: "appended-after-page",
        message: { role: "user", content: "Appended after opening the page" },
      });
      const older = await read({ cursor: initial.olderCursor, limit: 2 });
      expect(messageIds(older)).toEqual([`message-${end - 4}`, `message-${end - 3}`]);
      const reversed = await read({ cursor: older.newerCursor, limit: 2 });
      expect(messageIds(reversed)).toEqual(messageIds(initial));
      const walk = await walkPages(initial, "olderCursor", read, { limit: 2 }, 9);
      expect(walk.ids.toSorted((a, b) => String(a).localeCompare(String(b)))).toEqual(
        Array.from({ length: end - 2 }, (_, index) => `message-${index}`).toSorted(),
      );
    });
  },
);

it.each([
  ["olderCursor", "display flags", false],
  ["olderCursor", "stale announce pairs", false],
  ["newerCursor", "display flags", false],
  ["newerCursor", "stale announce pairs", false],
  ["olderCursor", "display flags", true],
  ["olderCursor", "stale announce pairs", true],
  ["newerCursor", "display flags", true],
  ["newerCursor", "stale announce pairs", true],
] as const)(
  "%s advances through pages hidden by %s with a one-message limit (ordinary=%s)",
  async (direction, hiddenBy, ordinary) => {
    await withHistoryState(async () => {
      const announcePair = hiddenBy === "stale announce pairs";
      const { read } = await seedHistory(
        [
          makeMessage("First visible message", { role: "user" }),
          announcePair
            ? {
                role: "user",
                content: "Old worker announcement",
                timestamp: 1000,
                provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
              }
            : makeMessage("Hidden one", { display: false }),
          announcePair
            ? makeMessage("Old paired reply", { timestamp: 1500 })
            : makeMessage("Hidden two", { display: false }),
          makeMessage("Last visible message", { timestamp: 3000 }),
        ],
        { sessionStartedAt: 2000 },
      );
      const older = direction === "olderCursor";
      const page = await read({
        ...(ordinary
          ? { offset: older ? 0 : 3 }
          : { messageId: older ? "message-3" : "message-0" }),
        limit: 1,
      });
      expect(messageIds(page)).toEqual([older ? "message-3" : "message-0"]);
      expect(await walkPages(page, direction, read, { limit: 1 }, 5)).toEqual({
        emptyPages: 2,
        ids: [older ? "message-0" : "message-3"],
      });
    });
  },
);

it("stays in the retained reset interval after the live session advances", async () => {
  await withHistoryState(async () => {
    const { read, send } = await seedHistory([
      makeMessage("Retained start", { role: "user" }),
      makeMessage("Retained anchor"),
      makeMessage("Retained end", { role: "user" }),
    ]);
    const ordinary = await read({ limit: 1 });
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "closed-reset",
      parentId: "message-2",
      timestamp: "2026-09-30T00:00:00.000Z",
      reason: "new",
    });
    await appendTranscriptMessage(scope, {
      eventId: "fresh-message",
      message: { role: "user", content: "Outside the retained interval" },
    });
    const initial = await read({ messageId: "message-1", limit: 1 });
    await upsertSessionEntryCore(scope, { sessionId: "new-live-session", updatedAt: 2 });
    expect(messageIds(await read({ cursor: ordinary.olderCursor, limit: 1 }))).toEqual([
      "message-1",
    ]);
    for (const [cursor, id] of [
      [initial.olderCursor, "message-0"],
      [initial.newerCursor, "message-2"],
    ]) {
      const page = await read({ cursor, limit: 1 });
      expect(page.sessionId).toBe(scope.sessionId);
      expect(messageIds(page)).toEqual([id]);
      if (id === "message-2") {
        const end = await read({ cursor: page.newerCursor, limit: 1 });
        expect(messageIds(end)).toEqual(["closed-reset"]);
        expect(end.newerCursor).toBeUndefined();
      }
    }
    for (const cursor of ["history-page:not-json", `history-page:${"x".repeat(4096)}`]) {
      expectHistoryError(await send({ cursor }), {
        code: "INVALID_REQUEST",
        message: "invalid history page cursor",
      });
    }
  });
});

it("keeps recovery context when an older cursor excludes the successful boundary reply", async () => {
  await withHistoryState(async () => {
    const { read } = await seedHistory([
      makeMessage("Question", { role: "user" }),
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Temporary provider failure",
        __openclaw: { runId: "recovered-run" },
      },
      makeMessage("Recovered answer", {
        stopReason: "stop",
        __openclaw: { runId: "recovered-run" },
      }),
    ]);
    const initial = await read({ messageId: "message-2", limit: 1 });
    const recovered = await read({ cursor: initial.olderCursor, limit: 1 });
    expect(messageIds(recovered)).toEqual([]);
    expect(messageIds(await read({ cursor: recovered.olderCursor, limit: 1 }))).toEqual([
      "message-0",
    ]);
  });
});
