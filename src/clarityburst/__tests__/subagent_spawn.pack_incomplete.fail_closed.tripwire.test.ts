/**
 * SUBAGENT_SPAWN Pack Incomplete → Fail-Closed Tripwire Test
 *
 * Verifies that SUBAGENT_SPAWN tool execution fails closed when loadPackOrAbstain("SUBAGENT_SPAWN")
 * throws ClarityBurstAbstainError due to an incomplete/malformed pack policy.
 *
 * This test invokes the REAL production path:
 * 1. createSessionsSpawnTool() creates the real production tool
 * 2. tool.execute() is called with spawn request
 * 3. loadPackOrAbstain("SUBAGENT_SPAWN") is mocked to throw ClarityBurstAbstainError
 * 4. The error is caught and converted to BlockedResponsePayload
 * 5. Underlying callGateway spawner is NOT called
 *
 * Mock mechanism:
 * - vi.spyOn(packLoadModule, "loadPackOrAbstain").mockImplementation(...)
 * - Throws ClarityBurstAbstainError with reason="PACK_POLICY_INCOMPLETE"
 *
 * Assertions:
 * - tool.execute returns BlockedResponsePayload with:
 *   - nonRetryable === true
 *   - outcome === "ABSTAIN_CLARIFY"
 *   - reason === "PACK_POLICY_INCOMPLETE"
 *   - contractId === null
 *   - stageId === "SUBAGENT_SPAWN"
 * - callGateway is NOT called (no spawner invocation)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSessionsSpawnTool } from "../../agents/tools/sessions-spawn-tool.js";
import * as PackLoadModule from "../pack-load";
import * as GatewayModule from "../../gateway/call.js";
import {
  ClarityBurstAbstainError,
} from "../errors";
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
    contracts: [],
    thresholds: {
      min_confidence_T: 0.75,
      dominance_margin_Delta: 0.15,
    },
    field_schema: {},
  };
}

describe("SUBAGENT_SPAWN pack_incomplete → fail-closed tripwire", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should block subagent spawn and return nonRetryable=true when pack is incomplete", async () => {
    // Arrange: Mock loadPackOrAbstain to throw ClarityBurstAbstainError with PACK_POLICY_INCOMPLETE
    const incompletePackError = new ClarityBurstAbstainError({
      stageId: "SUBAGENT_SPAWN",
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: "Pack validation failed for stage \"SUBAGENT_SPAWN\"",
    });

    const mockLoadPackOrAbstain = vi
      .spyOn(PackLoadModule, "loadPackOrAbstain")
      .mockImplementation((stageId) => {
        if (stageId === "SUBAGENT_SPAWN") {
          throw incompletePackError;
        }
        // For other stages, return a valid mock pack
        return createMockPack(stageId);
      });

    // Spy on callGateway to ensure spawner is NOT called
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
      agentId: "assistant",
    });

    // Assert: Result is a blocked response payload
    expect(result).toMatchObject({
      nonRetryable: true,
      stageId: "SUBAGENT_SPAWN",
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
    } as Partial<BlockedResponsePayload>);

    // Assert: loadPackOrAbstain was called to trigger the gating check
    expect(mockLoadPackOrAbstain).toHaveBeenCalledWith("SUBAGENT_SPAWN");

    // Assert: The underlying spawner (callGateway for agent call) was NOT called
    // Only pre-spawn callGateway calls for model patching might occur, but
    // the main agent call should not proceed due to the blocked response
    const agentCallMade = mockCallGateway.mock.calls.some(
      (call) => call[0]?.method === "agent"
    );
    expect(agentCallMade).toBe(false);
  });

  it("should return blocked response with exact pack_incomplete fields", async () => {
    // Arrange: Mock loadPackOrAbstain to throw pack incomplete error
    const packError = new ClarityBurstAbstainError({
      stageId: "SUBAGENT_SPAWN",
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: "Pack validation failed for stage \"SUBAGENT_SPAWN\"",
    });

    vi.spyOn(PackLoadModule, "loadPackOrAbstain").mockImplementation(
      (stageId) => {
        if (stageId === "SUBAGENT_SPAWN") {
          throw packError;
        }
        return createMockPack(stageId);
      }
    );

    vi.spyOn(GatewayModule, "callGateway");

    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:session:test",
      agentAccountId: "account-test",
    });

    // Act: Execute spawn request
    const result = await tool.execute("call-id-2", {
      task: "Complete background task",
    });

    // Assert: Verify blocked response structure matches fail-closed requirements
    expect(result).toEqual({
      nonRetryable: true,
      stageId: "SUBAGENT_SPAWN",
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: expect.any(String),
    } as BlockedResponsePayload);

    // Assert: instructions field exists and is non-empty
    if ("instructions" in result) {
      expect(result.instructions).toMatch(
        /pack|validation|policy|incomplete/i
      );
    }
  });

  it("should not invoke callGateway when pack is incomplete", async () => {
    // Arrange: Mock loadPackOrAbstain to throw pack incomplete error
    vi.spyOn(PackLoadModule, "loadPackOrAbstain").mockImplementation(
      (stageId) => {
        if (stageId === "SUBAGENT_SPAWN") {
          throw new ClarityBurstAbstainError({
            stageId: "SUBAGENT_SPAWN",
            outcome: "ABSTAIN_CLARIFY",
            reason: "PACK_POLICY_INCOMPLETE",
            contractId: null,
            instructions: "Pack validation failed for stage \"SUBAGENT_SPAWN\"",
          });
        }
        return createMockPack(stageId);
      }
    );

    const mockCallGateway = vi.spyOn(GatewayModule, "callGateway");

    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:session:minimal",
      agentAccountId: "account-123",
    });

    // Act: Execute spawn request
    await tool.execute("call-id-3", {
      task: "Minimal spawn task",
      agentId: "worker",
    });

    // Assert: callGateway should not have been called for the actual spawn
    // If pack is incomplete, the tool should not reach the spawn invocation point
    expect(mockCallGateway).not.toHaveBeenCalled();
  });
});
