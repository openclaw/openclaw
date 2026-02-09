import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";

vi.mock("../../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: vi.fn(() => ({
    prompt: "FRESH_SNAPSHOT",
    skills: [{ name: "new-skill" }],
    version: 1,
  })),
}));

vi.mock("../../agents/skills/refresh.js", () => ({
  getSkillsSnapshotVersion: vi.fn(() => 0),
  ensureSkillsWatcher: vi.fn(),
}));

vi.mock("../../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: vi.fn(() => ({})),
}));

vi.mock("../../config/sessions.js", async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    updateSessionStore: vi.fn(),
  };
});

import { buildWorkspaceSkillSnapshot } from "../../agents/skills.js";
import { getSkillsSnapshotVersion } from "../../agents/skills/refresh.js";
import { ensureSkillSnapshot } from "./session-updates.js";

describe("ensureSkillSnapshot", () => {
  const cfg = {} as OpenClawConfig;
  const workspaceDir = "/workspace";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rebuilds snapshot when in-memory version is zero but session has a persisted snapshot from a prior process lifetime", async () => {
    // Simulate a gateway restart: in-memory version is 0 (process just started),
    // but the session has a snapshot with version > 0 from before the restart.
    vi.mocked(getSkillsSnapshotVersion).mockReturnValue(0);

    const staleSnapshot = {
      prompt: "STALE_OLD_SKILLS",
      skills: [{ name: "old-skill" }],
      version: 1707400800000, // timestamp from a prior process lifetime
    };

    const sessionStore: Record<string, SessionEntry> = {};
    const sessionEntry: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      systemSent: true,
      skillsSnapshot: staleSnapshot,
    };

    const result = await ensureSkillSnapshot({
      sessionEntry,
      sessionStore,
      sessionKey: "test-key",
      isFirstTurnInSession: false,
      workspaceDir,
      cfg,
    });

    // After a restart, the stale snapshot should be replaced with a fresh one
    expect(result.skillsSnapshot?.prompt).toBe("FRESH_SNAPSHOT");
    expect(buildWorkspaceSkillSnapshot).toHaveBeenCalled();
  });

  it("reuses existing snapshot when in-memory version matches persisted version", async () => {
    // Normal operation: in-memory version matches the snapshot version.
    // No rebuild needed.
    vi.mocked(getSkillsSnapshotVersion).mockReturnValue(1707400800000);

    const currentSnapshot = {
      prompt: "CURRENT_SKILLS",
      skills: [{ name: "current-skill" }],
      version: 1707400800000,
    };

    const sessionStore: Record<string, SessionEntry> = {};
    const sessionEntry: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      systemSent: true,
      skillsSnapshot: currentSnapshot,
    };

    const result = await ensureSkillSnapshot({
      sessionEntry,
      sessionStore,
      sessionKey: "test-key",
      isFirstTurnInSession: false,
      workspaceDir,
      cfg,
    });

    // Snapshot should be reused, not rebuilt
    expect(result.skillsSnapshot?.prompt).toBe("CURRENT_SKILLS");
  });

  it("rebuilds when in-memory version is higher than persisted version (watcher fired)", async () => {
    // Normal watcher-triggered refresh: a new skill was added, watcher bumped version.
    vi.mocked(getSkillsSnapshotVersion).mockReturnValue(1707400900000);

    const oldSnapshot = {
      prompt: "OLD_SKILLS",
      skills: [{ name: "old-skill" }],
      version: 1707400800000,
    };

    const sessionStore: Record<string, SessionEntry> = {};
    const sessionEntry: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      systemSent: true,
      skillsSnapshot: oldSnapshot,
    };

    const result = await ensureSkillSnapshot({
      sessionEntry,
      sessionStore,
      sessionKey: "test-key",
      isFirstTurnInSession: false,
      workspaceDir,
      cfg,
    });

    // Snapshot should be rebuilt because watcher bumped the version
    expect(result.skillsSnapshot?.prompt).toBe("FRESH_SNAPSHOT");
    expect(buildWorkspaceSkillSnapshot).toHaveBeenCalled();
  });

  it("does not rebuild when session has no prior snapshot and version is zero", async () => {
    // Brand new session with no snapshot yet, version is 0.
    // The function should still build a snapshot (fallback path for no existing snapshot).
    vi.mocked(getSkillsSnapshotVersion).mockReturnValue(0);

    const sessionStore: Record<string, SessionEntry> = {};
    const sessionEntry: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      systemSent: true,
      // No skillsSnapshot — never built one
    };

    const result = await ensureSkillSnapshot({
      sessionEntry,
      sessionStore,
      sessionKey: "test-key",
      isFirstTurnInSession: false,
      workspaceDir,
      cfg,
    });

    // Should build a snapshot since none exists
    expect(result.skillsSnapshot?.prompt).toBe("FRESH_SNAPSHOT");
    expect(buildWorkspaceSkillSnapshot).toHaveBeenCalled();
  });
});
