/**
 * TOOL_DISPATCH_GATE Empty Allowlist → ABSTAIN_CLARIFY Tripwire Test
 *
 * Verifies that when deriveAllowedContracts() yields an EMPTY array
 * (due to capability restrictions), the gating flow blocks operations
 * with outcome: "ABSTAIN_CLARIFY" and reason: "PACK_POLICY_INCOMPLETE".
 *
 * This test exercises the centralized assertNonEmptyAllowedContracts()
 * invariant check, ensuring that:
 * - No inline empty checks bypass this path
 * - Tool executor is NOT called
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  deriveAllowedContracts,
  assertNonEmptyAllowedContracts,
  createRestrictedCapabilities,
  type RuntimeCapabilities,
} from "../allowed-contracts.js";
import {
  ClarityBurstAbstainError,
} from "../errors.js";
import type { OntologyPack } from "../pack-registry.js";

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
 * Creates a mock TOOL_DISPATCH_GATE ontology pack where ALL contracts
 * require at least one capability. This ensures deriveAllowedContracts()
 * will return an empty array when called with restrictedCapabilities.
 *
 * By design, this pack has no zero-capability contracts, making it
 * impossible to proceed when capabilities are restricted.
 */
function createToolDispatchGatePackWithAllCapabilityRequirements(): OntologyPack {
  return {
    pack_id: "openclawd.TOOL_DISPATCH_GATE_EMPTY_ALLOWLIST_TEST",
    pack_version: "2.0.0",
    stage_id: "TOOL_DISPATCH_GATE",
    description: "Test pack with ALL contracts requiring capabilities",
    thresholds: {
      min_confidence_T: 0.55,
      dominance_margin_Delta: 0.10,
    },
    contracts: [
      {
        contract_id: "DISPATCH_WRITE",
        risk_class: "MEDIUM",
        required_fields: ["tool_name", "target_path"],
        limits: {},
        needs_confirmation: false,
        deny_by_default: false,
        capability_requirements: ["fs_write"], // Requires capability
      },
      {
        contract_id: "DISPATCH_SHELL_EXEC",
        risk_class: "HIGH",
        required_fields: ["tool_name", "command", "working_directory"],
        limits: {},
        needs_confirmation: true,
        deny_by_default: false,
        capability_requirements: ["shell"], // Requires capability
      },
      {
        contract_id: "DISPATCH_NETWORK",
        risk_class: "HIGH",
        required_fields: ["tool_name", "url"],
        limits: {},
        needs_confirmation: false,
        deny_by_default: false,
        capability_requirements: ["network"], // Requires capability
      },
    ],
    field_schema: {},
  };
}

/**
 * Wrapper function that applies allowed contract derivation and
 * triggers the centralized assertNonEmptyAllowedContracts check.
 *
 * This simulates the gating flow where:
 * 1. deriveAllowedContracts() produces empty array
 * 2. assertNonEmptyAllowedContracts() throws ClarityBurstAbstainError
 * 3. Error propagates to caller
 */
function executeToolDispatchWithGatingAndAllowlistCheck(
  pack: OntologyPack,
  capabilities: RuntimeCapabilities,
  toolExecutor: ReturnType<typeof createMockToolExecutor>
): {
  success: true;
  result: string;
} {
  try {
    const allowedContractIds = deriveAllowedContracts(
      "TOOL_DISPATCH_GATE",
      pack,
      capabilities
    );

    // This centralized check ensures NO empty allowlist can bypass
    // - outcome: "ABSTAIN_CLARIFY"
    // - reason: "PACK_POLICY_INCOMPLETE"
    // - contractId: null
    assertNonEmptyAllowedContracts("TOOL_DISPATCH_GATE", allowedContractIds);

    // If we reach here, allowed contracts exist and we can proceed
    return toolExecutor.execute();
  } catch (error) {
    // Rethrow so caller can verify the error structure
    throw error;
  }
}

