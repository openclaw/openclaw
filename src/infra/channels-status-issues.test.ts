// Covers channel plugin status issue collection.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin, ChannelStatusIssue } from "../channels/plugins/types.public.js";

const mocks = vi.hoisted(() => ({
  listChannelPlugins: vi.fn(),
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listChannelPlugins,
}));

import { collectChannelStatusIssues } from "./channels-status-issues.js";

function createPlugin(
  id: string,
  collectStatusIssues?: NonNullable<ChannelPlugin["status"]>["collectStatusIssues"],
) {
  return {
    id,
    status: collectStatusIssues ? { collectStatusIssues } : undefined,
  } as ChannelPlugin;
}

describe("collectChannelStatusIssues", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("returns no issues when payload accounts are missing or not arrays", () => {
    const collectTelegramIssues = vi.fn((): ChannelStatusIssue[] => [
      {
        channel: "telegram",
        accountId: "default",
        kind: "runtime",
        message: "telegram down",
      },
    ]);
    mocks.listChannelPlugins.mockReturnValue([createPlugin("telegram", collectTelegramIssues)]);

    expect(collectChannelStatusIssues({})).toStrictEqual([]);
    expect(collectChannelStatusIssues({ channelAccounts: { telegram: { bad: true } } })).toEqual(
      [],
    );
    expect(collectTelegramIssues).not.toHaveBeenCalled();
  });

  it("uses Gateway-owned diagnostics without loading local plugins or duplicating issues", () => {
    const statusIssues: ChannelStatusIssue[] = [
      {
        channel: "guildchat",
        accountId: "work",
        kind: "config",
        message: "Channel configuration reload is deferred while active work finishes.",
      },
    ];
    expect(collectChannelStatusIssues({ statusIssues })).toEqual(statusIssues);
    expect(collectChannelStatusIssues({ statusIssues: [] })).toEqual([]);
    expect(mocks.listChannelPlugins).not.toHaveBeenCalled();
  });

  it("reports blocked lifecycle through the generic runtime path", () => {
    mocks.listChannelPlugins.mockReturnValue([createPlugin("slack")]);

    expect(
      collectChannelStatusIssues({
        channelAccounts: {
          slack: [
            {
              accountId: "default",
              enabled: true,
              configured: true,
              running: true,
              connected: true,
              lifecycle: "blocked",
            },
          ],
        },
      }),
    ).toContainEqual({
      channel: "slack",
      accountId: "default",
      kind: "runtime",
      message: "Channel runtime is blocked and needs operator action.",
      fix: "resolve the reported channel error, then restart the channel",
    });
  });

  it("reports stopped configured accounts without treating unknown runtime state as stopped", () => {
    mocks.listChannelPlugins.mockReturnValue([createPlugin("discord")]);

    expect(
      collectChannelStatusIssues({
        channelAccounts: {
          discord: [
            { accountId: "stopped", enabled: true, configured: true, running: false },
            { accountId: "unknown", enabled: true, configured: true },
            { accountId: "disabled", enabled: false, configured: true, running: false },
            { accountId: "unconfigured", enabled: true, configured: false, running: false },
          ],
        },
      }),
    ).toEqual([
      {
        channel: "discord",
        accountId: "stopped",
        kind: "runtime",
        message: "Channel is enabled and configured, but its runtime is not running.",
        fix: "restart the channel or gateway",
      },
    ]);
  });

  it("reports dead ingress even while a restart is pending", () => {
    mocks.listChannelPlugins.mockReturnValue([createPlugin("slack")]);

    const issues = collectChannelStatusIssues({
      channelAccounts: {
        slack: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            running: true,
            connected: true,
            restartPending: true,
            ingressUnavailable: true,
          },
        ],
      },
    });

    expect(issues).toEqual([
      {
        channel: "slack",
        accountId: "default",
        kind: "runtime",
        message:
          "Channel cannot admit inbound events; its durable ingress queue is unavailable. Outbound may still work.",
        fix: "check openclaw logs for the ingress failure, then rerun openclaw doctor",
      },
    ]);
  });

  it("keeps plugin-specific status issues while adding generic runtime issues", () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.listChannelPlugins.mockReturnValue([
      createPlugin("signal", () => [
        {
          channel: "signal",
          accountId: "default",
          kind: "auth",
          message: "Linked device credentials are invalid.",
        },
      ]),
    ]);

    const issues = collectChannelStatusIssues({
      channelAccounts: {
        signal: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            running: true,
            connected: false,
          },
        ],
      },
    });

    expect(issues).toEqual([
      {
        channel: "signal",
        accountId: "default",
        kind: "runtime",
        message: "Channel reports running, but the runtime is disconnected.",
        fix: "restart the channel or gateway",
      },
      {
        channel: "signal",
        accountId: "default",
        kind: "auth",
        message: "Linked device credentials are invalid.",
      },
    ]);
  });
});
