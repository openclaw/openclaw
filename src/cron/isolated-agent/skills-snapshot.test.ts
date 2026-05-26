import { beforeEach, describe, expect, it, vi } from "vitest";
import { SKILL_SNAPSHOT_SCHEMA_VERSION } from "../../agents/skills/types.js";

const {
  buildWorkspaceSkillSnapshotMock,
  canExecRequestNodeMock,
  getRemoteSkillEligibilityMock,
  getSkillsSnapshotVersionMock,
  resolveAgentSkillsFilterMock,
} = vi.hoisted(() => ({
  buildWorkspaceSkillSnapshotMock: vi.fn(),
  canExecRequestNodeMock: vi.fn().mockReturnValue(false),
  getRemoteSkillEligibilityMock: vi.fn(),
  getSkillsSnapshotVersionMock: vi.fn(),
  resolveAgentSkillsFilterMock: vi.fn(),
}));

vi.mock("./skills-snapshot.runtime.js", () => ({
  buildWorkspaceSkillSnapshot: buildWorkspaceSkillSnapshotMock,
  canExecRequestNode: canExecRequestNodeMock,
  getRemoteSkillEligibility: getRemoteSkillEligibilityMock,
  getSkillsSnapshotVersion: getSkillsSnapshotVersionMock,
  resolveAgentSkillsFilter: resolveAgentSkillsFilterMock,
}));

const { resolveCronSkillsSnapshot } = await import("./skills-snapshot.js");

describe("resolveCronSkillsSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSkillsSnapshotVersionMock.mockReturnValue(0);
    resolveAgentSkillsFilterMock.mockReturnValue(undefined);
    getRemoteSkillEligibilityMock.mockReturnValue({
      platforms: [],
      hasBin: () => false,
      hasAnyBin: () => false,
    });
    buildWorkspaceSkillSnapshotMock.mockReturnValue({ prompt: "fresh", skills: [] });
  });

  it("refreshes when the cached skill filter changes", async () => {
    resolveAgentSkillsFilterMock.mockReturnValue(["docs-search", "github"]);

    const result = await resolveCronSkillsSnapshot({
      workspaceDir: "/tmp/workspace",
      config: {} as never,
      agentId: "writer",
      existingSnapshot: {
        prompt: "old",
        skills: [{ name: "github" }],
        skillFilter: ["github"],
        version: 0,
      },
      isFastTestEnv: false,
    });

    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
    const snapshotOptions = buildWorkspaceSkillSnapshotMock.mock.calls[0]?.[1] as
      | { agentId?: string; snapshotVersion?: number }
      | undefined;
    expect(snapshotOptions?.agentId).toBe("writer");
    expect(snapshotOptions?.snapshotVersion).toBe(0);
    expect(result).toEqual({ prompt: "fresh", skills: [] });
  });

  it("refreshes when the process version resets to 0 but the cached snapshot is stale", async () => {
    getSkillsSnapshotVersionMock.mockReturnValue(0);

    await resolveCronSkillsSnapshot({
      workspaceDir: "/tmp/workspace",
      config: {} as never,
      agentId: "writer",
      existingSnapshot: {
        prompt: "old",
        skills: [{ name: "github" }],
        version: 42,
      },
      isFastTestEnv: false,
    });

    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
  });

  it("force-rebuilds legacy persisted snapshots that lack schemaVersion", async () => {
    // ClawSweeper P1 regression at the cron boundary: pre-PR cron sessions
    // persisted only the v1 shape (`prompt` / `skills` / `resolvedSkills`).
    // Without the schema-version refresh guard, `resolveCronSkillsSnapshot`
    // returns the legacy snapshot as-is and the Codex call site reads
    // `undefined` for both lane fields. The schema-outdated check forces a
    // rebuild via `buildWorkspaceSkillSnapshot`.
    await resolveCronSkillsSnapshot({
      workspaceDir: "/tmp/workspace",
      config: {} as never,
      agentId: "writer",
      existingSnapshot: {
        prompt: "legacy v1",
        skills: [{ name: "github" }],
        version: 0,
        // Intentionally no `schemaVersion` — this is what a pre-PR cron
        // session looks like on disk.
      },
      isFastTestEnv: false,
    });

    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
  });

  it("reuses persisted snapshots that already carry the current schemaVersion", async () => {
    await resolveCronSkillsSnapshot({
      workspaceDir: "/tmp/workspace",
      config: {} as never,
      agentId: "writer",
      existingSnapshot: {
        prompt: "current v3",
        schemaVersion: SKILL_SNAPSHOT_SCHEMA_VERSION,
        skills: [{ name: "github" }],
        version: 0,
      },
      isFastTestEnv: false,
    });

    expect(buildWorkspaceSkillSnapshotMock).not.toHaveBeenCalled();
  });
});
