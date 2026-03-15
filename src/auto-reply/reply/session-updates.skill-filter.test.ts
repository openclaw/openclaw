import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";

vi.mock("../../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: vi.fn(),
}));

vi.mock("../../agents/skills/refresh.js", () => ({
  ensureSkillsWatcher: vi.fn(),
  getSkillsSnapshotVersion: vi.fn(() => 0),
}));

vi.mock("../../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: vi.fn(() => undefined),
}));

vi.mock("../../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions.js")>();
  return {
    ...actual,
    updateSessionStore: vi.fn(),
  };
});

import { buildWorkspaceSkillSnapshot } from "../../agents/skills.js";
import { getSkillsSnapshotVersion } from "../../agents/skills/refresh.js";
import { ensureSkillSnapshot } from "./session-updates.js";

describe("ensureSkillSnapshot skill filter refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENCLAW_TEST_FAST;
    vi.mocked(getSkillsSnapshotVersion).mockReturnValue(0);
  });

  it("refreshes a stale cached snapshot when the effective skillFilter changes to empty", async () => {
    const refreshedSnapshot = {
      prompt: "",
      skills: [],
      skillFilter: [],
      version: 0,
    };
    vi.mocked(buildWorkspaceSkillSnapshot).mockReturnValue(refreshedSnapshot);

    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      skillsSnapshot: {
        prompt: "<available_skills><skill>weather</skill></available_skills>",
        skills: [{ name: "weather" }],
        version: 0,
      },
    };
    const sessionStore = { "agent:main:main": { ...sessionEntry } };

    const result = await ensureSkillSnapshot({
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:main",
      isFirstTurnInSession: false,
      workspaceDir: "/tmp/workspace",
      cfg: {},
      skillFilter: [],
    });

    expect(buildWorkspaceSkillSnapshot).toHaveBeenCalledOnce();
    expect(vi.mocked(buildWorkspaceSkillSnapshot).mock.calls[0]?.[1]).toMatchObject({
      skillFilter: [],
    });
    expect(result.skillsSnapshot).toEqual(refreshedSnapshot);
    expect(sessionStore["agent:main:main"]?.skillsSnapshot).toEqual(refreshedSnapshot);
  });

  it("reuses the cached snapshot when the normalized filter is unchanged", async () => {
    const cachedSnapshot = {
      prompt: "<available_skills><skill>weather</skill></available_skills>",
      skills: [{ name: "weather" }],
      skillFilter: ["meme-factory", "weather"],
      version: 0,
    };

    const result = await ensureSkillSnapshot({
      sessionEntry: {
        sessionId: "session-2",
        updatedAt: 1,
        skillsSnapshot: cachedSnapshot,
      },
      sessionStore: {
        "agent:main:main": {
          sessionId: "session-2",
          updatedAt: 1,
          skillsSnapshot: cachedSnapshot,
        },
      },
      sessionKey: "agent:main:main",
      isFirstTurnInSession: false,
      workspaceDir: "/tmp/workspace",
      cfg: {},
      skillFilter: [" weather ", "meme-factory", "weather"],
    });

    expect(buildWorkspaceSkillSnapshot).not.toHaveBeenCalled();
    expect(result.skillsSnapshot).toEqual(cachedSnapshot);
  });
});
