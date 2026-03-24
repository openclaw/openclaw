import { describe, expect, it } from "vitest";
import {
  isProgressOnlyMessage,
  sanitizeIncidentMessage,
  shouldBlockIncidentMessage,
} from "./index.js";

describe("shouldBlockIncidentMessage", () => {
  it("blocks messages without an incident header (intermediate thinking)", () => {
    expect(shouldBlockIncidentMessage("Now let me write the fixed file.")).toBe(true);
    expect(shouldBlockIncidentMessage("Let me check the conventions.")).toBe(true);
    expect(shouldBlockIncidentMessage("Found it.")).toBe(true);
    expect(shouldBlockIncidentMessage("On it")).toBe(true);
    expect(shouldBlockIncidentMessage("The code looks correct here.")).toBe(true);
  });

  it("allows substantive free-form summaries without incident labels", () => {
    expect(
      shouldBlockIncidentMessage(
        "Now I have the complete picture. The totalRealAssets in AdaptersProvider is computed as " +
          "x".repeat(300),
      ),
    ).toBe(false);
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

  it("trims narration before the incident header and allows the summary", () => {
    const withLabel =
      "Now let me summarize:\n\n*Incident:* server crash\n*Evidence:* pod restarted";
    expect(sanitizeIncidentMessage(withLabel)).toBe(
      "*Incident:* server crash\n*Evidence:* pod restarted",
    );
    expect(shouldBlockIncidentMessage(withLabel)).toBe(false);
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

  it("trims non-summary angle-bracket tokens before the incident header", () => {
    const reply = `<https://example.com|runbook>
*Incident:* API latency spike
*Customer impact:* confirmed`;
    expect(sanitizeIncidentMessage(reply)).toBe(
      "*Incident:* API latency spike\n*Customer impact:* confirmed",
    );
    expect(shouldBlockIncidentMessage(reply)).toBe(false);
  });

  it("allows summary labels beyond just the incident label", () => {
    expect(shouldBlockIncidentMessage("*Evidence:* one fact")).toBe(false);
    expect(shouldBlockIncidentMessage("*Mitigation:* restart pod")).toBe(false);
    expect(shouldBlockIncidentMessage("*Likely cause:* memory leak")).toBe(false);
    expect(shouldBlockIncidentMessage("*Status:* resolved")).toBe(false);
  });

  it("blocks empty messages", () => {
    expect(shouldBlockIncidentMessage("")).toBe(true);
    expect(shouldBlockIncidentMessage("   ")).toBe(true);
  });

  it("allows incident replies that omit sections as long as they are not progress-only", () => {
    const reply = `*Incident:* API latency spike
*Customer impact:* confirmed`;
    expect(shouldBlockIncidentMessage(reply)).toBe(false);
  });

  it("treats partial incident summaries as non-progress replies", () => {
    const reply = `*Incident:* API latency spike
*Customer impact:* confirmed`;
    expect(isProgressOnlyMessage(reply)).toBe(false);
    expect(shouldBlockIncidentMessage(reply)).toBe(false);
  });
});
