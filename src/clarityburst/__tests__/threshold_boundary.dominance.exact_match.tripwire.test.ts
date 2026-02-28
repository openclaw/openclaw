/**
 * Threshold Boundary: Dominance Margin Exact Match Tripwire Test
 *
 * Verifies that the dominance margin threshold boundary is correctly enforced at the exact match point.
 * Tests the condition: lowDominance = (top1Score - top2Score) < dominance_margin_Delta
 *
 * This ensures:
 * - Margin EXACTLY AT threshold → PROCEED (not ABSTAIN_CLARIFY)
 * - Margin BELOW threshold → ABSTAIN_CLARIFY (fail-closed)
 * - Margin ABOVE threshold → PROCEED
 * 
 * Dominance margin represents the gap between top1 and top2 contract scores.
 * Large gap = high dominance = proceed. Small gap = ambiguity = abstain.
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
 * Creates a mock NETWORK_IO ontology pack with specific dominance margin threshold
 */
function createMockNetworkPack(dominanceMarginDelta: number): OntologyPack {
  return {
    pack_id: "openclawd.NETWORK_IO_DOMINANCE_BOUNDARY_TEST",
    pack_version: "1.0.0",
    stage_id: "NETWORK_IO",
    description: "Test pack for dominance margin threshold boundary",
    thresholds: {
      min_confidence_T: 0.55,
      dominance_margin_Delta: dominanceMarginDelta,
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

describe("threshold_boundary.dominance.exact_match → tripwire", () => {
  let mockToolExecutor: ReturnType<typeof createMockToolExecutor>;

  beforeEach(() => {
    mockToolExecutor = createMockToolExecutor();
  });

  describe("dominance margin threshold at 0.10 boundary", () => {
    it("should PROCEED when margin is exactly at threshold (0.10)", () => {
      // Arrange: Dominance margin EXACTLY at dominance_margin_Delta
      // top1 = 0.80, top2 = 0.70 → margin = 0.10
      const pack = createMockNetworkPack(0.10);
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.80, // Both well above min_confidence_T
          },
          top2: {
            contract_id: "NETWORK_HTTP_POST",
            score: 0.70, // Margin = 0.10 (EXACT match)
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with exact margin
      const result = executeNetworkWithGating(pack, routeResult, context, mockToolExecutor);

      // Assert: Should PROCEED (margin is NOT < threshold)
      expect(result).toMatchObject({
        success: true,
        result: "mock_result",
      });
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });

    it("should ABSTAIN_CLARIFY when margin is just below threshold (0.0999...)", () => {
      // Arrange: Dominance margin just below threshold
      // top1 = 0.80, top2 = 0.7001 → margin = 0.0999
      const pack = createMockNetworkPack(0.10);
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.80,
          },
          top2: {
            contract_id: "NETWORK_HTTP_POST",
            score: 0.7001, // Margin = 0.0999 (just below threshold)
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with sub-boundary margin
      const result = executeNetworkWithGating(pack, routeResult, context, mockToolExecutor);

      // Assert: Should ABSTAIN_CLARIFY due to low dominance
      expect(result).toMatchObject({
        nonRetryable: false,
        outcome: "ABSTAIN_CLARIFY",
        reason: "LOW_DOMINANCE_OR_CONFIDENCE",
      });
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });

    it("should PROCEED when margin is above threshold (0.1001...)", () => {
      // Arrange: Dominance margin just above threshold
      // top1 = 0.80, top2 = 0.6999 → margin = 0.1001
      const pack = createMockNetworkPack(0.10);
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.80,
          },
          top2: {
            contract_id: "NETWORK_HTTP_POST",
            score: 0.6999, // Margin = 0.1001 (just above threshold)
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with super-boundary margin
      const result = executeNetworkWithGating(pack, routeResult, context, mockToolExecutor);

      // Assert: Should PROCEED
      expect(result).toMatchObject({
        success: true,
        result: "mock_result",
      });
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });
  });

  describe("dominance margin threshold at 0.15 boundary (tight margin)", () => {
    it("should PROCEED when margin is exactly at high threshold (0.15)", () => {
      // Arrange: High dominance margin threshold
      // top1 = 0.80, top2 = 0.65 → margin = 0.15
      const pack = createMockNetworkPack(0.15);
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.80,
          },
          top2: {
            contract_id: "NETWORK_HTTP_POST",
            score: 0.65, // Margin = 0.15 (EXACT match to high threshold)
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with exact high margin
      const result = executeNetworkWithGating(pack, routeResult, context, mockToolExecutor);

      // Assert: Should PROCEED
      expect(result).toMatchObject({
        success: true,
        result: "mock_result",
      });
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });

    it("should ABSTAIN_CLARIFY when margin is below high threshold (0.1499...)", () => {
      // Arrange: Margin just below high threshold
      // top1 = 0.80, top2 = 0.6501 → margin = 0.1499
      const pack = createMockNetworkPack(0.15);
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.80,
          },
          top2: {
            contract_id: "NETWORK_HTTP_POST",
            score: 0.6501, // Margin = 0.1499
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with sub-high-boundary margin
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

  describe("dominance margin threshold at zero boundary (0.0)", () => {
    it("should PROCEED when margin is zero with zero threshold", () => {
      // Arrange: Zero dominance margin threshold (equal scores allowed)
      // top1 = 0.80, top2 = 0.80 → margin = 0.0
      const pack = createMockNetworkPack(0.0);
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.80,
          },
          top2: {
            contract_id: "NETWORK_HTTP_POST",
            score: 0.80, // Margin = 0.0 (EXACT match to zero threshold)
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with zero margin and zero threshold
      const result = executeNetworkWithGating(pack, routeResult, context, mockToolExecutor);

      // Assert: Should PROCEED (0.0 is not < 0.0)
      expect(result).toMatchObject({
        success: true,
        result: "mock_result",
      });
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });

    it("should PROCEED when margin is positive with zero threshold", () => {
      // Arrange: Any positive margin passes zero threshold
      const pack = createMockNetworkPack(0.0);
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.80,
          },
          top2: {
            contract_id: "NETWORK_HTTP_POST",
            score: 0.70, // Margin = 0.10
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute
      const result = executeNetworkWithGating(pack, routeResult, context, mockToolExecutor);

      // Assert: Should PROCEED
      expect(result).toMatchObject({
        success: true,
        result: "mock_result",
      });
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });
  });

  describe("dominance margin with only top1 (no top2)", () => {
    it("should PROCEED when only top1 exists and confidence passes", () => {
      // Arrange: Only top1 in result, no top2 to compare dominance against
      const pack = createMockNetworkPack(0.10);
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.80, // Above confidence threshold
          },
          // No top2
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with only top1
      const result = executeNetworkWithGating(pack, routeResult, context, mockToolExecutor);

      // Assert: Should PROCEED (no top2 means no dominance check fails)
      expect(result).toMatchObject({
        success: true,
        result: "mock_result",
      });
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });
  });

  describe("dominance margin with combined confidence boundary", () => {
    it("should ABSTAIN_CLARIFY when confidence passes but dominance fails at boundary", () => {
      // Arrange: Confidence is high but dominance margin is too small
      // top1 = 0.80 (passes 0.55 confidence), but margin = 0.0999 (fails 0.10 dominance)
      const pack = createMockNetworkPack(0.10);
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.80, // High confidence
          },
          top2: {
            contract_id: "NETWORK_HTTP_POST",
            score: 0.7001, // Low margin
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute where confidence passes but dominance fails
      const result = executeNetworkWithGating(pack, routeResult, context, mockToolExecutor);

      // Assert: Should ABSTAIN_CLARIFY on dominance failure
      expect(result).toMatchObject({
        nonRetryable: false,
        outcome: "ABSTAIN_CLARIFY",
        reason: "LOW_DOMINANCE_OR_CONFIDENCE",
      });
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });

    it("should ABSTAIN_CLARIFY when both confidence and dominance fail at boundaries", () => {
      // Arrange: Both confidence and dominance at/below thresholds
      // top1 = 0.5499 (below 0.55), margin = 0.0999 (below 0.10)
      const pack = createMockNetworkPack(0.10);
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.5499, // Just below confidence threshold
          },
          top2: {
            contract_id: "NETWORK_HTTP_POST",
            score: 0.4500, // Low margin
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute where both fail
      const result = executeNetworkWithGating(pack, routeResult, context, mockToolExecutor);

      // Assert: Should ABSTAIN_CLARIFY
      expect(result).toMatchObject({
        nonRetryable: false,
        outcome: "ABSTAIN_CLARIFY",
        reason: "LOW_DOMINANCE_OR_CONFIDENCE",
      });
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });

    it("should PROCEED when both confidence and dominance pass at exact boundaries", () => {
      // Arrange: Both at exact thresholds (not below)
      // top1 = 0.55 (exactly at confidence threshold), margin = 0.10 (exactly at dominance threshold)
      const pack = createMockNetworkPack(0.10);
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.55, // Exactly at confidence threshold
          },
          top2: {
            contract_id: "NETWORK_HTTP_POST",
            score: 0.45, // Exactly at dominance margin threshold
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute at exact boundaries
      const result = executeNetworkWithGating(pack, routeResult, context, mockToolExecutor);

      // Assert: Should PROCEED (0.55 is not < 0.55, and 0.10 is not < 0.10)
      expect(result).toMatchObject({
        success: true,
        result: "mock_result",
      });
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });
  });
});
