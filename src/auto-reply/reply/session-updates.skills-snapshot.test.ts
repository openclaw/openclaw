import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../agents/skills/refresh.js", () => ({
  ensureSkillsWatcher: vi.fn(),
  getSkillsSnapshotVersion: vi.fn(),
}));

vi.mock("../../config/sessions.js", () => ({
  updateSessionStore: vi.fn(async () => undefined),
}));

vi.mock("../../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: vi.fn(() => ({
    platforms: [],
    hasBin: () => false,
    hasAnyBin: () => false,
  })),
}));

import { getSkillsSnapshotVersion } from "../../agents/skills/refresh.js";
import { ensureSkillSnapshot } from "./session-updates.js";

describe("ensureSkillSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENCLAW_TEST_FAST = "0";
  });

  it("refreshes existing snapshots when cold-start versioning cannot detect new skills", async () => {
    vi.mocked(getSkillsSnapshotVersion).mockReturnValue(0);

    const sessionStore = {
      "session-key": {
        sessionId: "session-1",
        updatedAt: 1,
        skillsSnapshot: {
          prompt: "old skills",
          skills: [{ name: "old-skill" }],
          version: 0,
        },
      },
    };

    const result = await ensureSkillSnapshot({
      sessionEntry: sessionStore["session-key"],
      sessionStore,
      sessionKey: "session-key",
      storePath: "/tmp/sessions.json",
      sessionId: "session-1",
      isFirstTurnInSession: false,
      workspaceDir: "/tmp/workspace",
      cfg: {} as never,
    });

    expect(result.skillsSnapshot?.prompt).not.toBe("old skills");
    expect(result.skillsSnapshot?.skills).not.toEqual([{ name: "old-skill" }]);
    expect(sessionStore["session-key"]?.skillsSnapshot).toEqual(result.skillsSnapshot);
  });
});
