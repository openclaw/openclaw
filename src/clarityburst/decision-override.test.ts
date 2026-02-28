/**
 * Unit tests for ClarityBurst Decision Override Module
 *
 * Tests the applyNetworkOverrides function to verify confirmation gating
 * for HIGH-risk contracts when uncertainty thresholds pass.
 *
 * IMPORTANT: applyNetworkOverrides() does NOT compute or infer confirmation tokens.
 * It only uses the boolean userConfirmed flag supplied by the caller.
 * Token generation (with opHash8) is handled by wrapWithNetworkGating() which
 * wraps this function.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  applyNetworkOverrides,
  type OntologyPack,
  type RouteResult,
  type NetworkIOContext,
} from "./decision-override";
import { ClarityBurstAbstainError } from "./errors";
import {
  convertAbstainToBlockedResponse,
  type BlockedResponsePayload,
} from "../agents/pi-tool-definition-adapter.js";

/**
 * Mock tool execution function - tracks call count
 */
function createMockToolExecutor() {
  let callCount = 0;
  return {
    execute: vi.fn((): { success: true; result: string } => {
      callCount++;
      return { success: true as const, result: "mock_result" };
    }),
    getCallCount: () => callCount,
    reset: () => {
      callCount = 0;
    },
  };
}

/**
 * Creates a mock NETWORK_IO ontology pack with a HIGH-risk contract
 * that requires confirmation (needs_confirmation: true)
 */
function createMockNetworkIOPack(): OntologyPack {
  return {
    pack_id: "openclawd.NETWORK_IO_TEST",
    pack_version: "1.0.0",
    stage_id: "NETWORK_IO",
    description: "Test pack for NETWORK_IO operations",
    thresholds: {
      min_confidence_T: 0.55,
      dominance_margin_Delta: 0.10,
    },
    contracts: [
      {
        contract_id: "NETWORK_GET_PUBLIC",
        risk_class: "LOW",
        required_fields: ["url", "method"],
        limits: {},
        needs_confirmation: false,
        deny_by_default: false,
        capability_requirements: [],
      },
      {
        contract_id: "NETWORK_HIGH_RISK_OPERATION",
        risk_class: "HIGH",
        required_fields: ["url", "method", "auth_header"],
        limits: {
          token_expiry_check: true,
        },
        needs_confirmation: true,
        deny_by_default: false,
        capability_requirements: [],
      },
      {
        contract_id: "NETWORK_CRITICAL_SOCKET",
        risk_class: "CRITICAL",
        required_fields: ["host", "port", "protocol"],
        limits: {
          allowed_ports: [],
          requires_audit: true,
        },
        needs_confirmation: true,
        deny_by_default: true,
        capability_requirements: [],
      },
    ],
    field_schema: {},
  };
}

/**
 * Creates a route result that routes to a specific contract
 * with scores that PASS uncertainty gating (high confidence, good dominance)
 */
function createPassingRouteResult(contractId: string): RouteResult {
  return {
    ok: true,
    data: {
      top1: {
        contract_id: contractId,
        score: 0.92, // Well above min_confidence_T of 0.55
      },
      top2: {
        contract_id: "NETWORK_GET_PUBLIC",
        score: 0.45, // Dominance margin: 0.92 - 0.45 = 0.47 > 0.10
      },
    },
  };
}

/**
 * Wrapper function that applies network overrides and throws
 * ClarityBurstAbstainError when the outcome is not PROCEED
 */
function applyNetworkOverridesWithGating(
  pack: OntologyPack,
  routeResult: RouteResult,
  context: NetworkIOContext
): { outcome: "PROCEED"; contractId: string | null } {
  const result = applyNetworkOverrides(pack, routeResult, context);

  if (result.outcome === "ABSTAIN_CONFIRM") {
    throw new ClarityBurstAbstainError({
      stageId: "NETWORK_IO",
      outcome: result.outcome,
      reason: result.reason,
      contractId: result.contractId,
      instructions: result.instructions ?? `${result.outcome}: ${result.reason}`,
    });
  }

  if (result.outcome === "ABSTAIN_CLARIFY") {
    throw new ClarityBurstAbstainError({
      stageId: "NETWORK_IO",
      outcome: result.outcome,
      reason: result.reason,
      contractId: result.contractId,
      instructions: result.instructions ?? `${result.outcome}: ${result.reason}`,
    });
  }

  return result;
}

