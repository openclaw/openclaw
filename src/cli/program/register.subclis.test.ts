import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { defaultRuntime } from "../../runtime.js";
import {
  applyCliExecutionStartupPresentation,
  ensureCliExecutionBootstrap,
} from "../command-execution-startup.js";
import { tryRouteCli } from "../route.js";
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
  const nodes = registrar("nodes", [], "list");
  const gatewayRunAction = vi.fn();
  return {
    nodesAction: nodes.action,
    nodes: nodes.register,
    infer: registrar("infer", ["capability"]).register,
    tui: vi.fn((program: Command) => program.command("tui").aliases(["terminal", "chat"])),
    pairing: registrar("pairing").register,
    plugins: registrar("plugins", [], "update [id]").register,
    pluginCommands: vi.fn(async (_program: Command) => null),
    resume: registrar("resume").register,
    gatewayRunAction,
    gatewayRun: vi.fn((command: Command) =>
      command.option("--force", "force", false).action(gatewayRunAction),
    ),
    gateway: registrar("gateway", [], "call").register,
    modelsStatus: vi.fn(async () => {}),
    statusJson: vi.fn(async () => {}),
    daemonStatus: vi.fn(async () => {}),
  };
});

// mock-isolation: Synthetic registrar; do not initialize live services.
vi.mock("../gateway-cli.js", () => ({ registerGatewayCli: mocks.gateway }));
// mock-isolation: Synthetic registrar; do not initialize live services.
vi.mock("../gateway-cli/run-command.js", () => ({ addGatewayRunCommand: mocks.gatewayRun }));
// mock-isolation: Synthetic registrar; do not initialize live services.
vi.mock("../nodes-cli.js", () => ({ registerNodesCli: mocks.nodes }));
// mock-isolation: Synthetic registrar; do not initialize live services.
vi.mock("../capability-cli.js", () => ({ registerCapabilityCli: mocks.infer }));
// mock-isolation: Synthetic registrar; do not initialize live services.
vi.mock("../tui-cli.js", () => ({ registerTuiCli: mocks.tui }));
// mock-isolation: Synthetic registrar; do not initialize pairing stores.
vi.mock("../pairing-cli.js", () => ({ registerPairingCli: mocks.pairing }));
// mock-isolation: Synthetic registrar; do not initialize live plugins.
vi.mock("../plugins-cli.js", () => ({ registerPluginsCli: mocks.plugins }));
// mock-isolation: Synthetic registrar; do not initialize live services.
vi.mock("../resume-cli.js", () => ({ registerResumeCli: mocks.resume }));
// mock-isolation: Synthetic registrar; do not initialize live plugins.
vi.mock("../../plugins/cli.js", () => ({
  registerPluginCliCommandsFromValidatedConfig: mocks.pluginCommands,
}));
// mock-isolation: Inspect routed startup policy without bootstrapping live state.
vi.mock("../command-execution-startup.js", () => ({
  applyCliExecutionStartupPresentation: vi.fn(async () => {}),
  ensureCliExecutionBootstrap: vi.fn(async () => {}),
}));
// mock-isolation: Parse probe flags without contacting model providers.
vi.mock("../../commands/models/list.status-command.js", () => ({
  modelsStatusCommand: mocks.modelsStatus,
}));
// mock-isolation: Verify lean JSON dispatch without collecting live status.
vi.mock("../../commands/status-json.js", () => ({ statusJsonCommand: mocks.statusJson }));
// mock-isolation: Route dispatch stops before opening daemon service state.
vi.mock("../daemon-cli/status.js", () => ({ runDaemonStatus: mocks.daemonStatus }));
const originalArgv = process.argv;
const createRegisteredProgram = (argv: string[]) => {
  process.argv = argv;
  const program = new Command().name("openclaw");
  registerSubCliCommands(program, argv);
  return program;
};

