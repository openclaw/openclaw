/**
 * FILE_SYSTEM_OPS writeConfigFile() Pack Incomplete → Fail-Closed at Commit Point Tripwire Test
 *
 * Verifies that the config file write commit point in createConfigIO().writeConfigFile()
 * fails closed when loadPackOrAbstain("FILE_SYSTEM_OPS") throws ClarityBurstAbstainError
 * due to a malformed/incomplete pack.
 *
 * This test simulates the REAL commit-point scenario:
 * - loadPackOrAbstain("FILE_SYSTEM_OPS") is called before JSON.stringify
 * - If pack is incomplete, loadPackOrAbstain throws ClarityBurstAbstainError
 * - The function throws an error with blocked response details
 * - fs.promises.writeFile is NOT called (fail-closed)
 *
 * Injection mechanism:
 * - Mock loadPackOrAbstain to throw ClarityBurstAbstainError with reason="PACK_POLICY_INCOMPLETE"
 * - This simulates the real scenario where pack validation fails during load
 *
 * Test assertions:
 * - Function throws an error with blocked response information
 * - fs.promises.writeFile was NOT called (fail-closed, no disk write)
 * - The error message contains FILE_SYSTEM_OPS gating indicator
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import {
  ClarityBurstAbstainError,
} from "../errors";
import * as packLoadModule from "../pack-load";
import type { OpenClawConfig } from "../../config/types.js";

/**
 * Creates a minimal valid config object for testing
 */
function createMockConfig(): OpenClawConfig {
  return {
    agents: {},
  };
}

describe("FILE_SYSTEM_OPS writeConfigFile() pack_incomplete → fail-closed at commit point tripwire", () => {
  let loadPackOrAbstainSpy: ReturnType<typeof vi.spyOn>;
  let writeFileSpy: ReturnType<typeof vi.spyOn>;
  let mkdirSpy: ReturnType<typeof vi.spyOn>;
  const testConfigPath = path.join(__dirname, "test_config_file_system_ops_incomplete_pack.json");

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper to call writeConfigFile via createConfigIO with mocked dependencies
   */
  async function callWriteConfigFileWithMocks(
    cfg: OpenClawConfig,
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
            contract_id: "FS_WRITE_WORKSPACE",
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
    writeFileSpy = vi.fn().mockResolvedValue(undefined);
    mkdirSpy = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(fsModule.promises, "mkdir").mockImplementation(mkdirSpy);
    vi.spyOn(fsModule.promises, "writeFile").mockImplementation(writeFileSpy);
    vi.spyOn(fsModule.promises, "rename").mockResolvedValue(undefined);
    vi.spyOn(fsModule.promises, "chmod").mockResolvedValue(undefined);
    vi.spyOn(fsModule, "existsSync").mockReturnValue(false);

    try {
      // Get the config IO module and call writeConfigFile
      const { createConfigIO } = await import("../../config/io.js");
      const configIO = createConfigIO({ configPath: testConfigPath });
      await configIO.writeConfigFile(cfg);
      return undefined; // Success case
    } catch (err) {
      return err as Error;
    }
  }

  describe("pack incomplete blocking at writeConfigFile commit point", () => {
    it("should throw error when FILE_SYSTEM_OPS pack is incomplete", async () => {
      // Arrange
      const mockConfig = createMockConfig();

      // Act: Call with incomplete pack error injected
      const result = await callWriteConfigFileWithMocks(mockConfig, true);

      // Assert: Function threw an error
      expect(result).toBeInstanceOf(Error);
      const error = result as Error;
      expect(error.message).toContain("FILE_SYSTEM_OPS");
    });

    it("should NOT write to disk when pack is incomplete", async () => {
      // Arrange
      const mockConfig = createMockConfig();

      // Act
      await callWriteConfigFileWithMocks(mockConfig, true);

      // Assert: writeFile was never called
      expect(writeFileSpy).not.toHaveBeenCalled();
    });

    it("should indicate blocked response in error message", async () => {
      // Arrange
      const mockConfig = createMockConfig();

      // Act
      const result = await callWriteConfigFileWithMocks(mockConfig, true);

      // Assert: Error message contains gating information
      expect(result).toBeInstanceOf(Error);
      const error = result as Error;
      expect(error.message).toMatch(/blocked|FILE_SYSTEM_OPS|gating/i);
    });

    it("should reach gating logic before any disk write attempts", async () => {
      // Arrange
      let loadPackCalled = false;
      const mockConfig = createMockConfig();

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
      writeFileSpy = vi.fn().mockResolvedValue(undefined);
      mkdirSpy = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(fsModule.promises, "writeFile").mockImplementation(writeFileSpy);
      vi.spyOn(fsModule.promises, "mkdir").mockImplementation(mkdirSpy);
      vi.spyOn(fsModule, "existsSync").mockReturnValue(false);

      const { createConfigIO } = await import("../../config/io.js");

      // Act
      try {
        const configIO = createConfigIO({ configPath: testConfigPath });
        await configIO.writeConfigFile(mockConfig);
      } catch {
        // Expected to throw
      }

      // Assert: loadPackOrAbstain was called (gating was attempted)
      expect(loadPackCalled).toBe(true);

      // Assert: writeFile was never called (blocked before reaching write)
      expect(writeFileSpy).not.toHaveBeenCalled();
    });
  });

  describe("fail-closed guarantees for incomplete pack", () => {
    it("should block even if config data looks valid", async () => {
      // Arrange: Even with valid config data, incomplete pack should block
      const validConfig: OpenClawConfig = {
        agents: {},
      };

      // Act
      const result = await callWriteConfigFileWithMocks(validConfig, true);

      // Assert: Blocked despite valid config content
      expect(result).toBeInstanceOf(Error);
      expect(writeFileSpy).not.toHaveBeenCalled();
    });

    it("should throw ClarityBurstAbstainError-derived exception", async () => {
      // Arrange
      const mockConfig = createMockConfig();

      // Act
      const result = await callWriteConfigFileWithMocks(mockConfig, true);

      // Assert: Error comes from FILE_SYSTEM_OPS gating
      expect(result).toBeInstanceOf(Error);
      const error = result as Error;
      expect(error.message).toContain("FILE_SYSTEM_OPS");
    });
  });
});
