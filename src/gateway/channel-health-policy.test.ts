import { describe, expect, it } from "vitest";
import {
  evaluateChannelHealth,
  isChannelOperational,
  resolveChannelRestartReason,
} from "./channel-health-policy.js";

function evaluateDiscordHealth(
  account: Record<string, unknown>,
  now = 100_000,
  channelId = "discord",
) {
  return evaluateChannelHealth(account, {
    channelId,
    now,
    channelConnectGraceMs: 10_000,
    staleEventThresholdMs: 30_000,
  });
}

describe("evaluateChannelHealth", () => {
  it("treats disabled accounts as healthy unmanaged", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: false,
        enabled: false,
        configured: true,
      },
      {
        channelId: "discord",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "unmanaged" });
  });

  it("uses channel connect grace before flagging disconnected", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        lastStartAt: 95_000,
      },
      {
        channelId: "discord",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "startup-connect-grace" });
  });

  it("treats active runs as busy even when disconnected", () => {
    const now = 100_000;
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        activeRuns: 1,
        lastRunActivityAt: now - 30_000,
      },
      {
        channelId: "discord",
        now,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "busy" });
  });

  it("flags stale busy channels as stuck when run activity is too old", () => {
    const now = 100_000;
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        activeRuns: 1,
        lastRunActivityAt: now - 26 * 60_000,
      },
      {
        channelId: "discord",
        now,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stuck" });
  });

  it("ignores inherited busy flags until current lifecycle reports run activity", () => {
    const now = 100_000;
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
        lastStartAt: now - 30_000,
        busy: true,
        activeRuns: 1,
        lastRunActivityAt: now - 31_000,
      },
      {
        channelId: "discord",
        now,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "disconnected" });
  });

  it("flags stale sockets when no events arrive beyond threshold", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastEventAt: 0,
      },
      {
        channelId: "discord",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it("skips stale-socket detection for telegram long-polling channels", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastEventAt: null,
      },
      {
        channelId: "telegram",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("skips stale-socket detection for channels in webhook mode", () => {
    const evaluation = evaluateDiscordHealth({
      running: true,
      connected: true,
      enabled: true,
      configured: true,
      lastStartAt: 0,
      lastEventAt: 0,
      mode: "webhook",
    });
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("does not flag stale sockets for channels without event tracking", () => {
    const evaluation = evaluateDiscordHealth({
      running: true,
      connected: true,
      enabled: true,
      configured: true,
      lastStartAt: 0,
      lastEventAt: null,
    });
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("does not flag stale sockets without an active connected socket", () => {
    const evaluation = evaluateDiscordHealth(
      {
        running: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastEventAt: 0,
      },
      75_000,
      "slack",
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("ignores inherited event timestamps from a previous lifecycle", () => {
    const evaluation = evaluateDiscordHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 50_000,
        lastEventAt: 10_000,
      },
      75_000,
      "slack",
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("flags inherited event timestamps after the lifecycle exceeds the stale threshold", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 50_000,
        lastEventAt: 10_000,
      },
      {
        channelId: "slack",
        now: 140_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });
});

describe("transport-aware channel health", () => {
  it("treats matrix as a polling channel (skips stale-socket detection)", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastEventAt: null,
      },
      {
        channelId: "matrix",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("treats signal as a polling channel (local transport, skips stale-socket)", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastEventAt: 0,
      },
      {
        channelId: "signal",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    // signal is local (polling-like), so stale-socket is not used;
    // it falls through to the stale-poll path instead
    expect(evaluation.reason).not.toBe("stale-socket");
  });

  it("treats zalo as a polling channel (skips stale-socket detection)", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastEventAt: null,
      },
      {
        channelId: "zalo",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("treats discord as a websocket channel (stale-socket detection applies)", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastEventAt: 0,
      },
      {
        channelId: "discord",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it("treats slack as a websocket channel (stale-socket detection applies)", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastEventAt: 0,
      },
      {
        channelId: "slack",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it("webhook channels (line) skip stale-socket detection via transport profile", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastEventAt: 0,
      },
      {
        channelId: "line",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    // line is a webhook (passive) channel, so stale-socket detection is skipped
    expect(evaluation.reason).not.toBe("stale-socket");
  });

  it("webhook channels (msteams) skip stale-socket detection via transport profile", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastEventAt: null,
      },
      {
        channelId: "msteams",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("detects stale-poll for matrix channel with stale lastInboundAt", () => {
    const now = 10 * 60 * 60_000;
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastInboundAt: now - 61 * 60_000,
        lastStartAt: now - 120 * 60_000,
      },
      {
        channelId: "matrix",
        now,
        channelConnectGraceMs: 120_000,
        staleEventThresholdMs: 30 * 60_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stale-poll" });
  });

  it("detects stale-poll for signal channel with stale lastInboundAt", () => {
    const now = 10 * 60 * 60_000;
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastInboundAt: now - 61 * 60_000,
        lastStartAt: now - 120 * 60_000,
      },
      {
        channelId: "signal",
        now,
        channelConnectGraceMs: 120_000,
        staleEventThresholdMs: 30 * 60_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stale-poll" });
  });
});

describe("stale-poll detection", () => {
  it("telegram channel with stale lastInboundAt returns stale-poll", () => {
    const now = 10 * 60 * 60_000;
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastInboundAt: now - 61 * 60_000,
        lastStartAt: now - 120 * 60_000,
      },
      {
        channelId: "telegram",
        now,
        channelConnectGraceMs: 120_000,
        staleEventThresholdMs: 30 * 60_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stale-poll" });
  });

  it("telegram channel with fresh lastInboundAt returns healthy", () => {
    const now = 10 * 60 * 60_000;
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastInboundAt: now - 10 * 60_000,
        lastStartAt: now - 120 * 60_000,
      },
      {
        channelId: "telegram",
        now,
        channelConnectGraceMs: 120_000,
        staleEventThresholdMs: 30 * 60_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("webhook mode channel with stale lastInboundAt returns stale-poll", () => {
    const now = 10 * 60 * 60_000;
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        mode: "webhook",
        lastInboundAt: now - 61 * 60_000,
        lastStartAt: now - 120 * 60_000,
      },
      {
        channelId: "slack",
        now,
        channelConnectGraceMs: 120_000,
        staleEventThresholdMs: 30 * 60_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stale-poll" });
  });

  it("polling channel without lastInboundAt returns healthy (no false positive)", () => {
    const now = 10 * 60 * 60_000;
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastInboundAt: undefined,
        lastStartAt: now - 120 * 60_000,
      },
      {
        channelId: "telegram",
        now,
        channelConnectGraceMs: 120_000,
        staleEventThresholdMs: 30 * 60_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("telegram channel within startup grace returns startup-connect-grace", () => {
    const now = 10 * 60 * 60_000;
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        enabled: true,
        configured: true,
        lastStartAt: now - 60_000,
        lastInboundAt: undefined,
      },
      {
        channelId: "telegram",
        now,
        channelConnectGraceMs: 120_000,
        staleEventThresholdMs: 30 * 60_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "startup-connect-grace" });
  });
});

describe("isChannelOperational", () => {
  it("treats startup grace as not yet operational", () => {
    expect(
      isChannelOperational(
        {
          running: true,
          connected: true,
          enabled: true,
          configured: true,
          lastStartAt: 95_000,
        },
        {
          channelId: "discord",
          now: 100_000,
          channelConnectGraceMs: 10_000,
          staleEventThresholdMs: 30_000,
        },
      ),
    ).toBe(false);
  });

  it("treats healthy connected channels as operational", () => {
    expect(
      isChannelOperational(
        {
          running: true,
          connected: true,
          enabled: true,
          configured: true,
          lastStartAt: 0,
          lastEventAt: 50_000,
        },
        {
          channelId: "discord",
          now: 60_000,
          channelConnectGraceMs: 10_000,
          staleEventThresholdMs: 30_000,
        },
      ),
    ).toBe(true);
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

  it("maps disconnected to disconnected instead of stuck", () => {
    const reason = resolveChannelRestartReason(
      {
        running: true,
        connected: false,
        enabled: true,
        configured: true,
      },
      { healthy: false, reason: "disconnected" },
    );
    expect(reason).toBe("disconnected");
  });

  it("returns stale-poll for stale-poll evaluation", () => {
    const reason = resolveChannelRestartReason(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
      },
      { healthy: false, reason: "stale-poll" },
    );
    expect(reason).toBe("stale-poll");
  });
});
