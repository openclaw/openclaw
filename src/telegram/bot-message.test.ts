import { beforeEach, describe, expect, it, vi } from "vitest";

const buildTelegramMessageContext = vi.hoisted(() => vi.fn());
const dispatchTelegramMessage = vi.hoisted(() => vi.fn());
const triggerInternalHook = vi.hoisted(() => vi.fn());
const createInternalHookEvent = vi.hoisted(() => vi.fn());

vi.mock("./bot-message-context.js", () => ({
  buildTelegramMessageContext,
}));

vi.mock("./bot-message-dispatch.js", () => ({
  dispatchTelegramMessage,
}));

vi.mock("../hooks/internal-hooks.js", () => ({
  triggerInternalHook,
  createInternalHookEvent,
}));

import { createTelegramMessageProcessor } from "./bot-message.js";

describe("telegram bot message processor", () => {
  beforeEach(() => {
    buildTelegramMessageContext.mockReset();
    dispatchTelegramMessage.mockReset();
    triggerInternalHook.mockReset();
    createInternalHookEvent.mockReset();
  });

  const baseDeps = {
    bot: {},
    cfg: {},
    account: {},
    telegramCfg: {},
    historyLimit: 0,
    groupHistories: {},
    dmPolicy: {},
    allowFrom: [],
    groupAllowFrom: [],
    ackReactionScope: "none",
    logger: { warn: vi.fn() },
    resolveGroupActivation: () => true,
    resolveGroupRequireMention: () => false,
    resolveTelegramGroupConfig: () => ({}),
    runtime: {},
    replyToMode: "auto",
    streamMode: "auto",
    textLimit: 4096,
    opts: {},
    resolveBotTopicsEnabled: () => false,
  };

  it("dispatches when context is available", async () => {
    const mockMsg = { chat: { id: 123 }, message_id: 456, date: 1700000000 };
    buildTelegramMessageContext.mockResolvedValue({
      route: { sessionKey: "agent:main:main" },
      ctxPayload: {
        SessionKey: "agent:main:main",
        MessageSid: "456",
        From: "telegram:123",
        To: "telegram:123",
      },
      chatId: 123,
      isGroup: false,
      msg: mockMsg,
    });

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processMessage({ message: mockMsg }, [], [], {});

    expect(triggerInternalHook).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("dispatches even when hook throws", async () => {
    const mockMsg = { chat: { id: 123 }, message_id: 456, date: 1700000000 };
    buildTelegramMessageContext.mockResolvedValue({
      route: { sessionKey: "agent:main:main" },
      ctxPayload: {
        SessionKey: "agent:main:main",
        MessageSid: "456",
        From: "telegram:123",
        To: "telegram:123",
      },
      chatId: 123,
      isGroup: false,
      msg: mockMsg,
    });
    triggerInternalHook.mockRejectedValue(new Error("hook exploded"));

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processMessage({ message: mockMsg }, [], [], {});

    expect(triggerInternalHook).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
    expect(baseDeps.logger.warn).toHaveBeenCalledWith(
      "message:received hook failed, continuing dispatch",
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  it("skips dispatch when no context is produced", async () => {
    buildTelegramMessageContext.mockResolvedValue(null);
    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processMessage({ message: { chat: { id: 123 }, message_id: 456 } }, [], [], {});
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });
});
