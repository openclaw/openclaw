/**
 * SUBAGENT_SPAWN Router Outage Fail-Closed Tripwire Test
 *
 * Verifies that SUBAGENT_SPAWN commit-point evaluation blocks subagent creation
 * when the router is unavailable, following the same fail-closed mechanism
 * as NETWORK_IO and FILE_SYSTEM_OPS.
 *
 * This test validates the production gating path:
 * 1. createSessionsSpawnTool() creates the real production tool
 * 2. tool.execute() is called with test arguments
 * 3. routeClarityBurst is mocked to return an outage result (ok: false)
 * 4. applySubagentSpawnOverrides throws ClarityBurstAbstainError
 * 5. convertAbstainToBlockedResponse converts to blocked response
 * 6. Underlying callGateway spawner is NOT called
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSessionsSpawnTool } from "../../agents/tools/sessions-spawn-tool.js";
import * as RouterModule from "../../clarityburst/router-client.js";
import * as GatewayModule from "../../gateway/call.js";
import type { BlockedResponsePayload } from "../../agents/pi-tool-definition-adapter.js";

describe("SUBAGENT_SPAWN router_outage → fail-closed tripwire", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should block subagent spawn and return nonRetryable=true when router is unavailable", async () => {
    // Arrange: Mock routeClarityBurst to return outage (ok: false)
    const mockRouteClarityBurst = vi
      .spyOn(RouterModule, "routeClarityBurst")
      .mockResolvedValue({
        ok: false,
        error: "Router service unavailable",
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
      reason: "router_outage",
      contractId: null,
    } as Partial<BlockedResponsePayload>);

    // Assert: Router was called to trigger the gating check
    expect(mockRouteClarityBurst).toHaveBeenCalled();

    // Assert: The underlying spawner (callGateway for agent call) was NOT called
    // Only pre-spawn callGateway calls for model patching might occur, but
    // the main agent call should not proceed due to the blocked response
    const agentCallMade = mockCallGateway.mock.calls.some(
      (call) => call[0]?.method === "agent"
    );
    expect(agentCallMade).toBe(false);
  });

  it("should return blocked response with exact router_outage fields", async () => {
    // Arrange: Mock router outage
    vi.spyOn(RouterModule, "routeClarityBurst").mockResolvedValue({
      ok: false,
      error: "Router service unavailable",
    });

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
      reason: "router_outage",
      contractId: null,
      instructions: expect.any(String),
    } as BlockedResponsePayload);

    // Assert: instructions field exists and is non-empty
    if ("instructions" in result) {
      expect(result.instructions).toMatch(/router|unavailable|try again/i);
    }
  });
});
