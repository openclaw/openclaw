import "../../test-utils/prepare-compiled-subprocesses.js";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentTurnCommand } from "./register.agent-turn.js";
import { registerAgentsCommands } from "./register.agent.js";

const mocks = vi.hoisted(() => ({
  agentCliCommandMock: vi.fn(),
  agentExecCommandMock: vi.fn(),
  agentsAddCommandMock: vi.fn(),
  agentsTeamCreateCommandMock: vi.fn(),
  agentsBindingsCommandMock: vi.fn(),
  agentsUpdateBindingsCommandMock: vi.fn(),
  agentsDeleteCommandMock: vi.fn(),
  agentsListCommandMock: vi.fn(),
  agentsSetIdentityCommandMock: vi.fn(),
  requestExitAfterOneShotOutputMock: vi.fn(),
  setVerboseMock: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../../commands/agent-via-gateway.js", () => ({
  agentCliCommand: mocks.agentCliCommandMock,
}));

vi.mock("../../commands/agent-exec.js", () => ({
  agentExecCommand: mocks.agentExecCommandMock,
}));

vi.mock("../../commands/agents.commands.add.js", () => ({
  agentsAddCommand: mocks.agentsAddCommandMock,
}));

vi.mock("../../commands/agents.commands.team.js", () => ({
  agentsTeamCreateCommand: mocks.agentsTeamCreateCommandMock,
}));

vi.mock("../../commands/agents.commands.bind.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/agents.commands.bind.js")>()),
  agentsBindingsCommand: mocks.agentsBindingsCommandMock,
  agentsUpdateBindingsCommand: mocks.agentsUpdateBindingsCommandMock,
}));

vi.mock("../../commands/agents.commands.delete.js", () => ({
  agentsDeleteCommand: mocks.agentsDeleteCommandMock,
}));

vi.mock("../../commands/agents.commands.identity.js", () => ({
  agentsSetIdentityCommand: mocks.agentsSetIdentityCommandMock,
}));

vi.mock("../../commands/agents.commands.list.js", () => ({
  agentsListCommand: mocks.agentsListCommandMock,
}));

