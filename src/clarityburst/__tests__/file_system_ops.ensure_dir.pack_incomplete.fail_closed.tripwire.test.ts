/**
 * FILE_SYSTEM_OPS ensureDir() Pack Incomplete → Fail-Closed Tripwire Test
 *
 * Verifies that the ensureDir() function in openclaw/src/utils.ts
 * fails closed when loadPackOrAbstain("FILE_SYSTEM_OPS") throws ClarityBurstAbstainError
 * due to a malformed/incomplete pack.
 *
 * This test simulates the REAL scenario:
 * - loadPackOrAbstain("FILE_SYSTEM_OPS") is called before fs.promises.mkdir()
 * - If pack is incomplete, loadPackOrAbstain throws ClarityBurstAbstainError
 * - The function throws ClarityBurstAbstainError (propagated to caller)
 * - fs.promises.mkdir is NOT called (fail-closed)
 *
 * Injection mechanism:
 * - Mock loadPackOrAbstain to throw ClarityBurstAbstainError with reason="PACK_POLICY_INCOMPLETE"
 * - This simulates the real scenario where pack validation fails during load
 *
 * Test assertions:
 * - Function throws ClarityBurstAbstainError with:
 *   - outcome === "ABSTAIN_CLARIFY"
 *   - reason === "PACK_POLICY_INCOMPLETE"
 *   - contractId === null
 * - fs.promises.mkdir was NOT called (fail-closed, no directory created)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import {
  ClarityBurstAbstainError,
} from "../errors";
import * as packLoadModule from "../pack-load";

describe("FILE_SYSTEM_OPS ensureDir() pack_incomplete → fail-closed tripwire", () => {
  let loadPackOrAbstainSpy: ReturnType<typeof vi.spyOn>;
  let mkdirSpy: ReturnType<typeof vi.spyOn>;
  const testDir = path.join(__dirname, "test_ensure_dir_file_system_ops_incomplete_pack");

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper to call ensureDir with mocked dependencies
   */
  async function callEnsureDirWithMocks(
    dir: string,
    shouldThrowIncompletePackError: boolean = true
  ): Promise<void | Error> {
    // Mock loadPackOrAbstain to throw ClarityBurstAbstainError for incomplete pack
    const incompletePackError = new ClarityBurstAbstainError({
      stageId: "FILE_SYSTEM_OPS",
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: "Pack validation failed for stage \"FILE_SYSTEM_OPS\"",
    });

    loadPackOrAbstainSpy = vi.spyOn(packLoadModule, "loadPackOrAbstain").mockImplementation(() => {
      if (shouldThrowIncompletePackError) {
        throw incompletePackError;
      }
      // Return a valid mock pack if not throwing
      return {
        pack_id: "openclawd.FILE_SYSTEM_OPS_TEST",
        pack_version: "1.0.0",
        stage_id: "FILE_SYSTEM_OPS",
        description: "Test pack",
        thresholds: { min_confidence_T: 0, dominance_margin_Delta: 0 },
        contracts: [
          {
            contract_id: "FS_CREATE_DIRECTORY",
            risk_class: "MEDIUM",
            required_fields: ["path", "operation"],
            limits: {},
            needs_confirmation: false,
            deny_by_default: false,
            capability_requirements: [],
          },
        ],
        field_schema: {},
      };
    });

    // Mock fs.promises operations
    const fsModule = await import("node:fs");
    mkdirSpy = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(fsModule.promises, "mkdir").mockImplementation(mkdirSpy);

    try {
      // Get the utils module and call ensureDir
      const { ensureDir } = await import("../../utils.js");
      await ensureDir(dir);
      return undefined; // Success case
    } catch (err) {
      return err as Error;
    }
  }

  describe("pack incomplete blocking in ensureDir", () => {
    it("should throw ClarityBurstAbstainError when FILE_SYSTEM_OPS pack is incomplete", async () => {
      // Arrange
      const testDir = path.join(__dirname, "test_dir");

      // Act: Call with incomplete pack error injected
      const result = await callEnsureDirWithMocks(testDir, true);

      // Assert: Function threw ClarityBurstAbstainError
      expect(result).toBeInstanceOf(ClarityBurstAbstainError);
      const error = result as ClarityBurstAbstainError;
      expect(error.stageId).toBe("FILE_SYSTEM_OPS");
      expect(error.outcome).toBe("ABSTAIN_CLARIFY");
      expect(error.reason).toBe("PACK_POLICY_INCOMPLETE");
    });

    it("should NOT create directory when pack is incomplete", async () => {
      // Arrange
      const testDir = path.join(__dirname, "test_dir");

      // Act
      await callEnsureDirWithMocks(testDir, true);

      // Assert: mkdir was never called
      expect(mkdirSpy).not.toHaveBeenCalled();
    });

    it("should reach gating logic before any mkdir attempts", async () => {
      // Arrange
      let loadPackCalled = false;
      const testDir = path.join(__dirname, "test_dir");

      loadPackOrAbstainSpy = vi.spyOn(packLoadModule, "loadPackOrAbstain").mockImplementation(() => {
        loadPackCalled = true;
        throw new ClarityBurstAbstainError({
          stageId: "FILE_SYSTEM_OPS",
          outcome: "ABSTAIN_CLARIFY",
          reason: "PACK_POLICY_INCOMPLETE",
          contractId: null,
          instructions: "Pack incomplete",
        });
      });

      const fsModule = await import("node:fs");
      mkdirSpy = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(fsModule.promises, "mkdir").mockImplementation(mkdirSpy);

      const { ensureDir } = await import("../../utils.js");

      // Act
      try {
        await ensureDir(testDir);
      } catch {
        // Expected to throw
      }

      // Assert: loadPackOrAbstain was called (gating was attempted)
      expect(loadPackCalled).toBe(true);

      // Assert: mkdir was never called (blocked before reaching mkdir)
      expect(mkdirSpy).not.toHaveBeenCalled();
    });

    it("should have outcome=ABSTAIN_CLARIFY and reason=PACK_POLICY_INCOMPLETE", async () => {
      // Arrange
      const testDir = path.join(__dirname, "test_dir");

      // Act
      const result = await callEnsureDirWithMocks(testDir, true);

      // Assert: Error has exact abstain structure
      expect(result).toBeInstanceOf(ClarityBurstAbstainError);
      const error = result as ClarityBurstAbstainError;
      expect(error.outcome).toBe("ABSTAIN_CLARIFY");
      expect(error.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(error.contractId).toBeNull();
    });
  });

  describe("fail-closed guarantees for incomplete pack", () => {
    it("should block directory creation even with valid path", async () => {
      // Arrange: Even with valid path, incomplete pack should block
      const validPath = path.join(__dirname, "valid", "nested", "path");

      // Act
      const result = await callEnsureDirWithMocks(validPath, true);

      // Assert: Blocked despite valid path
      expect(result).toBeInstanceOf(ClarityBurstAbstainError);
      expect(mkdirSpy).not.toHaveBeenCalled();
    });

    it("should propagate ClarityBurstAbstainError to caller", async () => {
      // Arrange
      const testDir = path.join(__dirname, "test_dir");

      // Act
      const result = await callEnsureDirWithMocks(testDir, true);

      // Assert: Error is directly throwable by caller
      expect(result).toBeInstanceOf(ClarityBurstAbstainError);
      const error = result as ClarityBurstAbstainError;
      expect(error.stageId).toBe("FILE_SYSTEM_OPS");
    });

    it("should never attempt mkdir regardless of directory depth", async () => {
      // Arrange: Test with deeply nested path
      const deepPath = path.join(
        __dirname,
        "a",
        "b",
        "c",
        "d",
        "e",
        "f",
        "g",
        "h",
        "i",
        "j"
      );

      // Act
      await callEnsureDirWithMocks(deepPath, true);

      // Assert: mkdir was never called even for deep nesting
      expect(mkdirSpy).not.toHaveBeenCalled();
    });
  });
});
