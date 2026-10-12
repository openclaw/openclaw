import { describe, expect, it } from "vitest";
import {
  evaluateChannelHealth,
  resolveChannelHealthState,
  resolveChannelRestartReason,
} from "./channel-health-policy.js";

function evaluateHealth(
  account: Record<string, unknown>,
  opts: { now?: number; channelId?: string } = {},
) {
  const { now = 100_000, channelId = "discord" } = opts;
  return evaluateChannelHealth(account, {
    channelId,
    now,
    channelConnectGraceMs: 10_000,
    staleEventThresholdMs: 30_000,
  });
}

function runningAccount(overrides: Record<string, unknown> = {}) {
  return {
    running: true,
    enabled: true,
    configured: true,
    ...overrides,
  };
}

function connectedAccount(overrides: Record<string, unknown> = {}) {
  return runningAccount({ connected: true, ...overrides });
}

function activeRunAccount(lastRunActivityAt: number, overrides: Record<string, unknown> = {}) {
  return runningAccount({
    connected: false,
    activeRuns: 1,
    lastRunActivityAt,
    ...overrides,
  });
}

function staleTransportAccount(overrides: Record<string, unknown> = {}) {
  return connectedAccount({
    lastStartAt: 0,
    lastTransportActivityAt: 0,
    ...overrides,
  });
}

function inheritedTransportAccount() {
  return connectedAccount({
    lastStartAt: 50_000,
    lastTransportActivityAt: 10_000,
  });
}

