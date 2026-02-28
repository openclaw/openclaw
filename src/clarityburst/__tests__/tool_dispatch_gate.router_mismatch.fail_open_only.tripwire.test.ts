/**
 * TOOL_DISPATCH_GATE Router Mismatch → FAIL-OPEN Tripwire Test
 *
 * Verifies that when a router returns ok:true with a contractId that is NOT
 * in the TOOL_DISPATCH_GATE pack (but deriveAllowedContracts still yields
 * non-empty allowlist), the system FAIL-OPENS and PROCEEDS with execution.
 *
 * This test exercises the mismatch scenario where:
 * - Pack contains: ["TDG_LOW_RISK_A", "TDG_LOW_RISK_B"]
 * - Router returns: ok:true, contractId: "TDG_NOT_IN_PACK"
 * - Allowed contracts are non-empty (capability check passes)
 * - System should NOT block, should call tool executor (fail-open)
 *
 * This is distinct from:
 * - Empty allowlist (capability-based denial) → blocks
 * - Outage scenario → blocks
 * - Mismatch only → fail-opens
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
 * Creates a mock TOOL_DISPATCH_GATE pack with dispatch contracts
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
 * must block dispatch operations. Mismatch detection is handled by
 * applyToolDispatchOverrides() which fail-opens on contract mismatches.
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

describe("TOOL_DISPATCH_GATE router_mismatch → FAIL-OPEN tripwire", () => {
   let mockPack: OntologyPack;
   let mockToolExecutor: ReturnType<typeof createMockToolExecutor>;

   beforeEach(() => {
     mockPack = createMockToolDispatchGatePack();
     mockToolExecutor = createMockToolExecutor();
   });

  describe("router mismatch fail-open behavior", () => {
    it("should fail-open when router returns contractId NOT in pack (mismatch only)", () => {
      // Arrange: Router returns a contract that does NOT exist in the pack
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "ROUTER_MISMATCH_CONTRACT",
            score: 0.95,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "TOOL_DISPATCH_GATE",
        userConfirmed: false,
      };

      // Act: Execute through real gating wrapper with mismatch injected
      const result = executeToolDispatchWithGating(
        mockPack,
        routeResult,
        context,
        mockToolExecutor
      );

      // Assert: System FAIL-OPENS and proceeds
      // - No blocked response returned
      expect(result).not.toHaveProperty("nonRetryable");
      expect(result).not.toHaveProperty("outcome");
      expect(result).not.toHaveProperty("reason");

      // - Result is success object
      expect(result).toMatchObject({
        success: true,
        result: "mock_result",
      });

      // Assert: Tool executor WAS called (fail-open behavior)
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });

    it("should proceed when router returns valid contractId in pack", () => {
      // Arrange: Router returns a contract that IS in the pack (valid case)
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

      // Assert: System proceeds normally
      expect(result).toMatchObject({
        success: true,
        result: "mock_result",
      });

      // Tool executor was called exactly once
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });

    it("should NOT throw ClarityBurstAbstainError on mismatch", () => {
      // Arrange: Router returns a mismatch contract
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "ROUTER_MISMATCH_CONTRACT",
            score: 0.95,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "TOOL_DISPATCH_GATE",
        userConfirmed: false,
      };

      // Act & Assert: No error should be thrown
      expect(() => {
        executeToolDispatchWithGating(
          mockPack,
          routeResult,
          context,
          mockToolExecutor
        );
      }).not.toThrow(ClarityBurstAbstainError);
    });

    it("should call tool executor exactly once on mismatch (fail-open)", () => {
      // Arrange: Router returns a mismatch contract
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "COMPLETELY_UNKNOWN_CONTRACT",
            score: 0.95,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "TOOL_DISPATCH_GATE",
        userConfirmed: false,
      };

      // Act
      executeToolDispatchWithGating(
        mockPack,
        routeResult,
        context,
        mockToolExecutor
      );

      // Assert: Executor called exactly once
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });
  });
});
