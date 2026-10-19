import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerSubCliByName, registerSubCliCommands } from "./register.subclis.js";
import * as subCliDescriptors from "./subcli-descriptors.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const mocks = vi.hoisted(() => {
  function registrar(name: string, aliases: string[] = [], child?: string) {
    const action = vi.fn();
    return {
      action,
      register: vi.fn((program: Command) => {
        const command = program.command(name).aliases(aliases);
        return (child ? command.command(child) : command).action(action);
      }),
    };
  }
  const acp = registrar("acp");
  const nodes = registrar("nodes", [], "list");
  const gatewayRunAction = vi.fn();
  return {
    acpAction: acp.action,
    acp: acp.register,
    nodesAction: nodes.action,
    nodes: nodes.register,
    infer: registrar("infer", ["capability"]).register,
    approvals: registrar("approvals", ["exec-approvals"]).register,
    tui: vi.fn((program: Command) => program.command("tui").aliases(["terminal", "chat"])),
    cron: vi.fn((program: Command) => program.command("cron").alias("automations")),
    pairing: registrar("pairing").register,
    plugins: vi.fn((program: Command) =>
      program
        .command("plugins")
        .command("update [id]")
        .action(() => undefined),
    ),
    pluginCommands: vi.fn(async (_program: Command) => null),
    channels: vi.fn(async () => undefined),
    resume: registrar("resume").register,
    gatewayRunAction,
    gatewayRun: vi.fn((command: Command) =>
      command.option("--force", "force", false).action(gatewayRunAction),
    ),
    gateway: registrar("gateway", [], "call").register,
  };
});

// mock-isolation: Registration-order tests use synthetic subcommands without initializing live plugins or services.
vi.mock("../acp-cli.js", () => ({ registerAcpCli: mocks.acp }));
// mock-isolation: Registration-order tests use synthetic subcommands without initializing live plugins or services.
vi.mock("../gateway-cli.js", () => ({ registerGatewayCli: mocks.gateway }));
// mock-isolation: Registration-order tests use synthetic subcommands without initializing live plugins or services.
vi.mock("../gateway-cli/run-command.js", () => ({
  addGatewayRunCommand: mocks.gatewayRun,
}));
// mock-isolation: Registration-order tests use synthetic subcommands without initializing live plugins or services.
vi.mock("../nodes-cli.js", () => ({ registerNodesCli: mocks.nodes }));
// mock-isolation: Registration-order tests use synthetic subcommands without initializing live plugins or services.
vi.mock("../capability-cli.js", () => ({ registerCapabilityCli: mocks.infer }));
// mock-isolation: Registration-order tests use synthetic subcommands without initializing live plugins or services.
vi.mock("../exec-approvals-cli.js", () => ({
  registerExecApprovalsCli: mocks.approvals,
}));
// mock-isolation: Registration-order tests use synthetic subcommands without initializing live plugins or services.
vi.mock("../tui-cli.js", () => ({ registerTuiCli: mocks.tui }));
// mock-isolation: Registration-order tests use synthetic subcommands without initializing live plugins or services.
vi.mock("../cron-cli.js", () => ({ registerCronCli: mocks.cron }));
// mock-isolation: registration-order checks must not initialize channel plugins or pairing stores.
vi.mock("../pairing-cli.js", () => ({ registerPairingCli: mocks.pairing }));
// mock-isolation: Registration-order tests use synthetic subcommands without initializing live plugins or services.
vi.mock("../plugins-cli.js", () => ({ registerPluginsCli: mocks.plugins }));
// mock-isolation: Registration-order tests use synthetic subcommands without initializing live plugins or services.
vi.mock("../channels-cli.js", () => ({ registerChannelsCli: mocks.channels }));
// mock-isolation: Registration-order tests use synthetic subcommands without initializing live plugins or services.
vi.mock("../resume-cli.js", () => ({ registerResumeCli: mocks.resume }));
// mock-isolation: Registration-order tests use synthetic subcommands without initializing live plugins or services.
vi.mock("../../plugins/cli.js", () => ({
  registerPluginCliCommandsFromValidatedConfig: mocks.pluginCommands,
}));
const originalArgv = process.argv;
const createRegisteredProgram = (argv: string[], lazy = true) => {
  process.argv = argv;
  const program = new Command().name("openclaw");
  if (lazy) {
    registerSubCliCommands(program, process.argv);
  }
  return program;
};

