import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";

function createHistoryRequest(
  method: "chat.history" | "chat.startup",
  sessionKey: string,
  context: Awaited<ReturnType<typeof createHistoryReadContext>>,
) {
  return async (params: Record<string, unknown>) => {
    let result: unknown;
    await expectDefined(
      chatHistoryHandlers[method],
      "history handler",
    )({
      params: { sessionKey, limit: 80, ...params },
      context,
      req: { type: "req", id: "budgeted-history", method },
      client: null,
      isWebchatConnect: () => false,
      respond: (ok, payload, error) => {
        expect(error).toBeUndefined();
        expect(ok).toBe(true);
        result = payload;
      },
    });
    return expectDefined(asOptionalRecord(result), "history response");
  };
}

describe("chat history request byte budgets", () => {
  it.each(["chat.history", "chat.startup"] as const)(
    "%s returns a small tail with a lossless back-scroll cursor",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:budgeted-history",
          sessionId: "budgeted-history",
        };
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        const messages = Array.from({ length: 12 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content:
            index % 4 === 1
              ? [
                  { type: "toolcall", id: `call-${index}`, name: "Read", arguments: {} },
                  {
                    type: "tool_result",
                    tool_use_id: `call-${index}`,
                    content: `record-${index}: ${"x".repeat(3_000)}`,
                  },
                ]
              : [{ type: "text", text: `record-${index}: ${"x".repeat(3_000)}` }],
        }));
        for (const message of messages) {
          await appendTranscriptMessage(scope, { message });
        }
        const request = createHistoryRequest(
          method,
          scope.sessionKey,
          await createHistoryReadContext(),
        );

        const tail = await request({ maxBytes: 8 * 1024 });
        expect(Buffer.byteLength(JSON.stringify(tail.messages))).toBeLessThanOrEqual(8 * 1024);
        expect(tail.hasMore).toBe(true);
        expect(tail.nextOffset).toBeGreaterThan(0);
        expect(JSON.stringify(tail.messages)).toContain("record-11:");
        const older = await request({ offset: tail.nextOffset });
        expect(older.hasMore).toBe(false);
        const restored = [...(older.messages as unknown[]), ...(tail.messages as unknown[])];
        expect(restored).toHaveLength(messages.length);
        for (const [index, message] of restored.entries()) {
          expect(JSON.stringify(message)).toContain(`record-${index}:`);
        }

        const longText = "Readable message beyond the soft page budget: " + "z".repeat(70_000);
        await appendTranscriptMessage(scope, {
          message: { role: "assistant", content: [{ type: "text", text: longText }] },
        });
        expect(await request({ cursor: tail.deltaCursor, maxBytes: 8 * 1024 })).toEqual({
          kind: "reset",
        });
        const single = await request({ maxBytes: 64 * 1024, maxChars: 100_000 });
        expect(single.messages).toHaveLength(1);
        expect(JSON.stringify(single.messages)).toContain(longText);
        expect(single.hasMore).toBe(true);
      });
    },
  );

  it("keeps large older-history pages within their target without losing messages", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:large-budgeted-history",
        sessionId: "large-budgeted-history",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const texts = Array.from(
        { length: 320 },
        (_, index) => `record-${index}: ${"x".repeat(7_000)}`,
      );
      for (const [index, text] of texts.entries()) {
        await appendTranscriptMessage(scope, {
          message: {
            role: index % 2 === 0 ? "user" : "assistant",
            content: [{ type: "text", text }],
          },
        });
      }
      const request = createHistoryRequest(
        "chat.history",
        scope.sessionKey,
        await createHistoryReadContext(),
      );
      const tail = await request({ maxBytes: 256 * 1024 });
      const restored: unknown[] = expectDefined(
        Array.isArray(tail.messages) ? tail.messages : undefined,
        "tail messages",
      ).slice();
      let offset = expectDefined(
        typeof tail.nextOffset === "number" ? tail.nextOffset : undefined,
        "older-history offset",
      );
      const defaultPage = await request({ limit: 1000, offset });
      const pageBytes = 512 * 1024;
      expect(Buffer.byteLength(JSON.stringify(defaultPage.messages))).toBeGreaterThan(pageBytes);

      let pages = 0;
      for (;;) {
        const page = await request({ limit: 1000, offset, maxBytes: pageBytes });
        const messages = expectDefined(
          Array.isArray(page.messages) ? page.messages : undefined,
          "older-history messages",
        );
        expect(messages.length).toBeGreaterThan(0);
        expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThanOrEqual(pageBytes);
        restored.unshift(...messages);
        expect(restored.length).toBeLessThanOrEqual(texts.length);
        pages += 1;
        if (page.hasMore !== true) {
          break;
        }
        const nextOffset = expectDefined(
          typeof page.nextOffset === "number" ? page.nextOffset : undefined,
          "advancing older-history offset",
        );
        expect(nextOffset).toBeGreaterThan(offset);
        offset = nextOffset;
      }

      expect(pages).toBeGreaterThan(1);
      expect(restored).toHaveLength(texts.length);
      for (const [index, message] of restored.entries()) {
        expect(JSON.stringify(message)).toContain(texts[index]);
      }
    });
  });
});
