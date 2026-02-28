/**
 * FILE_SYSTEM_OPS saveSessionStore() Pack Incomplete → Fail-Closed at Commit Point Tripwire Test
 *
 * Verifies that the session store commit point (saveSessionStoreUnlocked in
 * openclaw/src/config/sessions/store.ts) fails closed when loadPackOrAbstain("FILE_SYSTEM_OPS")
 * throws ClarityBurstAbstainError due to a malformed/incomplete pack.
 *
 * This test simulates the REAL commit-point scenario:
 * - loadPackOrAbstain("FILE_SYSTEM_OPS") is called before JSON.stringify
 * - If pack is incomplete, loadPackOrAbstain throws ClarityBurstAbstainError
 * - The catch block converts to BlockedResponsePayload
 * - fs.promises.writeFile is NOT called (fail-closed)
 *
 * Injection mechanism:
 * - Mock loadPackOrAbstain to throw ClarityBurstAbstainError with reason="PACK_POLICY_INCOMPLETE"
 * - This simulates the real scenario where pack validation fails during load
 *
 * Test assertions:
 * - Function returns BlockedResponsePayload with:
 *   - outcome === "ABSTAIN_CLARIFY"
 *   - reason === "PACK_POLICY_INCOMPLETE"
 *   - contractId === null
 *   - nonRetryable === true
 * - fs.promises.writeFile was NOT called (fail-closed, no disk write)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import {
  ClarityBurstAbstainError,
} from "../errors";
import {
  convertAbstainToBlockedResponse,
  type BlockedResponsePayload,
} from "../../agents/pi-tool-definition-adapter.js";
import * as packLoadModule from "../pack-load";

/**
 * Creates a mock session store entry
 */
function createMockSessionEntry() {
  return {
    channel: "slack",
    lastChannel: "slack",
    lastTo: "@user",
    lastAccountId: "slack:user123",
    lastThreadId: "ts_2026020500001",
    updatedAt: Date.now(),
    deliveryContext: {
      channel: "slack",
      to: "@user",
      accountId: "slack:user123",
      threadId: "ts_2026020500001",
    },
  };
}

/**
 * Creates a mock session store record
 */
function createMockSessionStore() {
  return {
    "session_123": createMockSessionEntry(),
  };
}

