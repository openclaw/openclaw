import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { startHeartbeatRunner } from "./heartbeat-runner.js";
import { resetHeartbeatWakeStateForTests } from "./heartbeat-wake.js";

describe("heartbeat: empty config disables heartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetHeartbeatWakeStateForTests();
  });

  it("does not schedule heartbeats when agents.defaults.heartbeat is an empty object", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const runOnce = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: {},
        },
      },
    } as OpenClawConfig;

    const runner = startHeartbeatRunner({ cfg, runOnce });

    // Advance past multiple potential heartbeat intervals
    await vi.advanceTimersByTimeAsync(120 * 60 * 1000); // 2 hours

    expect(runOnce).not.toHaveBeenCalled();

    runner.stop();
  });

  it("does schedule heartbeats when agents.defaults.heartbeat has an every field", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const runOnce = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: { every: "30m" },
        },
      },
    } as OpenClawConfig;

    const runner = startHeartbeatRunner({ cfg, runOnce });

    // Advance past one heartbeat interval
    await vi.advanceTimersByTimeAsync(35 * 60 * 1000); // 35 minutes

    expect(runOnce).toHaveBeenCalled();

    runner.stop();
  });

  it("does not schedule heartbeats when per-agent heartbeat is an empty object", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const runOnce = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "test-agent",
            heartbeat: {},
          },
        ],
      },
    } as OpenClawConfig;

    const runner = startHeartbeatRunner({ cfg, runOnce });

    await vi.advanceTimersByTimeAsync(120 * 60 * 1000);

    expect(runOnce).not.toHaveBeenCalled();

    runner.stop();
  });
});
