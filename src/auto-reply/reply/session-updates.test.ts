import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  buildWorkspaceSkillSnapshotMock,
  ensureSkillsWatcherMock,
  getSkillsSnapshotVersionMock,
  shouldRefreshSnapshotForVersionMock,
  getRemoteSkillEligibilityMock,
  resolveAgentConfigMock,
  resolveAgentSkillsFilterMock,
  resolveAgentWorkspaceDirMock,
  resolveSessionAgentIdMock,
  resolveAgentIdFromSessionKeyMock,
  loadSessionStoreMock,
  resolveSessionStoreEntryMock,
  updateSessionStoreMock,
} = vi.hoisted(() => ({
  buildWorkspaceSkillSnapshotMock: vi.fn(() => ({ prompt: "", skills: [], resolvedSkills: [] })),
  ensureSkillsWatcherMock: vi.fn(),
  getSkillsSnapshotVersionMock: vi.fn(() => 0),
  shouldRefreshSnapshotForVersionMock: vi.fn(() => false),
  getRemoteSkillEligibilityMock: vi.fn(() => ({
    platforms: [],
    hasBin: () => false,
    hasAnyBin: () => false,
  })),
  resolveAgentConfigMock: vi.fn(() => undefined),
  resolveAgentSkillsFilterMock: vi.fn(() => undefined as string[] | undefined),
  resolveAgentWorkspaceDirMock: vi.fn(() => "/tmp/workspace"),
  resolveSessionAgentIdMock: vi.fn(() => "writer"),
  resolveAgentIdFromSessionKeyMock: vi.fn(() => "main"),
  loadSessionStoreMock: vi.fn(),
  resolveSessionStoreEntryMock: vi.fn(),
  updateSessionStoreMock: vi.fn(
    async (_storePath: string, update: (store: Record<string, unknown>) => unknown) =>
      update(loadSessionStoreMock()),
  ),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: resolveAgentConfigMock,
  resolveAgentSkillsFilter: resolveAgentSkillsFilterMock,
  resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
  resolveSessionAgentId: resolveSessionAgentIdMock,
}));

vi.mock("../../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: buildWorkspaceSkillSnapshotMock,
}));

vi.mock("../../agents/skills/refresh.js", () => ({
  ensureSkillsWatcher: ensureSkillsWatcherMock,
}));

vi.mock("../../agents/skills/refresh-state.js", () => ({
  getSkillsSnapshotVersion: getSkillsSnapshotVersionMock,
  shouldRefreshSnapshotForVersion: shouldRefreshSnapshotForVersionMock,
}));

vi.mock("../../config/sessions.js", () => ({
  updateSessionStore: updateSessionStoreMock,
  resolveSessionFilePath: vi.fn(),
  resolveSessionFilePathOptions: vi.fn(),
}));

vi.mock("../../config/sessions/store.js", () => ({
  loadSessionStore: loadSessionStoreMock,
  resolveSessionStoreEntry: resolveSessionStoreEntryMock,
}));

vi.mock("../../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: getRemoteSkillEligibilityMock,
}));

vi.mock("../../routing/session-key.js", () => ({
  normalizeAgentId: (id: string) => id,
  normalizeMainKey: (key?: string) => key ?? "main",
  resolveAgentIdFromSessionKey: resolveAgentIdFromSessionKeyMock,
}));

const { ensureSkillSnapshot, prewarmMirroredSession } = await import("./session-updates.js");

