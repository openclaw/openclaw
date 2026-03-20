import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const mocks = vi.hoisted(() => ({
  resolveAgentSkillsFilterMock: vi.fn(),
  buildWorkspaceSkillSnapshotMock: vi.fn(),
  matchesSkillFilterMock: vi.fn(),
  matchesSkillPolicySnapshotMock: vi.fn(),
  resolveSkillPolicySnapshotMock: vi.fn(),
  getSkillsSnapshotVersionMock: vi.fn(),
  getRemoteSkillEligibilityMock: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentSkillsFilter: mocks.resolveAgentSkillsFilterMock,
}));

vi.mock("../../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: mocks.buildWorkspaceSkillSnapshotMock,
}));

vi.mock("../../agents/skills/filter.js", () => ({
  matchesSkillFilter: mocks.matchesSkillFilterMock,
}));

vi.mock("../../agents/skills/policy.js", () => ({
  matchesSkillPolicySnapshot: mocks.matchesSkillPolicySnapshotMock,
  resolveSkillPolicySnapshot: mocks.resolveSkillPolicySnapshotMock,
}));

vi.mock("../../agents/skills/refresh.js", () => ({
  getSkillsSnapshotVersion: mocks.getSkillsSnapshotVersionMock,
}));

vi.mock("../../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: mocks.getRemoteSkillEligibilityMock,
}));

import { resolveCronSkillsSnapshot } from "./skills-snapshot.js";

describe("resolveCronSkillsSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAgentSkillsFilterMock.mockReturnValue(undefined);
    mocks.matchesSkillFilterMock.mockReturnValue(true);
    mocks.matchesSkillPolicySnapshotMock.mockReturnValue(true);
    mocks.resolveSkillPolicySnapshotMock.mockReturnValue(undefined);
    mocks.getRemoteSkillEligibilityMock.mockReturnValue({});
    mocks.buildWorkspaceSkillSnapshotMock.mockReturnValue({
      prompt: "rebuilt",
      skills: [],
      version: 0,
    });
  });

  it("reuses cached snapshot when snapshotVersion is 0 and cached version is undefined", () => {
    mocks.getSkillsSnapshotVersionMock.mockReturnValue(0);
    const existingSnapshot = {
      prompt: "cached",
      skills: [],
      version: undefined,
    };

    const result = resolveCronSkillsSnapshot({
      workspaceDir: "/tmp/workspace",
      config: {} satisfies OpenClawConfig,
      agentId: "ops",
      existingSnapshot,
      isFastTestEnv: false,
    });

    expect(result).toBe(existingSnapshot);
    expect(mocks.buildWorkspaceSkillSnapshotMock).not.toHaveBeenCalled();
  });

  it("rebuilds when snapshotVersion increases beyond cached version", () => {
    mocks.getSkillsSnapshotVersionMock.mockReturnValue(1);
    const existingSnapshot = {
      prompt: "cached",
      skills: [],
      version: undefined,
    };

    const result = resolveCronSkillsSnapshot({
      workspaceDir: "/tmp/workspace",
      config: {} satisfies OpenClawConfig,
      agentId: "ops",
      existingSnapshot,
      isFastTestEnv: false,
    });

    expect(result).toMatchObject({ prompt: "rebuilt" });
    expect(mocks.buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
  });
});
