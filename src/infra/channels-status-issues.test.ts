import { afterEach, expect, it, vi } from "vitest";
import type { ChannelAccountSnapshot, ChannelPlugin } from "../channels/plugins/types.public.js";

const mocks = vi.hoisted(() => ({ listChannelPlugins: vi.fn() }));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listChannelPlugins,
}));

import { collectChannelStatusIssues } from "./channels-status-issues.js";

afterEach(() => vi.clearAllMocks());

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

function collect(accounts: ChannelAccountSnapshot[], status?: ChannelPlugin["status"]) {
  mocks.listChannelPlugins.mockReturnValue([{ id: "example", status }]);
  return collectChannelStatusIssues({ channelAccounts: { example: accounts } });
}

function issue(message: string, fix = "restart the channel or gateway", accountId = "default") {
  return { channel: "example", accountId, kind: "runtime", message, fix };
}

it("returns no issues when payload accounts are missing or not arrays", () => {
  const collectTelegramIssues = vi.fn(() => []);
  const plugins = [{ id: "telegram", status: { collectStatusIssues: collectTelegramIssues } }];
  expect(collectChannelStatusIssues({}, plugins)).toStrictEqual([]);
  expect(
    collectChannelStatusIssues({ channelAccounts: { telegram: { bad: true } } }, plugins),
  ).toEqual([]);
  expect(collectTelegramIssues).not.toHaveBeenCalled();
});

it("uses Gateway-owned diagnostics without loading local plugins or duplicating issues", () => {
  const statusIssues = [issue("Configuration reload is deferred.")];
  expect(collectChannelStatusIssues({ statusIssues })).toEqual(statusIssues);
  expect(collectChannelStatusIssues({ statusIssues: [] })).toEqual([]);
  expect(mocks.listChannelPlugins).not.toHaveBeenCalled();
});

it.each<[Partial<ChannelAccountSnapshot>, string, string]>([
  [
    { lifecycle: "blocked" },
    "Channel runtime is blocked and needs operator action.",
    "resolve the reported channel error, then restart the channel",
  ],
  [
    { restartPending: true, ingressUnavailable: true },
    "Channel cannot admit inbound events; its durable ingress queue is unavailable. Outbound may still work.",
    "check openclaw logs for the ingress failure, then rerun openclaw doctor",
  ],
])("reports generic runtime diagnostics for %j", (state, message, fix) => {
  expect(collect([account(state)])).toEqual([issue(message, fix)]);
});

it("reports stopped configured accounts without treating unknown runtime state as stopped", () => {
  expect(
    collect([
      { accountId: "stopped", enabled: true, configured: true, running: false },
      { accountId: "unknown", enabled: true, configured: true },
      { accountId: "disabled", enabled: false, configured: true, running: false },
      { accountId: "unconfigured", enabled: true, configured: false, running: false },
    ]),
  ).toEqual([
    issue(
      "Channel is enabled and configured, but its runtime is not running.",
      "restart the channel or gateway",
      "stopped",
    ),
  ]);
});

it("keeps plugin-specific status issues while adding generic runtime issues", () => {
  const authIssue = {
    channel: "example",
    accountId: "default",
    kind: "auth" as const,
    message: "Linked device credentials are invalid.",
  };
  expect(
    collect([account({ connected: false })], { collectStatusIssues: () => [authIssue] }),
  ).toEqual([issue("Channel reports running, but the runtime is disconnected."), authIssue]);
});
