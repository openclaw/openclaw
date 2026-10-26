import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReplySessionEntryHandle } from "./session-entry-handle.js";

const TEST_WORKSPACE_DIR = path.resolve("/tmp/workspace");

const { updateSessionEntryMock } = vi.hoisted(() => ({ updateSessionEntryMock: vi.fn() }));

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
  getRemoteSkillEligibility: vi.fn(() => ({
    platforms: [],
    hasBin: () => false,
    hasAnyBin: () => false,
  })),
}));

vi.mock("../../skills/loading/workspace-skill-prompt.js", () => ({
  buildSkillSnapshot: vi.fn(() => ({ prompt: "", skills: [], resolvedSkills: [] })),
}));

vi.mock("../../skills/runtime/refresh.js", () => ({
  ensureSkillsWatcher: vi.fn(),
}));

vi.mock("../../skills/runtime/refresh-state.js", () => ({
  getSkillsSnapshotVersion: vi.fn(() => 0),
  getSkillsSourceVersion: vi.fn(() => 0),
  shouldRefreshSnapshotForVersion: vi.fn(() => false),
}));

vi.mock("../../config/sessions.js", () => ({
  updateSessionStore: vi.fn(),
  resolveSessionFilePathCore: vi.fn(),
  resolveSessionFilePathOptions: vi.fn(),
}));

// mock-isolation: Skill-refresh cases control persistence acknowledgments without opening SQLite.
vi.mock("../../config/sessions/session-accessor.sqlite-entry.js", () => ({
  applySessionEntryOperation: (...args: unknown[]) => updateSessionEntryMock(...args),
}));

const { ensureSkillSnapshot } = await import("./session-updates.js");

function skillTurn(
  sessionEntry: NonNullable<Parameters<typeof ensureSkillSnapshot>[0]["sessionEntry"]>,
) {
  const sessionKey = "agent:main:main";
  const sessionStore = { [sessionKey]: sessionEntry };
  return {
    agentId: "main",
    sessionEntry,
    sessionStore,
    sessionKey,
    sessionId: sessionEntry.sessionId,
    storePath: "/tmp/sessions.json",
    isFirstTurnInSession: true,
    workspaceDir: TEST_WORKSPACE_DIR,
    cfg: {},
  };
}

describe("ensureSkillSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    updateSessionEntryMock.mockReset();
    updateSessionEntryMock.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not keep a deleted first-turn session entry when persisting skills", async () => {
    const turn = skillTurn({ sessionId: "deleted-session", updatedAt: 10 });
    const sessionEntryHandle = createReplySessionEntryHandle(turn);
    const result = await ensureSkillSnapshot({ ...turn, sessionEntryHandle });

    expect(updateSessionEntryMock).toHaveBeenCalledWith(
      {
        storePath: "/tmp/sessions.json",
        sessionKey: turn.sessionKey,
      },
      expect.objectContaining({ kind: "fields" }),
      expect.any(Object),
    );
    expect(result).toMatchObject({ sessionEntry: undefined, systemSent: false });
    expect(sessionEntryHandle.getCurrent()).toBeUndefined();
    expect(turn.sessionStore[turn.sessionKey]).toBeUndefined();
  });

  it.each([true, false])(
    "persists only owned skill fields as a partial update (first turn: %s)",
    async (isFirstTurnInSession) => {
      const turn = skillTurn({
        sessionId: "session-1",
        updatedAt: 10,
        modelOverride: "gpt-5.5",
        label: "Before rename",
        pinnedAt: 100,
      });
      updateSessionEntryMock.mockImplementationOnce(async (_scope, operation) => {
        const concurrentEntry = {
          sessionId: turn.sessionId,
          updatedAt: 20,
          modelOverride: "sonnet-4.6",
          label: "After rename",
          sendPolicy: "deny",
        };
        const patch = operation.patch;
        expect(patch).toStrictEqual({
          ...(isFirstTurnInSession ? { systemSent: true } : {}),
          skillsSnapshot: expect.any(Object),
        });
        return { ...concurrentEntry, ...patch };
      });

      const result = await ensureSkillSnapshot({ ...turn, isFirstTurnInSession });
      expect(result.sessionEntry).toMatchObject({
        modelOverride: "sonnet-4.6",
        label: "After rename",
        sendPolicy: "deny",
      });
      expect(result.sessionEntry?.pinnedAt).toBeUndefined();
      expect(turn.sessionStore[turn.sessionKey]).toEqual(result.sessionEntry);
    },
  );
});
