// Register service command tests cover daemon service subcommand registration.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isVerbose, setVerbose } from "../../globals.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { withConsoleLogsRoutedToStderrForJson } from "../json-output-mode.js";
import { ensureConfigReady } from "../program/config-guard.js";
import { registerPreActionHooks } from "../program/preaction.js";
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

function createGatewayParentLikeCommand(program?: Command) {
  const gateway = program ? program.command("gateway") : new Command().name("gateway");
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
  const opts = mockFn.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  if (opts === undefined) {
    throw new Error("expected daemon call options");
  }
  return opts;
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

describe("addGatewayServiceCommands", () => {
  let restartRouteEnvSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    restartRouteEnvSnapshot = captureEnv(RESTART_ROUTE_ENV_KEYS);
    setRestartRouteEnv({});
    runDaemonInstall.mockClear();
    runDaemonRestart.mockClear();
    runDaemonStart.mockClear();
    runDaemonStatus.mockClear();
    runDaemonStop.mockClear();
    runDaemonUninstall.mockClear();
    vi.mocked(ensureConfigReady).mockClear();
  });

  afterEach(() => {
    restartRouteEnvSnapshot.restore();
    vi.restoreAllMocks();
  });

  it.each([{ parent: "daemon", option: "--restore-service-cli" }])(
    "defers $parent install startup until $option is checked",
    async ({ parent, option }) => {
      const program = new Command().name("openclaw");
      addGatewayServiceCommands(program.command(parent));
      registerPreActionHooks(program, "9.9.9-test");
      const previousArgv = process.argv;
      const previousTitle = process.title;
      const previousVerbose = isVerbose();
      const startupEnv = captureEnv(["NODE_NO_WARNINGS"]);
      process.argv = [
        "node",
        "openclaw",
        parent,
        "install",
        "--json",
        option,
        JSON.stringify({ revision: "observed-pin", definition: null }),
      ];
      try {
        await withConsoleLogsRoutedToStderrForJson(
          process.argv,
          () => program.parseAsync(process.argv),
          { restoreChanges: true },
        );
      } finally {
        process.argv = previousArgv;
        process.title = previousTitle;
        setVerbose(previousVerbose);
        startupEnv.restore();
      }
      expect(ensureConfigReady).not.toHaveBeenCalled();
      expect(runDaemonInstall).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { parent: "gateway", action: "install" },
    { parent: "daemon", action: "stop" },
  ])(
    "probes $parent $action update custody without startup mutation or invoking the action",
    async ({ parent, action }) => {
      const program = new Command().name("openclaw").enablePositionalOptions();
      addGatewayServiceCommands(program.command(parent));
      registerPreActionHooks(program, "9.9.9-test");
      const previousArgv = process.argv;
      const previousTitle = process.title;
      const previousVerbose = isVerbose();
      const startupEnv = captureEnv(["NODE_NO_WARNINGS"]);
      process.argv = ["node", "openclaw", parent, action, "--update-executor", "check"];
      const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      try {
        await withConsoleLogsRoutedToStderrForJson(
          process.argv,
          () => program.parseAsync(process.argv),
          { restoreChanges: true },
        );
      } finally {
        process.argv = previousArgv;
        process.title = previousTitle;
        setVerbose(previousVerbose);
        startupEnv.restore();
      }
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
    {
      name: "uses safe restart for a plain Windows Gateway service restart",
      platform: "win32" as const,
      env: gatewayServiceEnv,
      argv: ["restart", "--json"],
      expected: { safe: true, json: true },
    },
    {
      name: "keeps a plain restart non-safe outside a service process",
      platform: "win32" as const,
      env: {},
      argv: ["restart"],
      expected: { safe: false },
    },
    {
      name: "keeps a plain restart non-safe inside a node service",
      platform: "win32" as const,
      env: { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "node" },
      argv: ["restart"],
      expected: { safe: false },
    },
    {
      name: "keeps a plain Gateway service restart non-safe outside Windows",
      platform: "linux" as const,
      env: gatewayServiceEnv,
      argv: ["restart"],
      expected: { safe: false },
    },
    {
      name: "honors normalized external supervisor mode before routing",
      platform: "win32" as const,
      env: { ...gatewayServiceEnv, OPENCLAW_SUPERVISOR_MODE: "  ExTeRnAl  " },
      argv: ["restart"],
      expected: { safe: false },
    },
    {
      name: "preserves explicit safe restart under external supervision",
      platform: "win32" as const,
      env: { ...gatewayServiceEnv, OPENCLAW_SUPERVISOR_MODE: "external" },
      argv: ["restart", "--safe"],
      expected: { safe: true },
    },
    {
      name: "preserves leaf force instead of adding implicit safe mode",
      platform: "win32" as const,
      env: gatewayServiceEnv,
      argv: ["restart", "--force"],
      expected: { safe: false, force: true },
    },
    {
      name: "preserves inherited force instead of adding implicit safe mode",
      platform: "win32" as const,
      env: gatewayServiceEnv,
      argv: ["--force", "restart"],
      expected: { safe: false, force: true },
    },
    {
      name: "preserves wait instead of adding implicit safe mode",
      platform: "win32" as const,
      env: gatewayServiceEnv,
      argv: ["restart", "--wait", "30s"],
      expected: { safe: false, wait: "30s" },
    },
    {
      name: "preserves definition control instead of adding implicit safe mode",
      platform: "win32" as const,
      env: gatewayServiceEnv,
      argv: ["restart", "--preserve-definition"],
      expected: { safe: false, preserveDefinition: true },
    },
    {
      name: "preserves skip-deferral validation instead of adding implicit safe mode",
      platform: "win32" as const,
      env: gatewayServiceEnv,
      argv: ["restart", "--skip-deferral"],
      expected: { safe: false, skipDeferral: true },
    },
  ])("$name", async ({ platform, env, argv, expected }) => {
    mockProcessPlatform(platform);
    setRestartRouteEnv(env);
    const gateway = createGatewayParentLikeCommand().enablePositionalOptions();

    await gateway.parseAsync(argv, { from: "user" });

    expect(expectSingleDaemonCall(runDaemonRestart)).toMatchObject(expected);
  });

  it.each([{ name: "daemon", timeout: "200" }])(
    "preserves $name status timeout $timeout without inventing an explicit value",
    async ({ name, timeout }) => {
      const program = new Command().enablePositionalOptions().exitOverride();
      if (name === "daemon") {
        registerDaemonCli(program);
      } else {
        createGatewayParentLikeCommand(program);
      }

      await program.parseAsync(
        [name, "status", ...(timeout === undefined ? [] : ["--timeout", timeout])],
        { from: "user" },
      );

      expect(expectSingleDaemonCall(runDaemonStatus).rpc).toHaveProperty("timeout", timeout);
    },
  );

  it("inherits an explicit parent port instead of a status leaf default", async () => {
    const gateway = createGatewayParentLikeCommand().enablePositionalOptions();
    const status = gateway.commands.find((command) => command.name() === "status")!;
    status.setOptionValueWithSource("port", "19003", "default");

    await gateway.parseAsync(["--port", "19002", "status"], { from: "user" });

    expect(expectSingleDaemonCall(runDaemonStatus).rpc).toMatchObject({
      port: "19002",
      localPortOverride: 19002,
    });
  });
});
