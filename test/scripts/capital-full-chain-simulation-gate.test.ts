import { describe, expect, it } from "vitest";
import {
  evaluateScenario,
  replayScenarios,
  summarizeCases,
} from "../../scripts/openclaw-capital-full-chain-simulation-gate.mjs";

function healthyBase() {
  return {
    quoteFresh: true,
    accountsReady: true,
    positionReady: true,
    orderModeReady: true,
    orderSentToBroker: false,
    orderStatsSent: 0,
    liveWriteDisabled: true,
    duplicatePoller: false,
  };
}

describe("capital full-chain simulation gate", () => {
  it("does not count baseline quote staleness as a fault-injection failure", () => {
    const base = { ...healthyBase(), quoteFresh: false };
    const normal = evaluateScenario(base, {
      id: "normal_paper_chain",
      expect: "paper_only_allowed",
      patch: {},
    });

    expect(normal.decision).toBe("blocked");
    expect(normal.baselineBlocked).toBe(true);
    expect(normal.ok).toBe(true);

    const replay = replayScenarios(base, 9);
    const summary = summarizeCases(replay.results);

    expect(replay.byScenario.normal_paper_chain).toMatchObject({
      runs: 1,
      passed: 0,
      failed: 0,
      skipped: 1,
    });
    expect(summary.failedRuns).toBe(0);
    expect(summary.skippedRuns).toBe(1);
    expect(summary.failedScenarioIds).toEqual([]);
    expect(summary.baselineBlockedScenarioIds).toEqual(["normal_paper_chain"]);
  });

  it("still catches actual fault-injection regressions when the baseline is healthy", () => {
    const replay = replayScenarios(healthyBase(), 9);
    const summary = summarizeCases(replay.results);

    expect(summary.failedRuns).toBe(0);
    expect(summary.skippedRuns).toBe(0);
    expect(replay.byScenario.normal_paper_chain).toMatchObject({
      runs: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
    });
  });
});
