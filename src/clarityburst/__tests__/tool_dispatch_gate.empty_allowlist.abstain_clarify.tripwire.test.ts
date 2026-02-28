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
 * - The response structure includes nonRetryable: true
 * - Tool executor is NOT called
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  deriveAllowedContracts,
  assertNonEmptyAllowedContracts,
  createRestrictedCapabilities,
  type RuntimeCapabilities,
} from "../allowed-contracts";
import {
  ClarityBurstAbstainError,
} from "../errors";
import {
  convertAbstainToBlockedResponse,
  type BlockedResponsePayload,
} from "../../agents/pi-tool-definition-adapter.js";
import type { OntologyPack } from "../pack-registry";

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
 * impossible to route when all capabilities are disabled.
 */
function createToolDispatchGatePackWithAllCapabilityRequirements(): OntologyPack {
  return {
    pack_id: "openclawd.TOOL_DISPATCH_GATE_ALL_CAPS_REQUIRED",
    pack_version: "2.0.0",
    stage_id: "TOOL_DISPATCH_GATE",
    description: "TOOL_DISPATCH_GATE pack where every contract requires at least one capability",
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
        capability_requirements: ["fs_write"], // Requires fs_write
      },
      {
        contract_id: "DISPATCH_DELETE",
        risk_class: "HIGH",
        required_fields: ["tool_name", "target_path"],
        limits: {},
        needs_confirmation: false,
        deny_by_default: false,
        capability_requirements: ["fs_write"], // Requires fs_write
      },
      {
        contract_id: "DISPATCH_SHELL_EXEC",
        risk_class: "HIGH",
        required_fields: ["tool_name", "command", "working_directory"],
        limits: {},
        needs_confirmation: true,
        deny_by_default: false,
        capability_requirements: ["shell"], // Requires shell
      },
      {
        contract_id: "DISPATCH_NETWORK_REQUEST",
        risk_class: "MEDIUM",
        required_fields: ["tool_name", "url", "method"],
        limits: {},
        needs_confirmation: false,
        deny_by_default: false,
        capability_requirements: ["network"], // Requires network
      },
      {
        contract_id: "DISPATCH_BROWSER_AUTOMATE",
        risk_class: "MEDIUM",
        required_fields: ["tool_name", "action_type"],
        limits: {},
        needs_confirmation: false,
        deny_by_default: false,
        capability_requirements: ["browser"], // Requires browser
      },
      {
        contract_id: "DISPATCH_SENSITIVE_DATA",
        risk_class: "HIGH",
        required_fields: ["tool_name", "data_classification"],
        limits: {},
        needs_confirmation: true,
        deny_by_default: false,
        capability_requirements: ["sensitive_access"], // Requires sensitive_access
      },
      {
        contract_id: "DISPATCH_PRIVILEGED_ADMIN",
        risk_class: "CRITICAL",
        required_fields: ["tool_name", "admin_scope"],
        limits: {},
        needs_confirmation: true,
        deny_by_default: true,
        capability_requirements: ["shell", "critical_opt_in"], // Requires shell AND critical_opt_in
      },
    ],
    field_schema: {},
  };
}

/**
 * Wrapper function that simulates the TOOL_DISPATCH_GATE gating flow.
 * Exercises the centralized assertNonEmptyAllowedContracts() path.
 *
 * Steps:
 * 1. Derive allowed contracts based on pack and capabilities
 * 2. Assert allowed contracts are non-empty (throws if empty)
 * 3. On empty allowlist error, convert to BlockedResponsePayload
 * 4. Otherwise, proceed with tool execution
 */
function executeToolDispatchWithGatingAndAllowlistCheck(
  pack: OntologyPack,
  runtimeCaps: RuntimeCapabilities,
  toolExecutor: ReturnType<typeof createMockToolExecutor>
): { success: true; result: unknown } | BlockedResponsePayload {
  try {
    // Derive allowed contracts based on pack and runtime capabilities
    const allowedContractIds = deriveAllowedContracts("TOOL_DISPATCH_GATE", pack, runtimeCaps);

    // Assert allowedContractIds is non-empty - this is the CENTRAL invariant check
    // If empty, throws ClarityBurstAbstainError with:
    // - outcome: "ABSTAIN_CLARIFY"
    // - reason: "PACK_POLICY_INCOMPLETE"
    // - contractId: null
    assertNonEmptyAllowedContracts("TOOL_DISPATCH_GATE", allowedContractIds);

    // If we reach here, allowed contracts exist and we can proceed
    return toolExecutor.execute();
  } catch (error) {
    // Handle the ClarityBurstAbstainError from assertNonEmptyAllowedContracts
    if (error instanceof ClarityBurstAbstainError) {
      return convertAbstainToBlockedResponse(error);
    }
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

      // Act: Execute through the gating wrapper
      const result = executeToolDispatchWithGatingAndAllowlistCheck(
        mockPack,
        restrictedCaps,
        mockToolExecutor
      );

      // Assert: Blocked response with PACK_POLICY_INCOMPLETE
      expect(result).toMatchObject({
        nonRetryable: true,
        stageId: "TOOL_DISPATCH_GATE",
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
      });

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

    it("should convert ClarityBurstAbstainError to BlockedResponsePayload with nonRetryable=true", () => {
      // Arrange: Empty allowlist
      const allowedContractIds = deriveAllowedContracts(
        "TOOL_DISPATCH_GATE",
        mockPack,
        restrictedCaps
      );

      // Act: Execute wrapper which triggers assertNonEmptyAllowedContracts
      const result = executeToolDispatchWithGatingAndAllowlistCheck(
        mockPack,
        restrictedCaps,
        mockToolExecutor
      );

      // Assert: BlockedResponsePayload structure
      expect(result).toHaveProperty("nonRetryable");
      expect(result).toHaveProperty("stageId");
      expect(result).toHaveProperty("outcome");
      expect(result).toHaveProperty("reason");
      expect(result).toHaveProperty("contractId");

      const blocked = result as BlockedResponsePayload;
      expect(blocked.nonRetryable).toBe(true); // Fail-closed, non-retryable
      expect(blocked.outcome).toBe("ABSTAIN_CLARIFY");
      expect(blocked.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(blocked.contractId).toBe(null);
    });

    it("should NOT call tool executor when allowlist is empty", () => {
      // Arrange
      const allowedContractIds = deriveAllowedContracts(
        "TOOL_DISPATCH_GATE",
        mockPack,
        restrictedCaps
      );
      expect(allowedContractIds).toHaveLength(0);

      // Act
      executeToolDispatchWithGatingAndAllowlistCheck(
        mockPack,
        restrictedCaps,
        mockToolExecutor
      );

      // Assert: Tool executor was never invoked
      expect(mockToolExecutor.getCallCount()).toBe(0);
    });
  });
});
