import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerSubCliByName, registerSubCliCommands } from "./register.subclis.js";
import * as subCliDescriptors from "./subcli-descriptors.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const mocks = vi.hoisted(() => {
  function registrar(name: string, aliases: string[] = []) {
    const action = vi.fn();
    return {
      action,
      register: vi.fn((program: Command) => program.command(name).aliases(aliases).action(action)),
    };
  }
  const acp = registrar("acp");
  const nodesAction = vi.fn();
  const gatewayRunAction = vi.fn();
  return {
    acpAction: acp.action,
    registerAcpCli: acp.register,
    nodesAction,
    registerNodesCli: vi.fn((program: Command) =>
      program.command("nodes").command("list").action(nodesAction),
    ),
    registerCapabilityCli: registrar("infer", ["capability"]).register,
    registerExecApprovalsCli: registrar("approvals", ["exec-approvals"]).register,
    registerTuiCli: vi.fn((program: Command) =>
      program.command("tui").aliases(["terminal", "chat"]),
    ),
    registerCronCli: vi.fn((program: Command) => program.command("cron").alias("automations")),
    registerPluginsCli: vi.fn((program: Command) =>
      program
        .command("plugins")
        .command("update")
        .argument("[id]")
        .action(() => undefined),
    ),
    registerPluginCliCommandsFromValidatedConfig: vi.fn(async () => null),
    registerChannelsCli: vi.fn(async () => undefined),
    registerResumeCli: registrar("resume").register,
    gatewayRunAction,
    addGatewayRunCommand: vi.fn((command: Command) =>
      command.option("--force", "force", false).action(gatewayRunAction),
    ),
    registerGatewayCli: vi.fn((program: Command) =>
      program
        .command("gateway")
        .command("call")
        .action(() => undefined),
    ),
  };
});

vi.mock("../acp-cli.js", () => ({ registerAcpCli: mocks.registerAcpCli }));
vi.mock("../gateway-cli.js", () => ({ registerGatewayCli: mocks.registerGatewayCli }));
vi.mock("../gateway-cli/run-command.js", () => ({
  addGatewayRunCommand: mocks.addGatewayRunCommand,
}));
vi.mock("../nodes-cli.js", () => ({ registerNodesCli: mocks.registerNodesCli }));
vi.mock("../capability-cli.js", () => ({ registerCapabilityCli: mocks.registerCapabilityCli }));
vi.mock("../exec-approvals-cli.js", () => ({
  registerExecApprovalsCli: mocks.registerExecApprovalsCli,
}));
vi.mock("../tui-cli.js", () => ({ registerTuiCli: mocks.registerTuiCli }));
vi.mock("../cron-cli.js", () => ({ registerCronCli: mocks.registerCronCli }));
vi.mock("../plugins-cli.js", () => ({ registerPluginsCli: mocks.registerPluginsCli }));
vi.mock("../channels-cli.js", () => ({ registerChannelsCli: mocks.registerChannelsCli }));
vi.mock("../resume-cli.js", () => ({ registerResumeCli: mocks.registerResumeCli }));
vi.mock("../../plugins/cli.js", () => ({
  registerPluginCliCommandsFromValidatedConfig: mocks.registerPluginCliCommandsFromValidatedConfig,
}));
describe("registerSubCliCommands", () => {
  const originalArgv = process.argv;
  const createRegisteredProgram = (argv: string[]) => {
    process.argv = argv;
    const program = new Command().name("openclaw");
    registerSubCliCommands(program, process.argv);
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
    expect(mocks.registerCapabilityCli).toHaveBeenCalledTimes(1);
    expect(mocks.registerExecApprovalsCli).toHaveBeenCalledTimes(1);
    expect(mocks.registerCronCli).toHaveBeenCalledTimes(1);
    expect(mocks.registerTuiCli).toHaveBeenCalledTimes(2);
    expect(program.commands.map((command) => command.name())).toEqual([
      "completion",
      "infer",
      "approvals",
      "resume",
      "tui",
      "cron",
    ]);
  });

  it("omits the qa placeholder when the private qa cli is disabled", () => {
    delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;

    const program = createRegisteredProgram(["node", "openclaw"]);

    const names = program.commands.map((cmd) => cmd.name());
    expect(names).toEqual(expect.arrayContaining(["acp", "gateway", "clawbot"]));
    expect(names).not.toContain("qa");
    expect(mocks.registerAcpCli).not.toHaveBeenCalled();
  });

  it("re-parses argv for lazy subcommands", async () => {
    const argv = ["node", "openclaw", "nodes", "list"];
    const program = createRegisteredProgram(argv);

    expect(program.commands.map((cmd) => cmd.name())).toEqual(["nodes", "completion"]);

    await program.parseAsync(["nodes", "list"], { from: "user" });

    expect(mocks.registerNodesCli).toHaveBeenCalledTimes(1);
    expect(mocks.registerNodesCli).toHaveBeenCalledWith(expect.any(Command), argv);
    expect(mocks.nodesAction).toHaveBeenCalledTimes(1);
  });

  it("replaces placeholder when registering a subcommand by name", async () => {
    const program = createRegisteredProgram(["node", "openclaw", "acp", "--help"]);

    await registerSubCliByName(program, "acp");

    const names = program.commands.map((cmd) => cmd.name());
    expect(names.reduce((count, name) => count + (name === "acp" ? 1 : 0), 0)).toBe(1);

    await program.parseAsync(["acp"], { from: "user" });
    expect(mocks.registerAcpCli).toHaveBeenCalledTimes(1);
    expect(mocks.acpAction).toHaveBeenCalledTimes(1);
  });

  it("registers only the gateway run surface for gateway startup", async () => {
    const argv = ["node", "openclaw", "gateway", "--force"];
    process.argv = argv;
    const program = new Command().name("openclaw");

    await registerSubCliByName(program, "gateway", argv);

    expect(mocks.addGatewayRunCommand).toHaveBeenCalledTimes(2);
    expect(mocks.registerGatewayCli).not.toHaveBeenCalled();
    await program.parseAsync(["gateway", "--force"], { from: "user" });
    expect(mocks.gatewayRunAction).toHaveBeenCalledTimes(1);
  });

  it("keeps the full gateway CLI for non-run gateway subcommands", async () => {
    const argv = ["node", "openclaw", "gateway", "call", "health"];
    process.argv = argv;
    const program = new Command().name("openclaw");

    await registerSubCliByName(program, "gateway", argv);

    expect(mocks.addGatewayRunCommand).not.toHaveBeenCalled();
    expect(mocks.registerGatewayCli).toHaveBeenCalledTimes(1);
  });

  it("passes completion context to channel registration", async () => {
    const argv = ["node", "openclaw", "completion", "--write-state"];
    const program = new Command().name("openclaw");

    await registerSubCliByName(program, "channels", argv, { purpose: "completion" });

    expect(mocks.registerChannelsCli).toHaveBeenCalledWith(program, argv, {
      includeSetupOptions: true,
    });
  });

  it.each([{ args: [] }, { args: ["update", "lossless-claw"] }, { args: ["--help"] }])(
    "does not preload plugin CLI registrations for builtin plugins %j",
    async ({ args }) => {
      process.argv = ["node", "openclaw", "plugins", ...args];
      const program = new Command().name("openclaw");
      await registerSubCliByName(program, "plugins");
      expect(mocks.registerPluginsCli).toHaveBeenCalledTimes(1);
      expect(mocks.registerPluginCliCommandsFromValidatedConfig).not.toHaveBeenCalled();
    },
  );
});
