import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { collectStatusIssuesFromLastError } from "../plugin-sdk/status-helpers.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { formatGatewayChannelsStatusLines } from "./channels/status.runtime.js";

const now = 1_700_000_000_000;
const signalPlugin = {
  ...createChannelTestPluginBase({ id: "signal" }),
  status: {
    collectStatusIssues: (accounts: Parameters<typeof collectStatusIssuesFromLastError>[1]) =>
      collectStatusIssuesFromLastError("signal", accounts),
  },
};

function accountPayload(channel: string, label: string, account: Record<string, unknown>) {
  return {
    channelLabels: { [channel]: label },
    channelAccounts: { [channel]: [{ accountId: "default", ...account }] },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now });
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "signal", source: "test", plugin: signalPlugin }]),
  );
});
afterEach(() => {
  vi.useRealTimers();
  setActivePluginRegistry(createTestRegistry([]));
});

const cases: {
  name: string;
  payload: Record<string, unknown>;
  contains?: (string | RegExp)[];
  verify?: (lines: string[], output: string) => void;
}[] = [
  {
    name: "Signal runtime errors",
    payload: accountPayload("signal", "Signal", {
      enabled: true,
      configured: true,
      running: false,
      lastError: "signal-cli unreachable",
    }),
    contains: [/Warnings:/, /signal/i, /Channel error/i],
  },
  {
    name: "degraded Gateway event loop",
    payload: {
      eventLoop: {
        degraded: true,
        degradedSinceMs: 180_000,
        reasons: ["event_loop_delay", "cpu"],
        delayP99Ms: 61_000,
        delayMaxMs: 62_000,
        utilization: 1,
        cpuCoreRatio: 1,
      },
      channelLabels: {},
      channelAccounts: {},
    },
    contains: [
      /Gateway event loop degraded/,
      /for 3m \(p99 61000ms\)/,
      /eventLoopDelayMaxMs=62000/,
    ],
  },
  {
    name: "partial status warnings",
    payload: {
      partial: true,
      warnings: ["whatsapp:default status failed: snapshot failed"],
    },
    contains: [/Channel status is partial/, "whatsapp:default status failed: snapshot failed"],
  },
  {
    name: "policy diagnostics without partial status",
    payload: {
      channelAccounts: { signal: [{ accountId: "default", configured: true, running: true }] },
      statusIssues: [
        {
          channel: "signal",
          accountId: "default",
          kind: "config",
          message: "Channel configuration reload is deferred while active work finishes.",
          fix: "Wait for active work to finish, then refresh channel status.",
        },
      ],
    },
    contains: ["running", "configuration reload is deferred", "Wait for active work to finish"],
    verify: (_lines, output) => expect(output).not.toContain("status is partial"),
  },
  {
    name: "transport liveness timestamps",
    payload: accountPayload("signal", "Signal", {
      connected: true,
      lastTransportActivityAt: now - 2 * 60_000,
    }),
    contains: ["transport:"],
  },
  {
    name: "phone allowlists without interpreting account names",
    payload: accountPayload("signal", "Signal", {
      accountId: "work",
      name: "+12133734253",
      configured: true,
      allowFrom: ["+442079460018", "uuid:123e4567-e89b-12d3-a456-426614174000"],
    }),
    verify: (lines) =>
      expect(lines).toContain(
        "- Signal work (+12133734253): configured, allow:+44 20 7946 0018 (id: +442079460018),uuid:123e4567-e89b-12d3-a456-426614174000",
      ),
  },
  {
    name: "Telegram bot username from probe data",
    payload: accountPayload("telegram", "Telegram", {
      probe: { ok: true, bot: { username: "openclaw_bot" } },
    }),
    contains: [/bot:@openclaw_bot/],
  },
  {
    name: "unlinked WhatsApp",
    payload: accountPayload("whatsapp", "WhatsApp", { linked: false }),
    contains: [/WhatsApp/i, /Not linked/i],
  },
  {
    name: "disconnected WhatsApp",
    payload: accountPayload("whatsapp", "WhatsApp", {
      linked: true,
      connected: false,
    }),
    contains: [/disconnected/i],
  },
];
it.each(cases)("renders $name in channel status", ({ payload, contains = [], verify }) => {
  const lines = formatGatewayChannelsStatusLines(payload);
  const output = lines.join("\n");
  contains.forEach((fragment) => expect(output).toMatch(fragment));
  verify?.(lines, output);
});