describe("evaluateChannelHealth", () => {
  it("treats explicitly unlinked accounts as healthy unmanaged", () => {
    const evaluation = evaluateHealth({
      running: false,
      enabled: true,
      configured: true,
      linked: false,
    });
    expect(evaluation).toEqual({ healthy: true, reason: "unmanaged" });
  });

  it("uses channel connect grace before flagging disconnected", () => {
    const evaluation = evaluateHealth(
      runningAccount({
        connected: false,
        lastStartAt: 95_000,
      }),
    );
    expect(evaluation).toEqual({ healthy: true, reason: "startup-connect-grace" });
  });

  it("trusts a fresh recorded starting lifecycle inside connect grace", () => {
    expect(
      evaluateHealth(
        runningAccount({ connected: false, lifecycle: "starting", lastStartAt: 95_000 }),
      ),
    ).toEqual({ healthy: true, reason: "startup-connect-grace" });
  });

  it("falls through to stale socket when recorded recovering outlives connect grace", () => {
    expect(evaluateHealth(staleTransportAccount({ lifecycle: "recovering" }))).toEqual({
      healthy: false,
      reason: "stale-socket",
    });
  });

  it("does not synthesize lifecycle grace without a start timestamp", () => {
    expect(evaluateHealth(runningAccount({ connected: false, lifecycle: "starting" }))).toEqual({
      healthy: false,
      reason: "disconnected",
    });
  });

  it.each([
    {
      name: "starting lifecycle",
      account: runningAccount({ connected: false, lifecycle: "starting", lastStartAt: 101_000 }),
      expected: { healthy: false, reason: "disconnected" },
    },
    {
      name: "recovering lifecycle",
      account: runningAccount({ connected: false, lifecycle: "recovering", lastStartAt: 101_000 }),
      expected: { healthy: false, reason: "disconnected" },
    },
    {
      name: "unrecorded lifecycle",
      account: runningAccount({ connected: false, lastStartAt: 101_000 }),
      expected: { healthy: false, reason: "disconnected" },
    },
    {
      name: "disconnected active run",
      account: activeRunAccount(101_000, { lastStartAt: 0, activeRunStartedAt: 101_000 }),
      expected: { healthy: false, reason: "disconnected" },
    },
    {
      name: "activity inherited before a future lifecycle",
      account: runningAccount({
        connected: false,
        lifecycle: "starting",
        lastStartAt: 101_000,
        busy: true,
        lastRunActivityAt: 99_000,
      }),
      expected: { healthy: false, reason: "disconnected" },
    },
    {
      name: "disconnect inherited before a future lifecycle",
      account: runningAccount({
        connected: false,
        lifecycle: "recovering",
        lastStartAt: 101_000,
        lastDisconnect: { at: 99_000, error: "socket closed" },
      }),
      expected: { healthy: false, reason: "disconnected" },
    },
    {
      name: "stale transport inherited before a future lifecycle",
      account: connectedAccount({
        lifecycle: "ready",
        lastStartAt: 101_000,
        lastTransportActivityAt: 0,
      }),
      expected: { healthy: false, reason: "stale-socket" },
    },
  ])("does not trust future activity for $name", ({ account, expected }) => {
    expect(evaluateHealth(account)).toEqual(expected);
  });

  it("lets recorded ready bypass wall-clock startup grace", () => {
    expect(
      evaluateHealth(runningAccount({ connected: false, lifecycle: "ready", lastStartAt: 99_999 })),
    ).toEqual({ healthy: false, reason: "disconnected" });
  });

  it.each([
    {
      name: "uses reconnect grace for a fresh typed disconnect",
      lastStartAt: 0,
      lastDisconnect: { at: 95_000, error: "socket closed" },
      expected: { healthy: true, reason: "reconnect-grace" },
    },
    {
      name: "expires reconnect grace after 120 seconds",
      lastStartAt: 0,
      lastDisconnect: { at: -20_001, error: "socket closed" },
      expected: { healthy: false, reason: "disconnected" },
    },
    {
      name: "ignores a legacy string disconnect",
      lastStartAt: 0,
      lastDisconnect: "socket closed",
      expected: { healthy: false, reason: "disconnected" },
    },
    {
      name: "ignores a malformed typed disconnect",
      lastStartAt: 0,
      lastDisconnect: { at: Number.NaN, error: "socket closed" },
      expected: { healthy: false, reason: "disconnected" },
    },
    {
      name: "ignores a disconnect from the previous lifecycle",
      lastStartAt: 80_000,
      lastDisconnect: { at: 79_000, error: "socket closed" },
      expected: { healthy: false, reason: "disconnected" },
    },
    {
      name: "ignores a disconnect dated after the current clock",
      lastStartAt: 0,
      lastDisconnect: { at: 101_000, error: "socket closed" },
      expected: { healthy: false, reason: "disconnected" },
    },
  ] as const)("$name", ({ lastStartAt, lastDisconnect, expected }) => {
    expect(
      evaluateHealth(
        runningAccount({
          connected: false,
          lifecycle: "recovering",
          lastStartAt,
          lastDisconnect,
        }),
      ),
    ).toEqual(expected);
  });

  it("maps recorded stopped lifecycle to the existing restartable verdict", () => {
    expect(evaluateHealth(runningAccount({ lifecycle: "stopped" }))).toEqual({
      healthy: false,
      reason: "not-running",
    });
  });

  it("treats active runs as busy even when disconnected", () => {
    const now = 100_000;
    const evaluation = evaluateHealth(activeRunAccount(now - 30_000), { now });
    expect(evaluation).toEqual({ healthy: true, reason: "busy" });
  });

  it("flags a hung run masking a disconnected transport as stuck despite a fresh heartbeat", () => {
    const now = 30 * 60_000;
    const evaluation = evaluateHealth(
      activeRunAccount(now - 1_000, {
        connected: false,
        activeRunStartedAt: now - 26 * 60_000,
      }),
      { now },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stuck" });
  });

  it("keeps a connected run healthy past the threshold while its heartbeat stays fresh", () => {
    const now = 30 * 60_000;
    const evaluation = evaluateHealth(
      activeRunAccount(now - 1_000, {
        connected: true,
        activeRunStartedAt: now - 26 * 60_000,
      }),
      { now },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "busy" });
  });

  it("ignores inherited busy flags until current lifecycle reports run activity", () => {
    const now = 100_000;
    const evaluation = evaluateHealth(
      runningAccount({
        connected: false,
        lastStartAt: now - 30_000,
        busy: true,
        activeRuns: 1,
        lastRunActivityAt: now - 31_000,
      }),
      { now },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "disconnected" });
  });

  it("does not flag stale sockets for channels without transport tracking", () => {
    const evaluation = evaluateHealth(
      connectedAccount({
        lastStartAt: 0,
        lastTransportActivityAt: null,
      }),
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("does not flag stale sockets without an active connected socket", () => {
    const evaluation = evaluateHealth(
      runningAccount({
        lastStartAt: 0,
        lastTransportActivityAt: 0,
      }),
      { now: 75_000, channelId: "slack" },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("ignores inherited transport timestamps from a previous lifecycle", () => {
    const evaluation = evaluateHealth(inheritedTransportAccount(), {
      now: 75_000,
      channelId: "slack",
    });
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("flags inherited transport timestamps after the lifecycle exceeds the stale threshold", () => {
    const evaluation = evaluateHealth(inheritedTransportAccount(), {
      now: 140_000,
      channelId: "slack",
    });
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it.each([
    {
      name: "distinguishes a stopped terminal channel",
      snapshot: { running: false, terminalDisconnect: true, linked: false },
      expected: { healthy: false, reason: "terminal-disconnect" },
    },
    {
      name: "keeps ordinary stopped channels restartable",
      snapshot: { running: false, terminalDisconnect: false },
      expected: { healthy: false, reason: "not-running" },
    },
    {
      name: "ignores stale terminal state while running",
      snapshot: { running: true, connected: true, terminalDisconnect: true },
      expected: { healthy: true, reason: "healthy" },
    },
  ] as const)("$name", ({ snapshot, expected }) => {
    expect(
      evaluateHealth({ enabled: true, configured: true, ...snapshot }, { channelId: "whatsapp" }),
    ).toEqual(expected);
  });

  describe("inbound ingress dimension", () => {
    it("keeps the ingress reason for the stopped state a failed start lands in", () => {
      // server-channels records the verdict only after the start task rejects, so
      // this is the shape the real failure has. Collapsing it into not-running
      // would throw the cause away exactly where it matters.
      const evaluation = evaluateHealth({
        running: false,
        enabled: true,
        configured: true,
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
          enabled: true,
          configured: true,
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
});

describe("resolveChannelHealthState", () => {
  it("preserves authored terminal detail above the shared blocked projection", () => {
    const snapshot = runningAccount({
      running: false,
      connected: false,
      terminalDisconnect: true,
      lifecycle: "blocked",
      healthState: "conflict",
    });
    const evaluation = evaluateHealth(snapshot);

    expect(evaluation).toEqual({ healthy: false, reason: "terminal-disconnect" });
    expect(
      resolveChannelHealthState(snapshot, {
        channelId: "discord",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      }),
    ).toBe("conflict");
  });
});

describe("resolveChannelRestartReason", () => {
  it("maps not-running + high reconnect attempts to gave-up", () => {
    const reason = resolveChannelRestartReason(
      {
        running: false,
        reconnectAttempts: 10,
      },
      { healthy: false, reason: "not-running" },
    );
    expect(reason).toBe("gave-up");
  });
});
