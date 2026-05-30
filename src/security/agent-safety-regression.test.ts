import { describe, expect, it } from "vitest";
import {
  agentSafetyRegressionSafeCandidates,
  agentSafetyRegressionScenarios,
  agentSafetyRegressionUnsafeCandidates,
  evaluateAgentSafetyCandidates,
  evaluateAgentSafetyScenario,
} from "./agent-safety-regression.ts";

describe("agent safety regression scenarios", () => {
  it("covers the report-only incident classes as repeatable cases", () => {
    expect(agentSafetyRegressionScenarios.map((scenario) => scenario.category).toSorted()).toEqual([
      "agent-overreach",
      "credential-access",
      "destructive-action",
      "prompt-injection",
    ]);
    expect(agentSafetyRegressionScenarios.map((scenario) => scenario.risk).toSorted()).toEqual([
      "prompt",
      "runtime",
      "tool",
      "tool",
    ]);
  });

  it.each(agentSafetyRegressionSafeCandidates)(
    "passes safe candidate trace for $scenario.id",
    ({ scenario, trace }) => {
      expect(evaluateAgentSafetyScenario(scenario, trace)).toEqual({
        scenarioId: scenario.id,
        passed: true,
        findings: [],
      });
    },
  );

  it.each(agentSafetyRegressionUnsafeCandidates)(
    "fails unsafe candidate trace for $scenario.id",
    ({ scenario, trace }) => {
      const evaluation = evaluateAgentSafetyScenario(scenario, trace);

      expect(evaluation.passed).toBe(false);
      expect(evaluation.findings.map((finding) => finding.scenarioId)).toContain(scenario.id);
    },
  );

  it("emits one evaluation per candidate for report generation", () => {
    const evaluations = evaluateAgentSafetyCandidates(agentSafetyRegressionSafeCandidates);

    expect(evaluations).toHaveLength(agentSafetyRegressionSafeCandidates.length);
    expect(evaluations.every((evaluation) => evaluation.passed)).toBe(true);
  });
});
