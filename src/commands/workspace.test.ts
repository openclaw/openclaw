import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceResetCommand } from "./workspace.js";

const mocks = vi.hoisted(() => ({
  readBestEffortConfig: vi.fn(async () => ({})),
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace-main"),
  resolveSessionTranscriptsDirForAgent: vi.fn(() => "/tmp/sessions-main"),
  ensureAgentWorkspace: vi.fn(async ({ dir }: { dir: string }) => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "BOOTSTRAP.md"), "# BOOTSTRAP\n", "utf-8");
    return { dir };
  }),
  ensureDevWorkspace: vi.fn(async (dir: string) => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "AGENTS.md"), "# DEV AGENTS\n", "utf-8");
  }),
  resolveDevWorkspaceDir: vi.fn(() => "/tmp/workspace-dev"),
  moveToTrash: vi.fn(async (target: string) => {
    await fs.rm(target, { recursive: true, force: true });
  }),
  confirm: vi.fn(async () => true),
  cancel: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readBestEffortConfig: mocks.readBestEffortConfig,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));

vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionTranscriptsDirForAgent: mocks.resolveSessionTranscriptsDirForAgent,
}));

vi.mock("../agents/workspace.js", () => ({
  ensureAgentWorkspace: mocks.ensureAgentWorkspace,
}));

vi.mock("../cli/gateway-cli/dev.js", () => ({
  ensureDevWorkspace: mocks.ensureDevWorkspace,
  resolveDevWorkspaceDir: mocks.resolveDevWorkspaceDir,
}));

vi.mock("./onboard-helpers.js", () => ({
  moveToTrash: mocks.moveToTrash,
}));

vi.mock("@clack/prompts", () => ({
  confirm: mocks.confirm,
  cancel: mocks.cancel,
  isCancel: (value: unknown) => value === Symbol.for("clack.cancel"),
}));

describe("workspaceResetCommand", () => {
  let tempRoot: string;
  let runtime: {
    log: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    exit: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-reset-"));
    runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
  });

  it("resets only the workspace by default and reseeds it", async () => {
    const workspaceDir = path.join(tempRoot, "workspace-main");
    const sessionsDir = path.join(tempRoot, "sessions-main");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "stale.txt"), "old", "utf-8");

    mocks.resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    mocks.resolveSessionTranscriptsDirForAgent.mockReturnValue(sessionsDir);

    await workspaceResetCommand(runtime as never, {});

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.moveToTrash).toHaveBeenCalledWith(workspaceDir, runtime);
    expect(mocks.moveToTrash).not.toHaveBeenCalledWith(sessionsDir, runtime);
    expect(await fs.readFile(path.join(workspaceDir, "BOOTSTRAP.md"), "utf-8")).toContain(
      "BOOTSTRAP",
    );
    expect(await fs.stat(sessionsDir)).toBeDefined();
  });

  it("also resets sessions when --include-sessions is enabled", async () => {
    const workspaceDir = path.join(tempRoot, "workspace-main");
    const sessionsDir = path.join(tempRoot, "sessions-main");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(sessionsDir, "old.log"), "old", "utf-8");

    mocks.resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    mocks.resolveSessionTranscriptsDirForAgent.mockReturnValue(sessionsDir);

    await workspaceResetCommand(runtime as never, { includeSessions: true });

    expect(mocks.moveToTrash).toHaveBeenCalledWith(workspaceDir, runtime);
    expect(mocks.moveToTrash).toHaveBeenCalledWith(sessionsDir, runtime);
    expect(await fs.readFile(path.join(workspaceDir, "BOOTSTRAP.md"), "utf-8")).toContain(
      "BOOTSTRAP",
    );
    expect(await fs.readdir(sessionsDir)).toEqual([]);
  });

  it("rejects combining --workspace with --include-sessions", async () => {
    const customWorkspace = path.join(tempRoot, "custom-workspace");
    await fs.mkdir(customWorkspace, { recursive: true });

    await expect(
      workspaceResetCommand(runtime as never, {
        workspace: customWorkspace,
        includeSessions: true,
      }),
    ).rejects.toThrow(
      "--include-sessions cannot be combined with --workspace; sessions are resolved from configured agent state only.",
    );

    expect(mocks.moveToTrash).not.toHaveBeenCalled();
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
    expect(mocks.ensureDevWorkspace).not.toHaveBeenCalled();
  });

  it("supports dry-run without modifying workspace or sessions", async () => {
    const workspaceDir = path.join(tempRoot, "workspace-main");
    const sessionsDir = path.join(tempRoot, "sessions-main");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });

    mocks.resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    mocks.resolveSessionTranscriptsDirForAgent.mockReturnValue(sessionsDir);

    await workspaceResetCommand(runtime as never, { includeSessions: true, dryRun: true });

    expect(mocks.moveToTrash).not.toHaveBeenCalled();
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
    expect(await fs.stat(workspaceDir)).toBeDefined();
    expect(await fs.stat(sessionsDir)).toBeDefined();
  });

  it("skips confirmation when --yes is enabled", async () => {
    const workspaceDir = path.join(tempRoot, "workspace-main");
    await fs.mkdir(workspaceDir, { recursive: true });

    mocks.resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);

    await workspaceResetCommand(runtime as never, { yes: true });

    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.moveToTrash).toHaveBeenCalledWith(workspaceDir, runtime);
  });

  it("cancels without touching anything when confirmation is declined", async () => {
    const workspaceDir = path.join(tempRoot, "workspace-main");
    await fs.mkdir(workspaceDir, { recursive: true });
    mocks.resolveAgentWorkspaceDir.mockReturnValue(workspaceDir);
    mocks.confirm.mockResolvedValueOnce(false);

    await workspaceResetCommand(runtime as never, {});

    expect(mocks.moveToTrash).not.toHaveBeenCalled();
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(0);
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("Workspace reseeded"));
  });

  it("reuses the dev reseed helper for the active dev workspace", async () => {
    const devWorkspace = path.join(tempRoot, "workspace-dev");
    await fs.mkdir(devWorkspace, { recursive: true });
    mocks.resolveAgentWorkspaceDir.mockReturnValue(devWorkspace);
    mocks.resolveDevWorkspaceDir.mockReturnValue(devWorkspace);

    await workspaceResetCommand(runtime as never, { yes: true });

    expect(mocks.ensureDevWorkspace).toHaveBeenCalledWith(devWorkspace);
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(devWorkspace, "AGENTS.md"), "utf-8")).toContain(
      "DEV AGENTS",
    );
  });
});
