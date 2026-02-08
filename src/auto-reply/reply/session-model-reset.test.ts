import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionStore, saveSessionStore } from "../../config/sessions.js";
import { initSessionState } from "./session.js";

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

  it("clears stale model/modelProvider/systemPromptReport fields when session is reset via /new", async () => {
    // Setup: Create a session with model metadata from a previous turn
    const sessionKey = "agent:main:test-session";
    const initialEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
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
      // Token metrics
      totalTokens: 5000,
      inputTokens: 3000,
      outputTokens: 2000,
    };

    await saveSessionStore(storePath, { [sessionKey]: initialEntry });

    // Trigger /new via initSessionState
    const cfg = {
      session: { store: storePath, idleMinutes: 999 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "/new",
        RawBody: "/new",
        CommandBody: "/new",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    // Verify the result
    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);

    // Verify stale model fields are cleared
    // Use skipCache to avoid reading stale cached values from prior saveSessionStore calls
    const store = loadSessionStore(storePath, { skipCache: true });
    const entry = store[sessionKey];

    expect(entry?.sessionId).not.toBe("session-1"); // New session ID
    expect(entry?.model).toBeUndefined(); // Cleared - fix for #10404
    expect(entry?.modelProvider).toBeUndefined(); // Cleared - fix for #10404
    expect(entry?.systemPromptReport).toBeUndefined(); // Cleared - fix for #10404

    // Token metrics should also be cleared
    expect(entry?.totalTokens).toBeUndefined();
    expect(entry?.inputTokens).toBeUndefined();
    expect(entry?.outputTokens).toBeUndefined();
  });

  it("clears stale model fields when session is reset via /reset", async () => {
    // Same test with /reset instead of /new
    const sessionKey = "agent:main:test-session";
    const initialEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      systemSent: true,
      model: "gpt-4o",
      modelProvider: "openai",
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now() - 60000,
        provider: "openai",
        model: "gpt-4o",
      } as SessionEntry["systemPromptReport"],
    };

    await saveSessionStore(storePath, { [sessionKey]: initialEntry });

    const cfg = {
      session: { store: storePath, idleMinutes: 999, resetTriggers: ["/reset", "/new"] },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "/reset",
        RawBody: "/reset",
        CommandBody: "/reset",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);

    // Use skipCache to avoid reading stale cached values
    const store = loadSessionStore(storePath, { skipCache: true });
    const entry = store[sessionKey];

    expect(entry?.model).toBeUndefined();
    expect(entry?.modelProvider).toBeUndefined();
    expect(entry?.systemPromptReport).toBeUndefined();
  });
});
