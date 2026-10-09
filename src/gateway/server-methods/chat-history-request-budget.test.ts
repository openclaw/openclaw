import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  appendTranscriptMessage,
  appendTranscriptMessages,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { serializeGatewayFrame } from "../serialized-json.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { chatMessageGetHandlers } from "./chat-message-get-handler.js";

function createHistoryRequest(
  method: "chat.history" | "chat.startup" | "chat.message.get",
  sessionKey: string,
  context: Awaited<ReturnType<typeof createHistoryReadContext>>,
) {
  return async (params: Record<string, unknown>) => {
    let result: unknown;
    await expectDefined(
      (method === "chat.message.get" ? chatMessageGetHandlers : chatHistoryHandlers)[method],
      "history handler",
    )({
      params: { sessionKey, ...(method === "chat.message.get" ? {} : { limit: 80 }), ...params },
      context,
      req: { type: "req", id: "budgeted-history", method },
      client: null,
      acceptsSerializedJson: true,
      isWebchatConnect: () => false,
      respond: (ok, payload, error) => {
        expect(error).toBeUndefined();
        expect(ok).toBe(true);
        result = JSON.parse(serializeGatewayFrame({ type: "res", payload }).toString()).payload;
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
        const unchanged = await request({ cursor: tail.deltaCursor });
        expect(unchanged).toMatchObject({
          kind: "delta",
          messages: [],
          deltaCursor: tail.deltaCursor,
        });
        expect(Buffer.byteLength(JSON.stringify(unchanged))).toBeLessThan(2 * 1024);
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
        expect(single.messages).toContainEqual(
          expect.objectContaining({
            __openclaw: expect.objectContaining({ truncated: true, reason: "oversized" }),
          }),
        );
        expect(Buffer.byteLength(JSON.stringify(single.messages))).toBeLessThanOrEqual(64 * 1024);
        expect(single.hasMore).toBe(false);
      });
    },
  );

  it("bounds default older-history responses below 1 MB without losing messages", async () => {
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
      let pages = 0;
      for (;;) {
        const page = await request({ limit: 1000, offset });
        const messages = expectDefined(
          Array.isArray(page.messages) ? page.messages : undefined,
          "older-history messages",
        );
        expect(messages.length).toBeGreaterThan(0);
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1_000_000);
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

  it("replaces an indivisible source row with a fetchable reference across anchored and back-scroll pages", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:history-sibling-budget",
        sessionId: "history-sibling-budget",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await appendTranscriptMessage(scope, {
        message: { role: "user", content: "Before the sibling group" },
      });
      const texts = Array.from(
        { length: 10 },
        (_, index) => `sibling-${index}: ${"x".repeat(60_000)}`,
      );
      await appendTranscriptMessage(scope, {
        eventId: "sibling-group",
        message: {
          role: "assistant",
          content: [
            ...texts.map((text, index) => ({
              type: "text",
              text,
              textSignature: JSON.stringify({ v: 1, id: `sibling-${index}`, phase: "commentary" }),
            })),
            {
              type: "text",
              text: "Short final answer",
              textSignature: JSON.stringify({ v: 1, id: "final", phase: "final_answer" }),
            },
          ],
        },
      });
      await appendTranscriptMessage(scope, {
        message: { role: "user", content: "After the sibling group" },
      });
      const context = await createHistoryReadContext();
      const request = createHistoryRequest("chat.history", scope.sessionKey, context);
      const getMessage = createHistoryRequest("chat.message.get", scope.sessionKey, context);
      const original = await loadTranscriptEvents(scope);

      const anchored = await request({ messageId: "sibling-group", maxChars: 100_000 });
      expect(Buffer.byteLength(JSON.stringify(anchored))).toBeLessThan(1_000_000);
      expect(anchored.messages).toContainEqual(
        expect.objectContaining({
          __openclaw: expect.objectContaining({
            id: "sibling-group",
            truncated: true,
            reason: "oversized",
          }),
        }),
      );
      expect(anchored.nextOffset).toBeUndefined();

      const recovered = await getMessage({ messageId: "sibling-group", maxChars: 8_000_000 });
      expect(recovered.ok).toBe(true);
      for (const text of texts) {
        expect(JSON.stringify(recovered.message)).toContain(text);
      }
      const truncated = await getMessage({ messageId: "sibling-group", maxChars: 1000 });
      expect(truncated).toMatchObject({
        ok: true,
        message: { __openclaw: { truncated: true, reason: "display-cap" } },
      });
      expect(JSON.stringify(truncated.message)).toContain("Short final answer");
      const expected = ["Before the sibling group", "sibling-group", "After the sibling group"];
      const seen = new Set<string>();
      let offset: number | undefined;
      for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
        const page = await request({
          maxChars: 100_000,
          ...(offset === undefined ? {} : { offset }),
        });
        const serialized = JSON.stringify(page.messages);
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1_000_000);
        for (const text of expected) {
          if (serialized.includes(text)) {
            seen.add(text);
          }
        }
        if (page.hasMore !== true) {
          expect(seen.size).toBe(expected.length);
          expect(await loadTranscriptEvents(scope)).toEqual(original);
          return;
        }
        const nextOffset = expectDefined(
          typeof page.nextOffset === "number" ? page.nextOffset : undefined,
          "advancing source-row offset",
        );
        expect(nextOffset).toBeGreaterThan(offset ?? 0);
        offset = nextOffset;
      }
      throw new Error("History did not finish within its three source rows");
    });
  });

  it("keeps a 5 MB tool result out of history while its reference returns every byte", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:large-tool",
        sessionId: "large-tool",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const text = "tool-output:" + "x".repeat(5_000_000);
      await appendTranscriptMessage(scope, {
        eventId: "large-result",
        message: {
          role: "toolResult",
          toolName: "read",
          toolCallId: "large-call",
          content: [{ type: "text", text }],
        },
      });
      const original = await loadTranscriptEvents(scope);
      const context = await createHistoryReadContext();
      const history = createHistoryRequest("chat.history", scope.sessionKey, context);
      for (const selector of [{}, { messageId: "large-result" }]) {
        const page = await history({ ...selector, maxChars: 500_000 });
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1_000_000);
        expect(page.messages).toMatchObject([
          { toolCallId: "large-call", __openclaw: { id: "large-result", truncated: true } },
        ]);
      }
      const recovered = await createHistoryRequest(
        "chat.message.get",
        scope.sessionKey,
        context,
      )({ messageId: "large-result", maxChars: 8_000_000 });
      expect(recovered).toMatchObject({ ok: true, message: { content: [{ type: "text", text }] } });
      expect(await loadTranscriptEvents(scope)).toEqual(original);
    });
  });

  it("keeps recovery lookahead beyond the default response target on older pages", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:history-recovery-budget",
        sessionId: "history-recovery-budget",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const progress = Array.from({ length: 7 }, (_, index) => ({
        eventId: `progress-${index}`,
        message: {
          role: "toolResult",
          toolCallId: `tool-${index}`,
          toolName: "read",
          content: "x".repeat(90_000),
        },
      }));
      await appendTranscriptMessages(scope, {
        messages: [
          { eventId: "question", message: { role: "user", content: "Question" } },
          {
            eventId: "failed",
            message: {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "The selected model is unavailable.",
              __openclaw: { runId: "recovered-run" },
            },
          },
          ...progress,
          {
            eventId: "answer",
            message: {
              role: "assistant",
              content: "Recovered answer",
              stopReason: "stop",
              __openclaw: { runId: "recovered-run" },
            },
          },
        ],
      });
      const request = createHistoryRequest(
        "chat.history",
        scope.sessionKey,
        await createHistoryReadContext(),
      );

      const older = await request({ offset: progress.length + 1, limit: 1 });
      expect(older.messages).toMatchObject([{ role: "user", __openclaw: { id: "question" } }]);
      expect(older.messages).toHaveLength(1);
      expect(older.hasMore).toBe(false);
    });
  });
});