beforeEach(() => {
  vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "1");
  vi.stubEnv("OPENCLAW_DISABLE_LAZY_SUBCOMMANDS", undefined);
  vi.clearAllMocks();
});
afterEach(() => {
  process.argv = originalArgv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("coalesces adjacent completion aliases while preserving separated command visits", async () => {
  const selectedNames = new Set(
    "infer capability approvals exec-approvals tui resume terminal chat cron automations completion".split(
      " ",
    ),
  );
  const descriptors = subCliDescriptors
    .getSubCliEntriesCore()
    .filter(({ name }) => selectedNames.has(name));
  vi.spyOn(subCliDescriptors, "getSubCliEntriesCore").mockReturnValue(descriptors);
  const root = tempDirs.make("openclaw-completion-groups-");
  for (const name of ["HOME", "USERPROFILE", "OPENCLAW_HOME"]) {
    vi.stubEnv(name, root);
  }
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
  vi.stubEnv("OPENCLAW_COMPLETION_SKIP_PLUGIN_COMMANDS", "1");
  const program = createRegisteredProgram(["node", "openclaw", "completion", "--write-state"]);
  await program.parseAsync(["completion", "--write-state"], { from: "user" });
  expect(mocks.infer).toHaveBeenCalledTimes(1);
  expect(mocks.approvals).toHaveBeenCalledTimes(1);
  expect(mocks.cron).toHaveBeenCalledTimes(1);
  expect(mocks.tui).toHaveBeenCalledTimes(2);
  expect(program.commands.map((command) => command.name())).toEqual(
    "completion infer approvals resume tui cron".split(" "),
  );
});

it("omits the qa placeholder when the private qa cli is disabled", () => {
  delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
  const program = createRegisteredProgram(["node", "openclaw"]);
  const names = program.commands.map((cmd) => cmd.name());
  expect(names).toEqual(expect.arrayContaining(["acp", "gateway", "clawbot"]));
  expect(names).not.toContain("qa");
  expect(mocks.acp).not.toHaveBeenCalled();
});

it("re-parses argv for lazy subcommands", async () => {
  const argv = ["node", "openclaw", "nodes", "list"];
  const program = createRegisteredProgram(argv);
  expect(program.commands.map((cmd) => cmd.name())).toEqual(["nodes", "completion"]);
  await program.parseAsync(["nodes", "list"], { from: "user" });
  expect(mocks.nodes).toHaveBeenCalledExactlyOnceWith(expect.any(Command), argv);
  expect(mocks.nodesAction).toHaveBeenCalledTimes(1);
});

it("replaces placeholder when registering a subcommand by name", async () => {
  const program = createRegisteredProgram(["node", "openclaw", "acp", "--help"]);
  await registerSubCliByName(program, "acp");
  expect(program.commands.filter((command) => command.name() === "acp")).toHaveLength(1);
  await program.parseAsync(["acp"], { from: "user" });
  expect(mocks.acp).toHaveBeenCalledTimes(1);
  expect(mocks.acpAction).toHaveBeenCalledTimes(1);
});

it.each([
  ["gateway --force", 2, 0],
  ["gateway call health", 0, 1],
] as const)("registers the correct gateway surface for %s", async (args, runCalls, fullCalls) => {
  const argv = ["node", "openclaw", ...args.split(" ")];
  const program = createRegisteredProgram(argv, false);
  await registerSubCliByName(program, "gateway", argv);
  expect(mocks.gatewayRun).toHaveBeenCalledTimes(runCalls);
  expect(mocks.gateway).toHaveBeenCalledTimes(fullCalls);
  if (runCalls) {
    await program.parseAsync(args.split(" "), { from: "user" });
    expect(mocks.gatewayRunAction).toHaveBeenCalledTimes(1);
  }
});

it("passes completion context to channel registration", async () => {
  const argv = ["node", "openclaw", "completion", "--write-state"];
  const program = new Command().name("openclaw");
  await registerSubCliByName(program, "channels", argv, { purpose: "completion" });
  expect(mocks.channels).toHaveBeenCalledWith(program, argv, {
    includeSetupOptions: true,
  });
});

it.each([
  { name: "pairing", expected: ["synthetic-plugin", "pairing"] },
  { name: "plugins", expected: ["plugins", "synthetic-plugin"] },
])("preserves plugin command registration order for $name", async ({ name, expected }) => {
  mocks.pluginCommands.mockImplementationOnce(async (program) => {
    program.command("synthetic-plugin");
    return null;
  });
  const program = new Command().name("openclaw");
  // Eager registration visits other groups while a plugin-backed command is selected.
  await registerSubCliByName(program, name, ["node", "openclaw", "directory", "peers"]);
  expect(program.commands.map((command) => command.name())).toEqual(expected);
});
