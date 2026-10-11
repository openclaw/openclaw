import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReplySessionEntryHandle } from "./session-entry-handle.js";

const TEST_WORKSPACE_DIR = path.resolve("/tmp/workspace");

const {
  buildWorkspaceSkillSnapshotMock,
  ensureSkillsWatcherMock,
  getSkillsSnapshotVersionMock,
  shouldRefreshSnapshotForVersionMock,
  getRemoteSkillEligibilityMock,
  updateSessionEntryMock,
  loadSessionEntryMock,
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
  updateSessionEntryMock: vi.fn(),
  loadSessionEntryMock: vi.fn(),
}));

// mock-isolation: Session classification is outside skill snapshot publication.
vi.mock("../../agents/sandbox/runtime-status.js", () => ({
  resolveSandboxRuntimeStatus: () => ({ sandboxed: false, sandboxRequired: false }),
  withSandboxRuntimeStatusInWorker: async (
    _params: unknown,
    source: { assertCurrent: () => void },
    consume: (sandbox: { sandboxed: boolean; sandboxRequired: boolean }) => Promise<unknown>,
  ) => {
    source.assertCurrent();
    const result = await consume({ sandboxed: false, sandboxRequired: false });
    source.assertCurrent();
    return result;
  },
}));

// mock-isolation: Use a fixed policy while testing skill ownership and publication.
vi.mock("../../infra/exec-approvals-store.js", () => ({
  loadExecApprovalsReadOnlyAsync: async () => ({ version: 1, agents: {} }),
}));

vi.mock("../../skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: getRemoteSkillEligibilityMock,
}));

vi.mock("../../skills/loading/workspace-skill-prompt.js", () => ({
  buildSkillSnapshot: buildWorkspaceSkillSnapshotMock,
}));

vi.mock("../../skills/runtime/refresh.js", () => ({
  ensureSkillsWatcher: ensureSkillsWatcherMock,
}));

vi.mock("../../skills/runtime/refresh-state.js", () => ({
  getSkillsSnapshotVersion: getSkillsSnapshotVersionMock,
  getSkillsSourceVersion: getSkillsSnapshotVersionMock,
  shouldRefreshSnapshotForVersion: shouldRefreshSnapshotForVersionMock,
}));

vi.mock("../../config/sessions.js", () => ({
  updateSessionStore: vi.fn(),
  resolveSessionFilePathCore: vi.fn(),
  resolveSessionFilePathOptions: vi.fn(),
}));

// mock-isolation: Skill-refresh cases control persistence acknowledgments without opening SQLite.
vi.mock("../../config/sessions/session-accessor.js", () => ({
  patchSessionEntryCore: async (...args: unknown[]) => {
    const entry = await updateSessionEntryMock(...args);
    loadSessionEntryMock.mockReturnValue(entry ?? undefined);
    return entry;
  },
}));

// mock-isolation: Skill-refresh cases read the fixture's acknowledged row without starting workers.
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryInWorker: loadSessionEntryMock,
}));

const { ensureSkillSnapshot } = await import("./session-updates.js");

describe("ensureSkillSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    buildWorkspaceSkillSnapshotMock.mockReturnValue({ prompt: "", skills: [], resolvedSkills: [] });
    getSkillsSnapshotVersionMock.mockReturnValue(0);
    shouldRefreshSnapshotForVersionMock.mockReturnValue(false);
    getRemoteSkillEligibilityMock.mockReturnValue({
      platforms: [],
      hasBin: () => false,
      hasAnyBin: () => false,
    });
    updateSessionEntryMock.mockReset();
    loadSessionEntryMock.mockReset();
    updateSessionEntryMock.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not keep a deleted first-turn session entry when persisting skills", async () => {
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
      agentId: "main",
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
      expect.any(Object),
    );
    expect(result.sessionEntry).toBeUndefined();
    expect(result.systemSent).toBe(false);
    expect(sessionEntryHandle.getCurrent()).toBeUndefined();
    expect(sessionStore[sessionKey]).toBeUndefined();
  });

  it("adopts a rebound first-turn session entry instead of overwriting it", async () => {
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
      agentId: "main",
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

  it.each([true, false])(
    "persists skill snapshots as a guarded partial update (first turn: %s)",
    async (isFirstTurnInSession) => {
      const sessionKey = "agent:main:main";
      const sessionEntry = {
        sessionId: "session-1",
        updatedAt: 10,
        modelOverride: "gpt-5.5",
        label: "Before rename",
        pinnedAt: 100,
      };
      const sessionStore = { [sessionKey]: sessionEntry };
      updateSessionEntryMock.mockImplementationOnce(async (_scope, update) => {
        const concurrentEntry = {
          sessionId: sessionEntry.sessionId,
          updatedAt: 20,
          modelOverride: "sonnet-4.6",
          label: "After rename",
          sendPolicy: "deny",
        };
        const patch = await update(concurrentEntry);
        expect(patch).toMatchObject({ sessionId: "session-1" });
        if (isFirstTurnInSession) {
          expect(patch).toHaveProperty("systemSent", true);
        } else {
          expect(patch).not.toHaveProperty("systemSent");
        }
        expect(patch).not.toHaveProperty("modelOverride");
        expect(patch).not.toHaveProperty("label");
        expect(patch).not.toHaveProperty("pinnedAt");
        expect(patch).not.toHaveProperty("sendPolicy");
        return { ...concurrentEntry, ...patch };
      });

      const result = await ensureSkillSnapshot({
        agentId: "main",
        sessionEntry,
        sessionStore,
        sessionKey,
        sessionId: "session-1",
        storePath: "/tmp/sessions.json",
        isFirstTurnInSession,
        workspaceDir: TEST_WORKSPACE_DIR,
        cfg: {},
      });

      expect(result.sessionEntry?.modelOverride).toBe("sonnet-4.6");
      expect(sessionStore[sessionKey]?.modelOverride).toBe("sonnet-4.6");
      expect(result.sessionEntry).toMatchObject({ label: "After rename", sendPolicy: "deny" });
      expect(result.sessionEntry?.pinnedAt).toBeUndefined();
      expect(sessionStore[sessionKey]).toEqual(result.sessionEntry);
    },
  );
});