vi.mock("../../global-state.js", () => ({
  setVerbose: mocks.setVerboseMock,
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));

vi.mock("../one-shot-exit.js", () => ({
  requestExitAfterOneShotOutput: mocks.requestExitAfterOneShotOutputMock,
}));

const { agentCliCommandMock, agentExecCommandMock, requestExitAfterOneShotOutputMock, runtime } =
  mocks;

async function runCli(args: string[]) {
  const program = new Command().enablePositionalOptions();
  registerAgentTurnCommand(program, { agentChannelOptions: "last|telegram|discord" });
  registerAgentsCommands(program);
  await program.parseAsync(args, { from: "user" });
}

beforeEach(() => {
  vi.resetAllMocks();
  agentExecCommandMock.mockResolvedValue({ exitCode: 0 });
});

describe("agent command registration", () => {
  it("normalizes explicit verbosity", async () => {
    await runCli("agent --message hi --verbose ON --json".split(" "));
    expect(mocks.setVerboseMock).toHaveBeenCalledWith(true);
    expect(agentCliCommandMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "hi", verbose: "ON", json: true }),
      runtime,
    );
  });

  it("keeps exec-valued parent messages and failure status on the parent action", async () => {
    const previousExitCode = process.exitCode;
    agentCliCommandMock.mockImplementationOnce(async () => {
      process.exitCode = 1;
    });
    try {
      await runCli("agent --message exec --agent ops".split(" "));
      expect(agentCliCommandMock).toHaveBeenCalledOnce();
      expect(agentExecCommandMock).not.toHaveBeenCalled();
      expect(requestExitAfterOneShotOutputMock).toHaveBeenCalledWith(runtime);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("runs nested exec with ordered fallbacks and stored credentials by default", async () => {
    await runCli(
      "agent exec fix --cwd /tmp/project --model openai/gpt-5.6-luna --fallback anthropic/claude-sonnet-4-6 --fallback google/gemini-3.1-pro-preview --json".split(
        " ",
      ),
    );
    expect(agentCliCommandMock).not.toHaveBeenCalled();
    expect(agentExecCommandMock).toHaveBeenCalledWith(
      "fix",
      expect.objectContaining({
        cwd: "/tmp/project",
        model: "openai/gpt-5.6-luna",
        fallback: ["anthropic/claude-sonnet-4-6", "google/gemini-3.1-pro-preview"],
        authEnvOnly: false,
        isolated: false,
        timeout: "600",
        json: true,
      }),
      runtime,
    );
  });

  it.each([
    {
      args: "agent --model openai/gpt-5.6-luna --timeout 30 exec fix".split(" "),
      timeout: "30",
    },
    { args: "agent --timeout 30 exec fix --timeout 120".split(" "), timeout: "120" },
  ])("resolves parent and leaf exec options for $args", async ({ args, timeout }) => {
    await runCli(args);
    expect(agentExecCommandMock).toHaveBeenCalledWith(
      "fix",
      expect.objectContaining({ timeout }),
      runtime,
    );
    expect(agentCliCommandMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      args: ["alpha"],
      options: { name: "alpha", bind: [] },
      workspace: undefined,
      hasAutomationFlags: false,
    },
    {
      args: "editor --role writer --json".split(" "),
      options: { name: "editor", role: "writer", json: true, nonInteractive: false },
      workspace: undefined,
      hasAutomationFlags: false,
    },
    {
      args: "beta --workspace /tmp/ws --bind telegram --bind discord:acct --non-interactive --json".split(
        " ",
      ),
      options: {
        name: "beta",
        bind: ["telegram", "discord:acct"],
        nonInteractive: true,
        json: true,
      },
      workspace: "/tmp/ws",
      hasAutomationFlags: true,
    },
  ])(
    "selects agent creation posture for $args",
    async ({ args, options, workspace, hasAutomationFlags }) => {
      await runCli(["agents", "add", ...args]);
      expect(mocks.agentsAddCommandMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining(options),
        runtime,
        { hasAutomationFlags },
      );
      expect(mocks.agentsAddCommandMock.mock.calls[0]?.[0].workspace).toBe(workspace);
    },
  );

  it.each([
    ["", mocks.agentsListCommandMock, {}],
    [
      "list --json --bindings --tree",
      mocks.agentsListCommandMock,
      { json: true, bindings: true, tree: true },
    ],
    ["bindings --agent ops --json", mocks.agentsBindingsCommandMock, { agent: "ops", json: true }],
    [
      "bind --agent ops --bind matrix:ops --bind telegram --json",
      mocks.agentsUpdateBindingsCommandMock,
      { agent: "ops", bind: ["matrix:ops", "telegram"], json: true },
      "bind",
    ],
    [
      "unbind --agent ops --all --json",
      mocks.agentsUpdateBindingsCommandMock,
      { agent: "ops", bind: [], all: true, json: true },
      "unbind",
    ],
    [
      "delete worker-a --force --json",
      mocks.agentsDeleteCommandMock,
      { id: "worker-a", force: true, json: true },
    ],
    [
      "team create --preset team --coordinator lead --prefix docs --workspace-root /tmp/team --non-interactive --json",
      mocks.agentsTeamCreateCommandMock,
      {
        preset: "team",
        coordinator: "lead",
        prefix: "docs",
        workspaceRoot: "/tmp/team",
        nonInteractive: true,
        json: true,
      },
    ],
    [
      "set-identity --agent main --workspace /tmp/ws --identity-file /tmp/ws/IDENTITY.md --from-identity --json",
      mocks.agentsSetIdentityCommandMock,
      {
        agent: "main",
        workspace: "/tmp/ws",
        identityFile: "/tmp/ws/IDENTITY.md",
        fromIdentity: true,
        json: true,
      },
    ],
  ] as const)(
    "dispatches agents %s",
    async (args, command, options, operation?: "bind" | "unbind") => {
      await runCli(["agents", ...(args ? args.split(" ") : [])]);
      expect(command).toHaveBeenCalledExactlyOnceWith(
        ...(operation ? [operation] : []),
        options,
        runtime,
      );
    },
  );

  it("renders Gateway request failures without internal class names", async () => {
    const message =
      "The selected model was not found by the provider. Check the model id or choose a different model.";
    agentCliCommandMock.mockRejectedValueOnce(
      Object.assign(new Error(message), {
        name: "GatewayClientRequestError",
        code: "UNAVAILABLE",
        gatewayCode: "UNAVAILABLE",
        details: { reason: "model_not_found" },
      }),
    );
    await runCli("agent --message hello --json".split(" "));
    expect(runtime.error).toHaveBeenCalledWith(message);
    expect(runtime.error).not.toHaveBeenCalledWith(expect.stringContaining("Error:"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
