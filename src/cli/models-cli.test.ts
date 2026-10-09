// Models CLI tests cover model listing command registration and provider output.
import "../commands/models/accounts.js";
import "../commands/models/auth-order.js";
import "../commands/models/fallbacks-shared.js";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime, ExitError } from "../runtime.js";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerModelsCli } from "./models-cli.js";
import { isModelsPlainMachineOutput } from "./models-output-mode.js";
import { isCommandJsonOutputMode } from "./program/json-mode.js";

const mocks = vi.hoisted(() => ({
  modelsListCommand: vi.fn().mockResolvedValue(undefined),
  modelsStatusCommand: vi.fn().mockResolvedValue(undefined),
  modelsSetCommand: vi.fn().mockResolvedValue(undefined),
  modelsSetImageCommand: vi.fn().mockResolvedValue(undefined),
  modelsRefreshCommand: vi.fn().mockResolvedValue(undefined),
  noopAsync: vi.fn(async () => undefined),
  changeFallbacksCommand: vi.fn().mockResolvedValue(undefined),
  clearFallbacksCommand: vi.fn().mockResolvedValue(undefined),
  modelsAliasesAddCommand: vi.fn().mockResolvedValue(undefined),
  modelsAliasesListCommand: vi.fn().mockResolvedValue(undefined),
  modelsAliasesRemoveCommand: vi.fn().mockResolvedValue(undefined),
  modelsScanCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthAddCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthListCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthLoginCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthLogoutCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthActivateCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthOrderGetCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthOrderUpdateCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthPasteApiKeyCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthPasteTokenCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthSetupTokenCommand: vi.fn().mockResolvedValue(undefined),
  modelsAccountsListCommand: vi.fn().mockResolvedValue(undefined),
  modelsAccountsLoginCommand: vi.fn().mockResolvedValue(undefined),
  modelsAccountsUpdateDefaultCommand: vi.fn().mockResolvedValue(undefined),
}));

const {
  changeFallbacksCommand,
  clearFallbacksCommand,
  modelsAliasesAddCommand,
  modelsAliasesRemoveCommand,
  modelsAuthAddCommand,
  modelsAuthListCommand,
  modelsAuthLoginCommand,
  modelsAuthLogoutCommand,
  modelsAuthOrderGetCommand,
  modelsAuthOrderUpdateCommand,
  modelsAuthPasteTokenCommand,
  modelsAuthSetupTokenCommand,
  modelsRefreshCommand,
  modelsScanCommand,
  modelsSetCommand,
  modelsSetImageCommand,
  modelsStatusCommand,
} = mocks;

vi.mock("../commands/models/list.list-command.js", () => ({
  modelsListCommand: mocks.modelsListCommand,
}));
vi.mock("../commands/models/list.status-command.js", () => ({
  modelsStatusCommand: mocks.modelsStatusCommand,
}));
vi.mock("../commands/models/auth.js", () => ({
  modelsAuthAddCommand: mocks.modelsAuthAddCommand,
  modelsAuthLoginCommand: mocks.modelsAuthLoginCommand,
  modelsAuthPasteApiKeyCommand: mocks.modelsAuthPasteApiKeyCommand,
  modelsAuthPasteTokenCommand: mocks.modelsAuthPasteTokenCommand,
  modelsAuthSetupTokenCommand: mocks.modelsAuthSetupTokenCommand,
}));
vi.mock("../commands/models/auth-list.js", () => ({
  modelsAuthListCommand: mocks.modelsAuthListCommand,
}));
vi.mock("../commands/models/accounts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/models/accounts.js")>()),
  modelsAccountsListCommand: mocks.modelsAccountsListCommand,
  modelsAccountsLoginCommand: mocks.modelsAccountsLoginCommand,
  modelsAccountsUpdateDefaultCommand: mocks.modelsAccountsUpdateDefaultCommand,
}));
vi.mock("../commands/models/auth-activate.js", () => ({
  modelsAuthActivateCommand: mocks.modelsAuthActivateCommand,
}));
vi.mock("../commands/models/auth-logout.js", () => ({
  modelsAuthLogoutCommand: mocks.modelsAuthLogoutCommand,
}));
vi.mock("../commands/models/auth-order.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/models/auth-order.js")>()),
  modelsAuthOrderGetCommand: mocks.modelsAuthOrderGetCommand,
  modelsAuthOrderUpdateCommand: mocks.modelsAuthOrderUpdateCommand,
}));
vi.mock("../commands/models/aliases.js", () => ({
  modelsAliasesAddCommand: mocks.modelsAliasesAddCommand,
  modelsAliasesListCommand: mocks.modelsAliasesListCommand,
  modelsAliasesRemoveCommand: mocks.modelsAliasesRemoveCommand,
}));
vi.mock("../commands/models/fallbacks-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/models/fallbacks-shared.js")>()),
  changeFallbacksCommand: mocks.changeFallbacksCommand,
  clearFallbacksCommand: mocks.clearFallbacksCommand,
  listFallbacksCommand: mocks.noopAsync,
}));
vi.mock("../commands/models/scan.js", () => ({
  modelsScanCommand: mocks.modelsScanCommand,
}));
vi.mock("../commands/models/set.js", () => ({
  modelsSetCommand: mocks.modelsSetCommand,
}));
vi.mock("../commands/models/set-image.js", () => ({
  modelsSetImageCommand: mocks.modelsSetImageCommand,
}));
vi.mock("../commands/models/refresh.js", () => ({
  modelsRefreshCommand: mocks.modelsRefreshCommand,
}));

