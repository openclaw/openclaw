import { describe, expect, it } from "vitest";
import { evaluateExecutorOutputCritic } from "./critic-loop.js";

describe("evaluateExecutorOutputCritic", () => {
  it("returns null when feature flag is disabled", () => {
    const result = evaluateExecutorOutputCritic({
      enabled: false,
      spec: "Ship a complete rollout plan",
      output: "Plan ready",
    });
    expect(result).toBeNull();
  });

  it("returns null when kill switch is active", () => {
    const result = evaluateExecutorOutputCritic({
      enabled: true,
      killSwitch: true,
      spec: "Include rollback steps",
      output: "Rollback steps included",
    });
    expect(result).toBeNull();
  });

  it("returns needs_replan when score is below threshold", () => {
    const result = evaluateExecutorOutputCritic({
      enabled: true,
      spec: "Include benchmark table and rollback checklist",
      output: "Done.",
      threshold: 0.8,
    });

    expect(result).not.toBeNull();
    expect(result?.mode).toBe("score");
    expect(result?.outcome).toBe("needs_replan");
    expect(result?.passed).toBe(false);
    expect(result?.score).toBeLessThan(0.8);
    expect(result?.scores.map((entry) => entry.key)).toEqual([
      "spec_coverage",
      "completeness",
      "actionability",
    ]);
    expect(result?.redTeam).toBeUndefined();
  });

  it("returns completed when score meets threshold", () => {
    const result = evaluateExecutorOutputCritic({
      enabled: true,
      spec: "Include benchmark table and rollback checklist",
      output: [
        "Implementation summary:",
        "- Include benchmark table for baseline and new run",
        "- Add rollback checklist with explicit verification steps",
        "Next step: verify in staging and collect before/after metrics.",
      ].join("\n"),
      threshold: 0.6,
    });

    expect(result).not.toBeNull();
    expect(result?.mode).toBe("score");
    expect(result?.outcome).toBe("completed");
    expect(result?.passed).toBe(true);
    expect(result?.score).toBeGreaterThanOrEqual(0.6);
  });

  it("runs red-team adversarial checks and gates on severity threshold", () => {
    const result = evaluateExecutorOutputCritic({
      enabled: true,
      mode: "redTeam",
      spec: "Plan must address leakage, slippage, assumptions, and dependencies.",
      output: [
        "Use future data to speed calibration.",
        "Assume zero slippage and ignore fees.",
        "Guaranteed outcome once deployed.",
      ].join(" "),
      threshold: 0,
      redTeamSeverityThreshold: "high",
    });

    expect(result).not.toBeNull();
    expect(result?.mode).toBe("redTeam");
    expect(result?.outcome).toBe("needs_replan");
    expect(result?.passed).toBe(false);
    expect(result?.redTeam?.failed).toBe(true);
    expect(result?.redTeam?.maxSeverity).toBe("critical");
    expect(result?.redTeam?.checks.map((check) => check.category)).toEqual([
      "leakage",
      "slippage_blindness",
      "unrealistic_assumptions",
      "hidden_coupling",
    ]);
    for (const check of result?.redTeam?.checks ?? []) {
      expect(check.attackPrompt.length).toBeGreaterThan(10);
      expect(Array.isArray(check.evidence)).toBe(true);
      expect(check.recommendation.length).toBeGreaterThan(10);
    }
  });

  it("keeps deterministic red-team output shape and passes when mitigations are present", () => {
    const result = evaluateExecutorOutputCritic({
      enabled: true,
      mode: "redTeam",
      spec: "Include leakage controls, slippage model, assumptions log, and dependency boundaries.",
      output: [
        "Implementation plan:",
        "- Enforce point-in-time joins and walk-forward holdout validation to prevent leakage.",
        "- Model spread, slippage, fees, and funding impact in backtests and dry-runs.",
        "- Track assumptions/constraints with explicit risks, fallback steps, and verification checks.",
        "- Document interface contracts, ownership boundaries, feature flags, and rollback isolation.",
      ].join("\n"),
      threshold: 0.5,
      redTeamSeverityThreshold: "high",
    });

    expect(result).not.toBeNull();
    expect(result?.mode).toBe("redTeam");
    expect(result?.outcome).toBe("completed");
    expect(result?.passed).toBe(true);
    expect(result?.redTeam).toMatchObject({
      threshold: "high",
      failed: false,
      maxSeverity: "none",
    });
    expect(result?.redTeam?.findings).toEqual([]);
  });
});
