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
  it("treats explicitly unlinked accounts as healthy unmanaged", () => {
    expect(evaluateHealth({ running: false, linked: false })).toEqual({
      healthy: true,
      reason: "unmanaged",
    });
  });

  it("trusts a fresh recorded starting lifecycle inside connect grace", () => {
    expect(
      evaluateHealth({ connected: false, lifecycle: "starting", lastStartAt: 95_000 }),
    ).toEqual({ healthy: true, reason: "startup-connect-grace" });
  });

  it.each([
    ["uses reconnect grace for a fresh typed disconnect", 0, { at: 95_000 }, true],
    ["expires reconnect grace after 120 seconds", 0, { at: -20_001 }, false],
    ["ignores a legacy string disconnect", 0, "socket closed", false],
    ["ignores a malformed typed disconnect", 0, { at: Number.NaN }, false],
    ["ignores a disconnect from the previous lifecycle", 80_000, { at: 79_000 }, false],
    ["ignores a disconnect dated after the current clock", 0, { at: 101_000 }, false],
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

  it("maps recorded stopped lifecycle to the existing restartable verdict", () => {
    expect(evaluateHealth({ lifecycle: "stopped" })).toEqual({
      healthy: false,
      reason: "not-running",
    });
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

  it("ignores inherited busy flags until current lifecycle reports run activity", () => {
    const now = 100_000;
    const evaluation = evaluateHealth(
      {
        connected: false,
        lastStartAt: now - 30_000,
        busy: true,
        activeRuns: 1,
        lastRunActivityAt: now - 31_000,
      },
      { now },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "disconnected" });
  });

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

  it.each([
    [{ running: false, terminalDisconnect: true, linked: false }, "terminal-disconnect"],
    [{ running: false, terminalDisconnect: false }, "not-running"],
    [{ running: true, connected: true, terminalDisconnect: true }, "healthy"],
  ] as const)("evaluates terminal state %j as %s", (snapshot, reason) => {
    expect(evaluateHealth(snapshot, { channelId: "whatsapp" })).toEqual({
      healthy: reason === "healthy",
      reason,
    });
  });

  it("keeps the ingress reason for the stopped state a failed start lands in", () => {
    // Failed ingress starts publish their cause after the start task stops.
    const evaluation = evaluateHealth({
      running: false,
      linked: false,
      restartPending: true,
      ingressUnavailable: true,
    });
    expect(evaluation).toEqual({ healthy: false, reason: "ingress-unavailable" });
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
