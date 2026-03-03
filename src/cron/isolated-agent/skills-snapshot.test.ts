import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildWorkspaceSkillSnapshot: vi.fn(),
  getRemoteSkillEligibility: vi.fn(),
  getSandboxSkillEligibility: vi.fn(),
}));

vi.mock("../../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: mocks.buildWorkspaceSkillSnapshot,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentSkillsFilter: () => undefined,
}));

vi.mock("../../agents/skills/filter.js", () => ({
  matchesSkillFilter: () => false,
}));

vi.mock("../../agents/skills/refresh.js", () => ({
  getSkillsSnapshotVersion: () => 1,
}));

vi.mock("../../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: mocks.getRemoteSkillEligibility,
}));

vi.mock("../../infra/skills-sandbox.js", () => ({
  getSandboxSkillEligibility: mocks.getSandboxSkillEligibility,
}));

import { resolveCronSkillsSnapshot } from "./skills-snapshot.js";

describe("resolveCronSkillsSnapshot", () => {
  beforeEach(() => {
    mocks.buildWorkspaceSkillSnapshot.mockReset();
    mocks.getRemoteSkillEligibility.mockReset();
    mocks.getSandboxSkillEligibility.mockReset();
  });

  it("passes sandbox eligibility into cron snapshot build", () => {
    const remote = { platforms: ["darwin"] };
    const sandbox = { image: "sandbox:latest" };
    mocks.getRemoteSkillEligibility.mockReturnValue(remote);
    mocks.getSandboxSkillEligibility.mockReturnValue(sandbox);
    mocks.buildWorkspaceSkillSnapshot.mockReturnValue({ prompt: "", skills: [] });

    resolveCronSkillsSnapshot({
      workspaceDir: "/tmp/workspace",
      config: {} as never,
      agentId: "a1",
      isFastTestEnv: false,
    });

    expect(mocks.buildWorkspaceSkillSnapshot).toHaveBeenCalledWith("/tmp/workspace", {
      config: {},
      skillFilter: undefined,
      eligibility: {
        remote,
        sandbox,
      },
      snapshotVersion: 1,
    });
  });
});
