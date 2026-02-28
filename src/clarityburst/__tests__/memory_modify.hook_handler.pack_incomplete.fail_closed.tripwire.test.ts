/**
 * Session Memory Hook Handler: Pack Incomplete Fail-Closed Tripwire Test
 *
 * Verifies that the session-memory hook handler (from hooks/bundled/session-memory/handler.ts)
 * aborts when MEMORY_MODIFY pack loading encounters a policy-incomplete condition,
 * preventing the memory file write (fail-closed).
 *
 * This test invokes the actual hook handler and simulates loadPackOrAbstain throwing
 * ClarityBurstAbstainError due to incomplete pack policy.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, beforeEach, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../test-helpers/workspace.js";
import { createHookEvent } from "../../hooks/hooks.js";
import { ClarityBurstAbstainError } from "../errors";
import * as packLoad from "../pack-load";

// Import the handler directly (not async - it's already compiled)
import saveSessionToMemory from "../../hooks/bundled/session-memory/handler.js";

/**
 * Create mock session content for testing
 */
function createMockSessionContent(
  entries: Array<{ role: string; content: string } | { type: string }>,
): string {
  return entries
    .map((entry) => {
      if ("role" in entry) {
        return JSON.stringify({
          type: "message",
          message: {
            role: entry.role,
            content: entry.content,
          },
        });
      }
      return JSON.stringify(entry);
    })
    .join("\n");
}

describe("session-memory hook handler → MEMORY_MODIFY pack_incomplete → fail-closed tripwire", () => {
  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
  });

  it("should throw ClarityBurstAbstainError when loadPackOrAbstain throws PACK_POLICY_INCOMPLETE", async () => {
    // Arrange: Set up temporary workspace with session file
    const tempDir = await makeTempWorkspace("session-memory-pack-incomplete-");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionContent = createMockSessionContent([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]);

    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: sessionContent,
    });

    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tempDir } },
    };

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg,
      previousSessionEntry: {
        sessionId: "test-123",
        sessionFile,
      },
    });

    // Mock loadPackOrAbstain to throw ClarityBurstAbstainError with PACK_POLICY_INCOMPLETE
    const packLoadSpy = vi.spyOn(packLoad, "loadPackOrAbstain").mockImplementation(() => {
      throw new ClarityBurstAbstainError({
        stageId: "MEMORY_MODIFY",
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
        instructions: "Pack policy is incomplete. Cannot proceed with memory modification.",
      });
    });

    // Mock fs.writeFile to track if it's called (it should NOT be)
    const writeFileSpy = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);

    // Act & Assert: Handler should throw ClarityBurstAbstainError with correct properties
    await expect(saveSessionToMemory(event)).rejects.toThrow(ClarityBurstAbstainError);

    // Verify the error has correct properties
    try {
      await saveSessionToMemory(event);
    } catch (err) {
      expect(err).toBeInstanceOf(ClarityBurstAbstainError);
      const abstainErr = err as ClarityBurstAbstainError;
      expect(abstainErr.stageId).toBe("MEMORY_MODIFY");
      expect(abstainErr.outcome).toBe("ABSTAIN_CLARIFY");
      expect(abstainErr.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(abstainErr.contractId).toBeNull();
    }

    // Assert: fs.writeFile was NOT called (fail-closed)
    expect(writeFileSpy).not.toHaveBeenCalled();

    // Cleanup
    packLoadSpy.mockRestore();
    writeFileSpy.mockRestore();
  });

  it("should not write to memory file when pack policy is incomplete", async () => {
    // Arrange: Set up workspace
    const tempDir = await makeTempWorkspace("session-memory-pack-no-write-");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionContent = createMockSessionContent([
      { role: "user", content: "Test message" },
      { role: "assistant", content: "Test response" },
    ]);

    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: sessionContent,
    });

    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tempDir } },
    };

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg,
      previousSessionEntry: {
        sessionId: "test-456",
        sessionFile,
      },
    });

    // Mock loadPackOrAbstain to fail with incomplete pack policy
    const packLoadSpy = vi.spyOn(packLoad, "loadPackOrAbstain").mockImplementation(() => {
      throw new ClarityBurstAbstainError({
        stageId: "MEMORY_MODIFY",
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
        instructions: "Pack policy configuration is incomplete.",
      });
    });

    // Track fs operations
    const writeFileSpy = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);

    // Act: Call handler (should throw and abort before write)
    await expect(saveSessionToMemory(event)).rejects.toThrow(ClarityBurstAbstainError);

    // Assert: fs.writeFile was never called (fail-closed prevents write)
    expect(writeFileSpy).not.toHaveBeenCalled();

    // Cleanup
    packLoadSpy.mockRestore();
    writeFileSpy.mockRestore();
  });

  it("should abort with exact ABSTAIN_CLARIFY properties on pack incomplete", async () => {
    // Arrange
    const tempDir = await makeTempWorkspace("session-memory-pack-exact-props-");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionContent = createMockSessionContent([{ role: "user", content: "Message" }]);

    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: sessionContent,
    });

    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tempDir } },
    };

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg,
      previousSessionEntry: {
        sessionId: "test-789",
        sessionFile,
      },
    });

    // Mock loadPackOrAbstain to simulate pack policy incomplete
    const packLoadSpy = vi.spyOn(packLoad, "loadPackOrAbstain").mockImplementation(() => {
      throw new ClarityBurstAbstainError({
        stageId: "MEMORY_MODIFY",
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
        instructions: "Missing required pack policy entries.",
      });
    });

    const writeFileSpy = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);

    // Act & Assert
    let caughtError: ClarityBurstAbstainError | null = null;
    try {
      await saveSessionToMemory(event);
    } catch (err) {
      if (err instanceof ClarityBurstAbstainError) {
        caughtError = err;
      } else {
        throw err;
      }
    }

    // Assert: All required properties match expected values
    expect(caughtError).not.toBeNull();
    expect(caughtError!.stageId).toBe("MEMORY_MODIFY");
    expect(caughtError!.outcome).toBe("ABSTAIN_CLARIFY");
    expect(caughtError!.reason).toBe("PACK_POLICY_INCOMPLETE");
    expect(caughtError!.contractId).toBeNull();

    // Assert: Write was blocked
    expect(writeFileSpy).not.toHaveBeenCalled();

    // Cleanup
    packLoadSpy.mockRestore();
    writeFileSpy.mockRestore();
  });
});
