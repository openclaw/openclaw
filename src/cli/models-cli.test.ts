import { beforeEach, describe, expect, it, vi } from "vitest";

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
  beforeEach(() => {
    githubCopilotLoginCommand.mockClear();
    modelsStatusCommand.mockClear();
  });

  it("registers github-copilot login command", { timeout: 60_000 }, async () => {
    const { Command } = await import("commander");
    const { registerModelsCli } = await import("./models-cli.js");

    const program = new Command();
    registerModelsCli(program);

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

  it("passes --agent to models status", async () => {
    const { Command } = await import("commander");
    const { registerModelsCli } = await import("./models-cli.js");

    const program = new Command();
    registerModelsCli(program);

    await program.parseAsync(["models", "status", "--agent", "poe"], { from: "user" });

    expect(modelsStatusCommand).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "poe" }),
      expect.any(Object),
    );
  });

  it("passes parent --agent to models status", async () => {
    const { Command } = await import("commander");
    const { registerModelsCli } = await import("./models-cli.js");

    const program = new Command();
    registerModelsCli(program);

    await program.parseAsync(["models", "--agent", "poe", "status"], { from: "user" });

    expect(modelsStatusCommand).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "poe" }),
      expect.any(Object),
    );
  });

  it("shows help for models auth without error exit", async () => {
    const { Command } = await import("commander");
    const { registerModelsCli } = await import("./models-cli.js");

    const program = new Command();
    program.exitOverride();
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
