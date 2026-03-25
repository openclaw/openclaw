import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandLane } from "../process/lanes.js";

const hoisted = vi.hoisted(() => ({
  resolveAgentMaxConcurrent: vi.fn(() => 7),
  resolveSubagentMaxConcurrent: vi.fn(() => 11),
  setCommandLaneConcurrency: vi.fn(),
}));

vi.mock("../config/agent-limits.js", () => ({
  resolveAgentMaxConcurrent: hoisted.resolveAgentMaxConcurrent,
  resolveSubagentMaxConcurrent: hoisted.resolveSubagentMaxConcurrent,
}));

vi.mock("../process/command-queue.js", () => ({
  setCommandLaneConcurrency: hoisted.setCommandLaneConcurrency,
}));

const { applyGatewayLaneConcurrency } = await import("./server-lanes.js");

describe("applyGatewayLaneConcurrency", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("applies cron concurrency to the nested lane too", () => {
    applyGatewayLaneConcurrency({
      cron: { maxConcurrentRuns: 3 },
    } as never);

    expect(hoisted.setCommandLaneConcurrency.mock.calls).toEqual([
      [CommandLane.Cron, 3],
      [CommandLane.Nested, 3],
      [CommandLane.Main, 7],
      [CommandLane.Subagent, 11],
    ]);
  });
});
