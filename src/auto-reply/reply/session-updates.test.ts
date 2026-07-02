// Tests session update fanout and persisted lifecycle records.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReplySessionEntryHandle } from "./session-entry-handle.js";

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
  updateSessionEntryMock,
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
  updateSessionEntryMock: vi.fn(),
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
  updateSessionStore: vi.fn(),
  resolveSessionFilePath: vi.fn(),
  resolveSessionFilePathOptions: vi.fn(),
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  patchSessionEntry: vi.fn(),
  updateSessionEntry: updateSessionEntryMock,
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
    updateSessionEntryMock.mockReset();
    updateSessionEntryMock.mockResolvedValue(null);
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

  it("does not keep a deleted first-turn session entry when persisting skills", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    const sessionKey = "agent:main:main";
    const sessionEntry = {
      sessionId: "deleted-session",
      updatedAt: 10,
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    const sessionEntryHandle = createReplySessionEntryHandle({
      sessionEntry,
      sessionKey,
      sessionStore,
    });

    const result = await ensureSkillSnapshot({
      sessionEntry,
      sessionEntryHandle,
      sessionStore,
      sessionKey,
      sessionId: "deleted-session",
      storePath: "/tmp/sessions.json",
      isFirstTurnInSession: true,
      workspaceDir: TEST_WORKSPACE_DIR,
      cfg: {},
    });

    expect(updateSessionEntryMock).toHaveBeenCalledWith(
      {
        storePath: "/tmp/sessions.json",
        sessionKey,
      },
      expect.any(Function),
    );
    expect(result.sessionEntry).toBeUndefined();
    expect(result.systemSent).toBe(false);
    expect(sessionEntryHandle.getCurrent()).toBeUndefined();
    expect(sessionStore[sessionKey]).toBeUndefined();
  });

  it("adopts a rebound first-turn session entry instead of overwriting it", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    const sessionKey = "agent:main:main";
    const sessionEntry = {
      sessionId: "old-session",
      updatedAt: 10,
    };
    const reboundEntry = {
      sessionId: "new-session",
      updatedAt: 20,
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    updateSessionEntryMock.mockImplementationOnce(async (_scope, update) => {
      const patch = await update(reboundEntry);
      expect(patch).toBeNull();
      return reboundEntry;
    });

    const result = await ensureSkillSnapshot({
      sessionEntry,
      sessionStore,
      sessionKey,
      sessionId: "old-session",
      storePath: "/tmp/sessions.json",
      isFirstTurnInSession: true,
      workspaceDir: TEST_WORKSPACE_DIR,
      cfg: {},
    });

    expect(result.sessionEntry).toEqual(reboundEntry);
    expect(result.systemSent).toBe(false);
    expect(sessionStore[sessionKey]).toEqual(reboundEntry);
  });
});
