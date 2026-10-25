import { Command } from "commander";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loggingState } from "../../logging/state.js";
import { captureEnv } from "../../test-utils/env.js";
import { createNonExitingRuntimeEnv } from "../../test-utils/plugin-runtime-env.js";
import { isConfigSetJsonParseOnly } from "../config-output-mode.js";
import { setCommandJsonMode } from "./json-mode.js";
import {
  registerPreActionCommandFixtures,
  registerNativeExecutorPreActionTests,
} from "./preaction.test-helpers.js";
import { expectNoCalls } from "./program.test-helpers.js";

const setVerboseMock = vi.fn();
const emitCliBannerMock = vi.fn();
const configReadyMock = vi.fn<typeof import("./config-guard.js").ensureConfigReady>(async () => {});
const loadPluginsMock = vi.fn();
const routeLogsToStderrMock = vi.fn();
const prepareGatewayMock = vi.fn(async () => true);
const recheckGatewayMock = vi.fn(async () => true);
const reloadGatewayEnvMock = vi.fn(async () => true);

const runtimeMock = vi.mocked(createNonExitingRuntimeEnv());

// mock-isolation: Capture startup effects without changing process-wide logging or terminal output.
vi.mock("../../globals.js", () => ({ setVerbose: setVerboseMock }));
// mock-isolation: Capture startup effects without changing process-wide logging or terminal output.
vi.mock("../../runtime.js", () => ({ defaultRuntime: runtimeMock }));
// mock-isolation: Capture startup effects without changing process-wide logging or terminal output.
vi.mock("../banner.js", () => ({ emitCliBanner: emitCliBannerMock }));
// mock-isolation: Capture startup effects without changing process-wide logging or terminal output.
vi.mock("../../logging/console.js", () => ({ routeLogsToStderr: routeLogsToStderrMock }));
// mock-isolation: Control config readiness while testing preaction ordering.
vi.mock("./config-guard.js", () => ({ ensureConfigReady: configReadyMock }));

vi.mock("../../plugins/runtime/runtime-registry-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/runtime/runtime-registry-loader.js")>()),
  ensurePluginRegistryLoaded: loadPluginsMock,
}));

vi.mock("../state-dir-gateway-check.js", () => ({
  checkCliGatewayStateDir: vi.fn(async () => ({ kind: "allow" })),
}));

// mock-isolation: Observe bootstrap ordering without selecting live Gateway state.
vi.mock("../gateway-cli/pre-bootstrap.js", () => ({
  prepareGatewayRunBootstrap: prepareGatewayMock,
  recheckGatewayRunBootstrap: recheckGatewayMock,
  reloadTrustedGatewayRunEnvironment: reloadGatewayEnvMock,
}));

let registerPreActionHooks: typeof import("./preaction.js").registerPreActionHooks;
let originalProcessArgv: string[];
let originalProcessTitle: string;
let originalEnv: ReturnType<typeof captureEnv>;
let originalForceStderr: boolean;
let originalEarlyConsoleRoutingRestore: boolean | null;

beforeEach(() => {
  vi.clearAllMocks();
  originalProcessArgv = [...process.argv];
  originalProcessTitle = process.title;
  originalEnv = captureEnv(["NODE_NO_WARNINGS", "OPENCLAW_HIDE_BANNER"]);
  originalForceStderr = loggingState.forceConsoleToStderr;
  originalEarlyConsoleRoutingRestore = loggingState.earlyConsoleRoutingRestore;
  loggingState.forceConsoleToStderr = false;
  loggingState.earlyConsoleRoutingRestore = null;
  delete process.env.NODE_NO_WARNINGS;
  delete process.env.OPENCLAW_HIDE_BANNER;
});

afterEach(() => {
  process.argv = originalProcessArgv;
  process.title = originalProcessTitle;
  loggingState.forceConsoleToStderr = originalForceStderr;
  loggingState.earlyConsoleRoutingRestore = originalEarlyConsoleRoutingRestore;
  originalEnv.restore();
});

