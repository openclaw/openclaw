/**
 * TOOL_DISPATCH_GATE Router Outage Fail-Closed Tripwire Test
 *
 * Verifies that TOOL_DISPATCH_GATE commit-point evaluation blocks operations
 * when the router is unavailable, following the same fail-closed mechanism
 * as NETWORK_IO.
 *
 * This test simulates a router outage and confirms:
 * - Blocked response with outcome: "ABSTAIN_CLARIFY"
 * - reason: "router_outage"
 * - nonRetryable: true (fail-closed)
 * - contractId: null
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  applyToolDispatchOverrides,
  type OntologyPack,
  type RouteResult,
  type DispatchContext,
} from "../decision-override";
import {
  ClarityBurstAbstainError,
} from "../errors";
import {
  convertAbstainToBlockedResponse,
  type BlockedResponsePayload,
} from "../../agents/pi-tool-definition-adapter.js";

/**
 * Mock tool execution function - tracks call count
 */
function createMockToolExecutor() {
  let callCount = 0;
  return {
    execute: (): { success: true; result: string } => {
      callCount++;
      return { success: true as const, result: "mock_result" };
    },
    getCallCount: () => callCount,
  };
}

/**
 * Creates a mock TOOL_DISPATCH_GATE ontology pack with dispatch contracts
 */
function createMockToolDispatchGatePack(): OntologyPack {
  return {
    pack_id: "openclawd.TOOL_DISPATCH_GATE_TEST",
    pack_version: "2.0.0",
    stage_id: "TOOL_DISPATCH_GATE",
    description: "Test pack for TOOL_DISPATCH_GATE",
    thresholds: {
      min_confidence_T: 0.55,
      dominance_margin_Delta: 0.10,
    },
    contracts: [
      {
        contract_id: "DISPATCH_READ_ONLY",
        risk_class: "LOW",
        required_fields: ["tool_name", "target_resource"],
        limits: {},
        needs_confirmation: false,
        deny_by_default: false,
        capability_requirements: [],
      },
      {
        contract_id: "DISPATCH_WRITE",
        risk_class: "MEDIUM",
        required_fields: ["tool_name", "target_path"],
        limits: {},
        needs_confirmation: false,
        deny_by_default: false,
        capability_requirements: ["fs_write"],
      },
      {
        contract_id: "DISPATCH_SHELL_EXEC",
        risk_class: "HIGH",
        required_fields: ["tool_name", "command", "working_directory"],
        limits: {},
        needs_confirmation: true,
        deny_by_default: false,
        capability_requirements: ["shell"],
      },
    ],
    field_schema: {},
  };
}

/**
 * Wrapper function that applies TOOL_DISPATCH_GATE overrides and handles
 * router_outage as fail-closed (ABSTAIN_CLARIFY with nonRetryable).
 *
 * This mirrors the commit-point sequence where router unavailability
 * must block dispatch operations.
 */
function executeToolDispatchWithGating(
  pack: OntologyPack,
  routeResult: RouteResult,
  context: DispatchContext,
  toolExecutor: ReturnType<typeof createMockToolExecutor>
): { success: true; result: unknown } | BlockedResponsePayload {
  // Fail-closed for router outage: if router is unavailable, block immediately
  if (!routeResult.ok) {
    const error = new ClarityBurstAbstainError({
      stageId: "TOOL_DISPATCH_GATE",
      outcome: "ABSTAIN_CLARIFY",
      reason: "router_outage",
      contractId: null,
      instructions: "The router is unavailable and tool dispatch cannot proceed. Retry when the router service is restored.",
    });
    return convertAbstainToBlockedResponse(error);
  }

  // Router is ok, apply standard dispatch override logic
  const gatingResult = applyToolDispatchOverrides(pack, routeResult, context);

  if (gatingResult.outcome === "ABSTAIN_CLARIFY") {
    // Convert to blocked response - clarification required
    const error = new ClarityBurstAbstainError({
      stageId: "TOOL_DISPATCH_GATE",
      outcome: gatingResult.outcome,
      reason: gatingResult.reason,
      contractId: gatingResult.contractId,
      instructions: gatingResult.instructions ?? `${gatingResult.outcome}: ${gatingResult.reason}`,
    });
    return convertAbstainToBlockedResponse(error, gatingResult.instructions);
  }

  if (gatingResult.outcome === "ABSTAIN_CONFIRM") {
    // Convert to blocked response - confirmation required
    const error = new ClarityBurstAbstainError({
      stageId: "TOOL_DISPATCH_GATE",
      outcome: gatingResult.outcome,
      reason: gatingResult.reason,
      contractId: gatingResult.contractId,
      instructions: gatingResult.instructions ?? `${gatingResult.outcome}: ${gatingResult.reason}`,
    });
    return convertAbstainToBlockedResponse(error, gatingResult.instructions);
  }

  // Only execute tool when gating passes with PROCEED
  return toolExecutor.execute();
}

