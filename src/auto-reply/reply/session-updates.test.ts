// Tests session update fanout and persisted lifecycle records.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
});

const { incrementCompactionCount, recordCompactionOutcome } = await import("./session-updates.js");

describe("compaction outcome tracking", () => {
  it("marks a successful compaction and clears a stale failure reason", async () => {
    const sessionStore = {
      "agent:main:test": {
        sessionId: "sess-1",
        updatedAt: 100,
        compactionCount: 2,
        lastCompactionAt: 50,
        lastCompactionOutcome: "failed" as const,
        lastCompactionReason: "summary_failed",
      },
    };

    const nextCount = await incrementCompactionCount({
      sessionStore,
      sessionKey: "agent:main:test",
      now: 1_000,
    });

    expect(nextCount).toBe(3);
    const entry = sessionStore["agent:main:test"];
    expect(entry.compactionCount).toBe(3);
    expect(entry.lastCompactionAt).toBe(1_000);
    expect(entry.lastCompactionOutcome).toBe("compacted");
    expect(entry.lastCompactionReason).toBeUndefined();
  });

  it("does not stamp an outcome when the increment amount is zero", async () => {
    const sessionStore: Record<string, import("../../config/sessions/types.js").SessionEntry> = {
      "agent:main:test": {
        sessionId: "sess-1",
        updatedAt: 100,
        compactionCount: 2,
      },
    };

    await incrementCompactionCount({
      sessionStore,
      sessionKey: "agent:main:test",
      amount: 0,
      now: 1_000,
    });

    const entry = sessionStore["agent:main:test"];
    expect(entry.compactionCount).toBe(2);
    expect(entry.lastCompactionAt).toBeUndefined();
    expect(entry.lastCompactionOutcome).toBeUndefined();
  });

  it("records failed and skipped outcomes without touching updatedAt", async () => {
    const sessionStore: Record<string, import("../../config/sessions/types.js").SessionEntry> = {
      "agent:main:test": {
        sessionId: "sess-1",
        updatedAt: 100,
        compactionCount: 1,
      },
    };

    await recordCompactionOutcome({
      sessionStore,
      sessionKey: "agent:main:test",
      outcome: "failed",
      reason: "summary_failed",
      now: 2_000,
    });

    let entry = sessionStore["agent:main:test"];
    expect(entry.updatedAt).toBe(100);
    expect(entry.compactionCount).toBe(1);
    expect(entry.lastCompactionAt).toBe(2_000);
    expect(entry.lastCompactionOutcome).toBe("failed");
    expect(entry.lastCompactionReason).toBe("summary_failed");

    await recordCompactionOutcome({
      sessionStore,
      sessionKey: "agent:main:test",
      outcome: "skipped",
      reason: "below_threshold",
      now: 3_000,
    });

    entry = sessionStore["agent:main:test"];
    expect(entry.lastCompactionAt).toBe(3_000);
    expect(entry.lastCompactionOutcome).toBe("skipped");
    expect(entry.lastCompactionReason).toBe("below_threshold");
  });

  it("does not resurrect a session row deleted while compaction was in flight", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-updates-outcome-"));
    const storePath = path.join(tmpDir, "sessions.json");
    // Disk store no longer has the session (deleted/reset mid-compaction);
    // the in-memory store still holds the stale entry.
    fs.writeFileSync(storePath, JSON.stringify({}));
    const sessionStore: Record<string, import("../../config/sessions/types.js").SessionEntry> = {
      "agent:main:test": { sessionId: "sess-1", updatedAt: 100 },
    };

    await recordCompactionOutcome({
      sessionStore,
      sessionKey: "agent:main:test",
      storePath,
      outcome: "failed",
      reason: "timeout",
      now: 2_000,
    });

    const persisted = JSON.parse(fs.readFileSync(storePath, "utf8"));
    expect(persisted["agent:main:test"]).toBeUndefined();
    // The stale in-memory copy must not be stamped either — memory mirrors
    // disk only when the persisted patch confirms the row still exists.
    expect(sessionStore["agent:main:test"].lastCompactionOutcome).toBeUndefined();
    expect(sessionStore["agent:main:test"].lastCompactionAt).toBeUndefined();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ignores outcome records for unknown sessions", async () => {
    const sessionStore: Record<string, { sessionId: string; updatedAt: number }> = {};

    await recordCompactionOutcome({
      sessionStore,
      sessionKey: "agent:main:missing",
      outcome: "failed",
      reason: "timeout",
    });

    expect(Object.keys(sessionStore)).toHaveLength(0);
  });
});
