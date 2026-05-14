import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";

const {
  buildWorkspaceSkillSnapshotMock,
  ensureSkillsWatcherMock,
  getSkillsSnapshotVersionMock,
  shouldRefreshSnapshotForVersionMock,
  getRemoteSkillEligibilityMock,
  resolveAgentConfigMock,
  resolveSessionAgentIdMock,
  resolveAgentIdFromSessionKeyMock,
} = vi.hoisted(() => ({
  buildWorkspaceSkillSnapshotMock: vi.fn((..._args: unknown[]) => ({
    prompt: "",
    skills: [] as unknown[],
    resolvedSkills: [] as unknown[],
  })),
  ensureSkillsWatcherMock: vi.fn(),
  getSkillsSnapshotVersionMock: vi.fn(() => 0),
  shouldRefreshSnapshotForVersionMock: vi.fn(() => false),
  getRemoteSkillEligibilityMock: vi.fn(() => ({
    platforms: [],
    hasBin: () => false,
    hasAnyBin: () => false,
  })),
  resolveAgentConfigMock: vi.fn(() => undefined),
  resolveSessionAgentIdMock: vi.fn(() => "writer"),
  resolveAgentIdFromSessionKeyMock: vi.fn(() => "main"),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: resolveAgentConfigMock,
  resolveSessionAgentId: resolveSessionAgentIdMock,
}));

vi.mock("../../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: buildWorkspaceSkillSnapshotMock,
}));

vi.mock("../../agents/skills/refresh.js", () => ({
  ensureSkillsWatcher: ensureSkillsWatcherMock,
  getSkillsSnapshotVersion: getSkillsSnapshotVersionMock,
  shouldRefreshSnapshotForVersion: shouldRefreshSnapshotForVersionMock,
}));

vi.mock("../../config/sessions.js", () => ({
  updateSessionStore: vi.fn(),
  resolveSessionFilePath: vi.fn(),
  resolveSessionFilePathOptions: vi.fn(),
}));

vi.mock("../../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: getRemoteSkillEligibilityMock,
}));

vi.mock("../../routing/session-key.js", () => ({
  normalizeAgentId: (id: string) => id,
  normalizeMainKey: (key?: string) => key ?? "main",
  resolveAgentIdFromSessionKey: resolveAgentIdFromSessionKeyMock,
}));

const { ensureSkillSnapshot, __testing_resetResolvedSkillsCache } =
  await import("./session-updates.js");

