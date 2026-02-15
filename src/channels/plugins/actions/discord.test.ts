import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
type SendMessageDiscord = typeof import("../../../discord/send.js").sendMessageDiscord;
type SendPollDiscord = typeof import("../../../discord/send.js").sendPollDiscord;

const sendMessageDiscord = vi.fn<Parameters<SendMessageDiscord>, ReturnType<SendMessageDiscord>>(
  async () => ({ ok: true }) as Awaited<ReturnType<SendMessageDiscord>>,
);
const sendPollDiscord = vi.fn<Parameters<SendPollDiscord>, ReturnType<SendPollDiscord>>(
  async () => ({ ok: true }) as Awaited<ReturnType<SendPollDiscord>>,
);

vi.mock("../../../discord/send.js", async () => {
  const actual = await vi.importActual<typeof import("../../../discord/send.js")>(
    "../../../discord/send.js",
  );
  return {
    ...actual,
    sendMessageDiscord: (...args: Parameters<SendMessageDiscord>) => sendMessageDiscord(...args),
    sendPollDiscord: (...args: Parameters<SendPollDiscord>) => sendPollDiscord(...args),
  };
});

const { handleDiscordMessageAction } = await import("./discord/handle-action.js");
const { discordMessageActions } = await import("./discord.js");

describe("discord message actions", () => {
  it("lists channel and upload actions by default", async () => {
    const cfg = { channels: { discord: { token: "d0" } } } as OpenClawConfig;
    const actions = discordMessageActions.listActions?.({ cfg }) ?? [];

    expect(actions).toContain("emoji-upload");
    expect(actions).toContain("sticker-upload");
    expect(actions).toContain("channel-create");
  });

  it("respects disabled channel actions", async () => {
    const cfg = {
      channels: { discord: { token: "d0", actions: { channels: false } } },
    } as OpenClawConfig;
    const actions = discordMessageActions.listActions?.({ cfg }) ?? [];

    expect(actions).not.toContain("channel-create");
  });
});

describe("handleDiscordMessageAction", () => {
  it("forwards context accountId for send", async () => {
    sendMessageDiscord.mockClear();

    await handleDiscordMessageAction({
      action: "send",
      params: {
        to: "channel:123",
        message: "hi",
      },
      cfg: {} as OpenClawConfig,
      accountId: "ops",
    });

    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:123",
      "hi",
      expect.objectContaining({
        accountId: "ops",
      }),
    );
  });

  it("forwards legacy embeds for send", async () => {
    sendMessageDiscord.mockClear();

    const embeds = [{ title: "Legacy", description: "Use components v2." }];

    await handleDiscordMessageAction({
      action: "send",
      params: {
        to: "channel:123",
        message: "hi",
        embeds,
      },
      cfg: {} as OpenClawConfig,
    });

    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:123",
      "hi",
      expect.objectContaining({
        embeds,
      }),
    );
  });

  it("falls back to params accountId when context missing", async () => {
    sendPollDiscord.mockClear();

    await handleDiscordMessageAction({
      action: "poll",
      params: {
        to: "channel:123",
        pollQuestion: "Ready?",
        pollOption: ["Yes", "No"],
        accountId: "marve",
      },
      cfg: {} as OpenClawConfig,
    });

    expect(sendPollDiscord).toHaveBeenCalledWith(
      "channel:123",
      expect.objectContaining({
        question: "Ready?",
        options: ["Yes", "No"],
      }),
      expect.objectContaining({
        accountId: "marve",
      }),
    );
  });

  it("forwards accountId for thread replies", async () => {
    sendMessageDiscord.mockClear();

    await handleDiscordMessageAction({
      action: "thread-reply",
      params: {
        channelId: "123",
        message: "hi",
      },
      cfg: {} as OpenClawConfig,
      accountId: "ops",
    });

    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:123",
      "hi",
      expect.objectContaining({
        accountId: "ops",
      }),
    );
  });

  it("accepts threadId for thread replies (tool compatibility)", async () => {
    sendMessageDiscord.mockClear();

    await handleDiscordMessageAction({
      action: "thread-reply",
      params: {
        // The `message` tool uses `threadId`.
        threadId: "999",
        // Include a conflicting channelId to ensure threadId takes precedence.
        channelId: "123",
        message: "hi",
      },
      cfg: {} as OpenClawConfig,
      accountId: "ops",
    });

    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:999",
      "hi",
      expect.objectContaining({
        accountId: "ops",
      }),
    );
  });
});
