import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DISCORD_BOT_USER_ID,
  createDiscordHandlerParams,
  createDiscordPreflightContext,
} from "./message-handler.test-helpers.js";

const preflightDiscordMessageMock = vi.hoisted(() => vi.fn());
const processDiscordMessageMock = vi.hoisted(() => vi.fn());

vi.mock("./message-handler.preflight.js", () => ({
  preflightDiscordMessage: preflightDiscordMessageMock,
}));

vi.mock("./message-handler.process.js", () => ({
  processDiscordMessage: processDiscordMessageMock,
}));

const { createDiscordMessageHandler } = await import("./message-handler.js");

function createMessageData(authorId: string, channelId = "ch-1") {
  return {
    author: { id: authorId, bot: authorId === DEFAULT_DISCORD_BOT_USER_ID },
    message: {
      id: "msg-1",
      author: { id: authorId, bot: authorId === DEFAULT_DISCORD_BOT_USER_ID },
      content: "hello",
      channel_id: channelId,
    },
    channel_id: channelId,
  };
}

function createPreflightContext(channelId = "ch-1") {
  return createDiscordPreflightContext(channelId);
}

describe("createDiscordMessageHandler bot-self filter", () => {
  it("skips bot-own messages before the debounce queue", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();

    const handler = createDiscordMessageHandler(createDiscordHandlerParams());

    await expect(
      handler(createMessageData(DEFAULT_DISCORD_BOT_USER_ID) as never, {} as never),
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

    const handler = createDiscordMessageHandler(createDiscordHandlerParams());

    await expect(
      handler(createMessageData("user-456") as never, {} as never),
    ).resolves.toBeUndefined();

    await vi.waitFor(() => {
      expect(preflightDiscordMessageMock).toHaveBeenCalledTimes(1);
      expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
    });
  });
});
