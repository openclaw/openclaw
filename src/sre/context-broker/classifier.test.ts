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

  it("detects db-first data investigation prompts", () => {
    const intents = classifyContextBrokerIntent(
      "We have a negative APY spike and inconsistent values, query the DB and pg_stat_activity before blaming math",
    ).intents;
    expect(intents).toContain("data-integrity-investigation");
    expect(intents).toContain("postgres-internals");
  });

  it("detects title-only integrator incident prompts", () => {
    const intents = classifyContextBrokerIntent(
      "spike in APY from API reported by several integrators",
    ).intents;
    expect(intents).toContain("incident-follow-up");
    expect(intents).toContain("data-integrity-investigation");
  });

  it("detects read-consistency prompts", () => {
    expect(
      classifyContextBrokerIntent(
        "Check if Promise.all fan-out across HAProxy and replicas caused mixed freshness and read consistency drift",
      ).intents,
    ).toContain("read-consistency-incident");
  });

  it("does not classify generic routing tables as data-integrity incidents", () => {
    expect(
      classifyContextBrokerIntent("Show me the routing table for this deployment").intents,
    ).not.toContain("data-integrity-investigation");
  });
});
