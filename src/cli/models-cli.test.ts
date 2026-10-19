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
// mock-isolation: Observe CLI routing without scanning live providers.
vi.mock("../commands/models/scan.js", () => ({ modelsScanCommand: mocks.modelsScanCommand }));
// mock-isolation: Observe CLI routing without changing stored model configuration.
vi.mock("../commands/models/set.js", () => ({ modelsSetCommand: mocks.modelsSetCommand }));
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

  function authCase(args: string, command: ReturnType<typeof vi.fn>, expected = {}) {
    return {
      label: args,
      args: ["models", "auth", ...args.split(" ")],
      command,
      expected: { agent: "poe", ...expected },
    };
  }
  function globalCase(args: string, command: ReturnType<typeof vi.fn>, field?: string) {
    return { label: args, args: args.split(" "), command, field };
  }

  const register = (program: Command) => registerModelsCli(program.enablePositionalOptions());
  const runModelsCommand = (argv: string[]) => runRegisteredCli({ register, argv });

  function expectCommandOptions(
    command: ReturnType<typeof vi.fn>,
    expected: Record<string, unknown>,
  ) {
    expect(command).toHaveBeenCalledTimes(1);
    const [options, context] = command.mock.calls[0] ?? [];
    expect(options).toEqual(expect.objectContaining(expected));
    if (!context || typeof context !== "object") {
      throw new Error("expected command context");
    }
  }

  async function detectJsonOutput(args: string[]) {
    const program = new Command();
    register(program);
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
      expectCommandOptions(mocks.modelsStatusCommand, { json: true });
    },
  );

  it("does not apply the parent status alias to a child action", async () => {
    expect(await detectJsonOutput(["models", "--status-json", "list"])).toBe(false);
  });

  it.each([
    {
      name: "an ignored parent status alias and a JSON-looking provider value",
      args: "models --status-json auth list --provider --json".split(" "),
      provider: "--json",
      json: false,
    },
    {
      name: "a real JSON flag before a plain-looking provider value",
      args: "models auth list --json --provider --plain".split(" "),
      provider: "--plain",
      json: true,
    },
  ])("classifies $name by its actual Commander role", async ({ args, provider, json }) => {
    expect(await detectJsonOutput(args)).toBe(json);
    expectCommandOptions(mocks.modelsAuthListCommand, { provider, json });
  });

  it("declares parent --status-plain as plain machine output owning stdout", () => {
    expect(isModelsPlainMachineOutput(["node", "openclaw", "models", "--status-plain"])).toBe(true);
  });

  it("does not declare plain after argv terminator as plain machine output", () => {
    expect(
      isModelsPlainMachineOutput(["node", "openclaw", "models", "list", "--", "--plain"]),
    ).toBe(false);
  });

  it("does not turn plain output into JSON failure envelope", async () => {
    expect(await detectJsonOutput(["models", "aliases", "list", "--plain"])).toBe(false);
  });

  it.each([
    authCase("--agent poe add", mocks.modelsAuthAddCommand),
    authCase("--agent poe activate openai:saved", mocks.modelsAuthActivateCommand, {
      profileId: "openai:saved",
    }),
    authCase("--agent poe logout openai:manual --yes", mocks.modelsAuthLogoutCommand, {
      profileId: "openai:manual",
      yes: true,
    }),
    authCase("--agent poe setup-token --provider anthropic", mocks.modelsAuthSetupTokenCommand, {
      provider: "anthropic",
    }),
    authCase("--agent poe paste-token --provider anthropic", mocks.modelsAuthPasteTokenCommand, {
      provider: "anthropic",
    }),
    authCase("--agent poe login-github-copilot --yes", mocks.modelsAuthLoginCommand, {
      provider: "github-copilot",
      method: "device",
      yes: true,
    }),
  ])("passes parent --agent to models auth $label", async ({ args, command, expected }) => {
    await runModelsCommand(args);

    expectCommandOptions(command, expected);
  });

  it.each([
    authCase("order get --provider anthropic --agent poe", mocks.modelsAuthOrderGetCommand, {
      provider: "anthropic",
    }),
    authCase(
      "order set --provider anthropic anthropic:first anthropic:second --agent poe",
      mocks.modelsAuthOrderUpdateCommand,
      { provider: "anthropic", order: ["anthropic:first", "anthropic:second"] },
    ),
    authCase("order clear --provider anthropic --agent poe", mocks.modelsAuthOrderUpdateCommand, {
      provider: "anthropic",
      order: null,
    }),
  ])("passes leaf --agent to models auth $label", async ({ args, command, expected }) => {
    await runModelsCommand(args);

    expectCommandOptions(command, expected);
  });

  it("maps --device-code to the provider device-code auth method", async () => {
    await runModelsCommand("models auth login --provider openai --device-code".split(" "));

    expectCommandOptions(mocks.modelsAuthLoginCommand, {
      provider: "openai",
      method: "device-code",
    });
  });

  const globalModelCommands = [
    globalCase("set-image openai/gpt-image-1", mocks.modelsSetCommand, "imageModel"),
    globalCase("aliases add zzz soraka/grok-4.6", mocks.modelsAliasesAddCommand),
    globalCase("aliases remove zzz", mocks.modelsAliasesRemoveCommand),
    globalCase("image-fallbacks remove openai/gpt-5.5", mocks.changeFallbacksCommand),
    globalCase("image-fallbacks clear", mocks.clearFallbacksCommand),
    globalCase("scan --no-probe --no-input", mocks.modelsScanCommand),
    globalCase("refresh", mocks.modelsRefreshCommand),
  ];

  it.each([
    [
      "models --agent poe set anthropic/claude-sonnet-4-6",
      "Remove --agent",
      mocks.modelsSetCommand,
    ],
    [
      "models --agent other-person accounts list",
      "does not support --agent",
      mocks.modelsAccountsListCommand,
    ],
  ] as const)("rejects unsupported agent scope: %s", async (args, message, command) => {
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
      throw new ExitError(code);
    });
    await expect(runModelsCommand(args.split(" "))).rejects.toMatchObject({ code: 1 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(command).not.toHaveBeenCalled();
  });

  it.each(globalModelCommands)(
    "still runs models $label without --agent",
    async ({ args, command, field }) => {
      await runModelsCommand(["models", ...args]);
      expect(command).toHaveBeenCalledOnce();
      if (field) {
        expect(command).toHaveBeenCalledWith(args[1], defaultRuntime, field);
      }
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

    await expect(program.parseAsync(["models", "auth"], { from: "user" })).rejects.toMatchObject({
      exitCode: 0,
    });
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
      const flags =
        "--url wss://accounts.example --token-file /tmp/gateway-token --password-file /tmp/gateway-password --timeout 45000 --json".split(
          " ",
        );
      await runModelsCommand(["models", "accounts", ...flags, ...args]);
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

  it("lets explicit leaf options override the account group and inherits models JSON", async () => {
    await runModelsCommand(
      "models --json accounts --port 19001 --timeout 45000 list --port 19002 --timeout 9000".split(
        " ",
      ),
    );
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
