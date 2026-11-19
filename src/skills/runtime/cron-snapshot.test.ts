// Cron snapshot tests cover runtime skill state attached to scheduled runs.
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  resolveNodeExecEligibilityMock,
  getRemoteSkillEligibilityMock,
  resolveReusableWorkspaceSkillSnapshotMock,
  resolveEffectiveAgentSkillFilterMock,
} = vi.hoisted(() => ({
  resolveNodeExecEligibilityMock: vi.fn().mockReturnValue({ canExec: false }),
  getRemoteSkillEligibilityMock: vi.fn(),
  resolveReusableWorkspaceSkillSnapshotMock: vi.fn(),
  resolveEffectiveAgentSkillFilterMock: vi.fn(),
}));

// mock-isolation: Snapshot refresh tests supply eligibility and snapshots without filesystem or approval-store access.
vi.mock("./cron-snapshot.runtime.js", () => ({
  resolveNodeExecEligibilityAsync: resolveNodeExecEligibilityMock,
  getRemoteSkillEligibility: getRemoteSkillEligibilityMock,
  resolveReusableWorkspaceSkillSnapshot: resolveReusableWorkspaceSkillSnapshotMock,
  resolveEffectiveAgentSkillFilter: resolveEffectiveAgentSkillFilterMock,
}));

const { resolveCronSkillsSnapshot } = await import("./cron-snapshot.js");

describe("resolveCronSkillsSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveEffectiveAgentSkillFilterMock.mockReturnValue(undefined);
    getRemoteSkillEligibilityMock.mockReturnValue({
      platforms: [],
      hasBin: () => false,
      hasAnyBin: () => false,
    });
    resolveReusableWorkspaceSkillSnapshotMock.mockReturnValue({
      snapshot: { prompt: "fresh", skills: [] },
      shouldRefresh: true,
    });
  });

  it("keeps the configured agent root primary and forwards the execution root", async () => {
    await resolveCronSkillsSnapshot({
      workspaceDir: "/agent/workspace",
      executionWorkspaceDir: "/managed/worktrees/audit",
      executionWorkspaceFileHost: "gateway",
      config: {} as never,
      agentId: "writer",
      existingSnapshot: { prompt: "stale execution-only catalog", skills: [] },
      isFastTestEnv: false,
    });

    expect(resolveReusableWorkspaceSkillSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/agent/workspace",
        executionWorkspaceDir: "/managed/worktrees/audit",
        executionWorkspaceFileHost: "gateway",
        agentId: "writer",
        watch: false,
        hydrateExisting: false,
      }),
    );
  });

  it("preserves the fast-test no-scan path with distinct roots", async () => {
    const existingSnapshot = { prompt: "cached", skills: [] };
    expect(
      await resolveCronSkillsSnapshot({
        workspaceDir: "/agent/workspace",
        executionWorkspaceDir: "/managed/worktrees/audit",
        executionWorkspaceFileHost: "gateway",
        config: {} as never,
        agentId: "writer",
        existingSnapshot,
        isFastTestEnv: true,
      }),
    ).toBe(existingSnapshot);
    expect(resolveReusableWorkspaceSkillSnapshotMock).not.toHaveBeenCalled();
  });

  it("refreshes when the cached skill filter changes", async () => {
    resolveEffectiveAgentSkillFilterMock.mockReturnValue(["docs-search", "github"]);

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

    expect(resolveReusableWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
    const snapshotOptions = resolveReusableWorkspaceSkillSnapshotMock.mock.calls[0]?.[0] as
      | { agentId?: string; watch?: boolean; hydrateExisting?: boolean }
      | undefined;
    expect(snapshotOptions?.agentId).toBe("writer");
    expect(snapshotOptions?.watch).toBe(false);
    expect(snapshotOptions?.hydrateExisting).toBe(false);
    expect(result).toEqual({ prompt: "fresh", skills: [] });
  });
});
