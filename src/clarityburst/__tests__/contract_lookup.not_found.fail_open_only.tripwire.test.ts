/**
 * Contract Lookup: Not Found Fail-Open Tripwire Test
 *
 * Verifies the fail-open behavior when router returns a contract_id that does NOT
 * exist in the pack.contracts array. This is a critical validation boundary where
 * the system must handle missing contract definitions safely.
 *
 * Expected behavior:
 * - Router returns contract_id that doesn't exist in pack contracts
 * - System cannot look up contract risk class or confirmation requirements
 * - Decision: ABSTAIN_CLARIFY (fail-open, do not block execution)
 * - Reason: router_mismatch (router returned unrecognized contract)
 * - Tool executor should NOT be called
 * 
 * This tests the validation logic: `const contract = findContractById(pack, top1.contract_id)`
 * When contract is undefined, system must handle gracefully without blocking.
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
 * Creates a mock NETWORK_IO ontology pack with specific contracts
 */
function createMockNetworkPackWithLimitedContracts(): OntologyPack {
  return {
    pack_id: "openclawd.NETWORK_IO_CONTRACT_LOOKUP_TEST",
    pack_version: "1.0.0",
    stage_id: "NETWORK_IO",
    description: "Test pack with limited contract definitions",
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
      // Intentionally missing: "NETWORK_HTTP_PATCH", "NETWORK_HTTP_DELETE", etc.
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

describe("contract_lookup.not_found → fail-open tripwire", () => {
  let mockPack: OntologyPack;
  let mockToolExecutor: ReturnType<typeof createMockToolExecutor>;

  beforeEach(() => {
    mockPack = createMockNetworkPackWithLimitedContracts();
    mockToolExecutor = createMockToolExecutor();
  });

  describe("router returns contract_id not in pack", () => {
    it("should ABSTAIN_CLARIFY when contract_id does not exist in pack (fail-open)", () => {
      // Arrange: Router returns a contract_id that doesn't exist in pack.contracts
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_DELETE", // This contract is not in mockPack
            score: 0.95, // High confidence, but contract not found
          },
          top2: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.80,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with unknown contract_id
      const result = executeNetworkWithGating(mockPack, routeResult, context, mockToolExecutor);

      // Assert: Should ABSTAIN_CLARIFY with router_mismatch (fail-open behavior)
      expect(result).toMatchObject({
        nonRetryable: false,
        outcome: "ABSTAIN_CLARIFY",
        reason: "router_mismatch",
      });

      // Assert: Tool executor NOT called (blocked on safety grounds)
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });

    it("should ABSTAIN_CLARIFY when contract_id is empty string (not in pack)", () => {
      // Arrange: Router returns empty string as contract_id
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "", // Empty string won't match any contract
            score: 0.95,
          },
          top2: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.80,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with empty contract_id
      const result = executeNetworkWithGating(mockPack, routeResult, context, mockToolExecutor);

      // Assert: Should ABSTAIN_CLARIFY
      expect(result).toMatchObject({
        nonRetryable: false,
        outcome: "ABSTAIN_CLARIFY",
        reason: "router_mismatch",
      });
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });

    it("should ABSTAIN_CLARIFY when contract_id has different case (case-sensitive lookup)", () => {
      // Arrange: Contract exists as "NETWORK_HTTP_GET" but router returns "network_http_get"
      // Assumes lookup is case-sensitive
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "network_http_get", // Lowercase (won't match "NETWORK_HTTP_GET")
            score: 0.95,
          },
          top2: {
            contract_id: "NETWORK_HTTP_POST",
            score: 0.80,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with different case
      const result = executeNetworkWithGating(mockPack, routeResult, context, mockToolExecutor);

      // Assert: Should ABSTAIN_CLARIFY (case-sensitive mismatch)
      expect(result).toMatchObject({
        nonRetryable: false,
        outcome: "ABSTAIN_CLARIFY",
        reason: "router_mismatch",
      });
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });

    it("should ABSTAIN_CLARIFY when contract_id contains typo", () => {
      // Arrange: Contract "NETWORK_HTTP_GET" vs router returns "NETWORK_HTTP_GE" (typo)
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GE", // Typo in contract_id
            score: 0.95,
          },
          top2: {
            contract_id: "NETWORK_HTTP_POST",
            score: 0.80,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with typo
      const result = executeNetworkWithGating(mockPack, routeResult, context, mockToolExecutor);

      // Assert: Should ABSTAIN_CLARIFY
      expect(result).toMatchObject({
        nonRetryable: false,
        outcome: "ABSTAIN_CLARIFY",
        reason: "router_mismatch",
      });
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });
  });

  describe("contract lookup with valid and invalid contracts", () => {
    it("should PROCEED when contract_id exists and contract lookup succeeds", () => {
      // Arrange: Router returns contract_id that exists in pack
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET", // This contract EXISTS in pack
            score: 0.95,
          },
          top2: {
            contract_id: "NETWORK_HTTP_POST",
            score: 0.80,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with valid contract_id
      const result = executeNetworkWithGating(mockPack, routeResult, context, mockToolExecutor);

      // Assert: Should PROCEED (contract found, LOW-risk, no confirmation needed)
      expect(result).toMatchObject({
        success: true,
        result: "mock_result",
      });
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });

    it("should ABSTAIN_CONFIRM when contract_id exists and contract needs confirmation", () => {
      // Arrange: Pack with HIGH-risk contract
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
            contract_id: "NETWORK_SHELL_EXEC", // Exists and requires confirmation
            score: 0.95,
          },
          top2: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.80,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with HIGH-risk contract requiring confirmation
      const result = executeNetworkWithGating(
        highRiskPack,
        routeResult,
        context,
        mockToolExecutor
      );

      // Assert: Should ABSTAIN_CONFIRM (contract found but confirmation required)
      expect(result).toMatchObject({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "NETWORK_SHELL_EXEC",
      });
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });
  });

  describe("contract not found with various score scenarios", () => {
    it("should ABSTAIN_CLARIFY when contract not found regardless of high confidence", () => {
      // Arrange: Unknown contract with very high confidence (1.0)
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_UNKNOWN_XYZ",
            score: 1.0, // Maximum confidence
          },
          top2: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.0,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with maximum confidence but unknown contract
      const result = executeNetworkWithGating(mockPack, routeResult, context, mockToolExecutor);

      // Assert: Should still ABSTAIN_CLARIFY (contract lookup failure takes precedence)
      expect(result).toMatchObject({
        nonRetryable: false,
        outcome: "ABSTAIN_CLARIFY",
        reason: "router_mismatch",
      });
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });

    it("should ABSTAIN_CLARIFY when contract not found with high dominance margin", () => {
      // Arrange: Unknown contract with excellent dominance (high confidence, large margin)
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_UNKNOWN_PATCH",
            score: 0.99, // High confidence
          },
          top2: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.10, // Large margin (0.89)
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with unknown contract but excellent metrics
      const result = executeNetworkWithGating(mockPack, routeResult, context, mockToolExecutor);

      // Assert: Should ABSTAIN_CLARIFY (contract lookup is gating factor)
      expect(result).toMatchObject({
        nonRetryable: false,
        outcome: "ABSTAIN_CLARIFY",
        reason: "router_mismatch",
      });
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });
  });

  describe("edge cases in contract lookup", () => {
    it("should ABSTAIN_CLARIFY when contract_id is null (not in pack)", () => {
      // Arrange: Router returns null as contract_id (invalid)
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: null as any, // Null contract_id
            score: 0.95,
          },
          top2: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.80,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with null contract_id
      const result = executeNetworkWithGating(mockPack, routeResult, context, mockToolExecutor);

      // Assert: Should ABSTAIN_CLARIFY
      expect(result).toMatchObject({
        nonRetryable: false,
        outcome: "ABSTAIN_CLARIFY",
      });
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });

    it("should ABSTAIN_CLARIFY when contract_id contains special characters (not in pack)", () => {
      // Arrange: Contract_id with special characters that don't exist in pack
      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK/HTTP\\GET", // Invalid characters
            score: 0.95,
          },
          top2: {
            contract_id: "NETWORK_HTTP_GET",
            score: 0.80,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with special characters in contract_id
      const result = executeNetworkWithGating(mockPack, routeResult, context, mockToolExecutor);

      // Assert: Should ABSTAIN_CLARIFY
      expect(result).toMatchObject({
        nonRetryable: false,
        outcome: "ABSTAIN_CLARIFY",
        reason: "router_mismatch",
      });
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });

    it("should ABSTAIN_CLARIFY when pack has empty contracts array and router returns any contract", () => {
      // Arrange: Pack with no contracts at all
      const emptyPack: OntologyPack = {
        ...mockPack,
        contracts: [], // Empty contracts
      };

      const routeResult: RouteResult = {
        ok: true,
        data: {
          top1: {
            contract_id: "NETWORK_HTTP_GET", // Any contract_id
            score: 0.95,
          },
        },
      };
      const context: DispatchContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Execute with empty contracts pack
      const result = executeNetworkWithGating(
        emptyPack,
        routeResult,
        context,
        mockToolExecutor
      );

      // Assert: Should ABSTAIN_CLARIFY (no contracts to look up)
      expect(result).toMatchObject({
        nonRetryable: false,
        outcome: "ABSTAIN_CLARIFY",
        reason: "router_mismatch",
      });
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });
  });
});