describe("ensureSkillSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildWorkspaceSkillSnapshotMock.mockReturnValue({ prompt: "", skills: [], resolvedSkills: [] });
    getSkillsSnapshotVersionMock.mockReturnValue(0);
    shouldRefreshSnapshotForVersionMock.mockReturnValue(false);
    getRemoteSkillEligibilityMock.mockReturnValue({
      platforms: [],
      hasBin: () => false,
      hasAnyBin: () => false,
    });
    resolveAgentConfigMock.mockReturnValue(undefined);
    resolveAgentSkillsFilterMock.mockReturnValue(undefined);
    resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");
    resolveSessionAgentIdMock.mockReturnValue("writer");
    resolveAgentIdFromSessionKeyMock.mockReturnValue("main");
    updateSessionStoreMock.mockImplementation(async (_storePath, update) =>
      update(loadSessionStoreMock()),
    );
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
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledWith(
      "/tmp/workspace",
      expect.objectContaining({ agentId: "writer" }),
    );
    expect(resolveAgentIdFromSessionKeyMock).not.toHaveBeenCalled();
  });

  it("prewarms mirrored sessions without consuming first-turn system state", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    const entry = { sessionId: "sess-1", updatedAt: 1 };
    const store = {
      "agent:writer:telegram:group:-100123:topic:42": entry,
    };
    loadSessionStoreMock.mockReturnValue(store);
    resolveSessionStoreEntryMock.mockReturnValue({ existing: entry, legacyKeys: [] });
    buildWorkspaceSkillSnapshotMock.mockReturnValue({
      prompt: "skills",
      skills: [],
      resolvedSkills: [],
    });

    await prewarmMirroredSession({
      cfg: {},
      storePath: "/tmp/sessions.json",
      sessionKey: "agent:writer:telegram:group:-100123:topic:42",
    });

    expect(updateSessionStoreMock).toHaveBeenCalled();
    expect(store["agent:writer:telegram:group:-100123:topic:42"]).toMatchObject({
      sessionId: "sess-1",
      skillsSnapshot: expect.objectContaining({ prompt: "skills" }),
    });
    expect(store["agent:writer:telegram:group:-100123:topic:42"]).not.toHaveProperty("systemSent");
  });

  it("prewarms mirrored sessions with the agent skill filter", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    const entry = { sessionId: "sess-1", updatedAt: 1 };
    loadSessionStoreMock.mockReturnValue({
      "agent:writer:telegram:group:-100123:topic:42": entry,
    });
    resolveSessionStoreEntryMock.mockReturnValue({ existing: entry, legacyKeys: [] });
    resolveAgentSkillsFilterMock.mockReturnValue(["telegram-callbacks"]);

    await prewarmMirroredSession({
      cfg: {},
      storePath: "/tmp/sessions.json",
      sessionKey: "agent:writer:telegram:group:-100123:topic:42",
    });

    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledWith(
      "/tmp/workspace",
      expect.objectContaining({
        agentId: "writer",
        skillFilter: ["telegram-callbacks"],
      }),
    );
  });

  it("refreshes stale mirrored session snapshots during prewarm", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    const entry = {
      sessionId: "sess-1",
      updatedAt: 1,
      skillsSnapshot: {
        prompt: "old-skills",
        skills: [],
        resolvedSkills: [],
        version: 1,
      },
    };
    const store = {
      "agent:writer:telegram:group:-100123:topic:42": entry,
    };
    loadSessionStoreMock.mockReturnValue(store);
    resolveSessionStoreEntryMock.mockReturnValue({ existing: entry, legacyKeys: [] });
    getSkillsSnapshotVersionMock.mockReturnValue(2);
    shouldRefreshSnapshotForVersionMock.mockReturnValue(true);
    buildWorkspaceSkillSnapshotMock.mockReturnValue({
      prompt: "fresh-skills",
      skills: [],
      resolvedSkills: [],
      version: 2,
    });

    await prewarmMirroredSession({
      cfg: {},
      storePath: "/tmp/sessions.json",
      sessionKey: "agent:writer:telegram:group:-100123:topic:42",
    });

    expect(shouldRefreshSnapshotForVersionMock).toHaveBeenCalledWith(1, 2);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalled();
    expect(store["agent:writer:telegram:group:-100123:topic:42"]).toMatchObject({
      sessionId: "sess-1",
      skillsSnapshot: expect.objectContaining({
        prompt: "fresh-skills",
        version: 2,
      }),
    });
    expect(store["agent:writer:telegram:group:-100123:topic:42"]).not.toHaveProperty("systemSent");
  });
});
