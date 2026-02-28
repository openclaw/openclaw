/**
 * SUBAGENT_SPAWN Empty Allowlist → Abstain/Clarify Tripwire Test
 *
 * Verifies that SUBAGENT_SPAWN tool execution returns ABSTAIN_CLARIFY with
 * nonRetryable=true when deriveAllowedContracts returns an empty array during
 * SUBAGENT_SPAWN gating (indicating policy is incomplete/unvetted).
 *
 * This test invokes the REAL production path:
 * 1. createSessionsSpawnTool() creates the real production tool
 * 2. tool.execute() is called with spawn request
 * 3. deriveAllowedContracts("SUBAGENT_SPAWN") is mocked to return []
 * 4. The gating logic detects empty allowlist and returns BlockedResponsePayload
 * 5. Underlying callGateway spawner is NOT called
 *
 * Mock mechanism:
 * - vi.spyOn(AllowedContractsModule, "deriveAllowedContracts").mockReturnValue([])
 * - Simulates policy where no contracts are allowed for SUBAGENT_SPAWN stage
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
import * as AllowedContractsModule from "../allowed-contracts";
import * as GatewayModule from "../../gateway/call.js";
import type { BlockedResponsePayload } from "../../agents/pi-tool-definition-adapter.js";

describe("SUBAGENT_SPAWN empty_allowlist → abstain_clarify tripwire", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should block subagent spawn and return nonRetryable=true when allowlist is empty", async () => {
    // Arrange: Mock deriveAllowedContracts to return empty array for SUBAGENT_SPAWN
    const mockDeriveAllowedContracts = vi
      .spyOn(AllowedContractsModule, "deriveAllowedContracts")
      .mockReturnValue([]);

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

    // Assert: deriveAllowedContracts was called to trigger the gating check
    expect(mockDeriveAllowedContracts).toHaveBeenCalledWith("SUBAGENT_SPAWN");

    // Assert: The underlying spawner (callGateway for agent call) was NOT called
    const agentCallMade = mockCallGateway.mock.calls.some(
      (call) => call[0]?.method === "agent"
    );
    expect(agentCallMade).toBe(false);
  });

  it("should return blocked response with exact empty_allowlist fields", async () => {
    // Arrange: Mock deriveAllowedContracts to return empty array
    vi.spyOn(AllowedContractsModule, "deriveAllowedContracts").mockReturnValue(
      []
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

    // Assert: Verify blocked response structure matches empty_allowlist requirements
    expect(result).toEqual({
      nonRetryable: true,
      stageId: "SUBAGENT_SPAWN",
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: expect.any(String),
    } as BlockedResponsePayload);
  });

  it("should not invoke callGateway when allowlist is empty", async () => {
    // Arrange: Mock deriveAllowedContracts to return empty array
    vi.spyOn(AllowedContractsModule, "deriveAllowedContracts").mockReturnValue(
      []
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
    // If allowlist is empty (policy incomplete), the tool should not reach the spawn invocation point
    expect(mockCallGateway).not.toHaveBeenCalled();
  });
});
