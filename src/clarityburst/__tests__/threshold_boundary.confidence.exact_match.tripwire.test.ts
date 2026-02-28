/**
 * Threshold Boundary: Confidence Exact Match Tripwire Test
 *
 * Verifies that the confidence threshold boundary is correctly enforced at the exact match point.
 * Tests the condition: lowConfidence = top1Score < minConfidenceT
 *
 * This ensures:
 * - Score EXACTLY AT threshold → PROCEED (not ABSTAIN_CLARIFY)
 * - Score BELOW threshold → ABSTAIN_CLARIFY (fail-closed)
 * - Score ABOVE threshold → PROCEED
 * 
 * Uses NETWORK_IO stage as the test vehicle since it has explicit threshold checking.
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
 * Creates a mock NETWORK_IO ontology pack with specific thresholds
 */
function createMockNetworkPack(minConfidenceT: number): OntologyPack {
  return {
    pack_id: "openclawd.NETWORK_IO_CONFIDENCE_BOUNDARY_TEST",
    pack_version: "1.0.0",
    stage_id: "NETWORK_IO",
    description: "Test pack for confidence threshold boundary",
    thresholds: {
      min_confidence_T: minConfidenceT,
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
 * Wrapper function that applies NETWORK_IO overrides and returns blocked response on abstain
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

describe("threshold_boundary.confidence.exact_match → tripwire", () => {
  let mockToolExecutor: ReturnType<typeof createMockToolExecutor>;

  beforeEach(() => {
    mockToolExecutor = createMockToolExecutor();
  });

  describe("confidence threshold at 0.55 boundary", () => {
    it("should PROCEED when score is exactly at threshold (0.55)", () => {
      // Arrange: Confidence score EXACTLY at min_confidence_T
      const pack = createMockNetworkPack(0.55);
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.55, // EXACT match to threshold
          },
          top2: {
            contract_id: "NETWORK_HTTP_POST",
            score: 0.40,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with exact boundary score
      const result = executeNetworkWithGating(pack, routeResult, context, mockToolExecutor);

      // Assert: Should PROCEED (not abstain) since score is NOT < threshold
      expect(result).toMatchObject({
        success: true,
        result: "mock_result",
      });
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });

    it("should ABSTAIN_CLARIFY when score is just below threshold (0.5499...)", () => {
      // Arrange: Confidence score just below threshold
      const pack = createMockNetworkPack(0.55);
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.5499, // Just below threshold
          },
          top2: {
            contract_id: "NETWORK_HTTP_POST",
            score: 0.40,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with sub-boundary score
      const result = executeNetworkWithGating(pack, routeResult, context, mockToolExecutor);

      // Assert: Should ABSTAIN_CLARIFY due to low confidence
      expect(result).toMatchObject({
        nonRetryable: false,
        outcome: "ABSTAIN_CLARIFY",
        reason: "LOW_DOMINANCE_OR_CONFIDENCE",
      });
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });

    it("should PROCEED when score is above threshold (0.5501...)", () => {
      // Arrange: Confidence score just above threshold
      const pack = createMockNetworkPack(0.55);
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.5501, // Just above threshold
          },
          top2: {
            contract_id: "NETWORK_HTTP_POST",
            score: 0.40,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with super-boundary score
      const result = executeNetworkWithGating(pack, routeResult, context, mockToolExecutor);

      // Assert: Should PROCEED since score is > threshold
      expect(result).toMatchObject({
        success: true,
        result: "mock_result",
      });
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });
  });

  describe("confidence threshold at 0.75 boundary (high confidence)", () => {
    it("should PROCEED when score is exactly at high threshold (0.75)", () => {
      // Arrange: High confidence threshold
      const pack = createMockNetworkPack(0.75);
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.75, // EXACT match to high threshold
          },
          top2: {
            contract_id: "NETWORK_HTTP_POST",
            score: 0.60,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with exact high boundary score
      const result = executeNetworkWithGating(pack, routeResult, context, mockToolExecutor);

      // Assert: Should PROCEED
      expect(result).toMatchObject({
        success: true,
        result: "mock_result",
      });
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });

    it("should ABSTAIN_CLARIFY when score is below high threshold (0.7499...)", () => {
      // Arrange: Confidence score just below high threshold
      const pack = createMockNetworkPack(0.75);
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.7499, // Just below high threshold
          },
          top2: {
            contract_id: "NETWORK_HTTP_POST",
            score: 0.60,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with sub-high-boundary score
      const result = executeNetworkWithGating(pack, routeResult, context, mockToolExecutor);

      // Assert: Should ABSTAIN_CLARIFY
      expect(result).toMatchObject({
        nonRetryable: false,
        outcome: "ABSTAIN_CLARIFY",
        reason: "LOW_DOMINANCE_OR_CONFIDENCE",
      });
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });
  });

  describe("confidence threshold at zero boundary (0.0)", () => {
    it("should PROCEED when score is zero with zero threshold", () => {
      // Arrange: Zero threshold (minimum possible)
      const pack = createMockNetworkPack(0.0);
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.0, // Exactly at zero threshold
          },
          top2: {
            contract_id: "NETWORK_HTTP_POST",
            score: 0.0,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with zero score and zero threshold
      const result = executeNetworkWithGating(pack, routeResult, context, mockToolExecutor);

      // Assert: Should PROCEED (0.0 is not < 0.0)
      expect(result).toMatchObject({
        success: true,
        result: "mock_result",
      });
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });
  });

  describe("confidence threshold at one boundary (1.0)", () => {
    it("should PROCEED when score is exactly at maximum threshold (1.0)", () => {
      // Arrange: Maximum threshold
      const pack = createMockNetworkPack(1.0);
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 1.0, // Maximum confidence
          },
          top2: {
            contract_id: "NETWORK_HTTP_POST",
            score: 0.95,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with maximum score and maximum threshold
      const result = executeNetworkWithGating(pack, routeResult, context, mockToolExecutor);

      // Assert: Should PROCEED (1.0 is not < 1.0)
      expect(result).toMatchObject({
        success: true,
        result: "mock_result",
      });
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });

    it("should ABSTAIN_CLARIFY when score is just below maximum threshold (0.9999...)", () => {
      // Arrange: Score just below maximum threshold
      const pack = createMockNetworkPack(1.0);
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.9999, // Just below maximum
          },
          top2: {
            contract_id: "NETWORK_HTTP_POST",
            score: 0.95,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with sub-maximum score
      const result = executeNetworkWithGating(pack, routeResult, context, mockToolExecutor);

      // Assert: Should ABSTAIN_CLARIFY
      expect(result).toMatchObject({
        nonRetryable: false,
        outcome: "ABSTAIN_CLARIFY",
        reason: "LOW_DOMINANCE_OR_CONFIDENCE",
      });
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });
  });
});
