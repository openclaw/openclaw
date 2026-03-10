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

    // Dynamic import to avoid module-level side effects
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
});
