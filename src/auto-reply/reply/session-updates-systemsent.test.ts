import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";

/**
 * Regression test for #41462: ensureSkillSnapshot must NOT persist
 * systemSent=true to the session store on disk.
 *
 * Previously, systemSent was written to disk inside ensureSkillSnapshot
 * (before the LLM call). If the LLM call failed (e.g. insufficient API
 * credits), all subsequent sessions would skip re-sending the system
 * prompt because systemSent=true was already on disk.
 */

// Disable fast-test bypass so we exercise the real code path
delete process.env.OPENCLAW_TEST_FAST;

let tmpDir = "";
beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-systemsent-"));
});
afterAll(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

describe("ensureSkillSnapshot systemSent persistence (#41462)", () => {
  it("should return systemSent=true in-memory but NOT write it to disk on first turn", async () => {
    const storePath = path.join(tmpDir, "sessions-1.json");
    const sessionKey = "wa:test-user";
    const initialEntry: SessionEntry = {
      sessionId: "old-session",
      updatedAt: Date.now() - 60_000,
    };

    // Pre-populate store on disk
    await fs.writeFile(storePath, JSON.stringify({ [sessionKey]: initialEntry }));

    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: { ...initialEntry },
    };

    const { ensureSkillSnapshot } = await import("./session-updates.js");

    const result = await ensureSkillSnapshot({
      sessionEntry: sessionStore[sessionKey],
      sessionStore,
      sessionKey,
      storePath,
      sessionId: "new-session",
      isFirstTurnInSession: true,
      workspaceDir: tmpDir,
      cfg: {} as unknown as import("../../config/config.js").OpenClawConfig,
    });

    // In-memory: systemSent should be true (so caller sends system prompt)
    expect(result.systemSent).toBe(true);

    // On disk: systemSent must NOT be true yet — read the file directly
    const raw = await fs.readFile(storePath, "utf-8");
    const persisted = JSON.parse(raw) as Record<string, SessionEntry>;
    const diskEntry = persisted[sessionKey];
    expect(diskEntry?.systemSent).not.toBe(true);
  });

  it("should allow retry with system prompt after simulated LLM failure", async () => {
    // Scenario: first turn calls ensureSkillSnapshot, then LLM fails.
    // On the next attempt, the session should still have systemSent=false
    // on disk, so the system prompt (with tool definitions) is re-sent.
    const storePath = path.join(tmpDir, "sessions-retry.json");
    const sessionKey = "wa:retry-user";
    const initialEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now() - 60_000,
    };

    await fs.writeFile(storePath, JSON.stringify({ [sessionKey]: initialEntry }));

    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: { ...initialEntry },
    };

    const { ensureSkillSnapshot } = await import("./session-updates.js");

    // --- Turn 1: ensureSkillSnapshot succeeds, but LLM will "fail" ---
    const turn1 = await ensureSkillSnapshot({
      sessionEntry: sessionStore[sessionKey],
      sessionStore,
      sessionKey,
      storePath,
      sessionId: "session-1",
      isFirstTurnInSession: true,
      workspaceDir: tmpDir,
      cfg: {} as unknown as import("../../config/config.js").OpenClawConfig,
    });

    expect(turn1.systemSent).toBe(true);

    // Simulate LLM failure: we do NOT persist systemSent=true
    // (in real code, agent-runner.ts only persists after success)

    // --- Turn 2: new session attempt loads state from disk ---
    const rawAfterFailure = await fs.readFile(storePath, "utf-8");
    const storeAfterFailure = JSON.parse(rawAfterFailure) as Record<string, SessionEntry>;
    const entryAfterFailure = storeAfterFailure[sessionKey];

    // The key assertion: disk state should NOT have systemSent=true,
    // so the next turn will treat this as a first turn and re-send
    // the system prompt with all tool definitions
    expect(entryAfterFailure?.systemSent).not.toBe(true);

    // Simulate loading the session for retry
    const sessionStore2: Record<string, SessionEntry> = {
      [sessionKey]: { ...entryAfterFailure },
    };

    // isFirstTurnInSession should be true because systemSent is not true
    const isFirstTurn = !entryAfterFailure?.systemSent;
    expect(isFirstTurn).toBe(true);

    // --- Turn 2: ensureSkillSnapshot again, should still work ---
    const turn2 = await ensureSkillSnapshot({
      sessionEntry: sessionStore2[sessionKey],
      sessionStore: sessionStore2,
      sessionKey,
      storePath,
      sessionId: "session-1",
      isFirstTurnInSession: isFirstTurn,
      workspaceDir: tmpDir,
      cfg: {} as unknown as import("../../config/config.js").OpenClawConfig,
    });

    // System prompt will be sent again on retry
    expect(turn2.systemSent).toBe(true);
  });
});
