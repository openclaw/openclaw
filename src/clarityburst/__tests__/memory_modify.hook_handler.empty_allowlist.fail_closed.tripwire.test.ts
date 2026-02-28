/**
 * Session Memory Hook Handler: Empty Allowlist Fail-Closed Tripwire Test
 *
 * Verifies that the session-memory hook handler (from hooks/bundled/session-memory/handler.ts)
 * aborts when deriveAllowedContracts("MEMORY_MODIFY", ...) yields an empty array,
 * preventing the memory file write (fail-closed).
 *
 * This test invokes the actual hook handler and ensures that when no contracts are
 * allowed by policy, the handler fails safely without modifying the session.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, beforeEach, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../test-helpers/workspace.js";
import { createHookEvent } from "../../hooks/hooks.js";
import { ClarityBurstAbstainError } from "../errors";
import * as allowedContracts from "../allowed-contracts";

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

describe("session-memory hook handler → MEMORY_MODIFY empty_allowlist → fail-closed tripwire", () => {
  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
  });

  it("should throw ClarityBurstAbstainError when deriveAllowedContracts returns empty array", async () => {
    // Arrange: Set up temporary workspace with session file
    const tempDir = await makeTempWorkspace("session-memory-empty-allowlist-");
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
        sessionId: "test-empty-123",
        sessionFile,
      },
    });

    // Mock deriveAllowedContracts to return empty array (no allowed contracts)
    const deriveAllowedContractsSpy = vi
      .spyOn(allowedContracts, "deriveAllowedContracts")
      .mockReturnValue([]);

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
    deriveAllowedContractsSpy.mockRestore();
    writeFileSpy.mockRestore();
  });

  it("should not write to memory file when allowlist is empty", async () => {
    // Arrange: Set up workspace
    const tempDir = await makeTempWorkspace("session-memory-empty-allowlist-no-write-");
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
        sessionId: "test-empty-456",
        sessionFile,
      },
    });

    // Mock deriveAllowedContracts to return empty array
    const deriveAllowedContractsSpy = vi
      .spyOn(allowedContracts, "deriveAllowedContracts")
      .mockReturnValue([]);

    // Track fs operations
    const writeFileSpy = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);

    // Act: Call handler (should throw and abort before write)
    await expect(saveSessionToMemory(event)).rejects.toThrow(ClarityBurstAbstainError);

    // Assert: fs.writeFile was never called (fail-closed prevents write)
    expect(writeFileSpy).not.toHaveBeenCalled();

    // Cleanup
    deriveAllowedContractsSpy.mockRestore();
    writeFileSpy.mockRestore();
  });

  it("should abort with exact ABSTAIN_CLARIFY properties when allowlist is empty", async () => {
    // Arrange
    const tempDir = await makeTempWorkspace("session-memory-empty-allowlist-exact-props-");
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
        sessionId: "test-empty-789",
        sessionFile,
      },
    });

    // Mock deriveAllowedContracts to force empty allowlist
    const deriveAllowedContractsSpy = vi
      .spyOn(allowedContracts, "deriveAllowedContracts")
      .mockReturnValue([]);

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
    deriveAllowedContractsSpy.mockRestore();
    writeFileSpy.mockRestore();
  });
});
