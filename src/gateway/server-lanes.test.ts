import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CommandLane } from "../process/lanes.js";

const setConcurrency = vi.fn();

vi.mock("../process/command-queue.js", () => ({
  setCommandLaneConcurrency: (...args: unknown[]) => setConcurrency(...args),
}));

vi.mock("../config/agent-limits.js", () => ({
  resolveAgentMaxConcurrent: (cfg: OpenClawConfig) => cfg.agents?.maxConcurrent ?? 1,
  resolveSubagentMaxConcurrent: (cfg: OpenClawConfig) => cfg.agents?.subagentMaxConcurrent ?? 1,
}));

const { applyGatewayLaneConcurrency } = await import("./server-lanes.js");

describe("applyGatewayLaneConcurrency", () => {
  beforeEach(() => {
    setConcurrency.mockClear();
  });

  it("sets Nested lane concurrency from cron.maxConcurrentRuns", () => {
    const cfg = { cron: { maxConcurrentRuns: 4 } } as OpenClawConfig;
    applyGatewayLaneConcurrency(cfg);

    const nestedCall = setConcurrency.mock.calls.find(
      ([lane]: [string]) => lane === CommandLane.Nested,
    );
    expect(nestedCall).toBeDefined();
    expect(nestedCall![1]).toBe(4);
  });

  it("defaults Nested lane concurrency to 1 when maxConcurrentRuns is unset", () => {
    const cfg = {} as OpenClawConfig;
    applyGatewayLaneConcurrency(cfg);

    const nestedCall = setConcurrency.mock.calls.find(
      ([lane]: [string]) => lane === CommandLane.Nested,
    );
    expect(nestedCall).toBeDefined();
    expect(nestedCall![1]).toBe(1);
  });

  it("sets all four lanes", () => {
    const cfg = { cron: { maxConcurrentRuns: 2 } } as OpenClawConfig;
    applyGatewayLaneConcurrency(cfg);

    const lanes = setConcurrency.mock.calls.map(([lane]: [string]) => lane);
    expect(lanes).toContain(CommandLane.Cron);
    expect(lanes).toContain(CommandLane.Main);
    expect(lanes).toContain(CommandLane.Subagent);
    expect(lanes).toContain(CommandLane.Nested);
  });

  it("Nested and Cron lanes share the same concurrency value", () => {
    const cfg = { cron: { maxConcurrentRuns: 3 } } as OpenClawConfig;
    applyGatewayLaneConcurrency(cfg);

    const cronCall = setConcurrency.mock.calls.find(
      ([lane]: [string]) => lane === CommandLane.Cron,
    );
    const nestedCall = setConcurrency.mock.calls.find(
      ([lane]: [string]) => lane === CommandLane.Nested,
    );
    expect(cronCall![1]).toBe(nestedCall![1]);
  });
});
