import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEnterWorktreeTool } from "./enter-worktree-tool.js";
import { createExitWorktreeTool } from "./exit-worktree-tool.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  createSessionWorktreeMock: vi.fn(),
  removeSessionWorktreeMock: vi.fn(),
  resolveRuntimeWorkspaceDirForSessionMock: vi.fn(),
  entry: undefined as Record<string, unknown> | undefined,
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => hoisted.callGatewayMock(opts),
}));

vi.mock("../worktree-runtime.js", () => ({
  createSessionWorktree: (params: unknown) => hoisted.createSessionWorktreeMock(params),
  removeSessionWorktree: (params: unknown) => hoisted.removeSessionWorktreeMock(params),
  resolveRuntimeWorkspaceDirForSession: (params: unknown) =>
    hoisted.resolveRuntimeWorkspaceDirForSessionMock(params),
}));

describe("worktree tools", () => {
  beforeEach(() => {
    hoisted.entry = undefined;
    hoisted.callGatewayMock.mockReset();
    hoisted.createSessionWorktreeMock.mockReset();
    hoisted.removeSessionWorktreeMock.mockReset();
    hoisted.resolveRuntimeWorkspaceDirForSessionMock.mockReset();
    hoisted.resolveRuntimeWorkspaceDirForSessionMock.mockReturnValue("/repo");
  });

  it("creates and persists an active session worktree", async () => {
    hoisted.createSessionWorktreeMock.mockResolvedValue({
      repoRoot: "/repo",
      worktreeDir: "/repo/.openclaw-worktrees/main",
      branch: "feature/demo",
      cleanupPolicy: "keep",
      createdAt: 10,
      updatedAt: 10,
      status: "active",
    });

    const tool = createEnterWorktreeTool({
      agentSessionKey: "agent:main:main",
      workspaceDir: "/repo",
      callGateway:
        hoisted.callGatewayMock as unknown as typeof import("../../gateway/call.js").callGateway,
    });
    const result = await tool.execute("call-1", {
      branch: "feature/demo",
      cleanup: "keep",
    });

    expect(hoisted.createSessionWorktreeMock).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      workspaceDir: "/repo",
      requestedName: undefined,
      branch: "feature/demo",
      baseRef: undefined,
      cleanupPolicy: "keep",
    });
    expect(hoisted.callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.patch",
        params: expect.objectContaining({
          key: "agent:main:main",
          worktreeMode: "active",
          worktreeArtifact: expect.objectContaining({
            worktreeDir: "/repo/.openclaw-worktrees/main",
          }),
        }),
      }),
    );
    expect(result.details).toMatchObject({
      status: "active",
      sessionKey: "agent:main:main",
      worktreeDir: "/repo/.openclaw-worktrees/main",
      effectiveOnNextTurn: true,
    });
  });

  it("rolls back a created worktree when session persistence fails", async () => {
    hoisted.createSessionWorktreeMock.mockResolvedValue({
      repoRoot: "/repo",
      worktreeDir: "/repo/.openclaw-worktrees/main",
      cleanupPolicy: "keep",
      createdAt: 10,
      updatedAt: 10,
      status: "active",
    });
    hoisted.callGatewayMock.mockRejectedValue(new Error("patch failed"));
    hoisted.removeSessionWorktreeMock.mockResolvedValue({
      removed: true,
      dirty: false,
      error: undefined,
    });

    const tool = createEnterWorktreeTool({
      agentSessionKey: "agent:main:main",
      workspaceDir: "/repo",
      callGateway:
        hoisted.callGatewayMock as unknown as typeof import("../../gateway/call.js").callGateway,
    });

    await expect(
      tool.execute("call-rollback", {
        cleanup: "keep",
      }),
    ).rejects.toThrow("patch failed");
    expect(hoisted.removeSessionWorktreeMock).toHaveBeenCalledWith({
      repoRoot: "/repo",
      worktreeDir: "/repo/.openclaw-worktrees/main",
      force: true,
    });
  });

  it("surfaces rollback failures after session persistence errors", async () => {
    hoisted.createSessionWorktreeMock.mockResolvedValue({
      repoRoot: "/repo",
      worktreeDir: "/repo/.openclaw-worktrees/main",
      cleanupPolicy: "keep",
      createdAt: 10,
      updatedAt: 10,
      status: "active",
    });
    hoisted.callGatewayMock.mockRejectedValue(new Error("patch failed"));
    hoisted.removeSessionWorktreeMock.mockResolvedValue({
      removed: false,
      dirty: false,
      error: "remove failed",
    });

    const tool = createEnterWorktreeTool({
      agentSessionKey: "agent:main:main",
      workspaceDir: "/repo",
      callGateway:
        hoisted.callGatewayMock as unknown as typeof import("../../gateway/call.js").callGateway,
    });

    await expect(
      tool.execute("call-rollback-failed", {
        cleanup: "keep",
      }),
    ).rejects.toThrow("patch failed Rollback failed: remove failed");
  });

  it("deactivates the worktree even when removal is skipped for dirty changes", async () => {
    hoisted.callGatewayMock.mockResolvedValue({
      key: "agent:main:main",
      actions: {
        worktree: {
          status: "inactive",
          cleanup: "remove",
          removed: false,
          dirty: true,
          error: "dirty checkout",
          previousWorktreeDir: "/repo/.openclaw-worktrees/main",
          resumedWorkspaceDir: "/repo",
          effectiveOnNextTurn: true,
        },
      },
    });

    const tool = createExitWorktreeTool({
      agentSessionKey: "agent:main:main",
      callGateway:
        hoisted.callGatewayMock as unknown as typeof import("../../gateway/call.js").callGateway,
    });
    const result = await tool.execute("call-1", {
      cleanup: "remove",
    });

    expect(hoisted.callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.control",
        params: expect.objectContaining({
          key: "agent:main:main",
          worktree: expect.objectContaining({
            exit: true,
            cleanup: "remove",
          }),
        }),
      }),
    );
    expect(hoisted.removeSessionWorktreeMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      status: "inactive",
      removed: false,
      dirty: true,
      error: "dirty checkout",
      effectiveOnNextTurn: true,
    });
  });
});
