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
    buildTelegramMessageContext.mockClear();
    dispatchTelegramMessage.mockClear();
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
    replyToMode: "first",
    streamMode: "partial",
    textLimit: 4096,
    opts: {},
  } as unknown as Parameters<typeof createTelegramMessageProcessor>[0];

  async function processSampleMessage(
    processMessage: ReturnType<typeof createTelegramMessageProcessor>,
    opts: {
      messageId?: number;
      text?: string;
      chatType?: "private" | "group" | "supergroup";
      fromId?: number;
    } = {},
  ) {
    await processMessage(
      {
        message: {
          chat: { id: 123, type: opts.chatType ?? "private", title: "chat" },
          from: opts.fromId != null ? { id: opts.fromId } : undefined,
          message_id: opts.messageId ?? 456,
          text: opts.text,
        },
      } as unknown as Parameters<typeof processMessage>[0],
      [],
      [],
      {},
    );
  }

  it("dispatches when context is available", async () => {
    buildTelegramMessageContext.mockResolvedValue({ route: { sessionKey: "agent:main:main" } });

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processSampleMessage(processMessage);

    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
    const args = dispatchTelegramMessage.mock.calls[0]?.[0] as { replyToMode?: string };
    expect(args.replyToMode).toBe("off");
  });

  it("enables reply threading on rapid consecutive messages", async () => {
    buildTelegramMessageContext.mockResolvedValue({ route: { sessionKey: "agent:main:main" } });

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processSampleMessage(processMessage, { text: "hi" });
    await processSampleMessage(processMessage, { messageId: 457, text: "again" });

    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(2);
    const first = dispatchTelegramMessage.mock.calls[0]?.[0] as { replyToMode?: string };
    const second = dispatchTelegramMessage.mock.calls[1]?.[0] as { replyToMode?: string };
    expect(first.replyToMode).toBe("off");
    expect(second.replyToMode).toBe("first");
  });

  it("disables reply threading when message gap exceeds base 10s window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T00:00:00.000Z"));
    buildTelegramMessageContext.mockResolvedValue({ route: { sessionKey: "agent:main:main" } });

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processSampleMessage(processMessage, {
      text: "this is a longer first message that should not count as dense short input",
    });
    vi.setSystemTime(new Date("2026-03-06T00:00:11.000Z"));
    await processSampleMessage(processMessage, {
      messageId: 458,
      text: "this is another long message past 10s so it should reset",
    });

    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(2);
    const first = dispatchTelegramMessage.mock.calls[0]?.[0] as { replyToMode?: string };
    const second = dispatchTelegramMessage.mock.calls[1]?.[0] as { replyToMode?: string };
    expect(first.replyToMode).toBe("off");
    expect(second.replyToMode).toBe("off");
    vi.useRealTimers();
  });

  it("expands burst window for dense short messages", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T00:00:00.000Z"));
    buildTelegramMessageContext.mockResolvedValue({ route: { sessionKey: "agent:main:main" } });

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processSampleMessage(processMessage, { text: "1" }); // off
    vi.setSystemTime(new Date("2026-03-06T00:00:08.000Z"));
    await processSampleMessage(processMessage, { messageId: 459, text: "2" }); // first
    vi.setSystemTime(new Date("2026-03-06T00:00:16.000Z"));
    await processSampleMessage(processMessage, { messageId: 460, text: "3" }); // first (20s window)

    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(3);
    const third = dispatchTelegramMessage.mock.calls[2]?.[0] as { replyToMode?: string };
    expect(third.replyToMode).toBe("first");
    vi.useRealTimers();
  });

  it("treats rapid group messages from different senders as one burst", async () => {
    buildTelegramMessageContext.mockResolvedValue({ route: { sessionKey: "agent:main:main" } });

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processSampleMessage(processMessage, {
      messageId: 461,
      text: "a",
      chatType: "group",
      fromId: 1,
    });
    await processSampleMessage(processMessage, {
      messageId: 462,
      text: "b",
      chatType: "group",
      fromId: 2,
    });

    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(2);
    const first = dispatchTelegramMessage.mock.calls[0]?.[0] as { replyToMode?: string };
    const second = dispatchTelegramMessage.mock.calls[1]?.[0] as { replyToMode?: string };
    expect(first.replyToMode).toBe("off");
    expect(second.replyToMode).toBe("first");
  });

  it("skips dispatch when no context is produced", async () => {
    buildTelegramMessageContext.mockResolvedValue(null);
    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processSampleMessage(processMessage);
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });
});
