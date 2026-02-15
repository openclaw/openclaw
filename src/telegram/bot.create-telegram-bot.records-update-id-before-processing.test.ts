import { describe, expect, it, vi } from "vitest";
import { getLoadConfigMock, middlewareUseSpy } from "./bot.create-telegram-bot.test-harness.js";
import { createTelegramBot } from "./bot.js";

const loadConfig = getLoadConfigMock();

describe("createTelegramBot", () => {
  it("records update id before processing (before next())", async () => {
    middlewareUseSpy.mockReset();

    const onUpdateId = vi.fn();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"] },
      },
    });

    createTelegramBot({
      token: "tok",
      updateOffset: { onUpdateId },
    });

    // Find the middleware that calls recordUpdateId.
    // It is the middleware registered via bot.use that accepts (ctx, next).
    const middlewares = middlewareUseSpy.mock.calls
      .map((call) => call[0])
      .filter((fn) => typeof fn === "function" && fn.length === 2);

    // Track the order of operations
    const order: string[] = [];

    const ctx = {
      update: { update_id: 500 },
      message: {
        chat: { id: 1, type: "private" },
        from: { id: 1, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_id: 1,
      },
    };

    const mockNext = vi.fn(async () => {
      order.push("next");
    });

    onUpdateId.mockImplementation(() => {
      order.push("onUpdateId");
    });

    // Invoke each two-arg middleware; the one that triggers onUpdateId
    // is the logging/recordUpdateId middleware.
    for (const mw of middlewares) {
      onUpdateId.mockClear();
      order.length = 0;
      mockNext.mockClear();
      await mw(ctx, mockNext);
      if (onUpdateId.mock.calls.length > 0) {
        break;
      }
    }

    expect(onUpdateId).toHaveBeenCalledWith(500);
    expect(order).toEqual(["onUpdateId", "next"]);
  });
});
