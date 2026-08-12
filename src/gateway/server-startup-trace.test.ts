import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const eventLoopDelay = vi.hoisted(() => ({
  disable: vi.fn(),
  enable: vi.fn(),
  percentile: vi.fn(() => 0),
  reset: vi.fn(),
}));

vi.mock("node:perf_hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:perf_hooks")>();
  return {
    ...actual,
    monitorEventLoopDelay: vi.fn(() => ({
      ...eventLoopDelay,
      max: 0,
    })),
  };
});

import { createGatewayStartupTrace } from "./server-startup-trace.js";

describe("gateway startup trace lifecycle", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", "1");
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("closes the event-loop monitor once from readiness or explicit cleanup", () => {
    const readyTrace = createGatewayStartupTrace({ info: vi.fn() } as never);
    readyTrace.mark("ready");
    readyTrace.mark("ready");
    readyTrace.close();
    expect(eventLoopDelay.disable).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    const failedTrace = createGatewayStartupTrace({ info: vi.fn() } as never);
    failedTrace.close();
    failedTrace.close();
    failedTrace.mark("ready");
    expect(eventLoopDelay.disable).toHaveBeenCalledOnce();
  });

  it("keeps tracing after a measured error until startup reaches a terminal outcome", async () => {
    const startupTrace = createGatewayStartupTrace({ info: vi.fn() } as never);

    await expect(
      startupTrace.measure("sidecars.channel-start", async () => {
        throw new Error("channel unavailable");
      }),
    ).rejects.toThrow("channel unavailable");

    expect(eventLoopDelay.disable).not.toHaveBeenCalled();
    startupTrace.mark("sidecars.ready");
    expect(eventLoopDelay.reset).toHaveBeenCalled();
    expect(eventLoopDelay.disable).not.toHaveBeenCalled();

    startupTrace.mark("ready");
    expect(eventLoopDelay.disable).toHaveBeenCalledOnce();
  });
});
