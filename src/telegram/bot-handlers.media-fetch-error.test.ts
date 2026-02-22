/**
 * Regression test for #4662: when Telegram media fetch fails with a non-size
 * error, the user should receive an error reply instead of seeing no response.
 *
 * We test this by verifying the catch block in processInboundMessage sends
 * a sendMessage call when resolveMedia throws a network error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock resolveMedia before the import so it's hoisted correctly
const resolveMediaMock = vi.hoisted(() => vi.fn());

vi.mock("./bot/delivery.js", () => ({
  resolveMedia: resolveMediaMock,
  deliverReplies: vi.fn(),
}));

vi.mock("./api-logging.js", () => ({
  withTelegramApiErrorLogging: vi.fn(async ({ fn }: { fn: () => Promise<unknown> }) => fn()),
}));

vi.mock("./bot-message-context.js", () => ({
  buildTelegramMessageContext: vi.fn().mockResolvedValue(null),
}));

vi.mock("../auto-reply/inbound-debounce.js", () => ({
  resolveInboundDebounceMs: vi.fn().mockReturnValue(0),
}));

vi.mock("../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));

import { withTelegramApiErrorLogging } from "./api-logging.js";

describe("Telegram bot handler: media fetch error reply (#4662)", () => {
  beforeEach(() => {
    resolveMediaMock.mockReset();
    vi.mocked(withTelegramApiErrorLogging).mockReset();
    vi.mocked(withTelegramApiErrorLogging).mockImplementation(async ({ fn }) => fn());
  });

  it("notifies user when media fetch throws a network error", async () => {
    resolveMediaMock.mockRejectedValue(new TypeError("fetch failed"));

    const sendMessage = vi.fn().mockResolvedValue({ message_id: 99 });

    const { registerTelegramHandlers } = await import("./bot-handlers.js");

    const bot = {
      api: { sendMessage },
      on: vi.fn(),
    };

    registerTelegramHandlers({
      cfg: {} as never,
      accountId: "default",
      bot: bot as never,
      opts: {} as never,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      mediaMaxBytes: 10 * 1024 * 1024,
      telegramCfg: {} as never,
      groupAllowFrom: [],
      resolveGroupPolicy: vi.fn().mockReturnValue({ allowlistEnabled: false, allowed: true }),
      resolveTelegramGroupConfig: vi.fn().mockReturnValue({
        groupConfig: undefined,
        topicConfig: undefined,
      }),
      shouldSkipUpdate: vi.fn().mockReturnValue(false),
      processMessage: vi.fn().mockResolvedValue(undefined),
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never,
    });

    // Find the "message" handler registered via bot.on
    const onCalls = (bot.on as ReturnType<typeof vi.fn>).mock.calls;
    const [, messageHandler] = onCalls.find(([event]) => event === "message") ?? [];
    expect(messageHandler).toBeDefined();

    await messageHandler({
      message: {
        message_id: 1,
        chat: { id: 12345, type: "private" },
        from: { id: 999, username: "tester" },
        date: Math.floor(Date.now() / 1000),
        photo: [{ file_id: "f1", file_unique_id: "u1", width: 100, height: 100 }],
      },
      me: { id: 1, username: "bot", is_bot: true, first_name: "Bot" },
    });

    // User should have received an error message
    expect(sendMessage).toHaveBeenCalledWith(
      12345,
      "⚠️ Failed to download media. Please try again.",
      expect.objectContaining({ reply_to_message_id: 1 }),
    );
  });

  it("does NOT send error reply when media fetch succeeds (null = no media)", async () => {
    resolveMediaMock.mockResolvedValue(null);

    const sendMessage = vi.fn().mockResolvedValue({ message_id: 99 });

    const { registerTelegramHandlers } = await import("./bot-handlers.js");

    const bot = {
      api: { sendMessage },
      on: vi.fn(),
    };

    registerTelegramHandlers({
      cfg: {} as never,
      accountId: "default",
      bot: bot as never,
      opts: {} as never,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      mediaMaxBytes: 10 * 1024 * 1024,
      telegramCfg: {} as never,
      groupAllowFrom: [],
      resolveGroupPolicy: vi.fn().mockReturnValue({ allowlistEnabled: false, allowed: true }),
      resolveTelegramGroupConfig: vi.fn().mockReturnValue({
        groupConfig: undefined,
        topicConfig: undefined,
      }),
      shouldSkipUpdate: vi.fn().mockReturnValue(false),
      processMessage: vi.fn().mockResolvedValue(undefined),
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never,
    });

    const onCalls = (bot.on as ReturnType<typeof vi.fn>).mock.calls;
    const [, messageHandler] = onCalls.find(([event]) => event === "message") ?? [];

    await messageHandler({
      message: {
        message_id: 2,
        chat: { id: 12345, type: "private" },
        from: { id: 999, username: "tester" },
        date: Math.floor(Date.now() / 1000),
        text: "hello",
      },
      me: { id: 1, username: "bot", is_bot: true, first_name: "Bot" },
    });

    // No error-reply call expected
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("Failed to download"),
      expect.anything(),
    );
  });
});
