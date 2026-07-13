import { describe, expect, it } from "vitest";
import { buildDraftSessionCreateParams } from "./create-params.ts";

describe("buildDraftSessionCreateParams", () => {
  it("keeps plain chats minimal", () => {
    expect(
      buildDraftSessionCreateParams({
        agentId: "Main",
        message: "hello",
        worktree: false,
        baseRef: "main",
        worktreeName: "ignored",
        cwd: "/workspace",
        workspace: "/workspace",
      }),
    ).toEqual({ agentId: "main", message: "hello" });
  });

  it("preselects a catalog-provided model", () => {
    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "start coding",
        worktree: false,
        model: "anthropic/claude-opus-4-8",
      }),
    ).toEqual({
      agentId: "main",
      message: "start coding",
      model: "anthropic/claude-opus-4-8",
    });
  });

  it("maps worktree selections onto additive create params", () => {
    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "fix the bug",
        worktree: true,
        baseRef: "origin/main",
        worktreeName: "bug-fix",
        cwd: "/workspace",
        workspace: "/workspace",
      }),
    ).toEqual({
      agentId: "main",
      message: "fix the bug",
      worktree: true,
      worktreeBaseRef: "origin/main",
      worktreeName: "bug-fix",
    });
  });

  it("sends cwd only for non-workspace folders and execNode when picked", () => {
    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "remote work",
        worktree: false,
        cwd: "/other/repo",
        workspace: "/workspace",
        execNode: "macbook",
      }),
    ).toEqual({
      agentId: "main",
      message: "remote work",
      cwd: "/other/repo",
      execNode: "macbook",
    });
  });

  it("sends the selected node cwd even when it matches the Gateway workspace path", () => {
    expect(
      buildDraftSessionCreateParams({
        agentId: "main",
        message: "remote work",
        worktree: false,
        cwd: "/workspace",
        workspace: "/workspace",
        execNode: "macbook",
      }),
    ).toEqual({
      agentId: "main",
      message: "remote work",
      cwd: "/workspace",
      execNode: "macbook",
    });
  });
});
