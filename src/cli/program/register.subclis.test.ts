import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadValidatedConfigForPluginRegistration,
  registerSubCliByName,
  registerSubCliCommands,
} from "./register.subclis.js";

const { acpAction, registerAcpCli } = vi.hoisted(() => {
  const action = vi.fn();
  const register = vi.fn((program: Command) => {
    program.command("acp").action(action);
  });
  return { acpAction: action, registerAcpCli: register };
});

const { nodesAction, registerNodesCli } = vi.hoisted(() => {
  const action = vi.fn();
  const register = vi.fn((program: Command) => {
    const nodes = program.command("nodes");
    nodes.command("list").action(action);
  });
  return { nodesAction: action, registerNodesCli: register };
});

const { registerQaCli } = vi.hoisted(() => ({
  registerQaCli: vi.fn((program: Command) => {
    const qa = program.command("qa");
    qa.command("run").action(() => undefined);
  }),
}));

const configModule = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
}));

vi.mock("../acp-cli.js", () => ({ registerAcpCli }));
vi.mock("../nodes-cli.js", () => ({ registerNodesCli }));
vi.mock("../qa-cli.js", () => ({ registerQaCli }));
vi.mock("../../config/config.js", () => configModule);

describe("registerSubCliCommands", () => {
  const originalArgv = process.argv;
  const originalDisableLazySubcommands = process.env.OPENCLAW_DISABLE_LAZY_SUBCOMMANDS;

  const createRegisteredProgram = (argv: string[], name?: string) => {
    process.argv = argv;
    const program = new Command();
    if (name) {
      program.name(name);
    }
    registerSubCliCommands(program, process.argv);
    return program;
  };

  beforeEach(() => {
    if (originalDisableLazySubcommands === undefined) {
      delete process.env.OPENCLAW_DISABLE_LAZY_SUBCOMMANDS;
    } else {
      process.env.OPENCLAW_DISABLE_LAZY_SUBCOMMANDS = originalDisableLazySubcommands;
    }
    registerAcpCli.mockClear();
    acpAction.mockClear();
    registerNodesCli.mockClear();
    nodesAction.mockClear();
    configModule.loadConfig.mockReset();
    configModule.readConfigFileSnapshot.mockReset();
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (originalDisableLazySubcommands === undefined) {
      delete process.env.OPENCLAW_DISABLE_LAZY_SUBCOMMANDS;
    } else {
      process.env.OPENCLAW_DISABLE_LAZY_SUBCOMMANDS = originalDisableLazySubcommands;
    }
  });

  it("registers only the primary placeholder and dispatches", async () => {
    const program = createRegisteredProgram(["node", "openclaw", "acp"]);

    expect(program.commands.map((cmd) => cmd.name())).toEqual(["acp"]);

    await program.parseAsync(["acp"], { from: "user" });

    expect(registerAcpCli).toHaveBeenCalledTimes(1);
    expect(acpAction).toHaveBeenCalledTimes(1);
  });

  it("registers placeholders for all subcommands when no primary", () => {
    const program = createRegisteredProgram(["node", "openclaw"]);

    const names = program.commands.map((cmd) => cmd.name());
    expect(names).toContain("acp");
    expect(names).toContain("gateway");
    expect(names).toContain("clawbot");
    expect(names).toContain("qa");
    expect(registerAcpCli).not.toHaveBeenCalled();
  });

  it("returns null for plugin registration when the config snapshot is invalid", async () => {
    configModule.readConfigFileSnapshot.mockResolvedValueOnce({
      valid: false,
      config: { plugins: { load: { paths: ["/tmp/evil"] } } },
    });

    await expect(loadValidatedConfigForPluginRegistration()).resolves.toBeNull();
    expect(configModule.loadConfig).not.toHaveBeenCalled();
  });

  it("loads validated config for plugin registration when the snapshot is valid", async () => {
    const loadedConfig = { plugins: { enabled: true } };
    configModule.readConfigFileSnapshot.mockResolvedValueOnce({
      valid: true,
      config: loadedConfig,
    });
    configModule.loadConfig.mockReturnValueOnce(loadedConfig);

    await expect(loadValidatedConfigForPluginRegistration()).resolves.toBe(loadedConfig);
    expect(configModule.loadConfig).toHaveBeenCalledTimes(1);
  });

  it("re-parses argv for lazy subcommands", async () => {
    const program = createRegisteredProgram(["node", "openclaw", "nodes", "list"], "openclaw");

    expect(program.commands.map((cmd) => cmd.name())).toEqual(["nodes"]);

    await program.parseAsync(["nodes", "list"], { from: "user" });

    expect(registerNodesCli).toHaveBeenCalledTimes(1);
    expect(nodesAction).toHaveBeenCalledTimes(1);
  });

  it("replaces placeholder when registering a subcommand by name", async () => {
    const program = createRegisteredProgram(["node", "openclaw", "acp", "--help"], "openclaw");

    await registerSubCliByName(program, "acp");

    const names = program.commands.map((cmd) => cmd.name());
    expect(names.filter((name) => name === "acp")).toHaveLength(1);

    await program.parseAsync(["acp"], { from: "user" });
    expect(registerAcpCli).toHaveBeenCalledTimes(1);
    expect(acpAction).toHaveBeenCalledTimes(1);
  });
});