describe("ensureSkillSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testing_resetResolvedSkillsCache();
    buildWorkspaceSkillSnapshotMock.mockReturnValue({ prompt: "", skills: [], resolvedSkills: [] });
    getSkillsSnapshotVersionMock.mockReturnValue(0);
    shouldRefreshSnapshotForVersionMock.mockReturnValue(false);
    getRemoteSkillEligibilityMock.mockReturnValue({
      platforms: [],
      hasBin: () => false,
      hasAnyBin: () => false,
    });
    resolveAgentConfigMock.mockReturnValue(undefined);
    resolveSessionAgentIdMock.mockReturnValue("writer");
    resolveAgentIdFromSessionKeyMock.mockReturnValue("main");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses config-aware session agent resolution for legacy session keys", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");

    await ensureSkillSnapshot({
      sessionKey: "main",
      isFirstTurnInSession: false,
      workspaceDir: "/tmp/workspace",
      cfg: {
        agents: {
          list: [{ id: "writer", default: true }],
        },
      },
    });

    expect(resolveSessionAgentIdMock).toHaveBeenCalledWith({
      sessionKey: "main",
      config: {
        agents: {
          list: [{ id: "writer", default: true }],
        },
      },
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
    const [[workspaceDir, snapshotParams]] = buildWorkspaceSkillSnapshotMock.mock
      .calls as unknown as Array<[string, { agentId?: string }]>;
    expect(workspaceDir).toBe("/tmp/workspace");
    expect(snapshotParams.agentId).toBe("writer");
    expect(resolveAgentIdFromSessionKeyMock).not.toHaveBeenCalled();
  });

  it("reuses cached resolvedSkills across calls with same workspaceDir/version/filter", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");

    const sessionStore: Record<string, SessionEntry> = {};
    const sessionKey = "main";
    const strippedSnapshot = {
      prompt: "skills prompt",
      skills: [{ name: "test" }],
      version: 0,
    };
    const sessionEntry = {
      sessionId: "sess-1",
      updatedAt: Date.now(),
      skillsSnapshot: strippedSnapshot,
    };

    await ensureSkillSnapshot({
      sessionEntry,
      sessionStore,
      sessionKey,
      isFirstTurnInSession: true,
      workspaceDir: "/tmp/workspace",
      cfg: {},
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);

    // Second call with different session entry but same workspaceDir/version/filter
    const sessionEntry2 = {
      sessionId: "sess-2",
      updatedAt: Date.now(),
      skillsSnapshot: { ...strippedSnapshot },
    };
    await ensureSkillSnapshot({
      sessionEntry: sessionEntry2,
      sessionStore: {},
      sessionKey: "other",
      isFirstTurnInSession: false,
      workspaceDir: "/tmp/workspace",
      cfg: {},
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates cache when skillFilter changes", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");

    const sessionStore: Record<string, SessionEntry> = {};
    const sessionKey = "main";
    const strippedSnapshot = {
      prompt: "skills prompt",
      skills: [{ name: "test" }],
      version: 0,
    };
    const sessionEntry = {
      sessionId: "sess-1",
      updatedAt: Date.now(),
      skillsSnapshot: strippedSnapshot,
    };

    await ensureSkillSnapshot({
      sessionEntry,
      sessionStore,
      sessionKey,
      isFirstTurnInSession: true,
      workspaceDir: "/tmp/workspace",
      cfg: {},
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);

    // Different skillFilter — cache key changes, rebuild needed
    const sessionEntry2 = {
      sessionId: "sess-2",
      updatedAt: Date.now(),
      skillsSnapshot: { ...strippedSnapshot, skillFilter: ["old-filter"] },
    };
    await ensureSkillSnapshot({
      sessionEntry: sessionEntry2,
      sessionStore: {},
      sessionKey: "other",
      isFirstTurnInSession: false,
      workspaceDir: "/tmp/workspace",
      skillFilter: ["new-filter"],
      cfg: {},
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates cache when non-skills config gates change", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");

    buildWorkspaceSkillSnapshotMock.mockImplementation((_workspaceDir, opts) => {
      const config = (opts as { config?: { channels?: { discord?: { token?: string } } } }).config;
      return {
        prompt: "",
        skills: [],
        resolvedSkills: config?.channels?.discord?.token ? [{ name: "discord" }] : [],
      };
    });

    const strippedSnapshot = {
      prompt: "skills prompt",
      skills: [{ name: "discord" }],
      version: 0,
    };

    const first = await ensureSkillSnapshot({
      sessionEntry: {
        sessionId: "sess-1",
        updatedAt: Date.now(),
        skillsSnapshot: strippedSnapshot,
      },
      sessionStore: {},
      sessionKey: "main",
      isFirstTurnInSession: true,
      workspaceDir: "/tmp/workspace",
      cfg: { channels: { discord: { token: "enabled" } } },
    });

    expect(first.skillsSnapshot?.resolvedSkills).toEqual([{ name: "discord" }]);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);

    const second = await ensureSkillSnapshot({
      sessionEntry: {
        sessionId: "sess-2",
        updatedAt: Date.now(),
        skillsSnapshot: { ...strippedSnapshot },
      },
      sessionStore: {},
      sessionKey: "other",
      isFirstTurnInSession: false,
      workspaceDir: "/tmp/workspace",
      cfg: { channels: { discord: {} } },
    });

    expect(second.skillsSnapshot?.resolvedSkills).toEqual([]);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it("redacts secret values in the cache key while preserving eligibility presence", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");

    buildWorkspaceSkillSnapshotMock.mockReturnValue({
      prompt: "",
      skills: [],
      resolvedSkills: [{ name: "discord" }],
    });

    const strippedSnapshot = {
      prompt: "skills prompt",
      skills: [{ name: "discord" }],
      version: 0,
    };

    await ensureSkillSnapshot({
      sessionEntry: {
        sessionId: "sess-1",
        updatedAt: Date.now(),
        skillsSnapshot: strippedSnapshot,
      },
      sessionStore: {},
      sessionKey: "main",
      isFirstTurnInSession: true,
      workspaceDir: "/tmp/workspace",
      cfg: { channels: { discord: { token: "first-secret" } } },
    });

    await ensureSkillSnapshot({
      sessionEntry: {
        sessionId: "sess-2",
        updatedAt: Date.now(),
        skillsSnapshot: { ...strippedSnapshot },
      },
      sessionStore: {},
      sessionKey: "other",
      isFirstTurnInSession: false,
      workspaceDir: "/tmp/workspace",
      cfg: { channels: { discord: { token: "rotated-secret" } } },
    });

    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
  });
});
