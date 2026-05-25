import { describe, expect, it } from "vitest";
import {
  DEFAULT_FAIL_RATE_THRESHOLD,
  evaluateRegressionGate,
  normalizeRegressionStats,
  parseFailRate,
  scoreIntentRegression,
} from "../../scripts/lib/claworks-weak-model-regression-gate.mjs";

describe("claworks weak model regression gate", () => {
  it("uses 0.3 default threshold aligned with Playbook learn_if_high_fail", () => {
    expect(DEFAULT_FAIL_RATE_THRESHOLD).toBe(0.3);
  });

  it("parseFailRate accepts number and numeric string", () => {
    expect(parseFailRate(0.25)).toBe(0.25);
    expect(parseFailRate("0.31")).toBe(0.31);
    expect(parseFailRate("")).toBeNull();
    expect(parseFailRate("n/a")).toBeNull();
  });

  it("normalizeRegressionStats parses JSON string from llm step output", () => {
    const stats = normalizeRegressionStats('{"pass":2,"fail":1,"fail_rate":0.33}');
    expect(stats).toEqual({ pass: 2, fail: 1, fail_rate: 0.33 });
  });

  it("passes when fail_rate equals threshold", () => {
    const gate = evaluateRegressionGate({ fail_rate: 0.3 }, 0.3);
    expect(gate.pass).toBe(true);
    expect(gate.reason).toBe("ok");
  });

  it("fails when fail_rate exceeds threshold", () => {
    const gate = evaluateRegressionGate({ fail_rate: 0.31 }, 0.3);
    expect(gate.pass).toBe(false);
    expect(gate.reason).toBe("fail_rate_exceeded");
    expect(gate.failRate).toBe(0.31);
  });

  it("fails closed when fail_rate missing", () => {
    const gate = evaluateRegressionGate({ pass: 1, fail: 0 });
    expect(gate.pass).toBe(false);
    expect(gate.reason).toBe("missing_fail_rate");
  });
});

describe("scoreIntentRegression", () => {
  it("scores pass/fail against expected_intent", () => {
    const scenarios = [
      { user_input: "a", expected_intent: "alarm_report" },
      { user_input: "b", expected_intent: "equipment_status" },
      { user_input: "c", expected_intent: "knowledge_query" },
    ];
    const intents = [
      { intent: "alarm_report", suggested_capability: "alarm_report" },
      { intent: "equipment_status", suggested_capability: "equipment_status" },
      { intent: "wrong", suggested_capability: "wrong" },
    ];
    const stats = scoreIntentRegression(scenarios, intents);
    expect(stats.pass).toBe(2);
    expect(stats.fail).toBe(1);
    expect(stats.fail_rate).toBeCloseTo(1 / 3, 5);
  });
});
