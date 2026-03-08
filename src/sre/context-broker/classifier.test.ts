import { describe, expect, it } from "vitest";
import { classifyContextBrokerIntent } from "./classifier.js";

describe("classifyContextBrokerIntent", () => {
  it("detects prior-work prompts", () => {
    expect(
      classifyContextBrokerIntent("What did we decide last time about this rollout?").intents,
    ).toContain("prior-work");
  });

  it("detects incident follow-up prompts", () => {
    expect(
      classifyContextBrokerIntent("Follow-up on this incident RCA and customer impact").intents,
    ).toContain("incident-follow-up");
  });

  it("detects ownership and multi-repo planning prompts", () => {
    const intents = classifyContextBrokerIntent(
      "Plan the fix across repos and tell me which repo owns the helm values for this deployment",
    ).intents;
    expect(intents).toContain("repo-deploy-ownership");
    expect(intents).toContain("multi-repo-fix-planning");
  });
});
