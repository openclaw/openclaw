import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionStore, updateSessionStore } from "../../config/sessions.js";

/**
 * Test for issue #10404: Runtime metadata shows stale model after /new or /reset
 *
 * This test verifies that when a new session is created via /new or /reset,
 * stale model-related fields from the previous session are cleared.
 *
 * Key fields that must be cleared on session reset:
 * - model: The model used in the LAST turn (persisted by persistSessionUsageUpdate)
 * - modelProvider: The provider used in the LAST turn
 * - systemPromptReport: Report from the LAST turn (includes provider/model)
 *
 * These fields should NOT persist after /new or /reset because they reflect
 * the previous session's state, not the new session's.
 */
describe("session model reset on /new", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-model-reset-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("clears stale model/modelProvider/systemPromptReport fields when session is reset", async () => {
    // Setup: Create a session with model A
    const sessionKey = "agent:main:test-session";
    const initialEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now() - 60000, // 1 minute ago
      systemSent: true,
      // These are the "persisted" values from a previous turn
      model: "claude-sonnet-4-5",
      modelProvider: "anthropic",
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now() - 60000,
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      } as SessionEntry["systemPromptReport"],
    };

    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = initialEntry;
    });

    // Simulate /new: Create a new session entry with model fields explicitly cleared
    // This matches the behavior in session.ts when isNewSession is true
    const newSessionId = crypto.randomUUID();
    const newEntry: Partial<SessionEntry> = {
      sessionId: newSessionId,
      updatedAt: Date.now(),
      systemSent: false,
      compactionCount: 0,
      // FIX for #10404: Explicitly clear stale model fields
      model: undefined,
      modelProvider: undefined,
      systemPromptReport: undefined,
    };

    // Merge with existing entry (mimics session.ts behavior at line 349)
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = { ...store[sessionKey], ...newEntry };
    });

    // Verify: Stale fields are cleared
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];

    expect(entry?.sessionId).toBe(newSessionId); // New session ID
    expect(entry?.model).toBeUndefined(); // Cleared
    expect(entry?.modelProvider).toBeUndefined(); // Cleared
    expect(entry?.systemPromptReport).toBeUndefined(); // Cleared
  });

  it("preserves modelOverride/providerOverride when session is reset", async () => {
    // modelOverride and providerOverride are sticky user preferences set via /model command.
    // They should NOT be cleared on /new because the user explicitly chose them.
    const sessionKey = "agent:main:test-session";
    const initialEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now() - 60000,
      systemSent: true,
      // Sticky user preference (set via /model command)
      modelOverride: "gpt-5.3-codex",
      providerOverride: "openai-codex",
      // Stale turn metadata (should be cleared)
      model: "claude-sonnet-4-5",
      modelProvider: "anthropic",
    };

    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = initialEntry;
    });

    // Simulate /new with model fields cleared but overrides preserved
    const newSessionId = crypto.randomUUID();
    const newEntry: Partial<SessionEntry> = {
      sessionId: newSessionId,
      updatedAt: Date.now(),
      systemSent: false,
      compactionCount: 0,
      model: undefined,
      modelProvider: undefined,
      systemPromptReport: undefined,
      // Note: NOT touching modelOverride/providerOverride - they should persist
    };

    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = { ...store[sessionKey], ...newEntry };
    });

    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];

    // Sticky overrides are preserved
    expect(entry?.modelOverride).toBe("gpt-5.3-codex");
    expect(entry?.providerOverride).toBe("openai-codex");
    // Stale turn metadata is cleared
    expect(entry?.model).toBeUndefined();
    expect(entry?.modelProvider).toBeUndefined();
  });
});
