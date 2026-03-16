import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const telegramGetCapabilitiesMock = vi.fn();
const discordGetCapabilitiesMock = vi.fn();

vi.mock("../../../extensions/telegram/src/runtime.js", () => ({
  getTelegramRuntime: () => ({
    channel: {
      telegram: {
        messageActions: {
          getCapabilities: telegramGetCapabilitiesMock,
        },
      },
    },
  }),
}));

vi.mock("../../../extensions/discord/src/runtime.js", () => ({
  getDiscordRuntime: () => ({
    channel: {
      discord: {
        messageActions: {
          getCapabilities: discordGetCapabilitiesMock,
        },
      },
    },
  }),
}));

const { slackPlugin } = await import("../../../extensions/slack/src/channel.js");
const { telegramPlugin } = await import("../../../extensions/telegram/src/channel.js");
const { discordPlugin } = await import("../../../extensions/discord/src/channel.js");
const { mattermostPlugin } = await import("../../../extensions/mattermost/src/channel.js");
const { feishuPlugin } = await import("../../../extensions/feishu/src/channel.js");
const { msteamsPlugin } = await import("../../../extensions/msteams/src/channel.js");
const { zaloPlugin } = await import("../../../extensions/zalo/src/channel.js");

describe("channel action capability matrix", () => {
  afterEach(() => {
    telegramGetCapabilitiesMock.mockReset();
    discordGetCapabilitiesMock.mockReset();
  });

  it("exposes Slack blocks by default and interactive when enabled", () => {
    const baseCfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
        },
      },
    } as OpenClawConfig;
    const interactiveCfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
          capabilities: { interactiveReplies: true },
        },
      },
    } as OpenClawConfig;

    expect(slackPlugin.actions?.getCapabilities?.({ cfg: baseCfg })).toEqual(["blocks"]);
    expect(slackPlugin.actions?.getCapabilities?.({ cfg: interactiveCfg })).toEqual([
      "blocks",
      "interactive",
    ]);
  });

  it("forwards Telegram action capabilities through the channel wrapper", () => {
    telegramGetCapabilitiesMock.mockReturnValue(["interactive", "buttons"]);

    const result = telegramPlugin.actions?.getCapabilities?.({ cfg: {} as OpenClawConfig });

    expect(result).toEqual(["interactive", "buttons"]);
    expect(telegramGetCapabilitiesMock).toHaveBeenCalledWith({ cfg: {} });
  });

  it("forwards Discord action capabilities through the channel wrapper", () => {
    discordGetCapabilitiesMock.mockReturnValue(["interactive", "components"]);

    const result = discordPlugin.actions?.getCapabilities?.({ cfg: {} as OpenClawConfig });

    expect(result).toEqual(["interactive", "components"]);
    expect(discordGetCapabilitiesMock).toHaveBeenCalledWith({ cfg: {} });
  });

  it("exposes Mattermost buttons only when an account is configured", () => {
    const configuredCfg = {
      channels: {
        mattermost: {
          enabled: true,
          botToken: "mm-token",
          baseUrl: "https://chat.example.com",
        },
      },
    } as OpenClawConfig;
    const unconfiguredCfg = {
      channels: {
        mattermost: {
          enabled: true,
        },
      },
    } as OpenClawConfig;

    expect(mattermostPlugin.actions?.getCapabilities?.({ cfg: configuredCfg })).toEqual([
      "buttons",
    ]);
    expect(mattermostPlugin.actions?.getCapabilities?.({ cfg: unconfiguredCfg })).toEqual([]);
  });

  it("exposes Feishu cards only when credentials are configured", () => {
    const configuredCfg = {
      channels: {
        feishu: {
          enabled: true,
          appId: "cli_a",
          appSecret: "secret",
        },
      },
    } as OpenClawConfig;
    const disabledCfg = {
      channels: {
        feishu: {
          enabled: false,
          appId: "cli_a",
          appSecret: "secret",
        },
      },
    } as OpenClawConfig;

    expect(feishuPlugin.actions?.getCapabilities?.({ cfg: configuredCfg })).toEqual(["cards"]);
    expect(feishuPlugin.actions?.getCapabilities?.({ cfg: disabledCfg })).toEqual([]);
  });

  it("exposes MSTeams cards only when credentials are configured", () => {
    const configuredCfg = {
      channels: {
        msteams: {
          enabled: true,
          tenantId: "tenant",
          appId: "app",
          appPassword: "secret",
        },
      },
    } as OpenClawConfig;
    const disabledCfg = {
      channels: {
        msteams: {
          enabled: false,
          tenantId: "tenant",
          appId: "app",
          appPassword: "secret",
        },
      },
    } as OpenClawConfig;

    expect(msteamsPlugin.actions?.getCapabilities?.({ cfg: configuredCfg })).toEqual(["cards"]);
    expect(msteamsPlugin.actions?.getCapabilities?.({ cfg: disabledCfg })).toEqual([]);
  });

  it("keeps Zalo actions on the empty capability set", () => {
    const cfg = {
      channels: {
        zalo: {
          enabled: true,
          botToken: "zl-token",
        },
      },
    } as OpenClawConfig;

    expect(zaloPlugin.actions?.getCapabilities?.({ cfg })).toEqual([]);
  });
});