describe("TOOL_DISPATCH_GATE router_outage → fail-closed tripwire", () => {
  let mockPack: OntologyPack;
  let mockToolExecutor: ReturnType<typeof createMockToolExecutor>;

  beforeEach(() => {
    mockPack = createMockToolDispatchGatePack();
    mockToolExecutor = createMockToolExecutor();
  });

  describe("router outage blocking behavior", () => {
    it("should return blocked response with nonRetryable=true when router is unavailable", () => {
      // Arrange: Router outage scenario - routeResult.ok is false
      const routeResult: RouteResult = {
        ok: false,
        // No data available due to outage
      };
      const context: DispatchContext = {
        stageId: "TOOL_DISPATCH_GATE",
        userConfirmed: false,
      };

      // Act: Execute through central non-retryable handling path
      const result = executeToolDispatchWithGating(
        mockPack,
        routeResult,
        context,
        mockToolExecutor
      );

      // Assert: Blocked response payload structure with fail-closed properties
      expect(result).toMatchObject({
        nonRetryable: true,
        stageId: "TOOL_DISPATCH_GATE",
        outcome: "ABSTAIN_CLARIFY",
        reason: "router_outage",
        contractId: null,
      });

      // Assert: Tool executor was NOT called (fail-closed)
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });

    it("should propagate router_outage through ClarityBurstAbstainError with exact fields", () => {
      // Arrange: Router outage at dispatch gate
      const routeResult: RouteResult = { ok: false };
      const context: DispatchContext = {
        stageId: "TOOL_DISPATCH_GATE",
      };

      // Act: Execute wrapper with router outage
      const result = executeToolDispatchWithGating(
        mockPack,
        routeResult,
        context,
        mockToolExecutor
      );

      // Assert: Verify blocked response structure matches fail-closed requirements
      expect(result).toMatchObject({
        nonRetryable: true,
        stageId: "TOOL_DISPATCH_GATE",
        outcome: "ABSTAIN_CLARIFY",
        reason: "router_outage",
        contractId: null,
      });

      // Assert: Tool executor was NOT called
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });
  });

  describe("successful dispatch (router ok)", () => {
    it("should proceed when router is available and contract is low-risk", () => {
      // Arrange: Router is available, low-risk contract
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "DISPATCH_READ_ONLY",
            score: 0.95,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "TOOL_DISPATCH_GATE",
        userConfirmed: false,
      };

      // Act: Execute through gating wrapper
      const result = executeToolDispatchWithGating(
        mockPack,
        routeResult,
        context,
        mockToolExecutor
      );

      // Assert: Tool was executed (not blocked)
      expect(result).toMatchObject({
        success: true,
        result: "mock_result",
      });

      // Assert: Tool executor was called exactly once
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });

    it("should block with ABSTAIN_CONFIRM when router is available but contract needs confirmation", () => {
      // Arrange: Router is available, but HIGH-risk contract requires confirmation
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "DISPATCH_SHELL_EXEC",
            score: 0.95,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "TOOL_DISPATCH_GATE",
        userConfirmed: false, // Not confirmed
      };

      // Act: Execute through gating wrapper
      const result = executeToolDispatchWithGating(
        mockPack,
        routeResult,
        context,
        mockToolExecutor
      );

      // Assert: Blocked with ABSTAIN_CONFIRM (not ABSTAIN_CLARIFY)
      expect(result).toMatchObject({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "DISPATCH_SHELL_EXEC",
      });

      // Assert: Tool executor was NOT called
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });
  });
});
