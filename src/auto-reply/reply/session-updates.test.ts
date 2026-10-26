import { afterEach, expect, it, vi } from "vitest";
import { createReplySessionEntryHandle } from "./session-entry-handle.js";

const { updateSessionEntryMock } = vi.hoisted(() => ({
  updateSessionEntryMock: vi.fn(async (..._args: unknown[]) => null),
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

afterEach(() => vi.unstubAllEnvs());

it("does not keep a deleted first-turn session entry when persisting skills", async () => {
  vi.stubEnv("OPENCLAW_TEST_FAST", "0");
  const sessionKey = "agent:main:main";
  const sessionEntry = { sessionId: "deleted-session", updatedAt: 10 };
  const sessionStore = { [sessionKey]: sessionEntry };
  const sessionEntryHandle = createReplySessionEntryHandle({
    sessionKey,
    sessionEntry,
    sessionStore,
  });
  const result = await ensureSkillSnapshot({
    agentId: "main",
    sessionEntry,
    sessionEntryHandle,
    sessionStore,
    sessionKey,
    sessionId: sessionEntry.sessionId,
    storePath: "/tmp/sessions.json",
    isFirstTurnInSession: true,
    workspaceDir: "/tmp/workspace",
    cfg: {},
  });
  expect(result).toMatchObject({ sessionEntry: undefined, systemSent: false });
  expect(sessionEntryHandle.getCurrent()).toBeUndefined();
  expect(sessionStore[sessionKey]).toBeUndefined();
});
