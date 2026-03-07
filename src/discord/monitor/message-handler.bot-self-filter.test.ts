import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

const preflightDiscordMessageMock = vi.hoisted(() => vi.fn());
const processDiscordMessageMock = vi.hoisted(() => vi.fn());

vi.mock("./message-handler.preflight.js", () => ({
  preflightDiscordMessage: preflightDiscordMessageMock,
}));

vi.mock("./message-handler.process.js", () => ({
  processDiscordMessage: processDiscordMessageMock,
}));

const { createDiscordMessageHandler } = await import("./message-handler.js");

const BOT_USER_ID = "bot-123";

function createHandlerParams(overrides?: Partial<{ botUserId: string }>) {
  const cfg: OpenClawConfig = {
    channels: {
      discord: {
        enabled: true,
        token: "test-token",
        groupPolicy: "allowlist",
      },
    },
    messages: {
      inbound: {
        debounceMs: 0,
      },
    },
  };
  return {
    cfg,
    discordConfig: cfg.channels?.discord,
    accountId: "default",
    token: "test-token",
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    },
    botUserId: overrides?.botUserId ?? BOT_USER_ID,
    guildHistories: new Map(),
    historyLimit: 0,
    mediaMaxBytes: 10_000,
    textLimit: 2000,
    replyToMode: "off" as const,
    dmEnabled: true,
    groupDmEnabled: false,
    threadBindings: createNoopThreadBindingManager("default"),
  };
}

function createMessageData(authorId: string, channelId = "ch-1") {
  return {
    author: { id: authorId, bot: authorId === BOT_USER_ID },
    message: {
      id: "msg-1",
      author: { id: authorId, bot: authorId === BOT_USER_ID },
      content: "hello",
      channel_id: channelId,
    },
    channel_id: channelId,
  };
}

function createPreflightContext(channelId = "ch-1") {
  return {
    data: {
      channel_id: channelId,
      message: {
        id: `msg-${channelId}`,
        channel_id: channelId,
        attachments: [],
      },
    },
    message: {
      id: `msg-${channelId}`,
      channel_id: channelId,
      attachments: [],
    },
    route: {
      sessionKey: `agent:main:discord:channel:${channelId}`,
    },
    baseSessionKey: `agent:main:discord:channel:${channelId}`,
    messageChannelId: channelId,
  };
}

describe("createDiscordMessageHandler bot-self filter", () => {
  it("skips bot-own messages before the debounce queue", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const handler = createDiscordMessageHandler(createHandlerParams());

    await expect(
      handler(createMessageData(BOT_USER_ID) as never, {} as never),
    ).resolves.toBeUndefined();

    expect(preflightDiscordMessageMock).not.toHaveBeenCalled();
    expect(processDiscordMessageMock).not.toHaveBeenCalled();
  });

  it("enqueues non-bot messages for processing", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    preflightDiscordMessageMock.mockImplementation(
      async (params: { data: { channel_id: string } }) =>
        createPreflightContext(params.data.channel_id),
    );

    const handler = createDiscordMessageHandler(createHandlerParams());

    await expect(
      handler(createMessageData("user-456") as never, {} as never),
    ).resolves.toBeUndefined();

    await vi.waitFor(() => {
      expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1);
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
    });
  });
});
