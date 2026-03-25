import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { CommandLane } from "../process/lanes.js";

const hoisted = vi.hoisted(() => ({
  resolveAgentMaxConcurrent: vi.fn(() => 7),
  resolveSubagentMaxConcurrent: vi.fn(() => 9),
  setCommandLaneConcurrency: vi.fn(),
}));

vi.mock("../config/agent-limits.js", () => ({
  resolveAgentMaxConcurrent: hoisted.resolveAgentMaxConcurrent,
  resolveSubagentMaxConcurrent: hoisted.resolveSubagentMaxConcurrent,
}));

vi.mock("../process/command-queue.js", () => ({
  setCommandLaneConcurrency: hoisted.setCommandLaneConcurrency,
}));

import { applyGatewayLaneConcurrency } from "./server-lanes.js";

describe("applyGatewayLaneConcurrency", () => {
  beforeEach(() => {
    hoisted.resolveAgentMaxConcurrent.mockClear();
    hoisted.resolveSubagentMaxConcurrent.mockClear();
    hoisted.setCommandLaneConcurrency.mockClear();
  });

  it("mirrors cron concurrency onto the nested lane", () => {
    const cfg: OpenClawConfig = {
      cron: { maxConcurrentRuns: 3 },
    };

    applyGatewayLaneConcurrency(cfg);

    expect(hoisted.setCommandLaneConcurrency).toHaveBeenNthCalledWith(1, CommandLane.Cron, 3);
    expect(hoisted.setCommandLaneConcurrency).toHaveBeenNthCalledWith(2, CommandLane.Nested, 3);
    expect(hoisted.setCommandLaneConcurrency).toHaveBeenNthCalledWith(3, CommandLane.Main, 7);
    expect(hoisted.setCommandLaneConcurrency).toHaveBeenNthCalledWith(4, CommandLane.Subagent, 9);
  });

  it("defaults cron and nested lanes to one slot when cron config is unset", () => {
    applyGatewayLaneConcurrency({});

    expect(hoisted.setCommandLaneConcurrency).toHaveBeenNthCalledWith(1, CommandLane.Cron, 1);
    expect(hoisted.setCommandLaneConcurrency).toHaveBeenNthCalledWith(2, CommandLane.Nested, 1);
  });
});
