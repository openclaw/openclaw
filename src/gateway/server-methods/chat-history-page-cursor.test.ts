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

it("walks both sides of a byte-limited anchor without gaps and rejects replaced transcripts", async () => {
  await withHistoryState(async () => {
    const { read, send } = await seedHistory(
      Array.from({ length: 13 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `Message ${index}: ${"x".repeat(100_000)}`,
      })),
    );
    const before = await loadTranscriptEvents(scope);
    const initial = await read({ messageId: "message-6", limit: 13, maxChars: 200_000 });
    const initialIds = messageIds(initial);
    expect(initialIds).toContain("message-6");
    expect(initial).toMatchObject({
      olderCursor: expect.any(String),
      newerCursor: expect.any(String),
    });
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
});

it.each([
  ["olderCursor", "display flags"],
  ["olderCursor", "stale announce pairs"],
  ["newerCursor", "display flags"],
  ["newerCursor", "stale announce pairs"],
] as const)(
  "%s advances through pages hidden by %s with a one-message limit",
  async (direction, hiddenBy) => {
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
      const page = await read({ messageId: older ? "message-3" : "message-0", limit: 1 });
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
