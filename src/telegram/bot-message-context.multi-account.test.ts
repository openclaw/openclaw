import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

describe("buildTelegramMessageContext multi-account defaults", () => {
  it("processes inbound DMs for non-default accounts without explicit bindings", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      accountId: "jarvis2",
      message: {
        chat: { id: 99_001, type: "private" },
        from: { id: 41, first_name: "Guido" },
        text: "/ping",
      },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.route.accountId).toBe("jarvis2");
  });

  it("routes non-default account DMs without relying on account enabled flags", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      accountId: "jarvis2",
      message: {
        chat: { id: 99_002, type: "private" },
        from: { id: 42, first_name: "Guido" },
        text: "/ping",
      },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.route.accountId).toBe("jarvis2");
  });
});
