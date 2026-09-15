import { describe, expect, it } from "vitest";
import { resolvePersistedWorktreeGitIsolation } from "./session-worktree-isolation.js";

describe("persisted worktree Git isolation", () => {
  it("stays required after current sandbox policy is disabled", () => {
    const config = {
      agents: { defaults: { sandbox: { mode: "off" as const, workspaceAccess: "none" as const } } },
    };
    expect(
      resolvePersistedWorktreeGitIsolation({
        sandboxGit: true,
        config,
        sessionKey: "agent:main:subagent:deferred",
        agentId: "main",
      }),
    ).toEqual({
      config,
      sessionKey: "agent:main:subagent:deferred",
      agentId: "main",
      required: true,
    });
  });

  it("leaves trusted deferred worktrees on host Git", () => {
    expect(
      resolvePersistedWorktreeGitIsolation({
        config: {},
        sessionKey: "agent:main:trusted",
        agentId: "main",
      }),
    ).toBeUndefined();
  });
});
