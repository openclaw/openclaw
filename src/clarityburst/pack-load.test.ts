/**
 * Unit tests for Pack Load Helper Module
 *
 * Tests the loadPackOrAbstain() function which wraps getPackForStage() with
 * deterministic error conversion and cross-file integrity validation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClarityBurstAbstainError } from "./errors";
import type { OntologyPack } from "./pack-registry";

// Mock the pack-registry module to control getPackForStage behavior
vi.mock("./pack-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pack-registry")>();
  return {
    ...actual,
    getPackForStage: vi.fn(),
  };
});

// Import after mocking
import { loadPackOrAbstain } from "./pack-load";
import { getPackForStage, PackPolicyIncompleteError } from "./pack-registry";

const mockedGetPackForStage = vi.mocked(getPackForStage);

describe("loadPackOrAbstain - stage_id mismatch detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Creates a valid mock pack with specified stage_id.
   * Used to simulate a pack that passes structural validation but has
   * a mismatched stage_id (the cross-file integrity invariant violation).
   */
  function createValidMockPack(stageId: string): OntologyPack {
    return {
      pack_id: `test.${stageId.toLowerCase()}_pack`,
      pack_version: "1.0.0",
      stage_id: stageId,
      description: `Test pack for ${stageId}`,
      thresholds: {
        min_confidence_T: 0.7,
        dominance_margin_Delta: 0.1,
      },
      contracts: [
        {
          contract_id: "TEST_CONTRACT",
          risk_class: "LOW",
          required_fields: [],
          limits: {},
          needs_confirmation: false,
          deny_by_default: false,
          capability_requirements: [],
        },
      ],
      field_schema: {},
    };
  }

  describe("cross-file integrity invariant: pack stage_id must match requested stageId", () => {
    it("should throw ClarityBurstAbstainError when pack.stage_id differs from requested stageId", () => {
      // Arrange: Mock getPackForStage to return a pack with WRONG stage_id
      // This simulates a registry/filename mismatch where:
      // - Lookup is by "SHELL_EXEC" (correct filename/registry key)
      // - But pack internally declares stage_id: "FILE_SYSTEM_OPS" (wrong)
      const mismatchedPack = createValidMockPack("FILE_SYSTEM_OPS");
      mockedGetPackForStage.mockReturnValue(mismatchedPack);

      // Act & Assert: Should throw with deterministic fields
      expect(() => loadPackOrAbstain("SHELL_EXEC")).toThrow(
        ClarityBurstAbstainError
      );
    });

    it("should have deterministic abstain fields when stage_id mismatch detected", () => {
      // Arrange: Pack declares "NETWORK_IO" but is loaded as "SHELL_EXEC"
      const mismatchedPack = createValidMockPack("NETWORK_IO");
      mockedGetPackForStage.mockReturnValue(mismatchedPack);

      // Act & Assert: Verify exact error fields
      try {
        loadPackOrAbstain("SHELL_EXEC");
        expect.fail("Should have thrown ClarityBurstAbstainError");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainErr = err as ClarityBurstAbstainError;

        // Deterministic field assertions per spec
        expect(abstainErr.stageId).toBe("SHELL_EXEC");
        expect(abstainErr.outcome).toBe("ABSTAIN_CLARIFY");
        expect(abstainErr.reason).toBe("PACK_POLICY_INCOMPLETE");
        expect(abstainErr.contractId).toBeNull();
        expect(abstainErr.instructions).toContain(
          'Pack stage_id mismatch: requested "SHELL_EXEC" but pack declares "NETWORK_IO"'
        );
      }
    });

    it("should NOT call router or executor when stage_id mismatch detected", () => {
      // Arrange: Create mock router/executor spies
      // (In this unit test, we verify that loadPackOrAbstain throws BEFORE
      // returning, which means callers never receive the pack to pass to router)
      const mismatchedPack = createValidMockPack("BROWSER_AUTOMATE");
      mockedGetPackForStage.mockReturnValue(mismatchedPack);

      // Track whether the function returns normally (it shouldn't)
      let packReturned = false;
      let errorThrown = false;

      // Act
      try {
        const result = loadPackOrAbstain("SHELL_EXEC");
        packReturned = true;
        // If we got here, the function returned - this is wrong
        void result; // Suppress unused variable warning
      } catch (err) {
        errorThrown = true;
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
      }

      // Assert: Error thrown means router/executor never get the pack
      expect(packReturned).toBe(false);
      expect(errorThrown).toBe(true);
      // getPackForStage was called exactly once (to fetch the pack)
      expect(mockedGetPackForStage).toHaveBeenCalledTimes(1);
      expect(mockedGetPackForStage).toHaveBeenCalledWith("SHELL_EXEC");
    });

    it("should produce identical error on repeated calls (determinism)", () => {
      // Arrange: Same mismatched pack scenario
      const mismatchedPack = createValidMockPack("CRON_SCHEDULE");
      mockedGetPackForStage.mockReturnValue(mismatchedPack);

      // Act: Call multiple times
      const errors: ClarityBurstAbstainError[] = [];
      for (let i = 0; i < 3; i++) {
        try {
          loadPackOrAbstain("SHELL_EXEC");
        } catch (err) {
          errors.push(err as ClarityBurstAbstainError);
        }
      }

      // Assert: All errors have identical fields
      expect(errors.length).toBe(3);
      for (const err of errors) {
        expect(err.stageId).toBe("SHELL_EXEC");
        expect(err.outcome).toBe("ABSTAIN_CLARIFY");
        expect(err.reason).toBe("PACK_POLICY_INCOMPLETE");
        expect(err.contractId).toBeNull();
        expect(err.instructions).toBe(errors[0].instructions);
      }
    });
  });

  describe("successful pack load when stage_id matches", () => {
    it("should return pack when pack.stage_id equals requested stageId", () => {
      // Arrange: Pack stage_id matches the requested stageId
      const matchingPack = createValidMockPack("SHELL_EXEC");
      mockedGetPackForStage.mockReturnValue(matchingPack);

      // Act
      const result = loadPackOrAbstain("SHELL_EXEC");

      // Assert: Pack returned without error
      expect(result).toBe(matchingPack);
      expect(result.stage_id).toBe("SHELL_EXEC");
    });
  });

  describe("PackPolicyIncompleteError conversion", () => {
    it("should convert PackPolicyIncompleteError to ClarityBurstAbstainError", () => {
      // Arrange: getPackForStage throws PackPolicyIncompleteError
      mockedGetPackForStage.mockImplementation(() => {
        throw new PackPolicyIncompleteError("SHELL_EXEC", [
          "contracts[0].capability_requirements",
        ]);
      });

      // Act & Assert
      expect(() => loadPackOrAbstain("SHELL_EXEC")).toThrow(
        ClarityBurstAbstainError
      );

      try {
        loadPackOrAbstain("SHELL_EXEC");
      } catch (err) {
        const abstainErr = err as ClarityBurstAbstainError;
        expect(abstainErr.outcome).toBe("ABSTAIN_CLARIFY");
        expect(abstainErr.reason).toBe("PACK_POLICY_INCOMPLETE");
        expect(abstainErr.contractId).toBeNull();
      }
    });

    it("should re-throw unexpected errors without conversion", () => {
      // Arrange: getPackForStage throws a generic error
      const genericError = new Error("Unknown stage_id");
      mockedGetPackForStage.mockImplementation(() => {
        throw genericError;
      });

      // Act & Assert: Should re-throw as-is
      expect(() => loadPackOrAbstain("SHELL_EXEC")).toThrow(genericError);
    });
  });
});
