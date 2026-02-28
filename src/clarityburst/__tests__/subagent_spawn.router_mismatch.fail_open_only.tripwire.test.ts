/**
 * SUBAGENT_SPAWN Router Mismatch → FAIL-OPEN Tripwire Test
 *
 * Verifies that when routeClarityBurst returns ok:true with a contractId that
 * is NOT in the SUBAGENT_SPAWN pack (but deriveAllowedContracts still yields
 * non-empty allowlist), the system FAIL-OPENS and PROCEEDS with execution.
 *
 * This test exercises the mismatch scenario where:
 * - Pack contains: ["SPAWN_READONLY_AGENT", "SPAWN_EPHEMERAL_WORKER", ...]
 * - Router returns: ok:true, contractId: "SUBAGENT_NOT_IN_PACK"
 * - Allowed contracts are non-empty (capability check passes)
 * - System should NOT block, should call spawner (fail-open)
 *
 * This is distinct from:
 * - Empty allowlist (capability-based denial) → blocks
 * - Outage scenario → blocks
 * - Mismatch only → fail-opens
 *
 * This test invokes the REAL production path:
 * 1. createSessionsSpawnTool() creates the real production tool
 * 2. tool.execute() is called with spawn request
 * 3. routeClarityBurst is mocked to return ok:true with mismatched contractId
 * 4. deriveAllowedContracts returns non-empty array (capability passed)
 * 5. applySubagentSpawnOverrides processes the mismatch and proceeds
 * 6. Underlying callGateway spawner IS called
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSessionsSpawnTool } from "../../agents/tools/sessions-spawn-tool.js";
import * as RouterModule from "../../clarityburst/router-client.js";
import * as AllowedContractsModule from "../allowed-contracts";
import * as PackLoadModule from "../pack-load";
import * as GatewayModule from "../../gateway/call.js";
import type { BlockedResponsePayload } from "../../agents/pi-tool-definition-adapter.js";
import type { OntologyPack } from "../pack-registry";

/**
 * Helper to create a minimal valid OntologyPack mock
 */
function createMockPack(stageId: string): OntologyPack {
  return {
    pack_id: `openclawd.${stageId}_TEST`,
    pack_version: "1.0.0",
    stage_id: stageId as any,
    contracts: [
      {
        contract_id: "SPAWN_READONLY_AGENT",
        risk_class: "LOW",
        required_fields: [],
        limits: {},
        needs_confirmation: false,
        deny_by_default: false,
        capability_requirements: []
      },
      {
        contract_id: "SPAWN_EPHEMERAL_WORKER",
        risk_class: "LOW",
        required_fields: [],
        limits: {},
        needs_confirmation: false,
        deny_by_default: false,
        capability_requirements: []
      },
    ],
    thresholds: {
      min_confidence_T: 0.75,
      dominance_margin_Delta: 0.15,
    },
    field_schema: {},
  };
}

