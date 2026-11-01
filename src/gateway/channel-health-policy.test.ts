import { expect, it } from "vitest";
import {
  evaluateChannelHealth,
  resolveChannelHealthState,
  resolveChannelRestartReason,
} from "./channel-health-policy.js";

const policy = {
  channelId: "discord",
  now: 100_000,
  channelConnectGraceMs: 10_000,
  staleEventThresholdMs: 30_000,
};

function evaluateHealth(
  account: Record<string, unknown>,
  opts: { now?: number; channelId?: string } = {},
) {
  return evaluateChannelHealth(
    { running: true, enabled: true, configured: true, ...account },
    { ...policy, ...opts },
  );
}

const reconnect = (lastDisconnect: unknown, lastStartAt = 0) => ({
  connected: false,
  lifecycle: "recovering",
  lastStartAt,
  lastDisconnect,
});
const inheritedTransport = {
  connected: true,
  lastStartAt: 50_000,
  lastTransportActivityAt: 10_000,
};
const oldRun = (connected: boolean) => ({
  connected,
  activeRuns: 1,
  lastRunActivityAt: 30 * 60_000 - 1_000,
  activeRunStartedAt: 4 * 60_000,
});
const unmanaged = {
  running: false,
  linked: false,
  terminalDisconnect: true,
  lifecycle: "blocked",
  ingressUnavailable: true,
};

it.each<[Record<string, unknown>, boolean, string, { now?: number; channelId?: string }?]>([
  [{ running: false, linked: false }, true, "unmanaged"],
  [{ connected: false, lifecycle: "starting", lastStartAt: 95_000 }, true, "startup-connect-grace"],
  [{ lifecycle: "stopped" }, false, "not-running"],
  [{ running: false, terminalDisconnect: true, linked: false }, false, "terminal-disconnect"],
  [{ running: true, connected: true, terminalDisconnect: true }, true, "healthy"],
  [
    { running: false, linked: false, restartPending: true, ingressUnavailable: true },
    false,
    "ingress-unavailable",
  ],
  [
    {
      connected: false,
      lastStartAt: 70_000,
      busy: true,
      activeRuns: 1,
      lastRunActivityAt: 69_000,
    },
    false,
    "disconnected",
  ],
  [reconnect({ at: 95_000 }), true, "reconnect-grace"],
  [reconnect({ at: 50_000 }), true, "reconnect-grace", { now: 169_999 }],
  [reconnect({ at: 50_000 }), false, "disconnected", { now: 170_000 }],
  [reconnect({ at: -20_001 }), false, "disconnected"],
  [reconnect("socket closed"), false, "disconnected"],
  [reconnect({ at: Number.NaN }), false, "disconnected"],
  [reconnect({ at: 79_000 }, 80_000), false, "disconnected"],
  [oldRun(false), false, "stuck", { now: 30 * 60_000 }],
  [oldRun(true), true, "busy", { now: 30 * 60_000 }],
  [inheritedTransport, true, "healthy", { now: 75_000, channelId: "slack" }],
  [inheritedTransport, false, "stale-socket", { now: 140_000, channelId: "slack" }],
  [{ ...unmanaged, enabled: false }, true, "unmanaged"],
  [{ ...unmanaged, configured: false }, true, "unmanaged"],
])("evaluates %j as %s/%s with %j", (snapshot, healthy, reason, options) => {
  expect(evaluateHealth(snapshot, options)).toEqual({ healthy, reason });
});

it("preserves authored terminal detail above the shared blocked projection", () => {
  const snapshot = {
    enabled: true,
    configured: true,
    running: false,
    connected: false,
    terminalDisconnect: true,
    lifecycle: "blocked",
    healthState: "conflict",
  } satisfies Parameters<typeof resolveChannelHealthState>[0];
  expect(evaluateHealth(snapshot)).toEqual({ healthy: false, reason: "terminal-disconnect" });
  expect(resolveChannelHealthState(snapshot, policy)).toBe("conflict");
});

it("maps not-running + high reconnect attempts to gave-up", () => {
  expect(
    resolveChannelRestartReason(
      { running: false, reconnectAttempts: 10 },
      { healthy: false, reason: "not-running" },
    ),
  ).toBe("gave-up");
});