describe("TOOL_DISPATCH_GATE empty_allowlist → ABSTAIN_CLARIFY tripwire", () => {
  let mockPack: OntologyPack;
  let restrictedCaps: RuntimeCapabilities;
  let mockToolExecutor: ReturnType<typeof createMockToolExecutor>;

  beforeEach(() => {
    // Create a pack where ALL contracts require capability (no zero-cap contracts)
    mockPack = createToolDispatchGatePackWithAllCapabilityRequirements();
    // Create capabilities with everything disabled
    restrictedCaps = createRestrictedCapabilities();
    mockToolExecutor = createMockToolExecutor();
  });

  describe("empty allowlist blocking behavior", () => {
    it("should block with ABSTAIN_CLARIFY when deriveAllowedContracts yields empty array (capability-based filtering)", () => {
      // Arrange: Verify that the pack + caps combination yields empty allowlist
      const allowedContractIds = deriveAllowedContracts(
        "TOOL_DISPATCH_GATE",
        mockPack,
        restrictedCaps
      );
      expect(allowedContractIds).toEqual([]); // Verify precondition: empty

      // Act & Assert: Execute should throw ClarityBurstAbstainError with correct structure
      expect(() => {
        executeToolDispatchWithGatingAndAllowlistCheck(
          mockPack,
          restrictedCaps,
          mockToolExecutor
        );
      }).toThrow(ClarityBurstAbstainError);

      // Verify exact error structure
      let caughtError: ClarityBurstAbstainError | undefined;
      try {
        executeToolDispatchWithGatingAndAllowlistCheck(
          mockPack,
          restrictedCaps,
          mockToolExecutor
        );
      } catch (error) {
        if (error instanceof ClarityBurstAbstainError) {
          caughtError = error;
        }
      }

      expect(caughtError).toBeDefined();
      expect(caughtError?.stageId).toBe("TOOL_DISPATCH_GATE");
      expect(caughtError?.outcome).toBe("ABSTAIN_CLARIFY");
      expect(caughtError?.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(caughtError?.contractId).toBe(null);

      // Assert: Tool executor was NOT called
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });

    it("should exercise centralized assertNonEmptyAllowedContracts path and throw with exact payload", () => {
      // Arrange: Empty allowlist scenario
      const allowedContractIds = deriveAllowedContracts(
        "TOOL_DISPATCH_GATE",
        mockPack,
        restrictedCaps
      );
      expect(allowedContractIds).toHaveLength(0);

      // Act: Call assertNonEmptyAllowedContracts directly
      // This should throw ClarityBurstAbstainError
      expect(() => {
        assertNonEmptyAllowedContracts("TOOL_DISPATCH_GATE", allowedContractIds);
      }).toThrow(ClarityBurstAbstainError);

      // Verify the error structure
      let caughtError: ClarityBurstAbstainError | undefined;
      try {
        assertNonEmptyAllowedContracts("TOOL_DISPATCH_GATE", allowedContractIds);
      } catch (error) {
        if (error instanceof ClarityBurstAbstainError) {
          caughtError = error;
        }
      }

      expect(caughtError).toBeDefined();
      expect(caughtError?.stageId).toBe("TOOL_DISPATCH_GATE");
      expect(caughtError?.outcome).toBe("ABSTAIN_CLARIFY");
      expect(caughtError?.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(caughtError?.contractId).toBe(null);
    });

    it("should NOT call tool executor when allowlist is empty", () => {
      // Arrange
      const allowedContractIds = deriveAllowedContracts(
        "TOOL_DISPATCH_GATE",
        mockPack,
        restrictedCaps
      );
      expect(allowedContractIds).toHaveLength(0);

      // Act: Try to execute, which should throw
      expect(() => {
        executeToolDispatchWithGatingAndAllowlistCheck(
          mockPack,
          restrictedCaps,
          mockToolExecutor
        );
      }).toThrow(ClarityBurstAbstainError);

      // Assert: Tool executor was never invoked
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });
  });
});
