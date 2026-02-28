/**
 * Session Memory Hook Handler: Router Outage Fail-Closed Tripwire Test
 *
 * Verifies that the session-memory hook handler (from hooks/bundled/session-memory/handler.ts)
 * aborts when MEMORY_MODIFY router gating encounters a router outage, preventing the
 * memory file write (fail-closed).
 *
 * NOTE: Hook contract:
 * - Hooks do NOT throw to the caller on ABSTAIN_*.
 * - They emit a deterministic user-visible blocked message via event.messages.push(...)
 * - They return early (resolving undefined) and MUST NOT write to disk.
 *
 * This test invokes the actual hook handler and simulates a router transport failure.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, beforeEach, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../test-helpers/workspace.js";
import { createHookEvent } from "../../hooks/hooks.js";
import * as routerClient from "../router-client";

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

describe("session-memory hook handler → MEMORY_MODIFY router_outage → fail-closed tripwire", () => {
  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
  });

  it("should emit deterministic block message (and not write) when routeClarityBurst throws (router outage)", async () => {
    // Arrange: Set up temporary workspace with session file
    const tempDir = await makeTempWorkspace("session-memory-router-outage-");
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

    // Mock routeClarityBurst to throw (simulating router unavailable)
    const routerSpy = vi.spyOn(routerClient, "routeClarityBurst").mockRejectedValue(
      new Error("Router unavailable"),
    );

    // Mock fs.writeFile to track if it's called (it should NOT be)
    const writeFileSpy = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);

    // Act: Handler should NOT throw; it should emit a deterministic block message and return
    await expect(saveSessionToMemory(event)).resolves.toBeUndefined();

    // Assert: deterministic user-visible blocked message emitted
    expect(event.messages).toBeDefined();
    expect(event.messages.length).toBe(1);
    expect(event.messages[0]).toContain("[Blocked] MEMORY_MODIFY: router_outage");

    // Assert: fs.writeFile was NOT called (fail-closed)
    expect(writeFileSpy).not.toHaveBeenCalled();

    // Cleanup
    routerSpy.mockRestore();
    writeFileSpy.mockRestore();
  });

  it("should not write to memory file when router is unavailable", async () => {
    // Arrange: Set up workspace
    const tempDir = await makeTempWorkspace("session-memory-no-write-");
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

    // Mock router to fail
    const routerSpy = vi.spyOn(routerClient, "routeClarityBurst").mockRejectedValue(
      new Error("Router connection timeout"),
    );

    // Track fs operations
    const writeFileSpy = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);

    // Act: Call handler (should return early and abort before write)
    await expect(saveSessionToMemory(event)).resolves.toBeUndefined();

    // Assert: deterministic user-visible blocked message emitted
    expect(event.messages).toBeDefined();
    expect(event.messages.length).toBe(1);
    expect(event.messages[0]).toContain("[Blocked] MEMORY_MODIFY: router_outage");

    // Assert: fs.writeFile was never called (fail-closed prevents write)
    expect(writeFileSpy).not.toHaveBeenCalled();

    // Assert: Memory directory exists but no memory files created
    const memoryDir = path.join(tempDir, "memory");
    try {
      const files = await fs.readdir(memoryDir);
      expect(files).toHaveLength(0);
    } catch {
      // Directory might not be created if mkdir wasn't called before abort
      // This is acceptable - the important thing is no files were written
    }

    // Cleanup
    routerSpy.mockRestore();
    writeFileSpy.mockRestore();
  });

  it("should abort with router_outage message when router is unavailable (exact fail-closed signal)", async () => {
    // Arrange
    const tempDir = await makeTempWorkspace("session-memory-exact-props-");
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

    // Mock router to simulate transport failure
    const routerSpy = vi.spyOn(routerClient, "routeClarityBurst").mockRejectedValue(
      new Error("Network error"),
    );

    const writeFileSpy = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);

    // Act
    await expect(saveSessionToMemory(event)).resolves.toBeUndefined();

    // Assert: deterministic fail-closed signal is user-visible via hook messages
    expect(event.messages).toBeDefined();
    expect(event.messages.length).toBe(1);
    expect(event.messages[0]).toContain("[Blocked] MEMORY_MODIFY: router_outage");

    // Assert: Write was blocked
    expect(writeFileSpy).not.toHaveBeenCalled();

    // Cleanup
    routerSpy.mockRestore();
    writeFileSpy.mockRestore();
  });
});
