// Preaction tests cover CLI preaction hooks and command context setup.
import { Command } from "commander";
import { repoInstallSpec } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loggingState } from "../../logging/state.js";
import { captureEnv } from "../../test-utils/env.js";
import { isConfigSetJsonParseOnly } from "../config-output-mode.js";
import { setCommandJsonMode } from "./json-mode.js";
import {
  registerPreActionCommandFixtures,
  registerNativeExecutorPreActionTests,
} from "./preaction.test-helpers.js";

const DISCORD_REPO_INSTALL_SPEC = repoInstallSpec("discord");

const setVerboseMock = vi.fn();
const emitCliBannerMock = vi.fn();
type EnsureConfigReadyOptions = {
  allowInvalid?: boolean;
  beforeStatePreparation?: () => Promise<boolean>;
  commandPath?: string[];
  requireConfig?: boolean;
};
const ensureConfigReadyMock = vi.fn<(_opts: EnsureConfigReadyOptions) => Promise<void>>(
  async () => {},
);
const ensurePluginRegistryLoadedMock = vi.fn();
const routeLogsToStderrMock = vi.fn();
const prepareGatewayRunBootstrapMock = vi.fn(async () => true);
const recheckGatewayRunBootstrapMock = vi.fn(async () => true);
const reloadTrustedGatewayRunEnvironmentMock = vi.fn(async () => true);

const runtimeMock = {
  log: vi.fn(),
  error: vi.fn(),
  writeStdout: vi.fn(),
  writeJson: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../../globals.js", () => ({
  setVerbose: setVerboseMock,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtimeMock,
}));

vi.mock("../banner.js", () => ({
  emitCliBanner: emitCliBannerMock,
}));

vi.mock("../../logging/console.js", () => ({
  routeLogsToStderr: routeLogsToStderrMock,
}));

vi.mock("./config-guard.js", () => ({
  ensureConfigReady: ensureConfigReadyMock,
}));

vi.mock("../../plugins/runtime/runtime-registry-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/runtime/runtime-registry-loader.js")>()),
  ensurePluginRegistryLoaded: ensurePluginRegistryLoadedMock,
}));

vi.mock("../state-dir-gateway-check.js", () => ({
  checkCliGatewayStateDir: vi.fn(async () => ({ kind: "allow" })),
}));

vi.mock("../gateway-cli/pre-bootstrap.js", () => ({
  prepareGatewayRunBootstrap: prepareGatewayRunBootstrapMock,
  recheckGatewayRunBootstrap: recheckGatewayRunBootstrapMock,
  reloadTrustedGatewayRunEnvironment: reloadTrustedGatewayRunEnvironmentMock,
}));

let registerPreActionHooks: typeof import("./preaction.js").registerPreActionHooks;
let originalProcessArgv: string[];
let originalProcessTitle: string;
let originalProcessTitleDescriptor: PropertyDescriptor | undefined;
let observedProcessTitle: string;
let originalEnv: ReturnType<typeof captureEnv>;
let originalForceStderr: boolean;
let originalEarlyConsoleRoutingRestore: boolean | null;

