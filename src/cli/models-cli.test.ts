import "../commands/models/accounts.js";
import "../commands/models/auth-order.js";
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
  modelsAliasesListCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthListCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthLoginCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthLogoutCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthOrderUpdateCommand: vi.fn().mockResolvedValue(undefined),
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
// mock-isolation: Observe auth command routing without invoking interactive provider sign-in.
vi.mock("../commands/models/auth.js", () => ({
  modelsAuthLoginCommand: mocks.modelsAuthLoginCommand,
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
vi.mock("../commands/models/auth-logout.js", () => ({
  modelsAuthLogoutCommand: mocks.modelsAuthLogoutCommand,
}));
vi.mock("../commands/models/auth-order.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/models/auth-order.js")>()),
  modelsAuthOrderUpdateCommand: mocks.modelsAuthOrderUpdateCommand,
}));
// mock-isolation: Observe alias command routing without reading stored model configuration.
vi.mock("../commands/models/aliases.js", () => ({
  modelsAliasesListCommand: mocks.modelsAliasesListCommand,
}));
// mock-isolation: Observe CLI routing without changing stored model configuration.
vi.mock("../commands/models/set.js", () => ({ modelsSetCommand: mocks.modelsSetCommand }));

describe("models cli", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => vi.clearAllMocks());

  const register = (program: Command) => registerModelsCli(program.enablePositionalOptions());
  const runModelsCommand = (argv: string[] | string) =>
    runRegisteredCli({ register, argv: typeof argv === "string" ? argv.split(" ") : argv });

  function expectCommandOptions(
    command: ReturnType<typeof vi.fn>,
    expected: Record<string, unknown>,
  ) {
    expect(command).toHaveBeenCalledWith(expect.objectContaining(expected), expect.any(Object));
  }

  async function detectJsonOutput(argv: string) {
    const args = argv.split(" ");
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
      expect(await detectJsonOutput(`models ${flag}`)).toBe(true);
      expectCommandOptions(mocks.modelsStatusCommand, { json: true });
    },
  );

  it("does not apply the parent status alias to a child action", async () => {
    expect(await detectJsonOutput("models --status-json list")).toBe(false);
  });

  it.each([
    ["models --status-json auth list --provider --json", "--json", false],
    ["models auth list --json --provider --plain", "--plain", true],
  ] as const)("classifies %s by its actual Commander role", async (args, provider, json) => {
    expect(await detectJsonOutput(args)).toBe(json);
    expectCommandOptions(mocks.modelsAuthListCommand, { provider, json });
  });

  it("does not declare plain after argv terminator as plain machine output", () => {
    expect(
      isModelsPlainMachineOutput(["node", "openclaw", "models", "list", "--", "--plain"]),
    ).toBe(false);
  });

  it("does not turn plain output into JSON failure envelope", async () => {
    expect(await detectJsonOutput("models aliases list --plain")).toBe(false);
  });

  const provider = { provider: "anthropic" };
  const authCase = (
    args: string,
    command: keyof typeof mocks,
    expected: Record<string, unknown> = provider,
  ) => ({ args, command, expected });
  it.each([
    authCase("--agent poe logout openai:manual --yes", "modelsAuthLogoutCommand", {
      profileId: "openai:manual",
      yes: true,
    }),
    authCase("--agent poe setup-token --provider anthropic", "modelsAuthSetupTokenCommand"),
    authCase("--agent poe login-github-copilot --yes", "modelsAuthLoginCommand", {
      provider: "github-copilot",
      method: "device",
      yes: true,
    }),
    authCase(
      "order set --provider anthropic anthropic:first anthropic:second --agent poe",
      "modelsAuthOrderUpdateCommand",
      { ...provider, order: ["anthropic:first", "anthropic:second"] },
    ),
    authCase("order clear --provider anthropic --agent poe", "modelsAuthOrderUpdateCommand", {
      ...provider,
      order: null,
    }),
  ])("passes parent or leaf --agent to models auth $args", async ({ args, command, expected }) => {
    await runModelsCommand(`models auth ${args}`);
    expectCommandOptions(mocks[command], { agent: "poe", ...expected });
  });

  it("maps --device-code to the provider device-code auth method", async () => {
    await runModelsCommand("models auth login --provider openai --device-code");

    expectCommandOptions(mocks.modelsAuthLoginCommand, {
      provider: "openai",
      method: "device-code",
    });
  });

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
    await expect(runModelsCommand(args)).rejects.toMatchObject({ code: 1 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(command).not.toHaveBeenCalled();
  });

  it("selects the image model field for set-image", async () => {
    await runModelsCommand("models set-image openai/gpt-image-1");
    expect(mocks.modelsSetCommand).toHaveBeenCalledWith(
      "openai/gpt-image-1",
      defaultRuntime,
      "imageModel",
    );
  });

  it("shows help for models auth without error exit", async () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerModelsCli(program);

    await expect(program.parseAsync(["models", "auth"], { from: "user" })).rejects.toMatchObject({
      exitCode: 0,
    });
  });

  it.each([
    ["use personal-account", { action: "use", authProfileId: "personal-account" }],
    ["clear-default anthropic", { action: "clear-default", provider: "anthropic" }],
  ] as const)("resolves personal-account Gateway options for %s", async (args, expected) => {
    const flags =
      "--url wss://accounts.example --token-file /tmp/gateway-token --password-file /tmp/gateway-password --timeout 45000 --json".split(
        " ",
      );
    await runModelsCommand(["models", "accounts", ...flags, ...args.split(" ")]);
    expectCommandOptions(mocks.modelsAccountsUpdateDefaultCommand, {
      ...expected,
      url: "wss://accounts.example",
      tokenFile: "/tmp/gateway-token",
      passwordFile: "/tmp/gateway-password",
      timeout: "45000",
      json: true,
    });
  });

  it("lets explicit leaf options override the account group and inherits models JSON", async () => {
    await runModelsCommand(
      "models --json accounts --port 19001 --timeout 45000 list --port 19002 --timeout 9000",
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
