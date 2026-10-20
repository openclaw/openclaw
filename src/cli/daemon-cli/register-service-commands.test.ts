import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isVerbose, setVerbose } from "../../globals.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { withConsoleLogsRoutedToStderrForJson } from "../json-output-mode.js";
import { ensureConfigReady } from "../program/config-guard.js";
import { registerPreActionHooks } from "../program/preaction.js";
import { requireMockCallArg } from "./lifecycle.test-helpers.js";
import { addGatewayServiceCommands } from "./register-service-commands.js";
import { registerDaemonCli } from "./register.js";

const runDaemonInstall = vi.fn(async (_opts: unknown) => {});
const runDaemonRestart = vi.fn(async (_opts: unknown) => {});
const runDaemonStart = vi.fn(async (_opts: unknown) => {});
const runDaemonStatus = vi.fn(async (_opts: unknown) => {});
const runDaemonStop = vi.fn(async (_opts: unknown) => {});
const runDaemonUninstall = vi.fn(async (_opts: unknown) => {});

vi.mock("../program/config-guard.js", () => ({ ensureConfigReady: vi.fn(async () => {}) }));

const RESTART_ROUTE_ENV_KEYS = [
  "OPENCLAW_SERVICE_MARKER",
  "OPENCLAW_SERVICE_KIND",
  "OPENCLAW_SUPERVISOR_MODE",
];

const gatewayServiceEnv = {
  OPENCLAW_SERVICE_MARKER: "openclaw",
  OPENCLAW_SERVICE_KIND: "gateway",
};

vi.mock("./install.runtime.js", () => ({
  runDaemonInstall: (opts: unknown) => runDaemonInstall(opts),
}));

vi.mock("./status.runtime.js", () => ({
  runDaemonStatus: (opts: unknown) => runDaemonStatus(opts),
}));

vi.mock("./lifecycle.runtime.js", () => ({
  runDaemonRestart: (opts: unknown) => runDaemonRestart(opts),
  runDaemonStart: (opts: unknown) => runDaemonStart(opts),
  runDaemonStop: (opts: unknown) => runDaemonStop(opts),
  runDaemonUninstall: (opts: unknown) => runDaemonUninstall(opts),
}));

function gatewayCommand() {
  const gateway = new Command().name("gateway");
  // Mirror overlapping root gateway options that conflict with service subcommand options.
  gateway.option("--port <port>", "Port for the gateway WebSocket");
  gateway.option("--token <token>", "Gateway token");
  gateway.option("--password <password>", "Gateway password");
  gateway.option("--force", "Gateway run --force", false);
  gateway.option("--allow-unconfigured", "Gateway run without local mode", false);
  addGatewayServiceCommands(gateway);
  return gateway;
}

function expectSingleDaemonCall(mockFn: ReturnType<typeof vi.fn>) {
  expect(mockFn).toHaveBeenCalledTimes(1);
  return requireMockCallArg(mockFn, "daemon");
}

function setRestartRouteEnv(env: Record<string, string | undefined>) {
  for (const key of RESTART_ROUTE_ENV_KEYS) {
    const value = env[key];
    if (value === undefined) {
      deleteTestEnvValue(key);
    } else {
      setTestEnvValue(key, value);
    }
  }
}

async function parseStartup(program: Command, argv: string[]) {
  const previousArgv = process.argv;
  const previousTitle = process.title;
  const previousVerbose = isVerbose();
  const startupEnv = captureEnv(["NODE_NO_WARNINGS"]);
  process.argv = argv;
  try {
    await withConsoleLogsRoutedToStderrForJson(argv, () => program.parseAsync(argv), {
      restoreChanges: true,
    });
  } finally {
    process.argv = previousArgv;
    process.title = previousTitle;
    setVerbose(previousVerbose);
    startupEnv.restore();
  }
}

