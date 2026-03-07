import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

describe("buildTelegramMessageContext sender prefix", () => {
  async function buildCtx(params: { messageId: number; options?: Record<string, unknown> }) {
    return await buildTelegramMessageContextForTest({
      message: {
        message_id: params.messageId,
        chat: { id: -99, type: "supergroup", title: "Dev Chat" },
        date: 1700000000,
        text: "hello",
        from: { id: 42, first_name: "Alice" },
      },
      options: params.options,
    });
  }

  it("prefixes group bodies with sender label", async () => {
    const ctx = await buildCtx({ messageId: 1 });

    expect(ctx).not.toBeNull();
    const body = ctx?.ctxPayload?.Body ?? "";
    expect(body).toContain("Alice (42): hello");
  });

  it("sets MessageSid from message_id", async () => {
    const ctx = await buildCtx({ messageId: 12345 });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.MessageSid).toBe("12345");
  });

  it("respects messageIdOverride option", async () => {
    const ctx = await buildCtx({
      messageId: 12345,
      options: { messageIdOverride: "67890" },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.MessageSid).toBe("67890");
  });
});