describe("registerPreActionHooks", () => {
  let program: Command;
  let preActionHook: Parameters<Command["hook"]>[1] | null = null;

  function buildProgram() {
    const programLocal = new Command().name("openclaw").enablePositionalOptions();
    registerPreActionCommandFixtures(programLocal);
    const config = programLocal.command("config").option("--section <section>");
    setCommandJsonMode(config.command("set"), "parse-only", ({ argv }) =>
      isConfigSetJsonParseOnly(argv),
    )
      .argument("<path>")
      .argument("<value>")
      .option("--json")
      .action(() => {});
    config
      .command("validate")
      .option("--json")
      .action(() => {});
    registerPreActionHooks(programLocal, "9.9.9-test");
    return programLocal;
  }

  function resolveActionCommand(parseArgv: string[]): Command {
    let current = program;
    for (const segment of parseArgv) {
      const next = current.commands.find((command) => command.name() === segment);
      if (!next) {
        break;
      }
      current = next;
    }
    return current;
  }

  async function runPreAction(parseArgv: string[], processArgv?: string[]) {
    process.argv = processArgv ?? ["node", "openclaw", ...parseArgv];
    const actionCommand = resolveActionCommand(parseArgv);
    if (!preActionHook) {
      throw new Error("missing preAction hook");
    }
    await preActionHook(program, actionCommand);
  }

  async function parse(args: string[]) {
    const parser = buildProgram();
    process.argv = ["node", "openclaw", ...args];
    await parser.parseAsync(process.argv);
  }

  function expectConfig(commandPath: string[], options = {}) {
    expect(configReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      measure: expect.any(Function),
      commandPath,
      ...options,
    });
  }

  registerNativeExecutorPreActionTests(() => registerPreActionHooks, {
    config: configReadyMock,
    plugins: loadPluginsMock,
    banner: emitCliBannerMock,
  });

  it("runs gateway pre-bootstrap before full-CLI gateway bootstrap", async () => {
    prepareGatewayMock.mockResolvedValueOnce(false);
    const gatewayRunCommand = resolveActionCommand(["gateway", "run"]);
    gatewayRunCommand.setOptionValueWithSource("force", true, "cli");
    try {
      await runPreAction(
        ["gateway", "run"],
        "node openclaw --log-level debug gateway run --raw-stream-path --reset --force".split(" "),
      );
    } finally {
      gatewayRunCommand.setOptionValueWithSource("force", false, "default");
    }

    expect(prepareGatewayMock).toHaveBeenCalledWith({
      opts: expect.objectContaining({ force: true, reset: false }),
      runtime: runtimeMock,
    });
    expect(configReadyMock).not.toHaveBeenCalled();
  });

  it("passes the gateway config recheck to the state migration boundary", async () => {
    await runPreAction(["gateway", "run"]);

    expect(configReadyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeStatePreparation: expect.any(Function),
        commandPath: ["gateway", "run"],
        measure: expect.any(Function),
      }),
    );
    const beforeStatePreparation = configReadyMock.mock.calls[0]?.[0]?.beforeStatePreparation;
    await beforeStatePreparation?.();
    expect(recheckGatewayMock).toHaveBeenCalledWith({
      opts: expect.objectContaining({ force: false, reset: false }),
      runtime: runtimeMock,
    });
    expect(reloadGatewayEnvMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
    });
  });

  it("loads plugins for text local agent runs", async () => {
    await runPreAction(["agent"], ["node", "openclaw", "agent", "--local", "--message", "hi"]);
    expectConfig(["agent"]);
    expect(loadPluginsMock).toHaveBeenCalledWith({ scope: "all" });
  });

  it.each([["onboard"], ["channels", "add"]])("keeps %j manifest-first", async (...commandPath) => {
    await runPreAction(commandPath);
    expectConfig(commandPath);
    expectNoCalls(loadPluginsMock);
  });

  it("skips startup bootstrap for parent default help actions", async () => {
    await runPreAction(["channels"]);

    expectNoCalls(emitCliBannerMock, setVerboseMock, configReadyMock, loadPluginsMock);
  });

  it("skips help/version preaction and respects banner opt-out", async () => {
    await runPreAction(["status"], ["node", "openclaw", "--version"]);

    expectNoCalls(emitCliBannerMock, setVerboseMock, configReadyMock);

    vi.clearAllMocks();
    process.env.OPENCLAW_HIDE_BANNER = "1";

    await runPreAction(["status"]);

    expectNoCalls(emitCliBannerMock, configReadyMock);
  });

  it("bootstraps when Commander consumed --help as a required option value", async () => {
    await parse(["agent", "--message", "--help", "--message", "hello"]);

    expect(configReadyMock).not.toHaveBeenCalled();
  });

  it("does not select JSON output when Commander consumed --json as an option value", async () => {
    await parse(["agent", "", "--message", "--json", "--message", "hello"]);

    expectNoCalls(configReadyMock, routeLogsToStderrMock);
  });

  it.each([
    ["channels send --json", false, 1, undefined],
    ["config set gateway.auth.mode local --json", true, 0, false],
    ["config set gateway.auth.mode local --dry-run --json", true, 1, true],
    ["agents list", true, 0, undefined],
  ] as const)("resolves early JSON log routing for %s", async (args, early, calls, forced) => {
    if (early) {
      loggingState.forceConsoleToStderr = true;
      loggingState.earlyConsoleRoutingRestore = false;
    }
    await runPreAction(args.split(" "));
    expect(routeLogsToStderrMock).toHaveBeenCalledTimes(calls);
    if (forced !== undefined) {
      expect(loggingState.forceConsoleToStderr).toBe(forced);
    }
  });

  it("keeps plain model output clean throughout Commander startup", async () => {
    loggingState.forceConsoleToStderr = true;
    loggingState.earlyConsoleRoutingRestore = false;

    await runPreAction(
      ["models", "aliases", "list"],
      ["node", "openclaw", "models", "aliases", "list", "--plain"],
    );

    expect(loggingState.forceConsoleToStderr).toBe(true);
    expect(routeLogsToStderrMock).toHaveBeenCalledOnce();
    expect(emitCliBannerMock).not.toHaveBeenCalled();
    expectConfig(["models", "aliases", "list"], { suppressDoctorStdout: true });
  });

  it.each([
    { args: ["--prompt=--local", "--gateway"], validationOnly: true },
    { args: ["--prompt", "hello", "--local"], validationOnly: false },
  ])("uses parsed transport for $args", async ({ args, validationOnly }) => {
    const parseProgram = new Command().name("openclaw").enablePositionalOptions();
    const action = vi.fn();
    parseProgram
      .command("infer")
      .command("model")
      .command("run")
      .requiredOption("--prompt <text>")
      .option("--local", "Force local execution", false)
      .option("--gateway", "Force Gateway execution", false)
      .action(action);
    registerPreActionHooks(parseProgram, "9.9.9-test");
    process.argv = ["node", "openclaw", "infer", "model", "run", ...args];

    await parseProgram.parseAsync(process.argv);

    expect(action).toHaveBeenCalledOnce();
    expect(configReadyMock).toHaveBeenCalledOnce();
    const bootstrap = configReadyMock.mock.calls[0]?.[0];
    if (validationOnly) {
      expect(bootstrap).toHaveProperty("validateConfigOnly", true);
    } else {
      expect(bootstrap).not.toHaveProperty("validateConfigOnly");
    }
  });
  it.each([
    ["gateway --token secret call health --json", true],
    ["gateway --port 19083 health --json", false],
    ["message send --json", true],
  ] as const)("defers config preparation for %s", async (args, skipsPlugins) => {
    await parse(args.split(" "));
    expectNoCalls(configReadyMock);
    if (skipsPlugins) {
      expectNoCalls(loadPluginsMock);
    }
  });

  it("bypasses config guard for config validate when root option values are present", async () => {
    await runPreAction(
      ["config", "validate"],
      ["node", "openclaw", "--profile", "work", "config", "validate"],
    );

    expectNoCalls(configReadyMock, loadPluginsMock);
  });

  it("routes logs to stderr during plugin loading in --json mode and restores after", async () => {
    let stderrDuringPluginLoad = false;
    loadPluginsMock.mockImplementation(() => {
      stderrDuringPluginLoad = loggingState.forceConsoleToStderr;
    });

    await runPreAction(["channels", "send"], ["node", "openclaw", "channels", "send", "--json"]);

    expect(loadPluginsMock).toHaveBeenCalledWith({
      scope: "configured-channels",
    });
    expect(stderrDuringPluginLoad).toBe(true);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  beforeAll(async () => {
    ({ registerPreActionHooks } = await import("./preaction.js"));
    program = buildProgram();
    const hooks = (
      program as unknown as {
        _lifeCycleHooks?: {
          preAction?: Array<(thisCommand: Command, actionCommand: Command) => Promise<void> | void>;
        };
      }
    )["_lifeCycleHooks"]?.preAction;
    preActionHook = hooks?.[0] ?? null;
  });
});
