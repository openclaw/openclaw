import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn());
const getChannelPluginMock = vi.hoisted(() => vi.fn());
const listChannelPluginsMock = vi.hoisted(() => vi.fn());
const normalizeMessageChannelMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", () => ({
  loadConfig: (...args: unknown[]) => loadConfigMock(...args),
}));

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
  listChannelPlugins: (...args: unknown[]) => listChannelPluginsMock(...args),
}));

vi.mock("../../extensions/discord/src/channel.js", () => ({
  discordPlugin: {},
}));

vi.mock("../../extensions/telegram/src/channel.js", () => ({
  telegramPlugin: {},
}));

vi.mock("../../extensions/slack/src/channel.js", () => ({
  slackPlugin: {},
}));

vi.mock("../../extensions/whatsapp/src/channel.js", () => ({
  whatsappPlugin: {},
}));

vi.mock("../../extensions/signal/src/channel.js", () => ({
  signalPlugin: {},
}));

vi.mock("../../extensions/imessage/src/channel.js", () => ({
  imessagePlugin: {},
}));

vi.mock("../utils/message-channel.js", () => ({
  INTERNAL_MESSAGE_CHANNEL: "web",
  normalizeMessageChannel: (...args: unknown[]) => normalizeMessageChannelMock(...args),
}));

import {
  hasConfiguredExecApprovalDmRoute,
  resolveExecApprovalInitiatingSurfaceState,
} from "./exec-approval-surface.js";

describe("resolveExecApprovalInitiatingSurfaceState", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    getChannelPluginMock.mockReset();
    listChannelPluginsMock.mockReset();
    normalizeMessageChannelMock.mockReset();
    normalizeMessageChannelMock.mockImplementation((value?: string | null) =>
      typeof value === "string" ? value.trim().toLowerCase() : undefined,
    );
  });

  it("treats web UI, terminal UI, and missing channels as enabled", () => {
    expect(resolveExecApprovalInitiatingSurfaceState({ channel: null })).toEqual({
      kind: "enabled",
      channel: undefined,
      channelLabel: "this platform",
    });
    expect(resolveExecApprovalInitiatingSurfaceState({ channel: "tui" })).toEqual({
      kind: "enabled",
      channel: "tui",
      channelLabel: "terminal UI",
    });
    expect(resolveExecApprovalInitiatingSurfaceState({ channel: "web" })).toEqual({
      kind: "enabled",
      channel: "web",
      channelLabel: "Web UI",
    });
  });

  it("uses the provided cfg for telegram and discord client enablement", () => {
    getChannelPluginMock.mockImplementation((channel: string) =>
      channel === "telegram"
        ? {
            execApprovals: {
              getInitiatingSurfaceState: () => ({ kind: "enabled" }),
            },
          }
        : channel === "discord"
          ? {
              execApprovals: {
                getInitiatingSurfaceState: () => ({ kind: "disabled" }),
              },
            }
          : undefined,
    );
    const cfg = { channels: {} };

    expect(
      resolveExecApprovalInitiatingSurfaceState({
        channel: "telegram",
        accountId: "main",
        cfg: cfg as never,
      }),
    ).toEqual({
      kind: "enabled",
      channel: "telegram",
      channelLabel: "Telegram",
    });
    expect(
      resolveExecApprovalInitiatingSurfaceState({
        channel: "discord",
        accountId: "main",
        cfg: cfg as never,
      }),
    ).toEqual({
      kind: "disabled",
      channel: "discord",
      channelLabel: "Discord",
    });

    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it("loads config lazily when cfg is omitted and marks unsupported channels", () => {
    loadConfigMock.mockReturnValueOnce({ loaded: true });
    getChannelPluginMock.mockImplementation((channel: string) =>
      channel === "telegram"
        ? {
            execApprovals: {
              getInitiatingSurfaceState: () => ({ kind: "disabled" }),
            },
          }
        : undefined,
    );

    expect(
      resolveExecApprovalInitiatingSurfaceState({
        channel: "telegram",
        accountId: "main",
      }),
    ).toEqual({
      kind: "disabled",
      channel: "telegram",
      channelLabel: "Telegram",
    });
    expect(loadConfigMock).toHaveBeenCalledOnce();

    expect(resolveExecApprovalInitiatingSurfaceState({ channel: "signal" })).toEqual({
      kind: "unsupported",
      channel: "signal",
      channelLabel: "Signal",
    });
  });
});

describe("hasConfiguredExecApprovalDmRoute", () => {
  beforeEach(() => {
    listChannelPluginsMock.mockReset();
  });

  it("returns true when any enabled account routes approvals to DM or both", () => {
    listChannelPluginsMock.mockReturnValueOnce([
      {
        execApprovals: {
          hasConfiguredDmRoute: () => false,
        },
      },
      {
        execApprovals: {
          hasConfiguredDmRoute: () => true,
        },
      },
    ]);

    expect(hasConfiguredExecApprovalDmRoute({} as never)).toBe(true);
  });

  it("returns false when no plugin reports a DM route", () => {
    listChannelPluginsMock.mockReturnValueOnce([
      {
        execApprovals: {
          hasConfiguredDmRoute: () => false,
        },
      },
      {
        execApprovals: {
          hasConfiguredDmRoute: () => false,
        },
      },
      {
        execApprovals: undefined,
      },
    ]);

    expect(hasConfiguredExecApprovalDmRoute({} as never)).toBe(false);
  });
});