describe("applyNetworkOverrides - HIGH risk contract confirmation gating", () => {
  let mockPack: OntologyPack;
  let mockToolExecutor: ReturnType<typeof createMockToolExecutor>;

  beforeEach(() => {
    mockPack = createMockNetworkIOPack();
    mockToolExecutor = createMockToolExecutor();
  });

  describe("when routing to HIGH-risk contract with passing uncertainty scores", () => {
    it("should return ABSTAIN_CONFIRM with deterministic instructions when userConfirmed is false", () => {
      // Arrange: Route to HIGH-risk contract with scores that pass uncertainty gating
      // Note: We're testing that applyNetworkOverrides() uses ONLY the boolean userConfirmed
      // and does NOT compute or infer any confirmation tokens - that's wrapWithNetworkGating()'s job
      const routeResult = createPassingRouteResult("NETWORK_HIGH_RISK_OPERATION");
      const context: NetworkIOContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false, // Boolean flag only - no token computation here
        operation: "fetch",
        url: "https://api.example.com/sensitive",
      };

      // Act
      const result = applyNetworkOverrides(mockPack, routeResult, context);

      // Assert: Should include instructions with placeholder token format (not a computed hash)
      expect(result.outcome).toBe("ABSTAIN_CONFIRM");
      expect(result).toMatchObject({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "NETWORK_HIGH_RISK_OPERATION",
      });
      // Verify instructions contain placeholder token format guidance
      if (result.outcome === "ABSTAIN_CONFIRM") {
        expect(result.instructions).toBeDefined();
        expect(result.instructions).toContain("CONFIRM NETWORK_IO <CONTRACT_ID> <opHash8>");
        expect(result.instructions).toContain("userConfirmed=true");
        // Should NOT contain an actual computed hash (8 hex chars)
        expect(result.instructions).not.toMatch(/CONFIRM NETWORK_IO \w+ [a-f0-9]{8}/i);
      }
    });

    it("should throw ClarityBurstAbstainError and NOT execute tool when userConfirmed is undefined", () => {
      // Arrange: userConfirmed is undefined (caller didn't provide confirmation)
      // applyNetworkOverrides() only checks the boolean - it never computes tokens
      const routeResult = createPassingRouteResult("NETWORK_HIGH_RISK_OPERATION");
      const context: NetworkIOContext = {
        stageId: "NETWORK_IO",
        userConfirmed: undefined, // Boolean not set - treated same as false
        operation: "fetch",
        url: "https://api.example.com/sensitive",
      };

      // Act & Assert
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        applyNetworkOverridesWithGating(mockPack, routeResult, context);
        // If gating passes, execute the tool
        mockToolExecutor.execute();
      } catch (error) {
        if (error instanceof ClarityBurstAbstainError) {
          caughtError = error;
        } else {
          throw error;
        }
      }

      // Verify error was thrown with correct outcome
      expect(caughtError).not.toBeNull();
      expect(caughtError!.outcome).toBe("ABSTAIN_CONFIRM");
      expect(caughtError!.reason).toBe("CONFIRM_REQUIRED");
      expect(caughtError!.contractId).toBe("NETWORK_HIGH_RISK_OPERATION");

      // Verify tool was NOT executed
      expect(mockToolExecutor.getCallCount()).toBe(0);
      expect(mockToolExecutor.execute).not.toHaveBeenCalled();
    });

    it("should return PROCEED and execute tool ONCE when userConfirmed=true (boolean only, no token)", () => {
      // Arrange: Route to HIGH-risk contract with scores that pass uncertainty gating
      // The caller sets userConfirmed=true after obtaining user consent externally
      // Token generation happens in wrapWithNetworkGating(), not here
      const routeResult = createPassingRouteResult("NETWORK_HIGH_RISK_OPERATION");
      const context: NetworkIOContext = {
        stageId: "NETWORK_IO",
        userConfirmed: true, // Boolean flag set by caller - no token computation in applyNetworkOverrides
        operation: "fetch",
        url: "https://api.example.com/sensitive",
      };

      // Act
      const result = applyNetworkOverridesWithGating(mockPack, routeResult, context);

      // Assert: Gating passes, proceed outcome
      expect(result.outcome).toBe("PROCEED");
      expect(result.contractId).toBe("NETWORK_HIGH_RISK_OPERATION");

      // Execute tool since gating passed
      mockToolExecutor.execute();

      // Verify tool executed exactly once
      expect(mockToolExecutor.getCallCount()).toBe(1);
      expect(mockToolExecutor.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("when routing to CRITICAL-risk contract with passing uncertainty scores", () => {
    it("should return ABSTAIN_CONFIRM with instructions when userConfirmed=false", () => {
      // Arrange: CRITICAL risk contracts always require confirmation
      // applyNetworkOverrides() only checks the boolean, never computes tokens
      const routeResult = createPassingRouteResult("NETWORK_CRITICAL_SOCKET");
      const context: NetworkIOContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false, // Boolean only
        operation: "connect",
        url: "tcp://192.168.1.1:8080",
      };

      // Act
      const result = applyNetworkOverrides(mockPack, routeResult, context);

      // Assert: Should include instructions with placeholder token format
      expect(result.outcome).toBe("ABSTAIN_CONFIRM");
      expect(result).toMatchObject({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "NETWORK_CRITICAL_SOCKET",
      });
      if (result.outcome === "ABSTAIN_CONFIRM") {
        expect(result.instructions).toBeDefined();
        expect(result.instructions).toContain("CONFIRM NETWORK_IO <CONTRACT_ID> <opHash8>");
      }
    });

    it("should return PROCEED when userConfirmed=true (boolean flag)", () => {
      // Arrange: Caller has set userConfirmed=true after obtaining user consent
      const routeResult = createPassingRouteResult("NETWORK_CRITICAL_SOCKET");
      const context: NetworkIOContext = {
        stageId: "NETWORK_IO",
        userConfirmed: true, // Boolean flag set by caller
        operation: "connect",
        url: "tcp://192.168.1.1:8080",
      };

      // Act
      const result = applyNetworkOverrides(mockPack, routeResult, context);

      // Assert
      expect(result.outcome).toBe("PROCEED");
      expect(result.contractId).toBe("NETWORK_CRITICAL_SOCKET");
    });
  });

  describe("when routing to LOW-risk contract (no confirmation required)", () => {
    it("should return PROCEED even without userConfirmed=true", () => {
      // Arrange: LOW risk contracts don't need confirmation
      const routeResult = createPassingRouteResult("NETWORK_GET_PUBLIC");
      const context: NetworkIOContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false, // LOW risk - doesn't matter
        operation: "fetch",
        url: "https://public-api.example.com/data",
      };

      // Act
      const result = applyNetworkOverrides(mockPack, routeResult, context);

      // Assert: LOW risk doesn't need confirmation, no instructions returned
      expect(result.outcome).toBe("PROCEED");
      expect(result.contractId).toBe("NETWORK_GET_PUBLIC");
    });
  });

  describe("confirmation gating edge cases (boolean-only, no token computation)", () => {
    it("should treat userConfirmed=false same as undefined (both require confirmation)", () => {
      // This test verifies that applyNetworkOverrides() only checks the boolean value
      // It never computes or infers tokens - that's wrapWithNetworkGating()'s job
      const routeResult = createPassingRouteResult("NETWORK_HIGH_RISK_OPERATION");

      // Test with false
      const resultFalse = applyNetworkOverrides(mockPack, routeResult, {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      });

      // Test with undefined
      const resultUndefined = applyNetworkOverrides(mockPack, routeResult, {
        stageId: "NETWORK_IO",
        userConfirmed: undefined,
      });

      // Both should require confirmation and include placeholder instructions
      expect(resultFalse.outcome).toBe("ABSTAIN_CONFIRM");
      expect(resultUndefined.outcome).toBe("ABSTAIN_CONFIRM");
      
      // Both should have instructions with placeholder token format
      if (resultFalse.outcome === "ABSTAIN_CONFIRM") {
        expect(resultFalse.instructions).toContain("CONFIRM NETWORK_IO <CONTRACT_ID> <opHash8>");
      }
      if (resultUndefined.outcome === "ABSTAIN_CONFIRM") {
        expect(resultUndefined.instructions).toContain("CONFIRM NETWORK_IO <CONTRACT_ID> <opHash8>");
      }
    });

    it("should only accept userConfirmed=true (boolean) to bypass confirmation", () => {
      // The only way to bypass confirmation is setting userConfirmed=true
      // No token validation happens here - that's in wrapWithNetworkGating()
      const routeResult = createPassingRouteResult("NETWORK_HIGH_RISK_OPERATION");

      // Only true should work
      const resultTrue = applyNetworkOverrides(mockPack, routeResult, {
        stageId: "NETWORK_IO",
        userConfirmed: true,
      });

      expect(resultTrue.outcome).toBe("PROCEED");
    });
  });

  describe("integration test: full tool dispatch flow (userConfirmed boolean only)", () => {
    /**
     * This test simulates the full flow:
     * 1. Router returns a route to HIGH-risk contract
     * 2. applyNetworkOverrides is called with userConfirmed boolean
     * 3. If ABSTAIN_CONFIRM: return instructions with placeholder token, do not execute tool
     * 4. If PROCEED: execute tool exactly once
     *
     * NOTE: Token generation with opHash8 happens in wrapWithNetworkGating(), not here.
     * Tests just flip userConfirmed true/false.
     */
    it("should block tool execution when userConfirmed=false and allow when userConfirmed=true", () => {
      const routeResult = createPassingRouteResult("NETWORK_HIGH_RISK_OPERATION");

      // Scenario 1: userConfirmed=false (caller hasn't obtained consent)
      const executor1 = createMockToolExecutor();
      const context1: NetworkIOContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false, // Boolean only - no token here
      };

      const gatingResult1 = applyNetworkOverrides(mockPack, routeResult, context1);

      if (gatingResult1.outcome === "PROCEED") {
        executor1.execute();
      }

      expect(gatingResult1.outcome).toBe("ABSTAIN_CONFIRM");
      expect(executor1.getCallCount()).toBe(0);
      // Verify placeholder instructions are returned
      if (gatingResult1.outcome === "ABSTAIN_CONFIRM") {
        expect(gatingResult1.instructions).toContain("CONFIRM NETWORK_IO <CONTRACT_ID> <opHash8>");
      }

      // Scenario 2: userConfirmed=true (caller has obtained consent)
      const executor2 = createMockToolExecutor();
      const context2: NetworkIOContext = {
        stageId: "NETWORK_IO",
        userConfirmed: true, // Boolean flag set after user consent
      };

      const gatingResult2 = applyNetworkOverrides(mockPack, routeResult, context2);

      if (gatingResult2.outcome === "PROCEED") {
        executor2.execute();
      }

      expect(gatingResult2.outcome).toBe("PROCEED");
      expect(executor2.getCallCount()).toBe(1);
    });
  });
});

