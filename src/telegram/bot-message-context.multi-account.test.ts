import { describe, expect, it } from "vitest";
import {
  baseTelegramMessageContextConfig,
  buildTelegramMessageContextForTest,
} from "./bot-message-context.test-harness.js";

describe("buildTelegramMessageContext multi-account defaults", () => {
  it("drops non-default account DMs when fallback route would use dmScope=main", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      accountId: "jarvis2",
      message: {
        chat: { id: 99_001, type: "private" },
        from: { id: 41, first_name: "Guido" },
        text: "/ping",
      },
    });

    expect(ctx).toBeNull();
  });

  it("allows non-default account DMs without explicit bindings when dmScope is account-isolated", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      accountId: "jarvis2",
      cfg: {
        ...structuredClone(baseTelegramMessageContextConfig),
        session: { dmScope: "per-account-channel-peer" },
      },
      message: {
        chat: { id: 99_001, type: "private" },
        from: { id: 41, first_name: "Guido" },
        text: "/ping",
      },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.route.accountId).toBe("jarvis2");
  });
});
