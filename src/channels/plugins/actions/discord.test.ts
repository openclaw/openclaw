import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../../../config/config.js";
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

const loadHandleDiscordMessageAction = async () => {
  const mod = await import("./discord/handle-action.js");
  return mod.handleDiscordMessageAction;
};

const loadDiscordMessageActions = async () => {
  const mod = await import("./discord.js");
  return mod.discordMessageActions;
};

describe("discord message actions", () => {
  it("lists channel and upload actions by default", async () => {
    const cfg = { channels: { discord: { token: "d0" } } } as ClawdbotConfig;
    const discordMessageActions = await loadDiscordMessageActions();
    const actions = discordMessageActions.listActions?.({ cfg }) ?? [];

    expect(actions).toContain("emoji-upload");
    expect(actions).toContain("sticker-upload");
    expect(actions).toContain("channel-create");
  });

  it("respects disabled channel actions", async () => {
    const cfg = {
      channels: { discord: { token: "d0", actions: { channels: false } } },
    } as ClawdbotConfig;
    const discordMessageActions = await loadDiscordMessageActions();
    const actions = discordMessageActions.listActions?.({ cfg }) ?? [];

    expect(actions).not.toContain("channel-create");
  });
});
