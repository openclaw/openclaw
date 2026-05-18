import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";

const TEST_WORKSPACE_DIR = "/tmp/workspace";
type TestSkillSnapshot = NonNullable<SessionEntry["skillsSnapshot"]>;

function strippedSnapshot(skillName = "test"): TestSkillSnapshot {
  return {
    prompt: "skills prompt",
    skills: [{ name: skillName }],
    version: 0,
  };
}

function testSessionEntry(sessionId: string, skillsSnapshot: TestSkillSnapshot): SessionEntry {
  return {
    sessionId,
    updatedAt: Date.now(),
    skillsSnapshot,
  };
}

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
  buildWorkspaceSkillSnapshotMock: vi.fn((..._args: unknown[]) => ({
    prompt: "",
    skills: [] as unknown[],
    resolvedSkills: [] as unknown[],
    version: 0,
  })),
  ensureSkillsWatcherMock: vi.fn(),
  getSkillsSnapshotVersionMock: vi.fn(() => 0),
  shouldRefreshSnapshotForVersionMock: vi.fn((_cached?: number, _next?: number) => false),
  getRemoteSkillEligibilityMock: vi.fn(() => ({
    platforms: [],
    hasBin: () => false,
    hasAnyBin: () => false,
  })),
  resolveAgentConfigMock: vi.fn(() => undefined),
  resolveAgentSkillsFilterMock: vi.fn<() => string[] | undefined>(() => undefined),
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

const { ensureSkillSnapshot, prewarmMirroredSession, resetResolvedSkillsCacheForTests } =
  await import("./session-updates.js");

describe("ensureSkillSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetResolvedSkillsCacheForTests();
    buildWorkspaceSkillSnapshotMock.mockReturnValue({
      prompt: "",
      skills: [],
      resolvedSkills: [],
      version: 0,
    });
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
      workspaceDir: TEST_WORKSPACE_DIR,
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
    expect(workspaceDir).toBe(TEST_WORKSPACE_DIR);
    expect(snapshotParams.agentId).toBe("writer");
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
      version: 0,
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

  it("reuses cached resolvedSkills across calls with same workspaceDir/version/filter", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");

    const sessionStore: Record<string, SessionEntry> = {};
    const sessionKey = "main";
    const snapshot = strippedSnapshot();
    const sessionEntry = testSessionEntry("sess-1", snapshot);

    await ensureSkillSnapshot({
      sessionEntry,
      sessionStore,
      sessionKey,
      isFirstTurnInSession: true,
      workspaceDir: TEST_WORKSPACE_DIR,
      cfg: {},
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);

    const sessionEntry2 = testSessionEntry("sess-2", { ...snapshot });
    await ensureSkillSnapshot({
      sessionEntry: sessionEntry2,
      sessionStore: {},
      sessionKey: "other",
      isFirstTurnInSession: false,
      workspaceDir: TEST_WORKSPACE_DIR,
      cfg: {},
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates cache when skillFilter changes", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");

    const sessionStore: Record<string, SessionEntry> = {};
    const sessionKey = "main";
    const snapshot = strippedSnapshot();
    const sessionEntry = testSessionEntry("sess-1", snapshot);

    await ensureSkillSnapshot({
      sessionEntry,
      sessionStore,
      sessionKey,
      isFirstTurnInSession: true,
      workspaceDir: TEST_WORKSPACE_DIR,
      cfg: {},
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);

    const sessionEntry2 = testSessionEntry("sess-2", {
      ...snapshot,
      skillFilter: ["old-filter"],
    });
    await ensureSkillSnapshot({
      sessionEntry: sessionEntry2,
      sessionStore: {},
      sessionKey: "other",
      isFirstTurnInSession: false,
      workspaceDir: TEST_WORKSPACE_DIR,
      skillFilter: ["new-filter"],
      cfg: {},
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it("reads the skills snapshot version after watcher-side invalidation", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    getSkillsSnapshotVersionMock.mockReturnValue(0);
    ensureSkillsWatcherMock.mockImplementation(() => {
      getSkillsSnapshotVersionMock.mockReturnValue(5);
    });
    shouldRefreshSnapshotForVersionMock.mockImplementation((cached = 0, next = 0) => cached < next);

    await ensureSkillSnapshot({
      sessionEntry: testSessionEntry("sess-1", strippedSnapshot()),
      sessionStore: {},
      sessionKey: "main",
      isFirstTurnInSession: false,
      workspaceDir: TEST_WORKSPACE_DIR,
      cfg: { skills: { load: { extraDirs: ["/tmp/shared-skills"] } } },
    });

    expect(shouldRefreshSnapshotForVersionMock).toHaveBeenCalledWith(0, 5);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
    const [[, snapshotParams]] = buildWorkspaceSkillSnapshotMock.mock.calls as unknown as Array<
      [string, { snapshotVersion?: number }]
    >;
    expect(snapshotParams.snapshotVersion).toBe(5);
  });

  it("invalidates cache when non-skills config gates change", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");

    buildWorkspaceSkillSnapshotMock.mockImplementation((_workspaceDir, opts) => {
      const config = (opts as { config?: { channels?: { discord?: { token?: string } } } }).config;
      return {
        prompt: "",
        skills: [],
        resolvedSkills: config?.channels?.discord?.token ? [{ name: "discord" }] : [],
        version: 0,
      };
    });

    const snapshot = strippedSnapshot("discord");

    const first = await ensureSkillSnapshot({
      sessionEntry: testSessionEntry("sess-1", snapshot),
      sessionStore: {},
      sessionKey: "main",
      isFirstTurnInSession: true,
      workspaceDir: TEST_WORKSPACE_DIR,
      cfg: { channels: { discord: { token: "enabled" } } },
    });

    expect(first.skillsSnapshot?.resolvedSkills).toEqual([{ name: "discord" }]);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);

    const second = await ensureSkillSnapshot({
      sessionEntry: testSessionEntry("sess-2", { ...snapshot }),
      sessionStore: {},
      sessionKey: "other",
      isFirstTurnInSession: false,
      workspaceDir: TEST_WORKSPACE_DIR,
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
      version: 0,
    });

    const snapshot = strippedSnapshot("discord");

    await ensureSkillSnapshot({
      sessionEntry: testSessionEntry("sess-1", snapshot),
      sessionStore: {},
      sessionKey: "main",
      isFirstTurnInSession: true,
      workspaceDir: TEST_WORKSPACE_DIR,
      cfg: { channels: { discord: { token: "first-secret" } } },
    });

    await ensureSkillSnapshot({
      sessionEntry: testSessionEntry("sess-2", { ...snapshot }),
      sessionStore: {},
      sessionKey: "other",
      isFirstTurnInSession: false,
      workspaceDir: TEST_WORKSPACE_DIR,
      cfg: { channels: { discord: { token: "rotated-secret" } } },
    });

    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
  });
});