describe("addGatewayServiceCommands", () => {
  let restartRouteEnvSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    restartRouteEnvSnapshot = captureEnv(RESTART_ROUTE_ENV_KEYS);
    setRestartRouteEnv({});
    vi.clearAllMocks();
  });

  afterEach(() => {
    restartRouteEnvSnapshot.restore();
    vi.restoreAllMocks();
  });

  it("defers daemon install startup until --restore-service-cli is checked", async () => {
    const program = new Command().name("openclaw");
    addGatewayServiceCommands(program.command("daemon"));
    registerPreActionHooks(program, "9.9.9-test");
    await parseStartup(program, [
      "node",
      "openclaw",
      "daemon",
      "install",
      "--json",
      "--restore-service-cli",
      JSON.stringify({ revision: "observed-pin", definition: null }),
    ]);
    expect(ensureConfigReady).not.toHaveBeenCalled();
    expect(runDaemonInstall).toHaveBeenCalledOnce();
  });

  it.each([
    { parent: "gateway", action: "install" },
    { parent: "daemon", action: "stop" },
  ])(
    "probes $parent $action update custody without startup mutation or invoking the action",
    async ({ parent, action }) => {
      const program = new Command().name("openclaw").enablePositionalOptions();
      addGatewayServiceCommands(program.command(parent));
      registerPreActionHooks(program, "9.9.9-test");
      const argv = ["node", "openclaw", parent, action, "--update-executor", "check"];
      const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      await parseStartup(program, argv);
      expect(output.mock.calls.map(([chunk]) => String(chunk)).join("")).toBe(
        JSON.stringify({
          updateExecutor: "root-spawner-v1",
          targetRootBinding: true,
          definitionBackup: true,
          retainedOwnerBinding: true,
          originalDefinitionBinding: true,
          originalRuntimePinBinding: true,
        }),
      );
      expect(ensureConfigReady).not.toHaveBeenCalled();
      expect(runDaemonInstall).not.toHaveBeenCalled();
      expect(runDaemonRestart).not.toHaveBeenCalled();
      expect(runDaemonStop).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "Windows gateway", argv: ["restart", "--json"], expected: { safe: true, json: true } },
    { name: "outside service", env: {}, expected: { safe: false } },
    {
      name: "node service",
      env: { ...gatewayServiceEnv, OPENCLAW_SERVICE_KIND: "node" },
      expected: { safe: false },
    },
    { name: "Linux gateway", platform: "linux" as const, expected: { safe: false } },
    {
      name: "normalized external mode",
      env: { ...gatewayServiceEnv, OPENCLAW_SUPERVISOR_MODE: "  ExTeRnAl  " },
      expected: { safe: false },
    },
    {
      name: "explicit safe under external supervision",
      env: { ...gatewayServiceEnv, OPENCLAW_SUPERVISOR_MODE: "external" },
      argv: ["restart", "--safe"],
      expected: { safe: true },
    },
    { name: "leaf --force", argv: ["restart", "--force"], expected: { safe: false, force: true } },
    {
      name: "inherited --force",
      argv: ["--force", "restart"],
      expected: { safe: false, force: true },
    },
    { name: "--wait", argv: ["restart", "--wait", "30s"], expected: { safe: false, wait: "30s" } },
    {
      name: "--preserve-definition",
      argv: ["restart", "--preserve-definition"],
      expected: { safe: false, preserveDefinition: true },
    },
    {
      name: "--skip-deferral",
      argv: ["restart", "--skip-deferral"],
      expected: { safe: false, skipDeferral: true },
    },
  ])("restart routing: $name", async ({ platform, env, argv, expected }) => {
    mockProcessPlatform(platform ?? "win32");
    setRestartRouteEnv(env ?? gatewayServiceEnv);
    const gateway = gatewayCommand().enablePositionalOptions();

    await gateway.parseAsync(argv ?? ["restart"], { from: "user" });

    expect(expectSingleDaemonCall(runDaemonRestart)).toMatchObject(expected);
  });

  it("preserves daemon status timeout without inventing an explicit value", async () => {
    const program = new Command().enablePositionalOptions().exitOverride();
    registerDaemonCli(program);
    await program.parseAsync(["daemon", "status", "--timeout", "200"], { from: "user" });
    expect(expectSingleDaemonCall(runDaemonStatus).rpc).toHaveProperty("timeout", "200");
  });

  it("inherits an explicit parent port instead of a status leaf default", async () => {
    const gateway = gatewayCommand().enablePositionalOptions();
    const status = gateway.commands.find((command) => command.name() === "status")!;
    status.setOptionValueWithSource("port", "19003", "default");

    await gateway.parseAsync(["--port", "19002", "status"], { from: "user" });

    expect(expectSingleDaemonCall(runDaemonStatus).rpc).toMatchObject({
      port: "19002",
      localPortOverride: 19002,
    });
  });

  it("routes local runtime intent status without requesting the diagnostic graph", async () => {
    const gateway = gatewayCommand().enablePositionalOptions();
    await gateway.parseAsync(["status", "--runtime-intent-only", "--json"], { from: "user" });
    expect(expectSingleDaemonCall(runDaemonStatus)).toMatchObject({
      runtimeIntentOnly: true,
      json: true,
      deep: false,
    });
  });
});
