import { beforeEach, describe, expect, it, vi } from "vitest";

const buildTelegramMessageContext = vi.hoisted(() => vi.fn());
const dispatchTelegramMessage = vi.hoisted(() => vi.fn());

vi.mock("./bot-message-context.js", () => ({
  buildTelegramMessageContext,
}));

vi.mock("./bot-message-dispatch.js", () => ({
  dispatchTelegramMessage,
}));

import { createTelegramMessageProcessor } from "./bot-message.js";

describe("telegram bot message processor", () => {
  beforeEach(() => {
    buildTelegramMessageContext.mockReset();
    dispatchTelegramMessage.mockReset();
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
    logger: {},
    resolveGroupActivation: () => true,
    resolveGroupRequireMention: () => false,
    resolveTelegramGroupConfig: () => ({}),
    runtime: {},
    replyToMode: "auto",
    streamMode: "partial",
    textLimit: 4096,
    opts: {},
  } as unknown as Parameters<typeof createTelegramMessageProcessor>[0];

  it("dispatches when context is available", async () => {
    buildTelegramMessageContext.mockResolvedValue({ route: { sessionKey: "agent:main:main" } });

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processMessage(
      {
        message: {
          chat: { id: 123, type: "private", title: "chat" },
          message_id: 456,
        },
      } as unknown as Parameters<typeof processMessage>[0],
      [],
      [],
      {},
    );

    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("skips dispatch when no context is produced", async () => {
    buildTelegramMessageContext.mockResolvedValue(null);
    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processMessage(
      {
        message: {
          chat: { id: 123, type: "private", title: "chat" },
          message_id: 456,
        },
      } as unknown as Parameters<typeof processMessage>[0],
      [],
      [],
      {},
    );
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });
});
