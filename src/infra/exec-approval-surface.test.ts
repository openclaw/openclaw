import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn());
const listEnabledDiscordAccountsMock = vi.hoisted(() => vi.fn());
const isDiscordExecApprovalClientEnabledMock = vi.hoisted(() => vi.fn());
const listEnabledTelegramAccountsMock = vi.hoisted(() => vi.fn());
const isTelegramExecApprovalClientEnabledMock = vi.hoisted(() => vi.fn());
const normalizeMessageChannelMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", () => ({
  loadConfig: (...args: unknown[]) => loadConfigMock(...args),
}));

vi.mock("../../extensions/discord/src/accounts.js", () => ({
  listEnabledDiscordAccounts: (...args: unknown[]) => listEnabledDiscordAccountsMock(...args),
}));

vi.mock("../../extensions/discord/src/exec-approvals.js", () => ({
  isDiscordExecApprovalClientEnabled: (...args: unknown[]) =>
    isDiscordExecApprovalClientEnabledMock(...args),
}));

vi.mock("../../extensions/telegram/src/accounts.js", () => ({
  listEnabledTelegramAccounts: (...args: unknown[]) => listEnabledTelegramAccountsMock(...args),
}));

vi.mock("../../extensions/telegram/src/exec-approvals.js", () => ({
  isTelegramExecApprovalClientEnabled: (...args: unknown[]) =>
    isTelegramExecApprovalClientEnabledMock(...args),
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
    listEnabledDiscordAccountsMock.mockReset();
    isDiscordExecApprovalClientEnabledMock.mockReset();
    listEnabledTelegramAccountsMock.mockReset();
    isTelegramExecApprovalClientEnabledMock.mockReset();
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
    isTelegramExecApprovalClientEnabledMock.mockReturnValueOnce(true);
    isDiscordExecApprovalClientEnabledMock.mockReturnValueOnce(false);
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
    isTelegramExecApprovalClientEnabledMock.mockReturnValueOnce(false);

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
    listEnabledDiscordAccountsMock.mockReset();
    listEnabledTelegramAccountsMock.mockReset();
  });

  it("returns true when any enabled account routes approvals to DM or both", () => {
    listEnabledDiscordAccountsMock.mockReturnValueOnce([
      {
        config: {
          execApprovals: {
            enabled: true,
            approvers: ["a"],
            target: "channel",
          },
        },
      },
    ]);
    listEnabledTelegramAccountsMock.mockReturnValueOnce([
      {
        config: {
          execApprovals: {
            enabled: true,
            approvers: ["a"],
            target: "both",
          },
        },
      },
    ]);

    expect(hasConfiguredExecApprovalDmRoute({} as never)).toBe(true);
  });

  it("returns false when exec approvals are disabled or have no DM route", () => {
    listEnabledDiscordAccountsMock.mockReturnValueOnce([
      {
        config: {
          execApprovals: {
            enabled: false,
            approvers: ["a"],
            target: "dm",
          },
        },
      },
    ]);
    listEnabledTelegramAccountsMock.mockReturnValueOnce([
      {
        config: {
          execApprovals: {
            enabled: true,
            approvers: [],
            target: "dm",
          },
        },
      },
      {
        config: {
          execApprovals: {
            enabled: true,
            approvers: ["a"],
            target: "channel",
          },
        },
      },
    ]);

    expect(hasConfiguredExecApprovalDmRoute({} as never)).toBe(false);
  });
});
