import { describe, expect, it } from "vitest";
import { isProgressOnlyMessage } from "./index.js";

describe("isProgressOnlyMessage", () => {
  it("blocks messages without incident labels (intermediate thinking)", () => {
    expect(isProgressOnlyMessage("Now let me write the fixed file.")).toBe(true);
    expect(isProgressOnlyMessage("Let me check the conventions.")).toBe(true);
    expect(isProgressOnlyMessage("Found it.")).toBe(true);
    expect(isProgressOnlyMessage("On it")).toBe(true);
    expect(isProgressOnlyMessage("The code looks correct here.")).toBe(true);
    // Long thinking messages without labels are also blocked
    expect(
      isProgressOnlyMessage(
        "Now I have the complete picture. The totalRealAssets in AdaptersProvider is computed as " +
          "x".repeat(300),
      ),
    ).toBe(true);
  });

  it("allows messages with bold incident labels", () => {
    const reply = `*Incident:* Server crash
*Customer impact:* confirmed
*Evidence:* Pod restarted 3 times`;
    expect(isProgressOnlyMessage(reply)).toBe(false);
  });

  it("allows messages with italic incident labels (pre-enforcement)", () => {
    const reply = `_Incident:_ Server crash
_Customer impact:_ confirmed`;
    expect(isProgressOnlyMessage(reply)).toBe(false);
  });

  it("blocks long messages without labels even if they contain analysis", () => {
    const longProgress =
      "Now let me look at the key code path for the NaN scenario — when totalAssets is 0n " +
      "x".repeat(200);
    expect(isProgressOnlyMessage(longProgress)).toBe(true);
  });

  it("allows messages containing incident labels regardless of prefix", () => {
    const withLabel =
      "Now let me summarize:\n\n*Incident:* server crash\n*Evidence:* pod restarted";
    expect(isProgressOnlyMessage(withLabel)).toBe(false);
  });

  it("allows messages with any single incident label", () => {
    expect(isProgressOnlyMessage("*Evidence:* one fact")).toBe(false);
    expect(isProgressOnlyMessage("*Mitigation:* restart pod")).toBe(false);
    expect(isProgressOnlyMessage("*Likely cause:* memory leak")).toBe(false);
    expect(isProgressOnlyMessage("*Status:* resolved")).toBe(false);
  });

  it("blocks empty messages", () => {
    expect(isProgressOnlyMessage("")).toBe(true);
    expect(isProgressOnlyMessage("   ")).toBe(true);
  });
});
