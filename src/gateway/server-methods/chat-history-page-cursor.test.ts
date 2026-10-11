import { createHash } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadTranscriptEvents,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { serializeGatewayFrame } from "../serialized-json.js";
import { readChatHistoryMessageId } from "../session-history-tail.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import type { RespondFn } from "./types.js";

const scope = {
  agentId: "main",
  sessionKey: "agent:main:anchored-page-cursor",
  sessionId: "anchored-page-cursor",
};

async function seedHistory(
  messages: Record<string, unknown>[],
  entryOptions: { sessionStartedAt?: number } = {},
) {
  await upsertSessionEntryCore(scope, {
    sessionId: scope.sessionId,
    updatedAt: 1,
    ...entryOptions,
  });
  await replaceTranscriptEvents(scope, [
    { type: "session", version: 3, id: scope.sessionId },
    ...messages.map((message, index) => ({
      type: "message",
      id: `message-${index}`,
      parentId: index > 0 ? `message-${index - 1}` : null,
      message,
    })),
  ]);
  const context = await createHistoryReadContext();
  const send = async (params: Record<string, unknown>) => {
    const respond = vi.fn<RespondFn>();
    await expectDefined(
      chatHistoryHandlers["chat.history"],
      "history handler",
    )({
      params: { sessionKey: scope.sessionKey, ...params },
      context,
      req: { type: "req", id: "anchored-page-cursor", method: "chat.history" },
      client: null,
      acceptsSerializedJson: true,
      isWebchatConnect: () => false,
      respond,
    });
    expect(respond).toHaveBeenCalledTimes(1);
    return respond.mock.calls[0]!;
  };
  const read = async (params: Record<string, unknown>) => {
    const [ok, payload, error] = await send(params);
    expect(error).toBeUndefined();
    expect(ok).toBe(true);
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

describe("source-bound chat history page cursors", () => {
  it("walks both sides of a byte-limited anchor without gaps and rejects replaced transcripts", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { read, send } = await seedHistory(
        Array.from({ length: 13 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: `Message ${index}: ${"x".repeat(100_000)}`,
        })),
      );
      const transcriptHash = async () =>
        createHash("sha256")
          .update(JSON.stringify(await loadTranscriptEvents(scope)))
          .digest("hex");
      const before = await transcriptHash();
      const initial = await read({ messageId: "message-6", limit: 13, maxChars: 200_000 });
      const initialIds = messageIds(initial);
      expect(initialIds).toContain("message-6");
      expect(initial.olderCursor).toEqual(expect.any(String));
      expect(initial.newerCursor).toEqual(expect.any(String));
      const seen = new Set(initialIds);
      for (const direction of ["olderCursor", "newerCursor"] as const) {
        let page = initial;
        const used = new Set<string>();
        while (typeof page[direction] === "string") {
          const cursor = page[direction];
          expect(used.has(cursor)).toBe(false);
          used.add(cursor);
          expect(used.size).toBeLessThan(13);
          page = await read({ cursor, limit: 13, maxChars: 200_000, maxBytes: 2_000_000 });
          for (const id of messageIds(page)) {
            expect(seen.has(id)).toBe(false);
            seen.add(id);
          }
        }
      }
      expect(seen).toEqual(new Set(Array.from({ length: 13 }, (_, index) => `message-${index}`)));
      expect(await transcriptHash()).toBe(before);

      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:unrelated" },
        { sessionId: "unrelated", updatedAt: 1 },
      );
      const [ok, , error] = await send({
        sessionKey: "agent:main:unrelated",
        cursor: initial.olderCursor,
      });
      expect(ok).toBe(false);
      expect(error).toMatchObject({
        code: "INVALID_REQUEST",
        message: "sessionId does not belong to sessionKey",
      });

      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: scope.sessionId },
        {
          type: "message",
          id: "message-4",
          parentId: null,
          message: { role: "user", content: "A different transcript generation" },
        },
      ]);
      expect(await read({ cursor: initial.olderCursor })).toMatchObject({
        messages: [],
        windowReset: true,
      });
    });
  });

  it.each(
    (["olderCursor", "newerCursor"] as const).flatMap((direction) =>
      (["display flags", "stale announce pairs"] as const).map((hiddenBy) => ({
        direction,
        hiddenBy,
      })),
    ),
  )(
    "$direction advances through pages hidden by $hiddenBy with a one-message limit",
    async ({ direction, hiddenBy }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const announcePair = hiddenBy === "stale announce pairs";
        const { read } = await seedHistory(
          [
            { role: "user", content: "First visible message" },
            announcePair
              ? {
                  role: "user",
                  content: "Old worker announcement",
                  timestamp: 1000,
                  provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
                }
              : { role: "assistant", content: "Hidden one", display: false },
            announcePair
              ? { role: "assistant", content: "Old paired reply", timestamp: 1500 }
              : { role: "assistant", content: "Hidden two", display: false },
            { role: "assistant", content: "Last visible message", timestamp: 3000 },
          ],
          { sessionStartedAt: 2000 },
        );
        const older = direction === "olderCursor";
        let page = await read({ messageId: older ? "message-3" : "message-0", limit: 1 });
        expect(messageIds(page)).toEqual([older ? "message-3" : "message-0"]);
        const used = new Set<string>();
        const seen: Array<string | undefined> = [];
        let emptyPages = 0;
        while (typeof page[direction] === "string") {
          const cursor = page[direction];
          expect(used.has(cursor)).toBe(false);
          used.add(cursor);
          expect(used.size).toBeLessThan(5);
          page = await read({ cursor, limit: 1 });
          const ids = messageIds(page);
          emptyPages += ids.length === 0 ? 1 : 0;
          seen.push(...ids);
        }
        expect(emptyPages).toBe(2);
        expect(seen).toEqual([older ? "message-0" : "message-3"]);
      });
    },
  );

  it("stays in the retained reset interval after the live session advances", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { read, send } = await seedHistory([
        { role: "user", content: "Retained start" },
        { role: "assistant", content: "Retained anchor" },
        { role: "user", content: "Retained end" },
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
        const [ok, , error] = await send({ cursor });
        expect(ok).toBe(false);
        expect(error).toMatchObject({
          code: "INVALID_REQUEST",
          message: "invalid history page cursor",
        });
      }
    });
  });

  it("keeps recovery context when an older cursor excludes the successful boundary reply", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { read } = await seedHistory([
        { role: "user", content: "Question" },
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Temporary provider failure",
          __openclaw: { runId: "recovered-run" },
        },
        {
          role: "assistant",
          content: "Recovered answer",
          stopReason: "stop",
          __openclaw: { runId: "recovered-run" },
        },
      ]);
      const initial = await read({ messageId: "message-2", limit: 1 });
      const recovered = await read({ cursor: initial.olderCursor, limit: 1 });
      expect(messageIds(recovered)).toEqual([]);
      expect(messageIds(await read({ cursor: recovered.olderCursor, limit: 1 }))).toEqual([
        "message-0",
      ]);
    });
  });
});