describe("applyNetworkOverrides - uncertainty gating before confirmation", () => {
  let mockPack: OntologyPack;

  beforeEach(() => {
    mockPack = createMockNetworkIOPack();
  });

  it("should return ABSTAIN_CLARIFY when confidence is below threshold (before checking confirmation)", () => {
    // Arrange: Low confidence score
    const routeResult: RouteResult = {
      ok: true,
      data: {
        top1: {
          contract_id: "NETWORK_HIGH_RISK_OPERATION",
          score: 0.40, // Below min_confidence_T of 0.55
        },
      },
    };

    const context: NetworkIOContext = {
      stageId: "NETWORK_IO",
      userConfirmed: true, // Even with token, should fail on uncertainty
    };

    // Act
    const result = applyNetworkOverrides(mockPack, routeResult, context);

    // Assert: Fails on uncertainty, not confirmation
    expect(result.outcome).toBe("ABSTAIN_CLARIFY");
    expect(result).toMatchObject({
      outcome: "ABSTAIN_CLARIFY",
      reason: "LOW_DOMINANCE_OR_CONFIDENCE",
      contractId: "NETWORK_HIGH_RISK_OPERATION",
    });
  });

  it("should return ABSTAIN_CLARIFY when dominance margin is insufficient", () => {
    // Arrange: Good confidence but poor dominance
    const routeResult: RouteResult = {
      ok: true,
      data: {
        top1: {
          contract_id: "NETWORK_HIGH_RISK_OPERATION",
          score: 0.60, // Above threshold
        },
        top2: {
          contract_id: "NETWORK_GET_PUBLIC",
          score: 0.55, // Dominance: 0.60 - 0.55 = 0.05 < 0.10
        },
      },
    };

    const context: NetworkIOContext = {
      stageId: "NETWORK_IO",
      userConfirmed: true,
    };

    // Act
    const result = applyNetworkOverrides(mockPack, routeResult, context);

    // Assert
    expect(result.outcome).toBe("ABSTAIN_CLARIFY");
    expect(result).toMatchObject({
      outcome: "ABSTAIN_CLARIFY",
      reason: "LOW_DOMINANCE_OR_CONFIDENCE",
    });
  });
});

