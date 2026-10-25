import { describe, expect, it } from "vitest";
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

describe("evaluateChannelHealth", () => {
  it.each([
    [{ running: false, linked: false }, true, "unmanaged"],
    [
      { connected: false, lifecycle: "starting", lastStartAt: 95_000 },
      true,
      "startup-connect-grace",
    ],
    [{ lifecycle: "stopped" }, false, "not-running"],
    [{ running: false, terminalDisconnect: true, linked: false }, false, "terminal-disconnect"],
    [{ running: false, terminalDisconnect: false }, false, "not-running"],
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
  ] as const)("evaluates %j as %s/%s", (snapshot, healthy, reason) => {
    expect(evaluateHealth(snapshot)).toEqual({ healthy, reason });
  });

  it.each([
    ["uses reconnect grace for a fresh typed disconnect", 0, { at: 95_000 }, true],
    ["expires reconnect grace after 120 seconds", 0, { at: -20_001 }, false],
    ["ignores a legacy string disconnect", 0, "socket closed", false],
    ["ignores a malformed typed disconnect", 0, { at: Number.NaN }, false],
    ["ignores a disconnect from the previous lifecycle", 80_000, { at: 79_000 }, false],
  ] as const)("%s", (_name, lastStartAt, lastDisconnect, healthy) => {
    expect(
      evaluateHealth({
        connected: false,
        lifecycle: "recovering",
        lastStartAt,
        lastDisconnect,
      }),
    ).toEqual({ healthy, reason: healthy ? "reconnect-grace" : "disconnected" });
  });

  it.each([false, true])(
    "evaluates an old run with a fresh heartbeat, connected=%s",
    (connected) => {
      const now = 30 * 60_000;
      const evaluation = evaluateHealth(
        {
          connected,
          activeRuns: 1,
          lastRunActivityAt: now - 1_000,
          activeRunStartedAt: now - 26 * 60_000,
        },
        { now },
      );
      expect(evaluation).toEqual({ healthy: connected, reason: connected ? "busy" : "stuck" });
    },
  );

  it.each([
    [75_000, true],
    [140_000, false],
  ] as const)("checks inherited transport at %s", (now, healthy) => {
    expect(
      evaluateHealth(
        { connected: true, lastStartAt: 50_000, lastTransportActivityAt: 10_000 },
        { now, channelId: "slack" },
      ),
    ).toEqual({ healthy, reason: healthy ? "healthy" : "stale-socket" });
  });

  it.each([{ enabled: false }, { configured: false }])(
    "keeps disabled or unconfigured accounts unmanaged (%j)",
    (unmanaged) => {
      const evaluation = evaluateHealth({
        running: false,
        linked: false,
        terminalDisconnect: true,
        lifecycle: "blocked",
        ingressUnavailable: true,
        ...unmanaged,
      });
      expect(evaluation).toEqual({ healthy: true, reason: "unmanaged" });
    },
  );
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
