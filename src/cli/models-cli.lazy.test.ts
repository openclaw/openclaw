import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const defaultRuntime = {};
const runtimeLoaded = vi.fn();
const runModelsCommand = vi.fn(async (action: () => Promise<void>) => await action());
const resolveModelAgentOption = vi.fn<() => string | undefined>();

beforeEach(() => {
  vi.resetModules();
  runtimeLoaded.mockClear();
  runModelsCommand.mockClear();
  resolveModelAgentOption.mockReturnValue("poe");
  vi.doMock("./models-cli.runtime.js", () => {
    runtimeLoaded();
    return {
      defaultRuntime,
      rejectAgentScopedModelCommand: vi.fn(),
      resolveModelAgentOption,
      runModelsCommand,
    };
  });
});

afterEach(() => {
  vi.doUnmock("./models-cli.runtime.js");
  vi.doUnmock("../commands/models/list.status-command.js");
  vi.doUnmock("../commands/models/accounts.js");
  vi.resetModules();
});

async function createProgram() {
  const { registerModelsCli } = await import("./models-cli.js");
  const program = new Command()
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerModelsCli(program);
  return program;
}

it("renders help without importing the models runtime", async () => {
  const program = await createProgram();
  await expect(program.parseAsync(["models", "--help"], { from: "user" })).rejects.toMatchObject({
    exitCode: 0,
  });
  expect(runtimeLoaded).not.toHaveBeenCalled();
});

it("loads the models runtime for command actions", async () => {
  const modelsStatusCommand = vi.fn().mockResolvedValue(undefined);
  vi.doMock("../commands/models/list.status-command.js", () => ({
    modelsStatusCommand,
  }));

  const program = await createProgram();
  await program.parseAsync(["models", "status", "--json"], { from: "user" });

  expect(runtimeLoaded).toHaveBeenCalledTimes(1);
  expect(runModelsCommand).toHaveBeenCalledTimes(1);
  expect(modelsStatusCommand).toHaveBeenCalledWith(
    expect.objectContaining({ agent: "poe", json: true }),
    defaultRuntime,
  );
});

it("dispatches catalog-based personal login without the retired connect spelling", async () => {
  const modelsAccountsLoginCommand = vi.fn().mockResolvedValue(undefined);
  resolveModelAgentOption.mockReturnValue(undefined);
  vi.doMock("../commands/models/accounts.js", () => ({ modelsAccountsLoginCommand }));

  const program = await createProgram();

  await program.parseAsync(
    ["models", "accounts", "login", "--url", "wss://personal.example", "--json"],
    { from: "user" },
  );
  expect(modelsAccountsLoginCommand).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      provider: undefined,
      method: undefined,
      url: "wss://personal.example",
      json: true,
    }),
    defaultRuntime,
  );
  await expect(
    program.parseAsync(["models", "accounts", "connect", "openai"], { from: "user" }),
  ).rejects.toMatchObject({ exitCode: 1 });
});
