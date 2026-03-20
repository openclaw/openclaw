import { describe, expect, it, vi } from "vitest";
import { CommandLane } from "../process/lanes.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

describe("heartbeat cron-collision avoidance", () => {
  function makeGetQueueSize(busy: Partial<Record<string, number>>) {
    return (lane?: string) => busy[lane ?? CommandLane.Main] ?? 0;
  }

  const baseDeps = {
    nowMs: () => Date.now(),
    sendOutbound: vi.fn(),
    resolveModel: vi.fn(),
  };

  it("skips with cron-in-progress when cron lane is busy", async () => {
    const res = await runHeartbeatOnce({
      heartbeat: { every: "30m" },
      deps: {
        ...baseDeps,
        getQueueSize: makeGetQueueSize({ [CommandLane.Cron]: 1 }),
      },
    });
    expect(res).toEqual({ status: "skipped", reason: "cron-in-progress" });
  });

  it("does not skip when cron lane is idle", async () => {
    const res = await runHeartbeatOnce({
      heartbeat: { every: "30m" },
      deps: {
        ...baseDeps,
        getQueueSize: makeGetQueueSize({}),
      },
    });
    // Should proceed past the cron check (may skip for another reason like
    // no delivery target, but not "cron-in-progress").
    expect(res.status === "skipped" && res.reason === "cron-in-progress").toBe(false);
  });

  it("skips with lanes-busy when skipWhenBusy is set and subagent lane is busy", async () => {
    const res = await runHeartbeatOnce({
      heartbeat: { every: "30m", skipWhenBusy: true },
      deps: {
        ...baseDeps,
        getQueueSize: makeGetQueueSize({ [CommandLane.Subagent]: 1 }),
      },
    });
    expect(res).toEqual({ status: "skipped", reason: "lanes-busy" });
  });

  it("skips with lanes-busy when skipWhenBusy is set and nested lane is busy", async () => {
    const res = await runHeartbeatOnce({
      heartbeat: { every: "30m", skipWhenBusy: true },
      deps: {
        ...baseDeps,
        getQueueSize: makeGetQueueSize({ [CommandLane.Nested]: 2 }),
      },
    });
    expect(res).toEqual({ status: "skipped", reason: "lanes-busy" });
  });

  it("does not skip for subagent/nested when skipWhenBusy is not set", async () => {
    const res = await runHeartbeatOnce({
      heartbeat: { every: "30m" },
      deps: {
        ...baseDeps,
        getQueueSize: makeGetQueueSize({ [CommandLane.Subagent]: 1 }),
      },
    });
    expect(res.status === "skipped" && res.reason === "lanes-busy").toBe(false);
  });

  it("checks main before cron (main takes priority)", async () => {
    const res = await runHeartbeatOnce({
      heartbeat: { every: "30m" },
      deps: {
        ...baseDeps,
        getQueueSize: makeGetQueueSize({
          [CommandLane.Main]: 1,
          [CommandLane.Cron]: 1,
        }),
      },
    });
    expect(res).toEqual({ status: "skipped", reason: "requests-in-flight" });
  });
});
