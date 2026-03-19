import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadGitHubChecksMock } = vi.hoisted(() => ({
  loadGitHubChecksMock: vi.fn(),
}));

vi.mock("../../github/checks.js", () => ({
  loadGitHubChecks: (opts: unknown) => loadGitHubChecksMock(opts),
}));

import { createGitHubChecksTool } from "./github-checks-tool.js";

describe("github checks tool", () => {
  beforeEach(() => {
    loadGitHubChecksMock.mockReset();
    loadGitHubChecksMock.mockResolvedValue({ overallState: "success" });
  });

  it("is owner-only", () => {
    const tool = createGitHubChecksTool();
    expect(tool.ownerOnly).toBe(true);
  });

  it("passes validated params to the github checks loader", async () => {
    const tool = createGitHubChecksTool();
    await tool.execute("call-1", {
      repo: "openclaw/openclaw",
      ref: "main",
      checkName: "CI / test",
      maxCheckRuns: 25,
      maxStatuses: 10,
      timeoutMs: 12000,
      token: "ghp_test",
    });

    expect(loadGitHubChecksMock).toHaveBeenCalledWith({
      repo: "openclaw/openclaw",
      ref: "main",
      checkName: "CI / test",
      token: "ghp_test",
      maxCheckRuns: 25,
      maxStatuses: 10,
      timeoutMs: 12000,
    });
  });

  it("requires repo and ref", async () => {
    const tool = createGitHubChecksTool();
    await expect(tool.execute("call-1", { repo: "openclaw/openclaw" })).rejects.toThrow(
      /ref required/i,
    );
  });
});
