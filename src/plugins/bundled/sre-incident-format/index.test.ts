import { describe, expect, it } from "vitest";
import { isProgressOnlyMessage, shouldBlockIncidentMessage } from "./index.js";

describe("shouldBlockIncidentMessage", () => {
  it("blocks messages without an incident header (intermediate thinking)", () => {
    expect(shouldBlockIncidentMessage("Now let me write the fixed file.")).toBe(true);
    expect(shouldBlockIncidentMessage("Let me check the conventions.")).toBe(true);
    expect(shouldBlockIncidentMessage("Found it.")).toBe(true);
    expect(shouldBlockIncidentMessage("On it")).toBe(true);
    expect(shouldBlockIncidentMessage("The code looks correct here.")).toBe(true);
    // Long thinking messages without labels are also blocked
    expect(
      shouldBlockIncidentMessage(
        "Now I have the complete picture. The totalRealAssets in AdaptersProvider is computed as " +
          "x".repeat(300),
      ),
    ).toBe(true);
  });

  it("allows messages with bold incident labels", () => {
    const reply = `*Incident:* Server crash
*Customer impact:* confirmed
*Status:* investigating
*Evidence:* Pod restarted 3 times`;
    expect(shouldBlockIncidentMessage(reply)).toBe(false);
  });

  it("allows messages with italic incident labels (pre-enforcement)", () => {
    const reply = `_Incident:_ Server crash
_Customer impact:_ confirmed
_Status:_ investigating
_Evidence:_ pod restarted`;
    expect(shouldBlockIncidentMessage(reply)).toBe(false);
  });

  it("blocks long messages without the incident header even if they contain analysis", () => {
    const longProgress =
      "Now let me look at the key code path for the NaN scenario — when totalAssets is 0n " +
      "x".repeat(200);
    expect(shouldBlockIncidentMessage(longProgress)).toBe(true);
  });

  it("blocks narration before the incident header", () => {
    const withLabel =
      "Now let me summarize:\n\n*Incident:* server crash\n*Evidence:* pod restarted";
    expect(shouldBlockIncidentMessage(withLabel)).toBe(true);
  });

  it("allows monitoring prefixes before the incident header", () => {
    const reply = `[[heartbeat_to:#platform-monitoring]]
<@U07KE3NALTX>
*Incident:* API latency spike
*Customer impact:* confirmed
*Status:* investigating
*Evidence:* p95 latency crossed threshold`;
    expect(shouldBlockIncidentMessage(reply)).toBe(false);
  });

  it("allows multiple Slack mention tokens before the incident header", () => {
    const reply = `<@U07KE3NALTX> <!subteam^S123|platform-oncall>
*Incident:* API latency spike
*Customer impact:* confirmed
*Status:* investigating
*Evidence:* p95 latency crossed threshold`;
    expect(shouldBlockIncidentMessage(reply)).toBe(false);
  });

  it("blocks non-mention angle-bracket tokens before the incident header", () => {
    const reply = `<https://example.com|runbook>
*Incident:* API latency spike
*Customer impact:* confirmed`;
    expect(shouldBlockIncidentMessage(reply)).toBe(true);
  });

  it("blocks messages that only contain later incident labels", () => {
    expect(shouldBlockIncidentMessage("*Evidence:* one fact")).toBe(true);
    expect(shouldBlockIncidentMessage("*Mitigation:* restart pod")).toBe(true);
    expect(shouldBlockIncidentMessage("*Likely cause:* memory leak")).toBe(true);
    expect(shouldBlockIncidentMessage("*Status:* resolved")).toBe(true);
  });

  it("blocks empty messages", () => {
    expect(shouldBlockIncidentMessage("")).toBe(true);
    expect(shouldBlockIncidentMessage("   ")).toBe(true);
  });

  it("blocks incident replies that omit required sections", () => {
    const reply = `*Incident:* API latency spike
*Customer impact:* confirmed`;
    expect(shouldBlockIncidentMessage(reply)).toBe(true);
  });

  it("treats missing sections separately from progress-only narration", () => {
    const reply = `*Incident:* API latency spike
*Customer impact:* confirmed`;
    expect(isProgressOnlyMessage(reply)).toBe(false);
    expect(shouldBlockIncidentMessage(reply)).toBe(true);
  });
});
