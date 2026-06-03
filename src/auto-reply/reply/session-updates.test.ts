import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_WORKSPACE_DIR = "/tmp/workspace";

const {
  buildWorkspaceSkillSnapshotMock,
  ensureSkillsWatcherMock,
  getSkillsSnapshotVersionMock,
  shouldRefreshSnapshotForVersionMock,
  getRemoteSkillEligibilityMock,
  resolveAgentConfigMock,
  resolveSessionAgentIdMock,
  resolveAgentIdFromSessionKeyMock,
  updateSessionStoreMock,
} = vi.hoisted(() => ({
  buildWorkspaceSkillSnapshotMock: vi.fn((..._args: unknown[]) => ({
    prompt: "",
    skills: [] as unknown[],
    resolvedSkills: [] as unknown[],
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
  resolveSessionAgentIdMock: vi.fn(() => "writer"),
  resolveAgentIdFromSessionKeyMock: vi.fn(() => "main"),
  updateSessionStoreMock: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: resolveAgentConfigMock,
  resolveSessionAgentId: resolveSessionAgentIdMock,
}));

vi.mock("../../skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: getRemoteSkillEligibilityMock,
}));

vi.mock("../../skills/loading/workspace.js", () => ({
  buildWorkspaceSkillSnapshot: buildWorkspaceSkillSnapshotMock,
}));

vi.mock("../../skills/runtime/refresh.js", () => ({
  ensureSkillsWatcher: ensureSkillsWatcherMock,
}));

vi.mock("../../skills/runtime/refresh-state.js", () => ({
  getSkillsSnapshotVersion: getSkillsSnapshotVersionMock,
  shouldRefreshSnapshotForVersion: shouldRefreshSnapshotForVersionMock,
}));

vi.mock("../../config/sessions.js", () => ({
  updateSessionStore: updateSessionStoreMock,
  resolveSessionFilePath: vi.fn(),
  resolveSessionFilePathOptions: vi.fn(),
}));

vi.mock("../../routing/session-key.js", () => ({
  normalizeAgentId: (id: string) => id,
  normalizeMainKey: (key?: string) => key ?? "main",
  resolveAgentIdFromSessionKey: resolveAgentIdFromSessionKeyMock,
}));

const { ensureSkillSnapshot } = await import("./session-updates.js");

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
    resolveSessionAgentIdMock.mockReturnValue("writer");
    resolveAgentIdFromSessionKeyMock.mockReturnValue("main");
    updateSessionStoreMock.mockImplementation(async (_storePath: string, mutator: unknown) =>
      typeof mutator === "function" ? await mutator({}) : undefined,
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

  it("preserves plugin session extension state when first-turn skill snapshot uses a stale entry", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    const sessionKey = "agent:main:plugin-patch-smoke";
    const permissionScope = {
      scope: ["web_search"],
      reread_policy: "request_only",
      write_policy: "deny",
    };
    const sessionStore = {
      [sessionKey]: {
        sessionId: "session-1",
        updatedAt: 100,
        pluginExtensions: {
          "jh-external-admission-guard": {
            external_admission_permission_scope: permissionScope,
          },
        },
        pluginExtensionSlotKeys: {
          "jh-external-admission-guard": {
            external_admission_permission_scope: "externalAdmissionPermissionScope",
          },
        },
        externalAdmissionPermissionScope: permissionScope,
      },
    };
    updateSessionStoreMock.mockImplementation(async (_storePath: string, mutator: unknown) =>
      typeof mutator === "function" ? await mutator(sessionStore) : undefined,
    );

    await ensureSkillSnapshot({
      sessionEntry: {
        sessionId: "session-1",
        updatedAt: 150,
        systemSent: false,
      },
      sessionStore,
      sessionKey,
      storePath: "/tmp/sessions.json",
      sessionId: "session-1",
      isFirstTurnInSession: true,
      workspaceDir: TEST_WORKSPACE_DIR,
      cfg: {},
    });

    expect(sessionStore[sessionKey]?.pluginExtensions).toEqual({
      "jh-external-admission-guard": {
        external_admission_permission_scope: permissionScope,
      },
    });
    expect(sessionStore[sessionKey]?.pluginExtensionSlotKeys).toEqual({
      "jh-external-admission-guard": {
        external_admission_permission_scope: "externalAdmissionPermissionScope",
      },
    });
    expect(
      (sessionStore[sessionKey] as Record<string, unknown>)?.externalAdmissionPermissionScope,
    ).toEqual(permissionScope);
    expect(sessionStore[sessionKey]?.systemSent).toBe(true);
    expect(sessionStore[sessionKey]?.skillsSnapshot).toBeDefined();
  });
});
