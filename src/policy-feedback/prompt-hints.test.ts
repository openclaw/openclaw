import { describe, expect, it } from "vitest";
import { formatPolicyHintsForPrompt } from "./prompt-hints.js";
import type { PolicyHints } from "./types.js";

function makeHints(overrides?: Partial<PolicyHints>): PolicyHints {
  return {
    recommendation: "proceed",
    reasons: [],
    fatigueLevel: 0,
    activeConstraints: [],
    mode: "advisory",
    ...overrides,
  };
}

describe("formatPolicyHintsForPrompt", () => {
  it("returns undefined for off mode", () => {
    expect(formatPolicyHintsForPrompt(makeHints({ mode: "off" }))).toBeUndefined();
  });

  it("returns undefined for passive mode", () => {
    expect(formatPolicyHintsForPrompt(makeHints({ mode: "passive" }))).toBeUndefined();
  });

  it("returns undefined when no advisory content", () => {
    expect(formatPolicyHintsForPrompt(makeHints())).toBeUndefined();
  });

  it("includes suppress recommendation", () => {
    const result = formatPolicyHintsForPrompt(makeHints({ recommendation: "suppress" }));
    expect(result).toContain("SUPPRESSING");
  });

  it("includes caution recommendation", () => {
    const result = formatPolicyHintsForPrompt(makeHints({ recommendation: "caution" }));
    expect(result).toContain("CAUTION");
  });

  it("includes fatigue warning when elevated", () => {
    const result = formatPolicyHintsForPrompt(makeHints({ fatigueLevel: 0.8 }));
    expect(result).toContain("fatigue");
    expect(result).toContain("80%");
  });

  it("does not include fatigue when low", () => {
    const result = formatPolicyHintsForPrompt(makeHints({ fatigueLevel: 0.2 }));
    expect(result).toBeUndefined();
  });

  it("includes tone hints", () => {
    const result = formatPolicyHintsForPrompt(
      makeHints({ toneHints: ["Consider a lighter tone"] }),
    );
    expect(result).toContain("lighter tone");
  });

  it("includes timing hint", () => {
    const result = formatPolicyHintsForPrompt(
      makeHints({ timingHint: "Hour 23 has below-average response rate" }),
    );
    expect(result).toContain("Hour 23");
  });

  it("includes reasons as signals", () => {
    const result = formatPolicyHintsForPrompt(
      makeHints({ reasons: ["Low data confidence", "High fatigue"] }),
    );
    expect(result).toContain("Signals:");
    expect(result).toContain("Low data confidence");
  });

  it("works in active mode", () => {
    const result = formatPolicyHintsForPrompt(
      makeHints({ mode: "active", recommendation: "suppress" }),
    );
    expect(result).toContain("SUPPRESSING");
  });
});