beforeAll(async () => {
  ({ registerPreActionHooks } = await import("./preaction.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  originalProcessArgv = [...process.argv];
  originalProcessTitle = process.title;
  originalProcessTitleDescriptor = Object.getOwnPropertyDescriptor(process, "title");
  observedProcessTitle = originalProcessTitle;
  originalEnv = captureEnv(["NODE_NO_WARNINGS", "OPENCLAW_HIDE_BANNER"]);
  originalForceStderr = loggingState.forceConsoleToStderr;
  originalEarlyConsoleRoutingRestore = loggingState.earlyConsoleRoutingRestore;
  // Worker-thread Vitest runs do not reliably mutate the real process title,
  // so capture writes at the property boundary instead.
  Object.defineProperty(process, "title", {
    configurable: true,
    enumerable: originalProcessTitleDescriptor?.enumerable ?? true,
    get: () => observedProcessTitle,
    set: (value: string) => {
      observedProcessTitle = value;
    },
  });
  loggingState.forceConsoleToStderr = false;
  loggingState.earlyConsoleRoutingRestore = null;
  delete process.env.NODE_NO_WARNINGS;
  delete process.env.OPENCLAW_HIDE_BANNER;
});

afterEach(() => {
  process.argv = originalProcessArgv;
  if (originalProcessTitleDescriptor && "value" in originalProcessTitleDescriptor) {
    Object.defineProperty(process, "title", {
      ...originalProcessTitleDescriptor,
      value: originalProcessTitle,
    });
  } else if (originalProcessTitleDescriptor) {
    Object.defineProperty(process, "title", originalProcessTitleDescriptor);
  } else {
    process.title = originalProcessTitle;
  }
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
    const config = programLocal.command("config");
    config.option("--section <section>");
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
    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      measure: expect.any(Function),
      commandPath,
      ...options,
    });
  }

  registerNativeExecutorPreActionTests(() => registerPreActionHooks, {
    config: ensureConfigReadyMock,
    plugins: ensurePluginRegistryLoadedMock,
    banner: emitCliBannerMock,
  });

  it("runs gateway pre-bootstrap before full-CLI gateway bootstrap", async () => {
    prepareGatewayRunBootstrapMock.mockResolvedValueOnce(false);
    const gatewayRunCommand = resolveActionCommand(["gateway", "run"]);
    gatewayRunCommand.setOptionValueWithSource("force", true, "cli");
    try {
      await runPreAction(
        ["gateway", "run"],
        [
          "node",
          "openclaw",
          "--log-level",
          "debug",
          "gateway",
          "run",
          "--raw-stream-path",
          "--reset",
          "--force",
        ],
      );
    } finally {
      gatewayRunCommand.setOptionValueWithSource("force", false, "default");
    }

    expect(prepareGatewayRunBootstrapMock).toHaveBeenCalledWith({
      opts: expect.objectContaining({ force: true, reset: false }),
      runtime: runtimeMock,
    });
    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
  });

  it("passes the gateway config recheck to the state migration boundary", async () => {
    await runPreAction(["gateway", "run"]);

    expect(ensureConfigReadyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeStatePreparation: expect.any(Function),
        commandPath: ["gateway", "run"],
        measure: expect.any(Function),
      }),
    );
    const beforeStatePreparation = ensureConfigReadyMock.mock.calls[0]?.[0]?.beforeStatePreparation;
    await beforeStatePreparation?.();
    expect(recheckGatewayRunBootstrapMock).toHaveBeenCalledWith({
      opts: expect.objectContaining({ force: false, reset: false }),
      runtime: runtimeMock,
    });
    expect(reloadTrustedGatewayRunEnvironmentMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
    });
  });

  it("loads plugins for text local agent runs", async () => {
    await runPreAction(["agent"], ["node", "openclaw", "agent", "--local", "--message", "hi"]);
    expectConfig(["agent"]);
    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "all",
    });
  });

  it("keeps setup alias and channels add manifest-first", async () => {
    await runPreAction(["onboard"]);
    expectConfig(["onboard"]);
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await runPreAction(["channels", "add"]);
    expectConfig(["channels", "add"]);
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("skips startup bootstrap for parent default help actions", async () => {
    await runPreAction(["channels"]);

    expect(emitCliBannerMock).not.toHaveBeenCalled();
    expect(setVerboseMock).not.toHaveBeenCalled();
    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("only allows invalid config when the selected install source owns recovery", async () => {
    const scenarios: Array<{ args: string[]; allowInvalid?: true }> = [
      { args: ["npm:@openclaw/discord"], allowInvalid: true },
      { args: ["npm:@openclaw/discord@2026.5.22"], allowInvalid: true },
      { args: ["npm:@openclaw/brave-plugin"], allowInvalid: true },
      { args: ["npm:@openclaw/slack"], allowInvalid: true },
      { args: ["discord"], allowInvalid: true },
      { args: ["brave"], allowInvalid: true },
      { args: ["@openclaw/discord"] },
      { args: ["@openclaw/discord@2026.5.22"] },
      { args: ["@openclaw/brave-plugin"] },
      { args: ["@openclaw/slack"] },
      { args: ["clawhub:@openclaw/discord"] },
      { args: ["clawhub:discord"] },
      { args: ["alpha"] },
      { args: [DISCORD_REPO_INSTALL_SPEC], allowInvalid: true },
      { args: ["@openclaw/discord", "--marketplace", "local/repo"] },
      { args: ["npm:@openclaw/discord", "--marketplace", "local/repo"] },
    ];
    for (const { args, allowInvalid } of scenarios) {
      vi.clearAllMocks();
      await runPreAction(["plugins", "install", ...args]);

      expect(ensureConfigReadyMock, args.join(" ")).toHaveBeenCalledWith({
        runtime: runtimeMock,
        measure: expect.any(Function),
        commandPath: ["plugins", "install"],
        ...(allowInvalid ? { allowInvalid } : {}),
      });
    }
  });

  it("skips help/version preaction and respects banner opt-out", async () => {
    await runPreAction(["status"], ["node", "openclaw", "--version"]);

    expect(emitCliBannerMock).not.toHaveBeenCalled();
    expect(setVerboseMock).not.toHaveBeenCalled();
    expect(ensureConfigReadyMock).not.toHaveBeenCalled();

    vi.clearAllMocks();
    process.env.OPENCLAW_HIDE_BANNER = "1";

    await runPreAction(["status"]);

    expect(emitCliBannerMock).not.toHaveBeenCalled();
    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
  });

  it("bootstraps when Commander consumed --help as a required option value", async () => {
    await parse(["agent", "--message", "--help", "--message", "hello"]);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
  });

  it("does not select JSON output when Commander consumed --json as an option value", async () => {
    await parse(["agent", "", "--message", "--json", "--message", "hello"]);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(routeLogsToStderrMock).not.toHaveBeenCalled();
  });

  it("routes logs to stderr in --json mode so stdout stays clean", async () => {
    await runPreAction(["channels", "send"], ["node", "openclaw", "channels", "send", "--json"]);

    expect(routeLogsToStderrMock).toHaveBeenCalledOnce();

    vi.clearAllMocks();

    // Early argv detection routes literal --json conservatively until Commander metadata resolves.
    loggingState.forceConsoleToStderr = true;
    loggingState.earlyConsoleRoutingRestore = false;
    await runPreAction(["config", "set", "gateway.auth.mode", "local", "--json"]);

    expect(routeLogsToStderrMock).not.toHaveBeenCalled();
    expect(loggingState.forceConsoleToStderr).toBe(false);

    vi.clearAllMocks();

    loggingState.forceConsoleToStderr = true;
    loggingState.earlyConsoleRoutingRestore = false;
    await runPreAction(["config", "set", "gateway.auth.mode", "local", "--dry-run", "--json"]);

    expect(routeLogsToStderrMock).toHaveBeenCalledOnce();
    expect(loggingState.forceConsoleToStderr).toBe(true);

    vi.clearAllMocks();

    // non-json command should not route
    await runPreAction(["agents", "list"]);

    expect(routeLogsToStderrMock).not.toHaveBeenCalled();
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

  describe("infer model run startup", () => {
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
      expect(ensureConfigReadyMock).toHaveBeenCalledOnce();
      const bootstrap = ensureConfigReadyMock.mock.calls[0]?.[0];
      if (validationOnly) {
        expect(bootstrap).toHaveProperty("validateConfigOnly", true);
      } else {
        expect(bootstrap).not.toHaveProperty("validateConfigOnly");
      }
    });
  });

  it("leaves gateway call config loading to the transport past parent option values", async () => {
    await parse(["gateway", "--token", "secret", "call", "health", "--json"]);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("uses the shared skip policy for gateway health on the Commander path", async () => {
    await parse(["gateway", "--port", "19083", "health", "--json"]);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
  });

  it("defers message config preparation until the action selects local or Gateway execution", async () => {
    await parse(["message", "send", "--json"]);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("bypasses config guard for config validate when root option values are present", async () => {
    await runPreAction(
      ["config", "validate"],
      ["node", "openclaw", "--profile", "work", "config", "validate"],
    );

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("routes logs to stderr during plugin loading in --json mode and restores after", async () => {
    let stderrDuringPluginLoad = false;
    ensurePluginRegistryLoadedMock.mockImplementation(() => {
      stderrDuringPluginLoad = loggingState.forceConsoleToStderr;
    });

    await runPreAction(["channels", "send"], ["node", "openclaw", "channels", "send", "--json"]);

    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "configured-channels",
    });
    expect(stderrDuringPluginLoad).toBe(true);
    // Flag must be restored after plugin loading completes
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  beforeAll(() => {
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
