import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ChannelMessageActionAdapter, ChannelPlugin } from "./types.js";

const telegramDescribeMessageToolMock = vi.fn();
const discordDescribeMessageToolMock = vi.fn();

vi.mock("../../../extensions/telegram/src/runtime.js", () => ({
  getTelegramRuntime: () => ({
    channel: {
      telegram: {
        messageActions: {
          describeMessageTool: telegramDescribeMessageToolMock,
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
          describeMessageTool: discordDescribeMessageToolMock,
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
    telegramDescribeMessageToolMock.mockReset();
    discordDescribeMessageToolMock.mockReset();
  });

  function getCapabilities(plugin: Pick<ChannelPlugin, "actions">, cfg: OpenClawConfig) {
    const describeMessageTool: ChannelMessageActionAdapter["describeMessageTool"] | undefined =
      plugin.actions?.describeMessageTool;
    return [...(describeMessageTool?.({ cfg })?.capabilities ?? [])];
  }

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

    expect(getCapabilities(slackPlugin, baseCfg)).toEqual(["blocks"]);
    expect(getCapabilities(slackPlugin, interactiveCfg)).toEqual(["blocks", "interactive"]);
  });

  it("forwards Telegram action capabilities through the channel wrapper", () => {
    telegramDescribeMessageToolMock.mockReturnValue({
      capabilities: ["interactive", "buttons"],
    });

    const result = getCapabilities(telegramPlugin, {} as OpenClawConfig);

    expect(result).toEqual(["interactive", "buttons"]);
    expect(telegramDescribeMessageToolMock).toHaveBeenCalledWith({ cfg: {} });
    discordDescribeMessageToolMock.mockReturnValue({
      capabilities: ["interactive", "components"],
    });

    const discordResult = getCapabilities(discordPlugin, {} as OpenClawConfig);

    expect(discordResult).toEqual(["interactive", "components"]);
    expect(discordDescribeMessageToolMock).toHaveBeenCalledWith({ cfg: {} });
  });

  it("exposes configured channel capabilities only when required credentials are present", () => {
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
    const configuredFeishuCfg = {
      channels: {
        feishu: {
          enabled: true,
          appId: "cli_a",
          appSecret: "secret",
        },
      },
    } as OpenClawConfig;
    const disabledFeishuCfg = {
      channels: {
        feishu: {
          enabled: false,
          appId: "cli_a",
          appSecret: "secret",
        },
      },
    } as OpenClawConfig;
    const configuredMsteamsCfg = {
      channels: {
        msteams: {
          enabled: true,
          tenantId: "tenant",
          appId: "app",
          appPassword: "secret",
        },
      },
    } as OpenClawConfig;
    const disabledMsteamsCfg = {
      channels: {
        msteams: {
          enabled: false,
          tenantId: "tenant",
          appId: "app",
          appPassword: "secret",
        },
      },
    } as OpenClawConfig;

    expect(getCapabilities(mattermostPlugin, configuredCfg)).toEqual(["buttons"]);
    expect(getCapabilities(mattermostPlugin, unconfiguredCfg)).toEqual([]);
    expect(getCapabilities(feishuPlugin, configuredFeishuCfg)).toEqual(["cards"]);
    expect(getCapabilities(feishuPlugin, disabledFeishuCfg)).toEqual([]);
    expect(getCapabilities(msteamsPlugin, configuredMsteamsCfg)).toEqual(["cards"]);
    expect(getCapabilities(msteamsPlugin, disabledMsteamsCfg)).toEqual([]);
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

    expect(getCapabilities(zaloPlugin, cfg)).toEqual([]);
  });
});
