/**
 * ULS Hub — Unit Tests
 */

import { describe, expect, it, afterEach } from "vitest";
import { UlsHub } from "./hub.js";
import { DEFAULT_ULS_CONFIG, ULS_SCHEMA_VERSION } from "./types.js";
import type { UlsConfig } from "./types.js";

function makeConfig(overrides?: Partial<UlsConfig>): UlsConfig {
  return {
    ...DEFAULT_ULS_CONFIG,
    enabled: true,
    storagePath: "", // in-memory
    ...overrides,
  };
}

describe("UlsHub", () => {
  let hub: UlsHub;

  afterEach(async () => {
    if (hub) {
      await hub.close();
    }
  });

  it("encodes u_t into a ULS record with sanitized p_public", async () => {
    hub = new UlsHub(makeConfig());
    const record = await hub.encode(
      {
        modality: "tool_result",
        toolName: "web_search",
        status: "success",
        summary: "Found results",
        result: "Raw output with api_key=sk-secret12345678901234",
        sourceTool: "web_search",
      },
      "agent-a",
    );

    expect(record.schemaVersion).toBe(ULS_SCHEMA_VERSION);
    expect(record.agentId).toBe("agent-a");
    expect(record.modality).toBe("tool_result");
    // p_public should not contain the secret
    expect(JSON.stringify(record.pPublic)).not.toContain("sk-secret");
    expect(record.riskFlags).toContain("credential_leak");
    expect(record.provenance.sourceTool).toBe("web_search");
    expect(record.provenance.inputHash).toBeTruthy();
  });

  it("project() returns p_public", async () => {
    hub = new UlsHub(makeConfig());
    const record = await hub.encode(
      { modality: "plan_step", step: "Deploy v2", goal: "Release" },
      "agent-a",
    );
    const projected = hub.project(record);
    expect(projected).toEqual(record.pPublic);
  });

  it("stores and retrieves records respecting scope", async () => {
    hub = new UlsHub(
      makeConfig({
        allowedScopes: {
          "agent-a": ["self", "team", "global"],
          "agent-b": ["self", "team"],
        },
        teamGroups: { devs: ["agent-a", "agent-b"] },
      }),
    );

    // Agent A stores a global record
    const record = await hub.encode(
      {
        modality: "tool_result",
        toolName: "deploy",
        summary: "Deployed service X successfully",
        status: "success",
        scope: "global",
        tags: ["deployment"],
      },
      "agent-a",
    );
    record.scope = "global";
    await hub.store(record);

    // Agent B retrieves
    const result = await hub.retrieve({
      agentId: "agent-b",
      query: "deployment service",
      scope: "team",
      topK: 5,
    });
    expect(result.records.length).toBe(1);
    expect(result.records[0].pPublic).toBeDefined();
  });

  it("denies storage at unauthorized scope", async () => {
    hub = new UlsHub(makeConfig());
    const record = await hub.encode({ modality: "system_event", summary: "test" }, "agent-a");
    record.scope = "global"; // not authorized

    await expect(hub.store(record)).rejects.toThrow("not authorized");
  });

  it("stores contradiction updates", async () => {
    hub = new UlsHub(
      makeConfig({
        teamGroups: { devs: ["agent-a", "agent-b"] },
      }),
    );

    await hub.contradictionUpdate(
      "agent-a",
      {
        contradictionType: "tool_failure",
        tensionScore: 0.7,
        parties: ["agent-a"],
        synthesisHint: "Service unavailable",
      },
      { description: "Deploy failed due to timeout" },
    );

    const store = hub.getStore();
    const records = store.getAllRecords();
    expect(records.length).toBe(1);
    expect(records[0].modality).toBe("contradiction");
    expect(records[0].tags).toContain("contradiction");
    expect(records[0].tags).toContain("tool_failure");
  });

  it("consensus update stores as system_event", async () => {
    hub = new UlsHub(
      makeConfig({
        allowedScopes: { "agent-a": ["self", "team", "global"] },
      }),
    );

    await hub.consensusUpdate({
      proposalId: "prop-1",
      agentId: "agent-a",
      vote: "approve",
      rationale: "Looks good",
    });

    const store = hub.getStore();
    expect(store.size).toBe(1);
  });
});
