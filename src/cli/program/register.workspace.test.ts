import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorkspaceCommand } from "./register.workspace.js";

const mocks = vi.hoisted(() => ({
  workspaceResetCommand: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../../commands/workspace.js", () => ({
  workspaceResetCommand: mocks.workspaceResetCommand,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerWorkspaceCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes workspace reset options through to the command", async () => {
    const program = new Command();
    registerWorkspaceCommand(program);

    await program.parseAsync(
      [
        "workspace",
        "reset",
        "--workspace",
        "/tmp/ws",
        "--agent",
        "ops",
        "--include-sessions",
        "--yes",
        "--dry-run",
      ],
      { from: "user" },
    );

    expect(mocks.workspaceResetCommand).toHaveBeenCalledWith(
      mocks.runtime,
      expect.objectContaining({
        workspace: "/tmp/ws",
        agent: "ops",
        includeSessions: true,
        yes: true,
        dryRun: true,
      }),
    );
  });
});