/**
 * Central adapter function that wraps applyNetworkOverrides and converts
 * abstain outcomes to BlockedResponsePayload through the non-retryable path.
 * This is the function that the network tool executor integrates with.
 *
 * NOTE: This uses the real convertAbstainToBlockedResponse from pi-tool-definition-adapter.ts
 * which is the production code path for SHELL_EXEC, FILE_SYSTEM_OPS, and NETWORK_IO.
 */
function executeNetworkOperationWithGating(
  pack: OntologyPack,
  routeResult: RouteResult,
  context: NetworkIOContext,
  toolExecutor: ReturnType<typeof createMockToolExecutor>
): { success: true; result: unknown } | BlockedResponsePayload {
  const gatingResult = applyNetworkOverrides(pack, routeResult, context);

  if (gatingResult.outcome === "ABSTAIN_CLARIFY") {
    // Convert to blocked response - this is the non-retryable path
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
    // Convert to blocked response - this is the non-retryable path
    const error = new ClarityBurstAbstainError({
      stageId: "NETWORK_IO",
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

describe("NETWORK_IO ClarityBurstAbstainError - central non-retryable handling path", () => {
  let mockPack: OntologyPack;
  let mockToolExecutor: ReturnType<typeof createMockToolExecutor>;

  beforeEach(() => {
    mockPack = createMockNetworkIOPack();
    mockToolExecutor = createMockToolExecutor();
  });

  describe("router_outage → ABSTAIN_CLARIFY propagation", () => {
    it("should return blocked response with all fields intact when router is unavailable", () => {
      // Arrange: Router outage scenario - routeResult.ok is false
      const routeResult: RouteResult = {
        ok: false,
        // No data available due to outage
      };
      const context: NetworkIOContext = {
        stageId: "NETWORK_IO",
        userConfirmed: true, // Even with confirmation, router outage blocks
        operation: "fetch",
        url: "https://api.example.com/data",
      };

      // Act: Execute through central non-retryable handling path
      const result = executeNetworkOperationWithGating(
        mockPack,
        routeResult,
        context,
        mockToolExecutor
      );

      // Assert: Blocked response payload structure
      expect(result).toMatchObject({
        nonRetryable: true,
        stageId: "NETWORK_IO",
        outcome: "ABSTAIN_CLARIFY",
        reason: "router_outage",
        contractId: null,
      });

      // Assert: Instructions field is present and meaningful
      expect((result as BlockedResponsePayload).instructions).toBeDefined();
      expect((result as BlockedResponsePayload).instructions).toContain("router");

      // Assert: Tool executor was NOT called
      expect(mockToolExecutor.getCallCount()).toBe(0);
      expect(mockToolExecutor.execute).not.toHaveBeenCalled();
    });

    it("should propagate router_outage through ClarityBurstAbstainError with exact fields", () => {
      // Arrange: Direct test of applyNetworkOverrides for router_outage
      const routeResult: RouteResult = { ok: false };
      const context: NetworkIOContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act
      const gatingResult = applyNetworkOverrides(mockPack, routeResult, context);

      // Assert: All expected fields present
      expect(gatingResult.outcome).toBe("ABSTAIN_CLARIFY");
      expect(gatingResult).toEqual({
        outcome: "ABSTAIN_CLARIFY",
        reason: "router_outage",
        stageId: "NETWORK_IO",
        contractId: null,
        instructions: expect.stringContaining("router"),
      });

      // Verify this is converted to non-retryable blocked response
      if (gatingResult.outcome === "ABSTAIN_CLARIFY") {
        const error = new ClarityBurstAbstainError({
          stageId: "NETWORK_IO",
          outcome: gatingResult.outcome,
          reason: gatingResult.reason,
          contractId: gatingResult.contractId,
          instructions: gatingResult.instructions ?? `${gatingResult.outcome}: ${gatingResult.reason}`,
        });
        const blocked = convertAbstainToBlockedResponse(error, gatingResult.instructions);
        
        expect(blocked.nonRetryable).toBe(true);
        expect(blocked.stageId).toBe("NETWORK_IO");
        expect(blocked.outcome).toBe("ABSTAIN_CLARIFY");
        expect(blocked.reason).toBe("router_outage");
        expect(blocked.contractId).toBeNull();
        expect(blocked.instructions).toBeDefined();
      }
    });
  });

  describe("ABSTAIN_CONFIRM - confirmation required & missing", () => {
    it("should return blocked response with all fields intact when confirmation is missing", () => {
      // Arrange: HIGH-risk contract with passing scores but no confirmation
      const routeResult = createPassingRouteResult("NETWORK_HIGH_RISK_OPERATION");
      const context: NetworkIOContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false, // Confirmation missing
        operation: "fetch",
        url: "https://api.example.com/sensitive",
      };

      // Act: Execute through central non-retryable handling path
      const result = executeNetworkOperationWithGating(
        mockPack,
        routeResult,
        context,
        mockToolExecutor
      );

      // Assert: Blocked response payload structure
      expect(result).toMatchObject({
        nonRetryable: true,
        stageId: "NETWORK_IO",
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "NETWORK_HIGH_RISK_OPERATION",
      });

      // Assert: Instructions field is present with confirmation guidance
      expect((result as BlockedResponsePayload).instructions).toBeDefined();
      expect((result as BlockedResponsePayload).instructions).toContain("userConfirmed=true");

      // Assert: Tool executor was NOT called
      expect(mockToolExecutor.getCallCount()).toBe(0);
      expect(mockToolExecutor.execute).not.toHaveBeenCalled();
    });

    it("should propagate ABSTAIN_CONFIRM through ClarityBurstAbstainError with exact fields", () => {
      // Arrange: CRITICAL-risk contract without confirmation
      const routeResult = createPassingRouteResult("NETWORK_CRITICAL_SOCKET");
      const context: NetworkIOContext = {
        stageId: "NETWORK_IO",
        userConfirmed: undefined, // Explicitly undefined
        operation: "connect",
        url: "tcp://192.168.1.1:8080",
      };

      // Act
      const gatingResult = applyNetworkOverrides(mockPack, routeResult, context);

      // Assert: All expected fields present
      expect(gatingResult.outcome).toBe("ABSTAIN_CONFIRM");
      expect(gatingResult).toEqual({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "NETWORK_CRITICAL_SOCKET",
        instructions: expect.stringContaining("CONFIRM NETWORK_IO"),
      });

      // Verify this is converted to non-retryable blocked response
      if (gatingResult.outcome === "ABSTAIN_CONFIRM") {
        const error = new ClarityBurstAbstainError({
          stageId: "NETWORK_IO",
          outcome: gatingResult.outcome,
          reason: gatingResult.reason,
          contractId: gatingResult.contractId,
          instructions: gatingResult.instructions ?? `${gatingResult.outcome}: ${gatingResult.reason}`,
        });
        const blocked = convertAbstainToBlockedResponse(error, gatingResult.instructions);
        
        expect(blocked.nonRetryable).toBe(true);
        expect(blocked.stageId).toBe("NETWORK_IO");
        expect(blocked.outcome).toBe("ABSTAIN_CONFIRM");
        expect(blocked.reason).toBe("CONFIRM_REQUIRED");
        expect(blocked.contractId).toBe("NETWORK_CRITICAL_SOCKET");
        expect(blocked.instructions).toContain("CONFIRM NETWORK_IO");
      }
    });

    it("should NOT execute tool and NOT retry when ABSTAIN_CONFIRM is returned", () => {
      // Arrange: Multiple attempts should all fail without tool execution
      const routeResult = createPassingRouteResult("NETWORK_HIGH_RISK_OPERATION");
      const context: NetworkIOContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false,
      };

      // Act: Simulate 3 retry attempts (should all be blocked)
      const results: (ReturnType<typeof executeNetworkOperationWithGating>)[] = [];
      for (let i = 0; i < 3; i++) {
        results.push(
          executeNetworkOperationWithGating(mockPack, routeResult, context, mockToolExecutor)
        );
      }

      // Assert: All results are blocked responses
      for (const result of results) {
        expect((result as BlockedResponsePayload).nonRetryable).toBe(true);
        expect((result as BlockedResponsePayload).outcome).toBe("ABSTAIN_CONFIRM");
      }

      // Assert: Tool was NEVER called across all attempts
      expect(mockToolExecutor.getCallCount()).toBe(0);
      expect(mockToolExecutor.execute).not.toHaveBeenCalled();
    });
  });

  describe("comparison: PROCEED outcome allows tool execution", () => {
    it("should execute tool exactly once when PROCEED is returned", () => {
      // Arrange: LOW-risk contract that doesn't need confirmation
      const routeResult = createPassingRouteResult("NETWORK_GET_PUBLIC");
      const context: NetworkIOContext = {
        stageId: "NETWORK_IO",
        userConfirmed: false, // LOW risk - doesn't matter
        operation: "fetch",
        url: "https://public-api.example.com/data",
      };

      // Act
      const result = executeNetworkOperationWithGating(
        mockPack,
        routeResult,
        context,
        mockToolExecutor
      );

      // Assert: Successful execution result
      expect(result).toEqual({ success: true, result: "mock_result" });

      // Assert: Tool was called exactly once
      expect(mockToolExecutor.getCallCount()).toBe(1);
      expect(mockToolExecutor.execute).toHaveBeenCalledTimes(1);
    });

    it("should execute tool when userConfirmed=true for HIGH-risk contract", () => {
      // Arrange: HIGH-risk with confirmation provided
      const routeResult = createPassingRouteResult("NETWORK_HIGH_RISK_OPERATION");
      const context: NetworkIOContext = {
        stageId: "NETWORK_IO",
        userConfirmed: true, // Confirmation provided
        operation: "fetch",
        url: "https://api.example.com/sensitive",
      };

      // Act
      const result = executeNetworkOperationWithGating(
        mockPack,
        routeResult,
        context,
        mockToolExecutor
      );

      // Assert: Successful execution
      expect(result).toEqual({ success: true, result: "mock_result" });
      expect(mockToolExecutor.getCallCount()).toBe(1);
    });
  });
});