describe("FILE_SYSTEM_OPS saveSessionStore() pack_incomplete → fail-closed at commit point tripwire", () => {
  let loadPackOrAbstainSpy: ReturnType<typeof vi.spyOn>;
  let writeFileSpy: ReturnType<typeof vi.spyOn>;
  const testStorePath = path.join(__dirname, "test_session_store_file_system_ops_incomplete_pack.json5");

  beforeEach(() => {
    // Clear session store cache before each test via dynamic import
    const clearCacheFn = async () => {
      const mod = await import("../../config/sessions/store.js");
      (mod as any).clearSessionStoreCacheForTest?.();
    };
    // Clear synchronously if available
    (clearCacheFn as any)();
  });

  afterEach(() => {
    // Clean up all spies
    vi.restoreAllMocks();
  });

  /**
   * Helper to call saveSessionStoreUnlocked via the store module's internal mechanism
   * Since saveSessionStoreUnlocked is private, we test it by mocking dependencies
   * and testing that the gating logic properly blocks writes
   */
  async function callSaveSessionStoreWithMocks(
    store: Record<string, unknown>,
    shouldThrowIncompletePackError: boolean = true
  ): Promise<void | BlockedResponsePayload> {
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
    vi.spyOn(fsModule.promises, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(fsModule.promises, "writeFile").mockImplementation(writeFileSpy);
    vi.spyOn(fsModule.promises, "rename").mockResolvedValue(undefined);
    vi.spyOn(fsModule.promises, "chmod").mockResolvedValue(undefined);

    // Get the store module and call saveSessionStore which internally calls saveSessionStoreUnlocked
    const storeModule = await import("../../config/sessions/store.js");
    return (storeModule as any).saveSessionStoreUnlocked(testStorePath, store);
  }

  describe("pack incomplete blocking at saveSessionStoreUnlocked commit point", () => {
    it("should return BlockedResponsePayload when FILE_SYSTEM_OPS pack is incomplete", async () => {
      // Arrange
      const mockStore = createMockSessionStore();

      // Act: Call with incomplete pack error injected
      const result = await callSaveSessionStoreWithMocks(mockStore, true);

      // Assert: Function returns BlockedResponsePayload (not void)
      expect(result).toBeDefined();
      expect(result).not.toBeUndefined();

      // Assert: Response has blocked structure
      const blockedResponse = result as BlockedResponsePayload;
      expect(blockedResponse).toMatchObject({
        nonRetryable: true,
        stageId: "FILE_SYSTEM_OPS",
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
      });

      // Assert: fs.promises.writeFile was NOT called (fail-closed)
      expect(writeFileSpy).not.toHaveBeenCalled();
    });

    it("should block with PACK_POLICY_INCOMPLETE reason and nonRetryable=true", async () => {
      // Arrange
      const mockStore = createMockSessionStore();

      // Act
      const result = await callSaveSessionStoreWithMocks(mockStore, true);

      // Assert: Exact blocked response structure with nonRetryable=true
      expect(result).toMatchObject({
        nonRetryable: true,
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
      });
    });

    it("should NOT write to disk when pack is incomplete", async () => {
      // Arrange
      const mockStore = createMockSessionStore();

      // Act
      await callSaveSessionStoreWithMocks(mockStore, true);

      // Assert: writeFile was never called
      expect(writeFileSpy).not.toHaveBeenCalled();
    });

    it("should reach gating logic before any disk write attempts", async () => {
      // Arrange
      let loadPackCalled = false;
      const mockStore = createMockSessionStore();

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
      vi.spyOn(fsModule.promises, "writeFile").mockImplementation(writeFileSpy);
      vi.spyOn(fsModule.promises, "mkdir").mockResolvedValue(undefined);
      vi.spyOn(fsModule.promises, "rename").mockResolvedValue(undefined);
      vi.spyOn(fsModule.promises, "chmod").mockResolvedValue(undefined);

      const storeModule = await import("../../config/sessions/store.js");

      // Act
      await (storeModule as any).saveSessionStoreUnlocked(testStorePath, mockStore);

      // Assert: loadPackOrAbstain was called first (gating is checked early)
      expect(loadPackCalled).toBe(true);

      // Assert: writeFile was never called (blocked before reaching write)
      expect(writeFileSpy).not.toHaveBeenCalled();
    });

    it("should convert ClarityBurstAbstainError to BlockedResponsePayload via convertAbstainToBlockedResponse", async () => {
      // Arrange
      const abstractionError = new ClarityBurstAbstainError({
        stageId: "FILE_SYSTEM_OPS",
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
        instructions: "Pack validation failed for stage \"FILE_SYSTEM_OPS\"",
      });

      loadPackOrAbstainSpy = vi.spyOn(packLoadModule, "loadPackOrAbstain").mockImplementation(() => {
        throw abstractionError;
      });

      const fsModule = await import("node:fs");
      vi.spyOn(fsModule.promises, "writeFile").mockResolvedValue(undefined);
      vi.spyOn(fsModule.promises, "mkdir").mockResolvedValue(undefined);
      vi.spyOn(fsModule.promises, "rename").mockResolvedValue(undefined);
      vi.spyOn(fsModule.promises, "chmod").mockResolvedValue(undefined);

      const mockStore = createMockSessionStore();
      const storeModule = await import("../../config/sessions/store.js");

      // Act
      const result = await (storeModule as any).saveSessionStoreUnlocked(testStorePath, mockStore);

      // Assert: Result matches convertAbstainToBlockedResponse output structure
      const expectedBlocked = convertAbstainToBlockedResponse(abstractionError);
      expect(result).toEqual(expectedBlocked);
    });
  });

  describe("fail-closed guarantees for incomplete pack", () => {
    it("should ensure nonRetryable=true prevents client retry on incomplete pack error", async () => {
      // Arrange
      const mockStore = createMockSessionStore();

      // Act
      const result = await callSaveSessionStoreWithMocks(mockStore, true);

      // Assert: nonRetryable is true - client should NOT retry
      expect((result as BlockedResponsePayload).nonRetryable).toBe(true);
    });

    it("should block even if store data looks valid", async () => {
      // Arrange: Even with valid store data, incomplete pack should block
      const validStore = {
        session_valid_1: {
          channel: "telegram",
          lastChannel: "telegram",
          lastTo: "user123",
          lastAccountId: "tg:user123",
          lastThreadId: "thread_1",
          updatedAt: Date.now(),
        },
        session_valid_2: {
          channel: "discord",
          lastChannel: "discord",
          lastTo: "user456",
          lastAccountId: "discord:user456",
          lastThreadId: "thread_2",
          updatedAt: Date.now(),
        },
      };

      // Act
      const result = await callSaveSessionStoreWithMocks(validStore, true);

      // Assert: Blocked despite valid store content
      expect((result as BlockedResponsePayload).outcome).toBe("ABSTAIN_CLARIFY");
      expect(writeFileSpy).not.toHaveBeenCalled();
    });
  });
});
