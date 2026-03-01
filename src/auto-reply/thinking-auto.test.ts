import { describe, expect, it } from "vitest";
import { buildAutoThinkClassifierPrompt, parseAutoThinkDecision } from "./thinking-auto.js";

describe("parseAutoThinkDecision", () => {
  it("parses valid JSON decision", () => {
    const decision = parseAutoThinkDecision('{"think":"high","confidence":0.82}');
    expect(decision).toEqual({ think: "high", confidence: 0.82 });
  });

  it("parses fenced JSON decision", () => {
    const decision = parseAutoThinkDecision('```json\n{"think":"xhigh","confidence":0.9}\n```');
    expect(decision).toEqual({ think: "xhigh", confidence: 0.9 });
  });

  it("rejects unknown think levels", () => {
    const decision = parseAutoThinkDecision('{"think":"auto","confidence":0.8}');
    expect(decision).toBeUndefined();
  });

  it("rejects out-of-range confidence", () => {
    const decision = parseAutoThinkDecision('{"think":"low","confidence":1.5}');
    expect(decision).toBeUndefined();
  });
});

describe("buildAutoThinkClassifierPrompt", () => {
  it("includes user request and strict JSON contract", () => {
    const prompt = buildAutoThinkClassifierPrompt("Please design a migration strategy");
    expect(prompt).toContain("Return STRICT JSON only");
    expect(prompt).toContain("Please design a migration strategy");
    expect(prompt).toContain('"think":"off|minimal|low|medium|high|xhigh"');
  });
});
