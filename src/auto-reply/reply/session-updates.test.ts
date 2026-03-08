import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";

const currentVersion = 1_707_400_900_000;

vi.mock("../../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: vi.fn(() => ({
    prompt: "FRESH_SNAPSHOT",
    skills: [{ name: "new-skill" }],
    version: 1_707_400_900_000,
  })),
}));

vi.mock("../../agents/skills/refresh.js", () => ({
  ensureSkillsSnapshotVersion: vi.fn(() => 1_707_400_900_000),
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
import { ensureSkillsSnapshotVersion } from "../../agents/skills/refresh.js";
import { ensureSkillSnapshot } from "./session-updates.js";

describe("ensureSkillSnapshot", () => {
  const cfg = {} as OpenClawConfig;
  const workspaceDir = "/workspace";
  const origTestFast = process.env.OPENCLAW_TEST_FAST;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENCLAW_TEST_FAST;
  });

  afterEach(() => {
    if (origTestFast !== undefined) {
      process.env.OPENCLAW_TEST_FAST = origTestFast;
    } else {
      delete process.env.OPENCLAW_TEST_FAST;
    }
  });

  it("rebuilds a stale version-zero snapshot after restart", async () => {
    vi.mocked(ensureSkillsSnapshotVersion).mockReturnValue(currentVersion);

    const result = await ensureSkillSnapshot({
      sessionEntry: {
        sessionId: "test-session",
        updatedAt: Date.now(),
        systemSent: true,
        skillsSnapshot: {
          prompt: "STALE_OLD_SKILLS",
          skills: [{ name: "old-skill" }],
          version: 0,
        },
      },
      sessionStore: {},
      sessionKey: "test-key",
      isFirstTurnInSession: false,
      workspaceDir,
      cfg,
    });

    expect(result.skillsSnapshot?.prompt).toBe("FRESH_SNAPSHOT");
    expect(buildWorkspaceSkillSnapshot).toHaveBeenCalledOnce();
  });

  it("reuses the existing snapshot when versions match", async () => {
    vi.mocked(ensureSkillsSnapshotVersion).mockReturnValue(currentVersion);

    const result = await ensureSkillSnapshot({
      sessionEntry: {
        sessionId: "test-session",
        updatedAt: Date.now(),
        systemSent: true,
        skillsSnapshot: {
          prompt: "CURRENT_SKILLS",
          skills: [{ name: "current-skill" }],
          version: currentVersion,
        },
      },
      sessionStore: {},
      sessionKey: "test-key",
      isFirstTurnInSession: false,
      workspaceDir,
      cfg,
    });

    expect(result.skillsSnapshot?.prompt).toBe("CURRENT_SKILLS");
    expect(buildWorkspaceSkillSnapshot).not.toHaveBeenCalled();
  });

  it("rebuilds when the current version is newer than the persisted one", async () => {
    vi.mocked(ensureSkillsSnapshotVersion).mockReturnValue(currentVersion);

    const result = await ensureSkillSnapshot({
      sessionEntry: {
        sessionId: "test-session",
        updatedAt: Date.now(),
        systemSent: true,
        skillsSnapshot: {
          prompt: "OLD_SKILLS",
          skills: [{ name: "old-skill" }],
          version: currentVersion - 1_000,
        },
      },
      sessionStore: {},
      sessionKey: "test-key",
      isFirstTurnInSession: false,
      workspaceDir,
      cfg,
    });

    expect(result.skillsSnapshot?.prompt).toBe("FRESH_SNAPSHOT");
    expect(buildWorkspaceSkillSnapshot).toHaveBeenCalledOnce();
  });

  it("rebuilds when persisted version exceeds the seeded version (clock skew / restart)", async () => {
    vi.mocked(ensureSkillsSnapshotVersion).mockReturnValue(currentVersion);

    const result = await ensureSkillSnapshot({
      sessionEntry: {
        sessionId: "test-session",
        updatedAt: Date.now(),
        systemSent: true,
        skillsSnapshot: {
          prompt: "FUTURE_SKILLS",
          skills: [{ name: "future-skill" }],
          version: currentVersion + 5_000,
        },
      },
      sessionStore: {},
      sessionKey: "test-key",
      isFirstTurnInSession: false,
      workspaceDir,
      cfg,
    });

    expect(result.skillsSnapshot?.prompt).toBe("FRESH_SNAPSHOT");
    expect(buildWorkspaceSkillSnapshot).toHaveBeenCalledOnce();
  });

  it("checks the stored snapshot version when sessionEntry is missing", async () => {
    vi.mocked(ensureSkillsSnapshotVersion).mockReturnValue(currentVersion);

    const sessionStore: Record<string, SessionEntry> = {
      "test-key": {
        sessionId: "existing-session",
        updatedAt: Date.now(),
        systemSent: true,
        skillsSnapshot: {
          prompt: "STALE_FROM_STORE",
          skills: [{ name: "store-skill" }],
          version: 0,
        },
      },
    };

    const result = await ensureSkillSnapshot({
      sessionStore,
      sessionKey: "test-key",
      isFirstTurnInSession: false,
      workspaceDir,
      cfg,
    });

    expect(result.skillsSnapshot?.prompt).toBe("FRESH_SNAPSHOT");
    expect(buildWorkspaceSkillSnapshot).toHaveBeenCalledOnce();
  });

  it("builds a snapshot when the session has none yet", async () => {
    vi.mocked(ensureSkillsSnapshotVersion).mockReturnValue(currentVersion);

    const result = await ensureSkillSnapshot({
      sessionEntry: {
        sessionId: "test-session",
        updatedAt: Date.now(),
        systemSent: true,
      },
      sessionStore: {},
      sessionKey: "test-key",
      isFirstTurnInSession: false,
      workspaceDir,
      cfg,
    });

    expect(result.skillsSnapshot?.prompt).toBe("FRESH_SNAPSHOT");
    expect(buildWorkspaceSkillSnapshot).toHaveBeenCalledOnce();
  });

  it("builds only once on first turn even when versions mismatch", async () => {
    vi.mocked(ensureSkillsSnapshotVersion).mockReturnValue(currentVersion);

    const result = await ensureSkillSnapshot({
      sessionEntry: {
        sessionId: "test-session",
        updatedAt: Date.now(),
        systemSent: false,
        skillsSnapshot: {
          prompt: "STALE",
          skills: [{ name: "old" }],
          version: 0,
        },
      },
      sessionStore: {},
      sessionKey: "test-key",
      isFirstTurnInSession: true,
      workspaceDir,
      cfg,
    });

    expect(result.skillsSnapshot?.prompt).toBe("FRESH_SNAPSHOT");
    // First-turn block builds once; the second block should reuse it, not rebuild.
    expect(buildWorkspaceSkillSnapshot).toHaveBeenCalledTimes(1);
  });
});
