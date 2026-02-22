import { beforeEach, describe, expect, it } from "vitest";
import {
  getGatewayToolMetricsSnapshot,
  recordGatewayToolInvocation,
  resetGatewayToolMetricsForTests,
  resolveGatewayMetricChannel,
} from "./tool-observability.js";

describe("tool observability", () => {
  beforeEach(() => {
    resetGatewayToolMetricsForTests();
  });

  it("prefers explicit message channel", () => {
    expect(
      resolveGatewayMetricChannel({
        messageChannel: "discord",
        sessionKey: "telegram:chat:123",
      }),
    ).toBe("discord");
  });

  it("falls back to channel prefix in session key", () => {
    expect(
      resolveGatewayMetricChannel({
        sessionKey: "telegram:chat:123",
      }),
    ).toBe("telegram");
    expect(
      resolveGatewayMetricChannel({
        sessionKey: "agent:main:main",
      }),
    ).toBe("unknown");
  });

  it("records call/error/latency aggregates by tool and channel", () => {
    recordGatewayToolInvocation({
      tool: "browser_open",
      channel: "telegram",
      ok: true,
      latencyMs: 120,
      now: 10,
    });
    recordGatewayToolInvocation({
      tool: "browser_open",
      channel: "telegram",
      ok: false,
      latencyMs: 340,
      now: 20,
    });
    recordGatewayToolInvocation({
      tool: "chat_send",
      channel: "discord",
      ok: true,
      latencyMs: 50,
      now: 30,
    });

    const snapshot = getGatewayToolMetricsSnapshot();
    expect(snapshot.tools[0]).toMatchObject({
      tool: "browser_open",
      calls: 2,
      errors: 1,
      avgLatencyMs: 230,
      maxLatencyMs: 340,
      lastLatencyMs: 340,
      lastAt: 20,
    });
    expect(snapshot.channels.find((row) => row.channel === "telegram")).toMatchObject({
      calls: 2,
      errors: 1,
      avgLatencyMs: 230,
    });
    expect(
      snapshot.byToolChannel.find((row) => row.tool === "browser_open")?.channels[0],
    ).toMatchObject({
      channel: "telegram",
      calls: 2,
      errors: 1,
    });
  });
});
