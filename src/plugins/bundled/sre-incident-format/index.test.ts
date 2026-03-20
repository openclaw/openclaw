import { describe, expect, it } from "vitest";
import { enforceIncidentLabelFormat, isProgressOnlyMessage } from "./index.js";

describe("enforceIncidentLabelFormat", () => {
  it("replaces italic incident labels with bold", () => {
    const input = `_Incident:_ Server crash
_Customer impact:_ confirmed
_Affected services:_ api
_Status:_ investigating`;

    const expected = `*Incident:* Server crash
*Customer impact:* confirmed
*Affected services:* api
*Status:* investigating`;

    expect(enforceIncidentLabelFormat(input)).toBe(expected);
  });

  it("replaces all known labels", () => {
    const labels = [
      "Incident",
      "Customer impact",
      "Affected services",
      "Status",
      "Evidence",
      "Likely cause",
      "Mitigation",
      "Validate",
      "Next",
      "Also watching",
      "Auto-fix PR",
      "Linear",
      "Suggested PR",
      "Fix PR",
      "Context",
      "What the PR does",
    ];

    for (const label of labels) {
      const input = `_${label}:_ test value`;
      const expected = `*${label}:* test value`;
      expect(enforceIncidentLabelFormat(input)).toBe(expected);
    }
  });

  it("leaves already-bold labels unchanged", () => {
    const input = `*Incident:* Server crash
*Customer impact:* confirmed`;
    expect(enforceIncidentLabelFormat(input)).toBe(input);
  });

  it("leaves non-label italic text unchanged", () => {
    const input = "_emphasis_ on this word";
    expect(enforceIncidentLabelFormat(input)).toBe(input);
  });

  it("handles mixed bold and italic labels", () => {
    const input = `*Incident:* Server crash
_Customer impact:_ confirmed
*Affected services:* api
_Status:_ investigating`;

    const expected = `*Incident:* Server crash
*Customer impact:* confirmed
*Affected services:* api
*Status:* investigating`;

    expect(enforceIncidentLabelFormat(input)).toBe(expected);
  });
});

describe("isProgressOnlyMessage", () => {
  it("detects progress-only messages", () => {
    expect(isProgressOnlyMessage("Now let me write the fixed file.")).toBe(true);
    expect(isProgressOnlyMessage("Let me check the conventions.")).toBe(true);
    expect(isProgressOnlyMessage("I need to stage the file first.")).toBe(true);
    expect(isProgressOnlyMessage("Found it.")).toBe(true);
    expect(isProgressOnlyMessage("Checking...")).toBe(true);
    expect(isProgressOnlyMessage("Good — the diff is clean.")).toBe(true);
    expect(isProgressOnlyMessage("The script tried to auto-derive.")).toBe(true);
    expect(isProgressOnlyMessage("The commit was created but errored.")).toBe(true);
    expect(isProgressOnlyMessage("PR is created. Let me attach it.")).toBe(true);
    expect(isProgressOnlyMessage("Honest answer: no.")).toBe(true);
    expect(isProgressOnlyMessage("On it")).toBe(true);
    expect(isProgressOnlyMessage("Let me verify")).toBe(true);
    expect(isProgressOnlyMessage("Even though this is a self-test, I'll follow the protocol")).toBe(
      true,
    );
    expect(isProgressOnlyMessage("I'll follow the full protocol — quick live probes")).toBe(true);
  });

  it("allows substantive messages", () => {
    const substantive = `*Incident:* Server crash
*Customer impact:* confirmed
*Evidence:* Pod restarted 3 times in 5 minutes`;
    expect(isProgressOnlyMessage(substantive)).toBe(false);
  });

  it("allows long messages even if they start with a prefix", () => {
    const longMessage = "Now let me " + "x".repeat(200);
    expect(isProgressOnlyMessage(longMessage)).toBe(false);
  });

  it("allows short messages containing incident labels (false positive protection)", () => {
    expect(isProgressOnlyMessage("*Incident:* brief update")).toBe(false);
    expect(isProgressOnlyMessage("*Evidence:* one fact")).toBe(false);
    expect(isProgressOnlyMessage("*Mitigation:* restart pod")).toBe(false);
  });

  it("blocks empty messages", () => {
    expect(isProgressOnlyMessage("")).toBe(true);
    expect(isProgressOnlyMessage("   ")).toBe(true);
  });
});
