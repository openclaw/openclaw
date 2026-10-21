import { afterEach, expect, it, vi } from "vitest";
import type {
  ChannelAccountSnapshot,
  ChannelPlugin,
  ChannelStatusIssue,
} from "../channels/plugins/types.public.js";

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

function account(overrides: Partial<ChannelAccountSnapshot> = {}): ChannelAccountSnapshot {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    running: true,
    connected: true,
    ...overrides,
  };
}

function collect(channel: string, accounts: ChannelAccountSnapshot[]) {
  return collectChannelStatusIssues({ channelAccounts: { [channel]: accounts } });
}

function issue(
  channel: string,
  kind: ChannelStatusIssue["kind"],
  message: string,
  extra: Partial<Pick<ChannelStatusIssue, "accountId" | "fix">> = {},
): ChannelStatusIssue {
  return { channel, accountId: "default", kind, message, ...extra };
}

afterEach(() => {
  vi.clearAllMocks();
});

it("returns no issues when payload accounts are missing or not arrays", () => {
  const collectTelegramIssues = vi.fn(() => [issue("telegram", "runtime", "telegram down")]);
  mocks.listChannelPlugins.mockReturnValue([createPlugin("telegram", collectTelegramIssues)]);

  expect(collectChannelStatusIssues({})).toStrictEqual([]);
  expect(collectChannelStatusIssues({ channelAccounts: { telegram: { bad: true } } })).toEqual([]);
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

  expect(collect("slack", [account({ lifecycle: "blocked" })])).toContainEqual(
    issue("slack", "runtime", "Channel runtime is blocked and needs operator action.", {
      fix: "resolve the reported channel error, then restart the channel",
    }),
  );
});

it("reports stopped configured accounts without treating unknown runtime state as stopped", () => {
  mocks.listChannelPlugins.mockReturnValue([createPlugin("discord")]);

  expect(
    collect("discord", [
      { accountId: "stopped", enabled: true, configured: true, running: false },
      { accountId: "unknown", enabled: true, configured: true },
      { accountId: "disabled", enabled: false, configured: true, running: false },
      { accountId: "unconfigured", enabled: true, configured: false, running: false },
    ]),
  ).toEqual([
    issue(
      "discord",
      "runtime",
      "Channel is enabled and configured, but its runtime is not running.",
      { accountId: "stopped", fix: "restart the channel or gateway" },
    ),
  ]);
});

it("reports dead ingress even while a restart is pending", () => {
  mocks.listChannelPlugins.mockReturnValue([createPlugin("slack")]);

  const issues = collect("slack", [account({ restartPending: true, ingressUnavailable: true })]);

  expect(issues).toEqual([
    issue(
      "slack",
      "runtime",
      "Channel cannot admit inbound events; its durable ingress queue is unavailable. Outbound may still work.",
      { fix: "check openclaw logs for the ingress failure, then rerun openclaw doctor" },
    ),
  ]);
});

it("keeps plugin-specific status issues while adding generic runtime issues", () => {
  const authIssue = issue("signal", "auth", "Linked device credentials are invalid.");
  mocks.listChannelPlugins.mockReturnValue([createPlugin("signal", () => [authIssue])]);

  const issues = collect("signal", [account({ connected: false })]);

  expect(issues).toEqual([
    issue("signal", "runtime", "Channel reports running, but the runtime is disconnected.", {
      fix: "restart the channel or gateway",
    }),
    authIssue,
  ]);
});
