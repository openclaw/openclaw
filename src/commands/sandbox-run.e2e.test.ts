import { beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxRunCommand } from "./sandbox-run.js";

// --- Mocks ---

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  resolveSandboxContext: vi.fn(),
  createExecTool: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveMainSessionKey: vi.fn(),
  resolveAgentIdFromSessionKey: vi.fn(),
  buildAgentMainSessionKey: vi.fn(),
  normalizeMainKey: vi.fn(),
  normalizeAgentId: vi.fn(),
  resolveAgentConfig: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../agents/sandbox.js", () => ({
  resolveSandboxContext: mocks.resolveSandboxContext,
}));

vi.mock("../agents/bash-tools.exec.js", () => ({
  createExecTool: mocks.createExecTool,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveAgentConfig: mocks.resolveAgentConfig,
}));

vi.mock("../config/sessions.js", () => ({
  resolveMainSessionKey: mocks.resolveMainSessionKey,
}));

vi.mock("../routing/session-key.js", () => ({
  resolveAgentIdFromSessionKey: mocks.resolveAgentIdFromSessionKey,
  buildAgentMainSessionKey: mocks.buildAgentMainSessionKey,
  normalizeMainKey: mocks.normalizeMainKey,
  normalizeAgentId: mocks.normalizeAgentId,
}));

// --- Test Helpers ---

function createMockRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function setupDefaultMocks() {
  const cfg = {
    agents: {
      list: [{ id: "main" }],
    },
    session: { mainKey: "main" },
  };
  mocks.loadConfig.mockReturnValue(cfg);
  mocks.resolveMainSessionKey.mockReturnValue("agent:main:main");
  mocks.resolveAgentIdFromSessionKey.mockReturnValue("main");
  mocks.normalizeAgentId.mockImplementation((id) => id);
  mocks.normalizeMainKey.mockImplementation((key) => key);
  mocks.buildAgentMainSessionKey.mockImplementation(
    ({ agentId, mainKey }) => `agent:${agentId}:${mainKey}`,
  );
  mocks.resolveAgentWorkspaceDir.mockReturnValue("/mock/workspace");

  mocks.resolveSandboxContext.mockResolvedValue({
    enabled: true,
    containerName: "mock-container",
    workspaceDir: "/mock/sandbox/workspace",
    containerWorkdir: "/workspace",
    docker: { env: { PATH: "/bin" } },
  });

  const mockTool = {
    execute: vi.fn().mockResolvedValue({
      isError: false,
      content: [{ type: "text", text: "done" }],
      details: { exitCode: 0 },
    }),
  };
  mocks.createExecTool.mockReturnValue(mockTool);
  mocks.resolveAgentConfig.mockReturnValue({});
}

describe("sandboxRunCommand", () => {
  let runtime: ReturnType<typeof createMockRuntime>;

  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
    runtime = createMockRuntime();
    // Mock process.stdout.write to avoid cluttering test output
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("should run a command successfully", async () => {
    await sandboxRunCommand({ command: "ls" }, runtime as never);

    expect(mocks.resolveSandboxContext).toHaveBeenCalled();
    expect(mocks.createExecTool).toHaveBeenCalled();
    const tool = mocks.createExecTool.mock.results[0].value;
    expect(tool.execute).toHaveBeenCalledWith(
      "cli-sandbox-run",
      { command: "ls", workdir: undefined },
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("should error if sandboxing is not enabled", async () => {
    mocks.resolveSandboxContext.mockResolvedValue(null);

    await sandboxRunCommand({ command: "ls" }, runtime as never);

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Sandboxing is not enabled"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("should propagate exit code on failure", async () => {
    const mockTool = {
      execute: vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "failed" }],
        details: { exitCode: 127 },
      }),
    };
    mocks.createExecTool.mockReturnValue(mockTool);

    await sandboxRunCommand({ command: "no-such-command" }, runtime as never);

    expect(runtime.exit).toHaveBeenCalledWith(127);
  });

  it("should handle tool execution error", async () => {
    const mockTool = {
      execute: vi.fn().mockResolvedValue({
        isError: true,
        error: "Spawn failed",
      }),
    };
    mocks.createExecTool.mockReturnValue(mockTool);

    await sandboxRunCommand({ command: "ls" }, runtime as never);

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Command failed: Spawn failed"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("should respect --agent override", async () => {
    await sandboxRunCommand({ command: "ls", agent: "coder" }, runtime as never);

    expect(mocks.normalizeAgentId).toHaveBeenCalledWith("coder");
    expect(mocks.resolveAgentWorkspaceDir).toHaveBeenCalledWith(expect.any(Object), "coder");
  });

  it("should respect --workdir override", async () => {
    await sandboxRunCommand({ command: "ls", workdir: "/custom/path" }, runtime as never);

    const tool = mocks.createExecTool.mock.results[0].value;
    expect(tool.execute).toHaveBeenCalledWith(
      "cli-sandbox-run",
      { command: "ls", workdir: "/custom/path" },
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });
});