describe("SUBAGENT_SPAWN router_mismatch → fail-open tripwire", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should fail-open when router returns contractId NOT in pack (mismatch only)", async () => {
    // Arrange: Mock loadPackOrAbstain to return valid pack
    vi.spyOn(PackLoadModule, "loadPackOrAbstain").mockReturnValue(
      createMockPack("SUBAGENT_SPAWN")
    );

    // Mock routeClarityBurst to return ok:true with a contractId NOT in the pack
    const mockRouteClarityBurst = vi
      .spyOn(RouterModule, "routeClarityBurst")
      .mockResolvedValue({
        ok: true,
        data: {
          top1: {
            contract_id: "SUBAGENT_NOT_IN_PACK",
            score: 0.95,
          },
          top2: {
            contract_id: "SPAWN_READONLY_AGENT",
            score: 0.85,
          },
        },
      });

    // Ensure allowlist is non-empty (capability check passes)
    const mockDeriveAllowedContracts = vi
      .spyOn(AllowedContractsModule, "deriveAllowedContracts")
      .mockReturnValue(["SPAWN_READONLY_AGENT", "SPAWN_EPHEMERAL_WORKER"]);

    // Spy on callGateway to verify spawner is called
    const mockCallGateway = vi.spyOn(GatewayModule, "callGateway");

    // Create the real production tool
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:session:abc123",
      agentAccountId: "account-123",
      agentTo: "channel-xyz",
      agentThreadId: 42,
    });

    // Act: Execute the tool with a simple spawn request
    const result = await tool.execute("test-call-id", {
      task: "Analyze data and generate report",
      label: "test-spawn",
    });

    // Assert: System FAIL-OPENS and proceeds
    // - No blocked response returned
    expect(result).not.toHaveProperty("nonRetryable");
    expect(result).not.toHaveProperty("outcome");
    expect(result).not.toHaveProperty("reason");

    // - Router was called to get routing decision
    expect(mockRouteClarityBurst).toHaveBeenCalled();

    // - deriveAllowedContracts was called to verify capability (called with stageId, pack, caps)
    expect(mockDeriveAllowedContracts).toHaveBeenCalled();
    const deriveCall = mockDeriveAllowedContracts.mock.calls[0];
    expect(deriveCall[0]).toBe("SUBAGENT_SPAWN");

    // - The underlying spawner (callGateway for agent call) WAS called (fail-open behavior)
    const agentCallMade = mockCallGateway.mock.calls.some(
      (call) => call[0]?.method === "agent"
    );
    expect(agentCallMade).toBe(true);
  });

  it("should proceed with execution when router mismatch detected but allowlist non-empty", async () => {
    // Arrange: Mock loadPackOrAbstain to return valid pack
    vi.spyOn(PackLoadModule, "loadPackOrAbstain").mockReturnValue(
      createMockPack("SUBAGENT_SPAWN")
    );

    // Mock router mismatch
    vi.spyOn(RouterModule, "routeClarityBurst").mockResolvedValue({
      ok: true,
      data: {
        top1: {
          contract_id: "INVALID_SPAWN_CONTRACT",
          score: 0.92,
        },
        top2: {
          contract_id: "SPAWN_READONLY_AGENT",
          score: 0.82,
        },
      },
    });

    // Non-empty allowlist
    vi.spyOn(AllowedContractsModule, "deriveAllowedContracts").mockReturnValue([
      "SPAWN_READONLY_AGENT",
    ]);

    const mockCallGateway = vi.spyOn(GatewayModule, "callGateway");

    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:session:test",
      agentAccountId: "account-test",
    });

    // Act: Execute spawn request
    const result = await tool.execute("call-id-2", {
      task: "Complete background task",
    });

    // Assert: Result is NOT a blocked response (success or error tuple, not BlockedResponsePayload)
    if (typeof result === "object" && result !== null) {
      expect(result).not.toHaveProperty("nonRetryable");
      expect(result).not.toHaveProperty("stageId");
    }

    // Spawner was called at least once
    const spawnerCalls = mockCallGateway.mock.calls.filter(
      (call) => call[0]?.method === "agent"
    );
    expect(spawnerCalls.length).toBeGreaterThan(0);
  });

  it("should NOT throw ClarityBurstAbstainError on mismatch", async () => {
    // Arrange: Mock loadPackOrAbstain to return valid pack
    vi.spyOn(PackLoadModule, "loadPackOrAbstain").mockReturnValue(
      createMockPack("SUBAGENT_SPAWN")
    );

    // Mock router mismatch
    vi.spyOn(RouterModule, "routeClarityBurst").mockResolvedValue({
      ok: true,
      data: {
        top1: {
          contract_id: "MISMATCH_CONTRACT",
          score: 0.88,
        },
        top2: {
          contract_id: "SPAWN_READONLY_AGENT",
          score: 0.78,
        },
      },
    });

    // Non-empty allowlist ensures capability check passes
    vi.spyOn(AllowedContractsModule, "deriveAllowedContracts").mockReturnValue([
      "SPAWN_READONLY_AGENT",
      "SPAWN_EPHEMERAL_WORKER",
    ]);

    vi.spyOn(GatewayModule, "callGateway");

    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:session:minimal",
      agentAccountId: "account-123",
    });

    // Act & Assert: No error should be thrown
    let errorThrown = false;
    try {
      await tool.execute("call-id-3", {
        task: "Minimal spawn task",
      });
    } catch (error) {
      // Only re-throw if it's a ClarityBurstAbstainError
      if (
        error instanceof Error &&
        error.constructor.name === "ClarityBurstAbstainError"
      ) {
        errorThrown = true;
      }
    }

    expect(errorThrown).toBe(false);
  });

  it("should call spawner exactly once on mismatch (fail-open)", async () => {
    // Arrange: Mock loadPackOrAbstain to return valid pack
    vi.spyOn(PackLoadModule, "loadPackOrAbstain").mockReturnValue(
      createMockPack("SUBAGENT_SPAWN")
    );

    // Router returns mismatch contract
    vi.spyOn(RouterModule, "routeClarityBurst").mockResolvedValue({
      ok: true,
      data: {
        top1: {
          contract_id: "COMPLETELY_UNKNOWN_SPAWN_CONTRACT",
          score: 0.90,
        },
        top2: {
          contract_id: "SPAWN_READONLY_AGENT",
          score: 0.80,
        },
      },
    });

    // Non-empty allowlist
    vi.spyOn(AllowedContractsModule, "deriveAllowedContracts").mockReturnValue([
      "SPAWN_READONLY_AGENT",
    ]);

    const mockCallGateway = vi.spyOn(GatewayModule, "callGateway");

    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:session:exact",
      agentAccountId: "account-exact",
    });

    // Act: Execute spawn
    await tool.execute("call-id-exact", {
      task: "Exact spawner call test",
    });

    // Assert: Spawner called exactly once (mismatch does not block)
    const spawnerCalls = mockCallGateway.mock.calls.filter(
      (call) => call[0]?.method === "agent"
    );
    expect(spawnerCalls.length).toBe(1);
  });
});
