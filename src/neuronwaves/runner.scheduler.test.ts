import { describe, expect, it, vi } from "vitest";
import { startNeuronWavesRunner } from "./runner.js";

// Minimal smoke test: ensure runner constructs and exposes stop/updateConfig.
// Full behavior tests will be added once we integrate planner/actions.

describe("NeuronWaves runner", () => {
  it("constructs", () => {
    const runner = startNeuronWavesRunner({
      // @ts-expect-error test stub
      cfg: { agents: { defaults: {} }, session: {} },
    });
    expect(typeof runner.stop).toBe("function");
    expect(typeof runner.updateConfig).toBe("function");
    runner.stop();
  });
});
