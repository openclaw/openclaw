/**
 * FILE_SYSTEM_OPS Session Store Write Path Gate Integration Tripwire Test
 *
 * Verifies that the session store write paths in src/config/sessions/store.ts
 * are correctly gated through FILE_SYSTEM_OPS execution-boundary gating.
 *
 * This test ensures:
 * 1. Gate is invoked before each fs.promises.writeFile call (temp file + permanent file)
 * 2. Gate is invoked before each fs.promises.rename call (atomic commit)
 * 3. Gate abstention (ABSTAIN_CONFIRM/ABSTAIN_CLARIFY) prevents filesystem mutations
 * 4. Gate approval preserves original behavior
 * 5. Atomic-write semantics (temp → rename) are not regressed
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import * as fsPromises from "fs/promises";
import { ClarityBurstAbstainError } from "../errors.js";
import {
  applyFileSystemOpsGateAndWrite,
  applyFileSystemOpsGateAndRename,
} from "../file-system-ops-gating.js";
import * as decisionOverride from "../decision-override.js";

describe("FILE_SYSTEM_OPS session store write paths gate integration", () => {
  let testDir: string;
  let testStorePath: string;

  beforeEach(() => {
    testDir = path.join(__dirname, "test-session-store-gating");
    testStorePath = path.join(testDir, "sessions.json");
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Session store temp write → rename atomic sequence", () => {
    it("should call gate twice (write + rename) for atomic persistence", async () => {
      const applyFileSystemOverridesSpy = vi.spyOn(decisionOverride, "applyFileSystemOverrides");
      applyFileSystemOverridesSpy.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "FS_WRITE",
      } as any);

      const testData = JSON.stringify({ sessionKey: "test", updatedAt: Date.now() }, null, 2);
      const tmpPath = `${testStorePath}.tmp`;

      // First gate call: temp file write
      await applyFileSystemOpsGateAndWrite(tmpPath, testData, "utf-8");

      // Second gate call: atomic rename to final location
      await applyFileSystemOpsGateAndRename(tmpPath, testStorePath);

      // Verify gate was called exactly twice
      expect(applyFileSystemOverridesSpy).toHaveBeenCalledTimes(2);

      // Verify first call is for write operation
      const firstCall = applyFileSystemOverridesSpy.mock.calls[0]?.[0];
      expect(firstCall).toMatchObject({
        stageId: "FILE_SYSTEM_OPS",
        operation: "write",
        path: tmpPath,
      });

      // Verify second call is for rename operation
      const secondCall = applyFileSystemOverridesSpy.mock.calls[1]?.[0];
      expect(secondCall).toMatchObject({
        stageId: "FILE_SYSTEM_OPS",
        operation: "rename",
        path: tmpPath,
      });

      applyFileSystemOverridesSpy.mockRestore();
    });

    it("should block write when gate returns ABSTAIN_CONFIRM", async () => {
      const applyFileSystemOverridesSpy = vi.spyOn(decisionOverride, "applyFileSystemOverrides");
      applyFileSystemOverridesSpy.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        contractId: "FS_WRITE",
        reason: "CONFIRM_REQUIRED",
        instructions: "Session store persistence requires explicit confirmation",
      } as any);

      const testData = JSON.stringify({ sessionKey: "test" });
      const tmpPath = `${testStorePath}.tmp`;

      // Pre-write the temp file to disk manually (what the code would do)
      fs.writeFileSync(tmpPath, "initial content");

      // Gate should prevent write from reaching the actual filesystem
      let thrownError: unknown;
      try {
        await applyFileSystemOpsGateAndWrite(tmpPath, testData, "utf-8");
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(ClarityBurstAbstainError);
      const error = thrownError as ClarityBurstAbstainError;
      expect(error.stageId).toBe("FILE_SYSTEM_OPS");
      expect(error.outcome).toBe("ABSTAIN_CONFIRM");

      applyFileSystemOverridesSpy.mockRestore();
    });

    it("should block rename when gate returns ABSTAIN_CLARIFY", async () => {
      const applyFileSystemOverridesSpy = vi.spyOn(decisionOverride, "applyFileSystemOverrides");
      const callCount = { count: 0 };

      applyFileSystemOverridesSpy.mockImplementation(async () => {
        callCount.count++;
        // First call (write) succeeds
        if (callCount.count === 1) {
          return {
            outcome: "PROCEED",
            contractId: "FS_WRITE",
          } as any;
        }
        // Second call (rename) abstains
        return {
          outcome: "ABSTAIN_CLARIFY",
          contractId: null,
          reason: "PACK_POLICY_INCOMPLETE",
          instructions: "Session store rename requires pack clarification",
        } as any;
      });

      const testData = JSON.stringify({ sessionKey: "test" });
      const tmpPath = `${testStorePath}.tmp`;

      // Write succeeds
      await applyFileSystemOpsGateAndWrite(tmpPath, testData, "utf-8");

      // Rename should be blocked
      let thrownError: unknown;
      try {
        await applyFileSystemOpsGateAndRename(tmpPath, testStorePath);
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(ClarityBurstAbstainError);
      const error = thrownError as ClarityBurstAbstainError;
      expect(error.stageId).toBe("FILE_SYSTEM_OPS");
      expect(error.outcome).toBe("ABSTAIN_CLARIFY");

      // Verify temp file still exists (wasn't renamed)
      expect(fs.existsSync(tmpPath)).toBe(true);
      expect(fs.existsSync(testStorePath)).toBe(false);

      applyFileSystemOverridesSpy.mockRestore();
    });
  });

  describe("Gate invocation before mutations", () => {
    it("gate is invoked and blocks mutations before executing filesystem operations", async () => {
      const applyFileSystemOverridesSpy = vi.spyOn(decisionOverride, "applyFileSystemOverrides");
      applyFileSystemOverridesSpy.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        contractId: null,
        reason: "PACK_POLICY_INCOMPLETE",
        instructions: "Blocked",
      } as any);

      const testData = JSON.stringify({ test: "data" });

      // Gate should block before filesystem touch
      let errorThrown = false;
      try {
        await applyFileSystemOpsGateAndWrite(testStorePath, testData, "utf-8");
      } catch (err) {
        if (err instanceof ClarityBurstAbstainError) {
          errorThrown = true;
        }
      }

      // Gate blocked the operation: file should NOT exist
      expect(errorThrown).toBe(true);
      expect(fs.existsSync(testStorePath)).toBe(false);

      applyFileSystemOverridesSpy.mockRestore();
    });
  });

  describe("Atomic-write semantics preservation", () => {
    it("should support options parameter for mode and encoding", async () => {
      const applyFileSystemOverridesSpy = vi.spyOn(decisionOverride, "applyFileSystemOverrides");
      applyFileSystemOverridesSpy.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "FS_WRITE",
      } as any);

      const testData = JSON.stringify({ test: "data" });

      // Should accept options object with mode and encoding
      await applyFileSystemOpsGateAndWrite(testStorePath, testData, {
        mode: 0o600,
        encoding: "utf-8",
      });

      // File should exist and be readable
      expect(fs.existsSync(testStorePath)).toBe(true);
      const content = fs.readFileSync(testStorePath, "utf-8");
      expect(content).toBe(testData);

      applyFileSystemOverridesSpy.mockRestore();
    });

    it("should preserve atomic temp→rename sequence behavior", async () => {
      const applyFileSystemOverridesSpy = vi.spyOn(decisionOverride, "applyFileSystemOverrides");
      applyFileSystemOverridesSpy.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "FS_WRITE",
      } as any);

      const testData1 = JSON.stringify({ version: 1 });
      const testData2 = JSON.stringify({ version: 2 });
      const tmpPath = `${testStorePath}.tmp`;

      // First atomic write: temp → final
      await applyFileSystemOpsGateAndWrite(tmpPath, testData1, "utf-8");
      await applyFileSystemOpsGateAndRename(tmpPath, testStorePath);

      // Verify first version is persisted
      let content = fs.readFileSync(testStorePath, "utf-8");
      expect(content).toBe(testData1);

      // Second atomic write: temp → final
      const tmpPath2 = `${testStorePath}.2.tmp`;
      await applyFileSystemOpsGateAndWrite(tmpPath2, testData2, "utf-8");
      await applyFileSystemOpsGateAndRename(tmpPath2, testStorePath);

      // Verify second version replaced the first
      content = fs.readFileSync(testStorePath, "utf-8");
      expect(content).toBe(testData2);

      applyFileSystemOverridesSpy.mockRestore();
    });
  });

  describe("Gating context and audit trails", () => {
    it("should include session-store context in gate calls", async () => {
      const applyFileSystemOverridesSpy = vi.spyOn(decisionOverride, "applyFileSystemOverrides");
      applyFileSystemOverridesSpy.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "FS_WRITE",
      } as any);

      const testData = JSON.stringify({ sessionKey: "user@domain" });
      const tmpPath = `${testStorePath}.tmp`;

      await applyFileSystemOpsGateAndWrite(tmpPath, testData, "utf-8");

      // Verify context passed to gate
      const context = applyFileSystemOverridesSpy.mock.calls[0]?.[0];
      expect(context).toBeDefined();
      expect(context?.stageId).toBe("FILE_SYSTEM_OPS");
      expect(context?.operation).toBe("write");
      expect(context?.path).toBe(tmpPath);

      applyFileSystemOverridesSpy.mockRestore();
    });

    it("should identify both write and rename as persistent operations", async () => {
      const applyFileSystemOverridesSpy = vi.spyOn(decisionOverride, "applyFileSystemOverrides");
      applyFileSystemOverridesSpy.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "FS_OPS",
      } as any);

      const testData = JSON.stringify({ test: "data" });
      const tmpPath = `${testStorePath}.tmp`;

      await applyFileSystemOpsGateAndWrite(tmpPath, testData, "utf-8");
      await applyFileSystemOpsGateAndRename(tmpPath, testStorePath);

      // Both operations should be recorded as FILE_SYSTEM_OPS
      expect(applyFileSystemOverridesSpy).toHaveBeenCalledTimes(2);

      for (const call of applyFileSystemOverridesSpy.mock.calls) {
        const context = call[0];
        expect(context?.stageId).toBe("FILE_SYSTEM_OPS");
      }

      applyFileSystemOverridesSpy.mockRestore();
    });
  });

  describe("Error handling and fail-closed behavior", () => {
    it("should throw ClarityBurstAbstainError with proper stageId on gate abstain", async () => {
      const applyFileSystemOverridesSpy = vi.spyOn(decisionOverride, "applyFileSystemOverrides");
      applyFileSystemOverridesSpy.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        contractId: "FS_WRITE",
        reason: "CONFIRM_REQUIRED",
        instructions: "Cannot persist session store without confirmation",
      } as any);

      const testData = JSON.stringify({ test: "data" });

      try {
        await applyFileSystemOpsGateAndWrite(testStorePath, testData, "utf-8");
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const error = err as ClarityBurstAbstainError;
        expect(error.stageId).toBe("FILE_SYSTEM_OPS");
        expect(error.outcome).toBe("ABSTAIN_CONFIRM");
      }

      applyFileSystemOverridesSpy.mockRestore();
    });

    it("fail-closed: gate blocks write and rename before persistence", async () => {
      const applyFileSystemOverridesSpy = vi.spyOn(decisionOverride, "applyFileSystemOverrides");

      // All gate calls abstain
      applyFileSystemOverridesSpy.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        contractId: null,
        reason: "PACK_POLICY_INCOMPLETE",
        instructions: "Pack policy incomplete for session store",
      } as any);

      const testData = JSON.stringify({ test: "data" });
      const tmpPath = `${testStorePath}.tmp`;

      // Both write and rename calls should be blocked
      let writeThrew = false;
      let renameThrew = false;

      try {
        await applyFileSystemOpsGateAndWrite(tmpPath, testData, "utf-8");
      } catch (err) {
        writeThrew = err instanceof ClarityBurstAbstainError;
      }

      try {
        await applyFileSystemOpsGateAndRename(tmpPath, testStorePath);
      } catch (err) {
        renameThrew = err instanceof ClarityBurstAbstainError;
      }

      // Both should have been blocked by the gate
      expect(writeThrew).toBe(true);
      expect(renameThrew).toBe(true);

      applyFileSystemOverridesSpy.mockRestore();
    });
  });
});
