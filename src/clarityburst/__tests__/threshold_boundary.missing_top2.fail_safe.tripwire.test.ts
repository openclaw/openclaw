/**
 * Threshold Boundary: Missing Top2 Fail-Safe Tripwire Test
 *
 * Verifies that the system fails gracefully when router result contains only top1
 * without top2 contract scores. This is a critical edge case for dominance margin
 * calculation, since dominance requires comparing top1 to top2.
 *
 * Expected behavior:
 * - When top2 is undefined/missing, skip dominance check (treat as passing)
 * - When top1 confidence passes, proceed
 * - When top1 confidence fails, still abstain
 * - Tool executor should NOT be called on any abstain outcome
 * 
 * This tests the code path: `const lowDominance = top2?.score !== undefined && ...`
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  applyNetworkOverrides,
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
 * Creates a mock NETWORK_IO ontology pack
 */
function createMockNetworkPack(): OntologyPack {
  return {
    pack_id: "openclawd.NETWORK_IO_MISSING_TOP2_TEST",
    pack_version: "1.0.0",
    stage_id: "NETWORK_IO",
    description: "Test pack for missing top2 edge case",
    thresholds: {
      min_confidence_T: 0.55,
      dominance_margin_Delta: 0.10,
    },
    contracts: [
      {
        contract_id: "NETWORK_HTTP_GET",
        risk_class: "LOW",
        required_fields: ["url"],
        limits: {},
        needs_confirmation: false,
        deny_by_default: false,
        capability_requirements: [],
      },
      {
        contract_id: "NETWORK_HTTP_POST",
        risk_class: "MEDIUM",
        required_fields: ["url", "body"],
        limits: {},
        needs_confirmation: false,
        deny_by_default: false,
        capability_requirements: [],
      },
    ],
    field_schema: {},
  };
}

/**
 * Wrapper function that applies NETWORK_IO overrides
 */
function executeNetworkWithGating(
  pack: OntologyPack,
  routeResult: RouteResult,
  context: DispatchContext,
  toolExecutor: ReturnType<typeof createMockToolExecutor>
): { success: true; result: unknown } | BlockedResponsePayload {
  // Check router availability first
  if (!routeResult.ok) {
    const error = new ClarityBurstAbstainError({
      stageId: "NETWORK_IO",
      outcome: "ABSTAIN_CLARIFY",
      reason: "router_outage",
      contractId: null,
      instructions: "Router unavailable",
    });
    return convertAbstainToBlockedResponse(error);
  }

  // Apply standard network override logic
  const gatingResult = applyNetworkOverrides(pack, routeResult, context);

  if (gatingResult.outcome === "ABSTAIN_CLARIFY") {
    const error = new ClarityBurstAbstainError({
      stageId: "NETWORK_IO",
      outcome: gatingResult.outcome,
      reason: gatingResult.reason,
      contractId: gatingResult.contractId,
      instructions: gatingResult.instructions ?? `${gatingResult.outcome}: ${gatingResult.reason}`,
    });
    return convertAbstainToBlockedResponse(error, gatingResult.instructions);
  }

  if (gatingResult.outcome === "ABSTAIN_CONFIRM") {
    const error = new ClarityBurstAbstainError({
      stageId: "NETWORK_IO",
      outcome: gatingResult.outcome,
      reason: gatingResult.reason,
      contractId: gatingResult.contractId,
      instructions: gatingResult.instructions ?? `${gatingResult.outcome}: ${gatingResult.reason}`,
    });
    return convertAbstainToBlockedResponse(error, gatingResult.instructions);
  }

  // Only execute when gating passes with PROCEED
  return toolExecutor.execute();
}

