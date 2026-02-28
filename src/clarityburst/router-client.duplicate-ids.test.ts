/**
 * Regression Test: allowedContractIds Duplicate Detection
 *
 * This test validates the client-side invariant that allowedContractIds
 * must not contain duplicates or non-string values.
 *
 * INVARIANT: routeClarityBurst() throws ClarityBurstAbstainError with
 * { outcome: "ABSTAIN_CLARIFY", reason: "PACK_POLICY_INCOMPLETE", contractId: null }
 * when allowedContractIds contains duplicate entries.
 */

import { describe, it, expect } from "vitest";
import { routeClarityBurst, type RouterInput } from "./router-client";
import { ClarityBurstAbstainError } from "./errors";

describe("routeClarityBurst allowedContractIds validation", () => {
  describe("duplicate ID detection", () => {
    /**
     * Regression test: Duplicate contract IDs in allowedContractIds
     *
     * When allowedContractIds contains ["A", "A"], the router client must:
     * 1. NOT call the router endpoint
     * 2. Throw ClarityBurstAbstainError with deterministic fields
     */
    it('throws ClarityBurstAbstainError when allowedContractIds contains duplicates ["A", "A"]', async () => {
      // Arrange: Input with duplicate contract IDs
      const input: RouterInput = {
        stageId: "SHELL_EXEC",
        packId: "test-pack",
        packVersion: "1.0.0",
        allowedContractIds: ["A", "A"],
        userText: "test command",
      };

      // Act & Assert: Should throw ClarityBurstAbstainError
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await routeClarityBurst(input);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        if (err instanceof ClarityBurstAbstainError) {
          caughtError = err;
        } else {
          throw err;
        }
      }

      // Assert: ClarityBurstAbstainError with exact fields
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      expect(caughtError!.outcome).toBe("ABSTAIN_CLARIFY");
      expect(caughtError!.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(caughtError!.contractId).toBeNull();
      expect(caughtError!.instructions).toContain("duplicate");
      expect(caughtError!.instructions).toContain('"A"');
    });

    it("throws ClarityBurstAbstainError when allowedContractIds contains multiple duplicates", async () => {
      // Arrange: Input with duplicates appearing later in array
      const input: RouterInput = {
        stageId: "NETWORK_IO",
        packId: "test-pack",
        packVersion: "1.0.0",
        allowedContractIds: ["A", "B", "C", "B"],
        userText: "test request",
      };

      // Act & Assert
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await routeClarityBurst(input);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        if (err instanceof ClarityBurstAbstainError) {
          caughtError = err;
        } else {
          throw err;
        }
      }

      // Assert: Reports the first duplicate found
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      expect(caughtError!.outcome).toBe("ABSTAIN_CLARIFY");
      expect(caughtError!.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(caughtError!.contractId).toBeNull();
      expect(caughtError!.instructions).toContain('"B"');
    });
  });

  describe("non-string value detection", () => {
    it("throws ClarityBurstAbstainError when allowedContractIds contains non-string values", async () => {
      // Arrange: Input with non-string value (type assertion to bypass TypeScript)
      const input = {
        stageId: "FILE_SYSTEM_OPS",
        packId: "test-pack",
        packVersion: "1.0.0",
        allowedContractIds: ["A", 123, "B"] as unknown as string[],
        userText: "test operation",
      } as RouterInput;

      // Act & Assert
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await routeClarityBurst(input);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        if (err instanceof ClarityBurstAbstainError) {
          caughtError = err;
        } else {
          throw err;
        }
      }

      // Assert
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      expect(caughtError!.outcome).toBe("ABSTAIN_CLARIFY");
      expect(caughtError!.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(caughtError!.contractId).toBeNull();
      expect(caughtError!.instructions).toContain("must be a string");
      expect(caughtError!.instructions).toContain("number");
    });

    it("throws ClarityBurstAbstainError when allowedContractIds contains empty strings", async () => {
      // Arrange: Input with empty string
      const input: RouterInput = {
        stageId: "SHELL_EXEC",
        packId: "test-pack",
        packVersion: "1.0.0",
        allowedContractIds: ["A", "", "B"],
        userText: "test command",
      };

      // Act & Assert
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await routeClarityBurst(input);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        if (err instanceof ClarityBurstAbstainError) {
          caughtError = err;
        } else {
          throw err;
        }
      }

      // Assert
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      expect(caughtError!.outcome).toBe("ABSTAIN_CLARIFY");
      expect(caughtError!.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(caughtError!.contractId).toBeNull();
      expect(caughtError!.instructions).toContain("non-empty string");
    });

    it("throws ClarityBurstAbstainError when allowedContractIds is not an array", async () => {
      // Arrange: Input with non-array value (type assertion to bypass TypeScript)
      const input = {
        stageId: "SHELL_EXEC",
        packId: "test-pack",
        packVersion: "1.0.0",
        allowedContractIds: "not-an-array" as unknown as string[],
        userText: "test command",
      } as RouterInput;

      // Act & Assert
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await routeClarityBurst(input);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        if (err instanceof ClarityBurstAbstainError) {
          caughtError = err;
        } else {
          throw err;
        }
      }

      // Assert
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      expect(caughtError!.outcome).toBe("ABSTAIN_CLARIFY");
      expect(caughtError!.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(caughtError!.contractId).toBeNull();
      expect(caughtError!.instructions).toContain("must be an array");
    });
  });

  describe("stageId propagation", () => {
    it("propagates stageId from input to ClarityBurstAbstainError", async () => {
      // Arrange: Test with different stageIds
      const stageIds = ["SHELL_EXEC", "FILE_SYSTEM_OPS", "NETWORK_IO"] as const;

      for (const stageId of stageIds) {
        const input: RouterInput = {
          stageId,
          packId: "test-pack",
          packVersion: "1.0.0",
          allowedContractIds: ["X", "X"], // Duplicate to trigger error
          userText: "test",
        };

        // Act
        let caughtError: ClarityBurstAbstainError | null = null;
        try {
          await routeClarityBurst(input);
        } catch (err) {
          if (err instanceof ClarityBurstAbstainError) {
            caughtError = err;
          }
        }

        // Assert: stageId is correctly propagated
        expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
        expect(caughtError!.stageId).toBe(stageId);
      }
    });
  });
});