describe("models cli", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createProgram() {
    const program = new Command().enablePositionalOptions();
    registerModelsCli(program);
    return program;
  }

  async function runModelsCommand(args: string[]) {
    await runRegisteredCli({
      register: (program: Command) => {
        program.enablePositionalOptions();
        registerModelsCli(program);
      },
      argv: args,
    });
  }

  function expectCommandOptions(
    command: ReturnType<typeof vi.fn>,
    expected: Record<string, unknown>,
  ) {
    expect(command).toHaveBeenCalledTimes(1);
    const [options, context] = command.mock.calls[0] ?? [];
    const optionRecord = options as Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(expected)) {
      expect(optionRecord?.[key]).toEqual(value);
    }
    if (!context || typeof context !== "object") {
      throw new Error("expected command context");
    }
  }

  async function detectJsonOutput(args: string[]) {
    const program = createProgram();
    let detected: boolean | undefined;
    program.hook("preAction", (_command, actionCommand) => {
      detected = isCommandJsonOutputMode(actionCommand, process.argv);
    });
    const originalArgv = process.argv;
    process.argv = ["node", "openclaw", ...args];
    try {
      await program.parseAsync(args, { from: "user" });
    } finally {
      process.argv = originalArgv;
    }
    return detected;
  }

  it.each(["--json", "--status-json"])(
    "declares and forwards %s as machine output",
    async (flag) => {
      expect(await detectJsonOutput(["models", flag])).toBe(true);
      expectCommandOptions(modelsStatusCommand, { json: true });
    },
  );

  it("does not apply the parent status alias to a child action", async () => {
    expect(await detectJsonOutput(["models", "--status-json", "list"])).toBe(false);
  });

  it.each([
    {
      name: "an ignored parent status alias and a JSON-looking provider value",
      args: ["models", "--status-json", "auth", "list", "--provider", "--json"],
      provider: "--json",
      json: false,
    },
    {
      name: "a real JSON flag before a plain-looking provider value",
      args: ["models", "auth", "list", "--json", "--provider", "--plain"],
      provider: "--plain",
      json: true,
    },
  ])("classifies $name by its actual Commander role", async ({ args, provider, json }) => {
    expect(await detectJsonOutput(args)).toBe(json);
    expectCommandOptions(modelsAuthListCommand, { provider, json });
  });

  it.each([["parent --status-plain", ["models", "--status-plain"]]])(
    "declares %s as plain machine output owning stdout",
    (_label, args) => {
      const argv = ["node", "openclaw", ...args];
      expect(isModelsPlainMachineOutput(argv)).toBe(true);
    },
  );

  it.each([
    ["logs --plain", ["logs", "--plain"]],
    ["plain after argv terminator", ["models", "list", "--", "--plain"]],
  ])("does not declare %s as plain machine output", (_label, args) => {
    const argv = ["node", "openclaw", ...args];
    expect(isModelsPlainMachineOutput(argv)).toBe(false);
  });

  it("does not turn plain output into JSON failure envelope", async () => {
    expect(await detectJsonOutput(["models", "aliases", "list", "--plain"])).toBe(false);
  });

  it.each([
    {
      label: "add",
      args: ["models", "auth", "--agent", "poe", "add"],
      command: modelsAuthAddCommand,
      expected: { agent: "poe" },
    },
    {
      label: "activate",
      args: ["models", "auth", "--agent", "poe", "activate", "openai:saved"],
      command: mocks.modelsAuthActivateCommand,
      expected: { agent: "poe", profileId: "openai:saved" },
    },
    {
      label: "logout",
      args: ["models", "auth", "--agent", "poe", "logout", "openai:manual", "--yes"],
      command: modelsAuthLogoutCommand,
      expected: { agent: "poe", profileId: "openai:manual", yes: true },
    },
    {
      label: "setup-token",
      args: ["models", "auth", "--agent", "poe", "setup-token", "--provider", "anthropic"],
      command: modelsAuthSetupTokenCommand,
      expected: { agent: "poe", provider: "anthropic" },
    },
    {
      label: "paste-token",
      args: ["models", "auth", "--agent", "poe", "paste-token", "--provider", "anthropic"],
      command: modelsAuthPasteTokenCommand,
      expected: { agent: "poe", provider: "anthropic" },
    },
    {
      label: "login-github-copilot",
      args: ["models", "auth", "--agent", "poe", "login-github-copilot", "--yes"],
      command: modelsAuthLoginCommand,
      expected: { agent: "poe", provider: "github-copilot", method: "device", yes: true },
    },
  ])("passes parent --agent to models auth $label", async ({ args, command, expected }) => {
    await runModelsCommand(args);

    expectCommandOptions(command, expected);
  });

  it.each([
    {
      label: "order get",
      args: ["models", "auth", "order", "get", "--provider", "anthropic", "--agent", "poe"],
      command: modelsAuthOrderGetCommand,
      expected: { agent: "poe", provider: "anthropic" },
    },
    {
      label: "order set",
      args: [
        "models",
        "auth",
        "order",
        "set",
        "--provider",
        "anthropic",
        "anthropic:first",
        "anthropic:second",
        "--agent",
        "poe",
      ],
      command: modelsAuthOrderUpdateCommand,
      expected: {
        agent: "poe",
        provider: "anthropic",
        order: ["anthropic:first", "anthropic:second"],
      },
    },
    {
      label: "order clear",
      args: ["models", "auth", "order", "clear", "--provider", "anthropic", "--agent", "poe"],
      command: modelsAuthOrderUpdateCommand,
      expected: { agent: "poe", provider: "anthropic", order: null },
    },
  ])("passes leaf --agent to models auth $label", async ({ args, command, expected }) => {
    await runModelsCommand(args);

    expectCommandOptions(command, expected);
  });

  it("maps --device-code to the provider device-code auth method", async () => {
    await runModelsCommand(["models", "auth", "login", "--provider", "openai", "--device-code"]);

    expectCommandOptions(modelsAuthLoginCommand, {
      provider: "openai",
      method: "device-code",
    });
  });

  const globalModelCommands = [
    {
      label: "set",
      args: ["set", "anthropic/claude-sonnet-4-6"],
      command: modelsSetCommand,
    },
    {
      label: "set-image",
      args: ["set-image", "openai/gpt-image-1"],
      command: modelsSetImageCommand,
    },
    {
      label: "aliases add",
      args: ["aliases", "add", "zzz", "soraka/grok-4.6"],
      command: modelsAliasesAddCommand,
    },
    {
      label: "aliases remove",
      args: ["aliases", "remove", "zzz"],
      command: modelsAliasesRemoveCommand,
    },
    {
      label: "image-fallbacks remove",
      args: ["image-fallbacks", "remove", "openai/gpt-5.5"],
      command: changeFallbacksCommand,
    },
    {
      label: "image-fallbacks clear",
      args: ["image-fallbacks", "clear"],
      command: clearFallbacksCommand,
    },
    {
      label: "scan",
      args: ["scan", "--no-probe", "--no-input"],
      command: modelsScanCommand,
    },
    {
      label: "refresh",
      args: ["refresh"],
      command: modelsRefreshCommand,
    },
  ];

  it.each([
    { label: "set", args: ["set", "anthropic/claude-sonnet-4-6"], command: modelsSetCommand },
    {
      label: "fallbacks add",
      args: ["fallbacks", "add", "openai/gpt-5.5"],
      command: changeFallbacksCommand,
    },
    { label: "fallbacks clear", args: ["fallbacks", "clear"], command: clearFallbacksCommand },
  ])("rejects parent --agent for models $label", async ({ args, command }) => {
    const agent = args[0] === "set" ? "poe" : "";
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
      throw new ExitError(code);
    });
    await expect(runModelsCommand(["models", "--agent", agent, ...args])).rejects.toMatchObject({
      code: 1,
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Remove --agent"));
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(command).not.toHaveBeenCalled();
  });

  it.each(globalModelCommands)(
    "still runs models $label without --agent",
    async ({ args, command }) => {
      await runModelsCommand(["models", ...args]);
      expect(command).toHaveBeenCalledOnce();
    },
  );

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

  const accountCommands = [
    {
      args: ["use", "personal-account"],
      command: mocks.modelsAccountsUpdateDefaultCommand,
      expected: { action: "use", authProfileId: "personal-account" },
    },
    {
      args: ["clear-default", "anthropic"],
      command: mocks.modelsAccountsUpdateDefaultCommand,
      expected: { action: "clear-default", provider: "anthropic" },
    },
  ];

  it.each(accountCommands)(
    "resolves personal-account Gateway options for $args",
    async ({ args, command, expected }) => {
      const position = args[0] === "list" ? "after" : "before";
      const flags = [
        "--url",
        "wss://accounts.example",
        "--token-file",
        "/tmp/gateway-token",
        "--password-file",
        "/tmp/gateway-password",
        "--timeout",
        "45000",
        "--json",
      ];
      await runModelsCommand([
        "models",
        "accounts",
        ...(position === "before" ? [...flags, ...args] : [...args, ...flags]),
      ]);
      expectCommandOptions(command, {
        ...expected,
        url: "wss://accounts.example",
        tokenFile: "/tmp/gateway-token",
        passwordFile: "/tmp/gateway-password",
        timeout: "45000",
        json: true,
      });
    },
  );

  it("rejects agent identity for personal accounts", async () => {
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
      throw new ExitError(code);
    });
    await expect(
      runModelsCommand(["models", "--agent", "other-person", "accounts", "list"]),
    ).rejects.toMatchObject({ code: 1 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("does not support --agent"));
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(mocks.modelsAccountsListCommand).not.toHaveBeenCalled();
  });

  it("lets explicit leaf options override the account group and inherits models JSON", async () => {
    await runModelsCommand([
      "models",
      "--json",
      "accounts",
      "--port",
      "19001",
      "--timeout",
      "45000",
      "list",
      "--port",
      "19002",
      "--timeout",
      "9000",
    ]);
    expectCommandOptions(mocks.modelsAccountsListCommand, {
      port: "19002",
      timeout: "9000",
      json: true,
    });
  });

  it.each(["--token", "--profile-id"])(
    "does not accept personal secret or identity option %s",
    async (flag) => {
      const writeErr = vi.fn();
      const program = new Command()
        .enablePositionalOptions()
        .exitOverride()
        .configureOutput({ writeErr });
      registerModelsCli(program);
      await expect(
        program.parseAsync(["models", "accounts", "login", "openai", flag, "not-an-input"], {
          from: "user",
        }),
      ).rejects.toMatchObject({ code: "commander.unknownOption", exitCode: 1 });
      expect(writeErr).toHaveBeenCalledWith(expect.stringContaining(`unknown option '${flag}'`));
      expect(mocks.modelsAccountsLoginCommand).not.toHaveBeenCalled();
    },
  );
});