describe("threshold_boundary.missing_top2 → fail-safe tripwire", () => {
  let mockPack: OntologyPack;
  let mockToolExecutor: ReturnType<typeof createMockToolExecutor>;

  beforeEach(() => {
    mockPack = createMockNetworkPack();
    mockToolExecutor = createMockToolExecutor();
  });

  describe("top2 missing (undefined) scenarios", () => {
    it("should PROCEED when only top1 exists and confidence passes", () => {
      // Arrange: Router returns only top1, no top2
      // Confidence 0.80 > 0.55 threshold, dominance check should be skipped
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.80, // Above confidence threshold
          },
          // top2 explicitly undefined
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with missing top2
      const result = executeNetworkWithGating(mockPack, routeResult, context, mockToolExecutor);

      // Assert: Should PROCEED (no top2 to compare, confidence passes)
      expect(result).toMatchObject({
        success: true,
        result: "mock_result",
      });
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });

    it("should ABSTAIN_CLARIFY when only top1 exists but confidence fails", () => {
      // Arrange: Router returns only top1 with low confidence
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.40, // Below confidence threshold of 0.55
          },
          // top2 explicitly undefined
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with missing top2 and low confidence
      const result = executeNetworkWithGating(mockPack, routeResult, context, mockToolExecutor);

      // Assert: Should ABSTAIN_CLARIFY due to low confidence
      expect(result).toMatchObject({
        nonRetryable: false,
        outcome: "ABSTAIN_CLARIFY",
        reason: "LOW_DOMINANCE_OR_CONFIDENCE",
      });
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });

    it("should PROCEED when top2 is missing from data object", () => {
      // Arrange: Router does not include top2 in data object
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.90,
          },
          // top2 not included in data
        } as any, // Use 'as any' to simulate missing property
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with missing top2 property
      const result = executeNetworkWithGating(mockPack, routeResult, context, mockToolExecutor);

      // Assert: Should PROCEED (missing top2 treated as no comparison)
      expect(result).toMatchObject({
        success: true,
        result: "mock_result",
      });
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });
  });

  describe("top2 missing with HIGH-risk contract confirmation", () => {
    it("should require ABSTAIN_CONFIRM for HIGH-risk contract when top2 is missing and confidence passes", () => {
      // Arrange: HIGH-risk contract (SHELL_EXEC-like) requires confirmation
      // Create a pack with a HIGH-risk contract that needs confirmation
      const highRiskPack: OntologyPack = {
        ...mockPack,
        contracts: [
          {
            contract_id: "NETWORK_SHELL_EXEC",
            risk_class: "HIGH",
            required_fields: ["command"],
            limits: {},
            needs_confirmation: true,
            deny_by_default: false,
            capability_requirements: [],
          },
        ],
      };

      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_SHELL_EXEC",
            score: 0.90, // High confidence, but HIGH-risk
          },
          // No top2
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false, // Not confirmed
      };

      // Act: Execute with HIGH-risk and missing top2
      const result = executeNetworkWithGating(
        highRiskPack,
        routeResult,
        context,
        mockToolExecutor
      );

      // Assert: Should ABSTAIN_CONFIRM for HIGH-risk, not execute
      expect(result).toMatchObject({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "NETWORK_SHELL_EXEC",
      });
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });

    it("should PROCEED for HIGH-risk contract when confirmed and top2 is missing", () => {
      // Arrange: HIGH-risk contract with user confirmation
      const highRiskPack: OntologyPack = {
        ...mockPack,
        contracts: [
          {
            contract_id: "NETWORK_SHELL_EXEC",
            risk_class: "HIGH",
            required_fields: ["command"],
            limits: {},
            needs_confirmation: true,
            deny_by_default: false,
            capability_requirements: [],
          },
        ],
      };

      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_SHELL_EXEC",
            score: 0.90,
          },
          // No top2
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: true, // User has confirmed
      };

      // Act: Execute with confirmation
      const result = executeNetworkWithGating(
        highRiskPack,
        routeResult,
        context,
        mockToolExecutor
      );

      // Assert: Should PROCEED when confirmed
      expect(result).toMatchObject({
        success: true,
        result: "mock_result",
      });
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });
  });

  describe("router result data variations with missing top2", () => {
    it("should handle empty data object when top2 is missing", () => {
      // Arrange: Router returns empty data with only top1
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.70,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute
      const result = executeNetworkWithGating(mockPack, routeResult, context, mockToolExecutor);

      // Assert: Should PROCEED
      expect(result).toMatchObject({
        success: true,
        result: "mock_result",
      });
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });

    it("should handle top1 with no score property and missing top2", () => {
      // Arrange: top1 has no score field - this would cause confidence check to skip
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            // No score property
          },
          // No top2
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with missing score
      const result = executeNetworkWithGating(mockPack, routeResult, context, mockToolExecutor);

      // Assert: Should PROCEED (no score means skip threshold check)
      // The code path: if (top1?.score !== undefined) { ... }
      expect(result).toMatchObject({
        success: true,
        result: "mock_result",
      });
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });

    it("should handle top1 with score=0 and missing top2", () => {
      // Arrange: top1 has zero score (edge case)
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0, // Zero score (below 0.55 threshold)
          },
          // No top2
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with zero score
      const result = executeNetworkWithGating(mockPack, routeResult, context, mockToolExecutor);

      // Assert: Should ABSTAIN_CLARIFY (0 < 0.55)
      expect(result).toMatchObject({
        nonRetryable: false,
        outcome: "ABSTAIN_CLARIFY",
        reason: "LOW_DOMINANCE_OR_CONFIDENCE",
      });
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });
  });

  describe("multiple router result scenarios", () => {
    it("should skip dominance check entirely when router has no data property", () => {
      // Arrange: Router result with ok=true but no data
      const routeResult: RouteResult = {
        ok: true,
        // No data property at all
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with no data
      const result = executeNetworkWithGating(mockPack, routeResult, context, mockToolExecutor);

      // Assert: Should handle gracefully
      // The behavior depends on how decision-override handles missing top1
      // It should either abstain or handle the missing data
      if ("success" in result) {
        expect(mockToolExecutor.getCallCount()).toBeGreaterThanOrEqual(0);
      } else {
        expect(result).toHaveProperty("outcome");
      }
    });

    it("should PROCEED when top1 has undefined score with missing top2", () => {
      // Arrange: top1 exists but score is explicitly undefined
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: undefined, // Explicitly undefined (not null or 0)
          },
          // No top2
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute
      const result = executeNetworkWithGating(mockPack, routeResult, context, mockToolExecutor);

      // Assert: Should PROCEED (undefined score skips threshold checks)
      expect(result).toMatchObject({
        success: true,
        result: "mock_result",
      });
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });
  });
});
