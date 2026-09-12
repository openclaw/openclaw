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

  it.each(
    ["gateway", "daemon"].flatMap((parent) =>
      ["install", "restart", "stop"].map((action) => ({ parent, action })),
    ),
  )(
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
          retainedOwnerBinding: true,
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
      name: "forwards install option collisions from parent gateway command",
      argv: ["install", "--force", "--port", "19000", "--token", "tok_test", "--runtime", "bun"],
      assert: () => {
        const opts = expectSingleDaemonCall(runDaemonInstall);
        expect(opts.force).toBe(true);
        expect(opts.port).toBe("19000");
        expect(opts.token).toBe("tok_test");
        expect(opts.runtime).toBe("bun");
      },
    },
    {
      name: "preserves an omitted service start-mode override during updater reinstall",
      argv: ["install", "--force", "--json"],
      assert: () => {
        expect(expectSingleDaemonCall(runDaemonInstall)).toMatchObject({
          force: true,
          json: true,
          allowUnconfigured: undefined,
        });
      },
    },
    {
      name: "forwards an explicit service start-mode override",
      argv: ["install", "--allow-unconfigured"],
      assert: () => {
        expect(expectSingleDaemonCall(runDaemonInstall).allowUnconfigured).toBe(true);
      },
    },
    {
      name: "inherits the parent service start-mode override",
      argv: ["--allow-unconfigured", "install"],
      assert: () => {
        expect(expectSingleDaemonCall(runDaemonInstall).allowUnconfigured).toBe(true);
      },
    },
    {
      name: "forwards restart force and wait controls",
      argv: ["restart", "--wait", "30s"],
      assert: () => {
        const opts = expectSingleDaemonCall(runDaemonRestart);
        expect(opts.wait).toBe("30s");
      },
    },
    {
      name: "forwards restart safe control",
      argv: ["restart", "--safe"],
      assert: () => {
        const opts = expectSingleDaemonCall(runDaemonRestart);
        expect(opts.safe).toBe(true);
      },
    },
    {
      name: "forwards restart force control",
      argv: ["restart", "--force"],
      assert: () => {
        const opts = expectSingleDaemonCall(runDaemonRestart);
        expect(opts.force).toBe(true);
      },
    },
    {
      name: "forwards stop force control",
      argv: ["stop", "--force"],
      assert: () => {
        const opts = expectSingleDaemonCall(runDaemonStop);
        expect(opts.force).toBe(true);
      },
    },
    {
      name: "forwards status auth collisions from parent gateway command",
      argv: ["status", "--token", "tok_status", "--password", "pw_status"],
      assert: () => {
        const opts = expectSingleDaemonCall(runDaemonStatus);
        const rpc = opts.rpc as { token?: unknown; password?: unknown } | undefined;
        expect(rpc?.token).toBe("tok_status");
        expect(rpc?.password).toBe("pw_status"); // pragma: allowlist secret
      },
    },
    {
      name: "forwards require-rpc for status",
      argv: ["status", "--require-rpc"],
      assert: () => {
        const opts = expectSingleDaemonCall(runDaemonStatus);
        expect(opts.requireRpc).toBe(true);
      },
    },
  ])("$name", async ({ argv, assert }) => {
    const gateway = createGatewayParentLikeCommand();
    await gateway.parseAsync(argv, { from: "user" });
    assert();
  });

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
      name: "keeps an externally supervised plain restart non-safe",
      platform: "win32" as const,
      env: { ...gatewayServiceEnv, OPENCLAW_SUPERVISOR_MODE: "external" },
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

  it.each(["gateway", "daemon"])("parses preservation only on %s restart", async (name) => {
    const program = new Command()
      .enablePositionalOptions()
      .exitOverride()
      .configureOutput({ writeErr: () => {} });
    if (name === "daemon") {
      registerDaemonCli(program);
    } else {
      createGatewayParentLikeCommand(program);
    }
    await program.parseAsync([name, "restart", "--preserve-definition", "--json"], {
      from: "user",
    });
    expect(expectSingleDaemonCall(runDaemonRestart)).toMatchObject({
      preserveDefinition: true,
      json: true,
    });
    for (const verb of ["install", "start", "stop", "uninstall"]) {
      await expect(
        program.parseAsync([name, verb, "--preserve-definition"], { from: "user" }),
      ).rejects.toMatchObject({ code: "commander.unknownOption" });
    }
    expect(runDaemonInstall).not.toHaveBeenCalled();
    expect(runDaemonStart).not.toHaveBeenCalled();
    expect(runDaemonStop).not.toHaveBeenCalled();
    expect(runDaemonUninstall).not.toHaveBeenCalled();
  });

  it.each(
    [
      { leaf: "status", runner: runDaemonStatus },
      { leaf: "install", runner: runDaemonInstall },
      { leaf: "uninstall", runner: runDaemonUninstall },
      { leaf: "start", runner: runDaemonStart },
      { leaf: "stop", runner: runDaemonStop },
      { leaf: "restart", runner: runDaemonRestart },
    ].flatMap(({ leaf, runner }) => [
      { name: `daemon --json ${leaf}`, argv: ["daemon", "--json", leaf], runner },
      { name: `daemon ${leaf} --json`, argv: ["daemon", leaf, "--json"], runner },
    ]),
  )("forwards JSON mode for $name", async ({ argv, runner }) => {
    const program = new Command().enablePositionalOptions().exitOverride();
    registerDaemonCli(program);

    await program.parseAsync(argv, { from: "user" });

    expect(expectSingleDaemonCall(runner).json).toBe(true);
  });

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

  it.each([
    { argv: ["status", "--port", "0"], error: "--port must be an integer between 1 and 65535." },
    {
      argv: ["--port", "19002", "status", "--url", "ws://localhost:19002"],
      error: "Use either --url or --port, not both.",
    },
  ])("rejects invalid status options $argv", async ({ argv, error }) => {
    const gateway = createGatewayParentLikeCommand().enablePositionalOptions().exitOverride();

    await expect(gateway.parseAsync(argv, { from: "user" })).rejects.toThrow(error);
    expect(runDaemonStatus).not.toHaveBeenCalled();
  });
});
