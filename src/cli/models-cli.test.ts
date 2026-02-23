import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";

const githubCopilotLoginCommand = vi.fn();
const modelsStatusCommand = vi.fn().mockResolvedValue(undefined);
const noopAsync = vi.fn(async () => undefined);

vi.mock("../commands/models.js", () => ({
  githubCopilotLoginCommand,
  modelsStatusCommand,
  modelsAliasesAddCommand: noopAsync,
  modelsAliasesListCommand: noopAsync,
  modelsAliasesRemoveCommand: noopAsync,
  modelsAuthAddCommand: noopAsync,
  modelsAuthLoginCommand: noopAsync,
  modelsAuthOrderClearCommand: noopAsync,
  modelsAuthOrderGetCommand: noopAsync,
  modelsAuthOrderSetCommand: noopAsync,
  modelsAuthPasteTokenCommand: noopAsync,
  modelsAuthSetupTokenCommand: noopAsync,
  modelsFallbacksAddCommand: noopAsync,
  modelsFallbacksClearCommand: noopAsync,
  modelsFallbacksListCommand: noopAsync,
  modelsFallbacksRemoveCommand: noopAsync,
  modelsImageFallbacksAddCommand: noopAsync,
  modelsImageFallbacksClearCommand: noopAsync,
  modelsImageFallbacksListCommand: noopAsync,
  modelsImageFallbacksRemoveCommand: noopAsync,
  modelsListCommand: noopAsync,
  modelsScanCommand: noopAsync,
  modelsSetCommand: noopAsync,
  modelsSetImageCommand: noopAsync,
}));

describe("models cli", () => {
  let registerModelsCli: (typeof import("./models-cli.js"))["registerModelsCli"];

  beforeAll(async () => {
    // Load once; vi.mock above ensures command handlers are already mocked.
    ({ registerModelsCli } = await import("./models-cli.js"));
  });

  beforeEach(() => {
    githubCopilotLoginCommand.mockClear();
    modelsStatusCommand.mockClear();
  });

  function createProgram() {
    const program = new Command();
    registerModelsCli(program);
    return program;
  }

  async function runModelsCommand(args: string[]) {
    await runRegisteredCli({
      register: registerModelsCli as (program: Command) => void,
      argv: args,
    });
  }

  it("registers github-copilot login command", async () => {
    const program = createProgram();
    const models = program.commands.find((cmd) => cmd.name() === "models");
    expect(models).toBeTruthy();

    const auth = models?.commands.find((cmd) => cmd.name() === "auth");
    expect(auth).toBeTruthy();

    const login = auth?.commands.find((cmd) => cmd.name() === "login-github-copilot");
    expect(login).toBeTruthy();

    await program.parseAsync(["models", "auth", "login-github-copilot", "--yes"], {
      from: "user",
    });

    expect(githubCopilotLoginCommand).toHaveBeenCalledTimes(1);
    expect(githubCopilotLoginCommand).toHaveBeenCalledWith(
      expect.objectContaining({ yes: true }),
      expect.any(Object),
    );
  });

  it.each([
    { label: "status flag", args: ["models", "status", "--agent", "poe"] },
    { label: "parent flag", args: ["models", "--agent", "poe", "status"] },
  ])("passes --agent to models status ($label)", async ({ args }) => {
    await runModelsCommand(args);
    expect(modelsStatusCommand).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "poe" }),
      expect.any(Object),
    );
  });

  it("shows help for models auth without error exit", async () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
    registerModelsCli(program);

    try {
      await program.parseAsync(["models", "auth"], { from: "user" });
      expect.fail("expected help to exit");
    } catch (err) {
      const error = err as { exitCode?: number };
      expect(error.exitCode).toBe(0);
    }
  });
});