beforeEach(() => {
  vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "1");
  vi.stubEnv("OPENCLAW_DISABLE_LAZY_SUBCOMMANDS", undefined);
  vi.stubEnv("OPENCLAW_LOG_LEVEL", undefined);
  vi.clearAllMocks();
});
afterEach(() => {
  process.argv = originalArgv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("coalesces adjacent completion aliases while preserving separated command visits", async () => {
  const selectedNames = new Set("infer capability tui resume terminal chat completion".split(" "));
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
  expect(mocks.tui).toHaveBeenCalledTimes(2);
  expect(program.commands.map((command) => command.name())).toEqual(
    "completion infer resume tui".split(" "),
  );
});

it.each([false, true])(
  "replaces lazy placeholders and dispatches once (explicit=%s)",
  async (explicit) => {
    const argv = ["node", "openclaw", "nodes", "list"];
    const program = createRegisteredProgram(argv);
    expect(program.commands.map((cmd) => cmd.name())).toEqual(["nodes", "completion"]);
    if (explicit) {
      await registerSubCliByName(program, "nodes");
      expect(program.commands.filter((command) => command.name() === "nodes")).toHaveLength(1);
    }
    await program.parseAsync(["nodes", "list"], { from: "user" });
    expect(mocks.nodesAction).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ["gateway --force", 2, 0],
  ["gateway call health", 0, 1],
] as const)("registers the correct gateway surface for %s", async (args, runCalls, fullCalls) => {
  const argv = ["node", "openclaw", ...args.split(" ")];
  const program = new Command().name("openclaw");
  await registerSubCliByName(program, "gateway", argv);
  expect(mocks.gatewayRun).toHaveBeenCalledTimes(runCalls);
  expect(mocks.gateway).toHaveBeenCalledTimes(fullCalls);
  if (runCalls) {
    await program.parseAsync(args.split(" "), { from: "user" });
    expect(mocks.gatewayRunAction).toHaveBeenCalledTimes(1);
  }
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
  await registerSubCliByName(program, name, ["node", "openclaw", "directory", "peers"]);
  expect(program.commands.map((command) => command.name())).toEqual(expected);
});

it("routes local runtime intent without config or plugin startup", async () => {
  await expect(
    tryRouteCli(["node", "openclaw", "gateway", "status", "--runtime-intent-only", "--json"]),
  ).resolves.toBe(true);
  expect(mocks.daemonStatus).toHaveBeenCalledWith(
    expect.objectContaining({ runtimeIntentOnly: true, json: true }),
  );
  expect(ensureCliExecutionBootstrap).toHaveBeenCalledWith(
    expect.objectContaining({
      startupPolicy: expect.objectContaining({ skipConfigGuard: true, loadPlugins: false }),
    }),
  );
});

it("routes status --json through the lean JSON command", async () => {
  await expect(
    tryRouteCli([
      "node",
      "openclaw",
      "status",
      "--json",
      "--deep",
      "--usage",
      "--agent",
      "beta",
      "--timeout",
      "5000",
    ]),
  ).resolves.toBe(true);
  expect(mocks.statusJson).toHaveBeenCalledExactlyOnceWith(
    { deep: true, all: false, usage: true, agent: "beta", timeoutMs: 5000 },
    defaultRuntime,
  );
});

it("routes negative-number probe profile values", async () => {
  await expect(
    tryRouteCli(["node", "openclaw", "models", "status", "--probe-profile", "-1"]),
  ).resolves.toBe(true);
  expect(mocks.modelsStatus).toHaveBeenCalledWith(
    expect.objectContaining({ probeProfile: "-1" }),
    defaultRuntime,
  );
});

it.each(["plugins list --wat", "gateway status --ssh-identity key"])(
  "defers unsupported %s",
  async (args) => {
    await expect(tryRouteCli(["node", "openclaw", ...args.split(" ")])).resolves.toBe(false);
    expect(ensureCliExecutionBootstrap).not.toHaveBeenCalled();
    expect(applyCliExecutionStartupPresentation).not.toHaveBeenCalled();
  },
);
