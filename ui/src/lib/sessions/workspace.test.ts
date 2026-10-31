// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolveSessionWorkspace } from "./workspace.ts";

describe("repository session workspace", () => {
  it.each(["/state", "C:\\state"])(
    "keeps a generated agent ID out of the workspace label under %s",
    (directory) => {
      const agentId = "bot-11111111-2222-4333-8444-555555555555";
      const workspace = `${directory}/workspace-${agentId}`;
      expect(
        resolveSessionWorkspace({
          session: { key: `agent:${agentId}:main`, kind: "direct" },
          agentWorkspace: workspace,
        }),
      ).toEqual({ root: workspace, label: "Workspace" });
    },
  );

  it("never substitutes the Gateway workspace for an unplaced repository", () => {
    expect(
      resolveSessionWorkspace({
        session: {
          key: "agent:main:cloud",
          kind: "direct",
          repositoryWorkspaceId: "repository-1",
          repository: {
            url: "https://github.com/openclaw/openclaw.git",
            branch: "openclaw/cloud-task",
          },
        },
        agentWorkspace: "/gateway/workspace",
        worktreePath: "/gateway/stale-checkout",
      }),
    ).toEqual({ root: null, label: "openclaw" });
  });

  it("uses the actual remote path after placement", () => {
    expect(
      resolveSessionWorkspace({
        session: {
          key: "agent:main:cloud",
          kind: "direct",
          repositoryWorkspaceId: "repository-1",
          execNode: "worker",
          execCwd: "/worker/repo",
        },
        agentWorkspace: "/gateway/workspace",
      }),
    ).toEqual({ root: "/worker/repo", label: null });
  });
});
