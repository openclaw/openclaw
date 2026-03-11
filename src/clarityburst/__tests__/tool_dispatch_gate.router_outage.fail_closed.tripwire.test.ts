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
 * - contractId: null
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  applyToolDispatchOverrides,
  type OntologyPack,
  type RouteResult,
  type DispatchContext,
} from "../decision-override.js";

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

describe("TOOL_DISPATCH_GATE router_outage → fail-closed tripwire", () => {
  let mockPack: OntologyPack;

  beforeEach(() => {
    mockPack = createMockToolDispatchGatePack();
  });

  describe("router outage blocking behavior", () => {
    it("should return ABSTAIN_CLARIFY with router_outage reason when router is unavailable", () => {
      // Arrange: Router outage scenario - routeResult.ok is false
      const routeResult: RouteResult = {
        ok: false,
        // No data available due to outage
      };
      const context: DispatchContext = {
        stageId: "TOOL_DISPATCH_GATE",
        userConfirmed: false,
      };

      // Act: Call applyToolDispatchOverrides with router unavailable
      const result = applyToolDispatchOverrides(mockPack, routeResult, context);

      // Assert: Fail-closed behavior - ABSTAIN_CLARIFY with router_outage reason
      expect(result.outcome).toBe("ABSTAIN_CLARIFY");
      if (result.outcome === "ABSTAIN_CLARIFY") {
        expect(result.reason).toBe("router_outage");
      }
      expect(result.contractId).toBeNull();
    });

    it("should propagate router_outage reason when router fails", () => {
      // Arrange: Router outage at dispatch gate
      const routeResult: RouteResult = { ok: false };
      const context: DispatchContext = {
        stageId: "TOOL_DISPATCH_GATE",
      };

      // Act: Execute with router outage
      const result = applyToolDispatchOverrides(mockPack, routeResult, context);

      // Assert: Verify fail-closed structure with exact reason
      expect(result).toMatchObject({
        outcome: "ABSTAIN_CLARIFY",
        reason: "router_outage",
        contractId: null,
      });
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

      // Act: Apply dispatch overrides with working router
      const result = applyToolDispatchOverrides(mockPack, routeResult, context);

      // Assert: Proceeds (not blocked)
      expect(result.outcome).toBe("PROCEED");
      expect(result.contractId).toBe("DISPATCH_READ_ONLY");
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

      // Act: Apply dispatch overrides with confirmation required
      const result = applyToolDispatchOverrides(mockPack, routeResult, context);

      // Assert: Blocked with ABSTAIN_CONFIRM (not ABSTAIN_CLARIFY)
      expect(result.outcome).toBe("ABSTAIN_CONFIRM");
      if (result.outcome === "ABSTAIN_CONFIRM") {
        expect(result.reason).toBe("CONFIRM_REQUIRED");
      }
      expect(result.contractId).toBe("DISPATCH_SHELL_EXEC");
    });
  });
});
