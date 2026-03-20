import { describe, expect, it } from "vitest";
import { isProgressOnlyMessage } from "./index.js";

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

  it("blocks long progress messages that start with a prefix", () => {
    const longProgress =
      "Now let me look at the key code path for the NaN scenario — when totalAssets is 0n " +
      "x".repeat(200);
    expect(isProgressOnlyMessage(longProgress)).toBe(true);
  });

  it("allows long messages containing incident labels even if starting with prefix", () => {
    const withLabel =
      "Now let me summarize:\n\n*Incident:* server crash\n*Evidence:* pod restarted";
    expect(isProgressOnlyMessage(withLabel)).toBe(false);
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
