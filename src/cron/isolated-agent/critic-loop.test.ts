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
    expect(result?.outcome).toBe("needs_replan");
    expect(result?.passed).toBe(false);
    expect(result?.score).toBeLessThan(0.8);
    expect(result?.scores.map((entry) => entry.key)).toEqual([
      "spec_coverage",
      "completeness",
      "actionability",
    ]);
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
    expect(result?.outcome).toBe("completed");
    expect(result?.passed).toBe(true);
    expect(result?.score).toBeGreaterThanOrEqual(0.6);
  });
});
