// Route CLI tests cover route command registration, channel routing, and output.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../runtime.js";
import { captureEnv } from "../test-utils/env.js";

const emitCliBannerMock = vi.hoisted(() => vi.fn());
const ensureConfigReadyMock = vi.hoisted(() =>
  vi.fn(async (_params: { runtime?: unknown; commandPath?: unknown }) => {}),
);
const ensurePluginRegistryLoadedMock = vi.hoisted(() => vi.fn());
const runRouteMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock("./banner.js", () => ({
  emitCliBanner: emitCliBannerMock,
}));

vi.mock("./program/config-guard.js", () => ({
  ensureConfigReady: ensureConfigReadyMock,
}));

vi.mock("../plugins/runtime/runtime-registry-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/runtime/runtime-registry-loader.js")>()),
  ensurePluginRegistryLoaded: ensurePluginRegistryLoadedMock,
}));

// Keep route selection and argument parsing real; replace only command side effects.
vi.mock("../commands/status.js", () => ({ statusCommand: runRouteMock }));
vi.mock("../commands/status-json.js", () => ({ statusJsonCommand: runRouteMock }));
vi.mock("../commands/health.js", () => ({ healthCommand: runRouteMock }));
vi.mock("../commands/agents.commands.list.js", () => ({ agentsListCommand: runRouteMock }));
vi.mock("../commands/sessions.js", () => ({ sessionsCommand: runRouteMock }));
vi.mock("../commands/channels/list.js", () => ({ channelsListCommand: runRouteMock }));
vi.mock("../commands/channels/status.js", () => ({ channelsStatusCommand: runRouteMock }));
vi.mock("./plugins-list-command.js", () => ({ runPluginsListCommand: runRouteMock }));
vi.mock("./daemon-cli/status.js", () => ({ runDaemonStatus: runRouteMock }));
vi.mock("./gateway-cli/health-route.js", () => ({ runGatewayHealthJsonRoute: runRouteMock }));
vi.mock("./config-cli.js", () => ({ runConfigGet: runRouteMock, runConfigUnset: runRouteMock }));
vi.mock("../commands/models/list.status-command.js", () => ({ modelsStatusCommand: runRouteMock }));
vi.mock("../commands/models/list.list-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/models/list.list-command.js")>()),
  modelsListCommand: runRouteMock,
}));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: {
    error: vi.fn(),
    log: vi.fn(),
    exit: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
  },
}));

describe("tryRouteCli", () => {
  let tryRouteCli: typeof import("./route.js").tryRouteCli;
  // Capture the same loggingState reference that route.js uses.
  let loggingState: typeof import("../logging/state.js").loggingState;
  let originalEnv: ReturnType<typeof captureEnv>;
  let originalForceStderr: boolean;

  beforeAll(async () => {
    ({ tryRouteCli } = await import("./route.js"));
    ({ loggingState } = await import("../logging/state.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    originalEnv = captureEnv([
      "OPENCLAW_DISABLE_ROUTE_FIRST",
      "OPENCLAW_HIDE_BANNER",
      "OPENCLAW_LOG_LEVEL",
    ]);
    delete process.env.OPENCLAW_DISABLE_ROUTE_FIRST;
    delete process.env.OPENCLAW_HIDE_BANNER;
    delete process.env.OPENCLAW_LOG_LEVEL;
    originalForceStderr = loggingState.forceConsoleToStderr;
    loggingState.forceConsoleToStderr = false;
  });

  afterEach(() => {
    if (loggingState) {
      loggingState.forceConsoleToStderr = originalForceStderr;
    }
    originalEnv.restore();
  });

  it.each([
    {
      command: "health --json --timeout 5000",
      expected: { json: true, verbose: false, timeoutMs: 5000 },
    },
    {
      command: "status --json --deep --all --usage --agent beta --timeout 5000",
      expected: { deep: true, all: true, usage: true, agent: "beta", timeoutMs: 5000 },
    },
    {
      command: "health --timeout nope --timeout 5000",
      expected: { json: false, verbose: false, timeoutMs: 5000 },
    },
    {
      command: "status --timeout 5000",
      expected: {
        json: false,
        deep: false,
        all: false,
        usage: false,
        verbose: false,
        timeoutMs: 5000,
      },
    },
    {
      command: "status --timeout 250",
      expected: {
        json: false,
        deep: false,
        all: false,
        usage: false,
        verbose: false,
        timeoutMs: 250,
      },
    },
    {
      command: "status",
      expected: {
        json: false,
        deep: false,
        all: false,
        usage: false,
        verbose: false,
        timeoutMs: undefined,
      },
    },
    {
      command: "--profile work status --json",
      expected: { deep: false, all: false, usage: false, timeoutMs: undefined },
    },
    {
      command: "--profile work health --timeout=5000 --json",
      expected: { json: true, verbose: false, timeoutMs: 5000 },
    },
    {
      command: "sessions --agent=default --limit=25",
      expected: {
        json: false,
        allAgents: false,
        agent: "default",
        store: undefined,
        active: undefined,
        limit: "25",
      },
    },
    {
      command: "--log-level=debug agents list --json",
      expected: { json: true, bindings: false, tree: false },
      singleArgument: true,
    },
    {
      command: "agents --json --bindings",
      expected: { json: true, bindings: true, tree: false },
      singleArgument: true,
    },
    {
      command:
        "gateway status --url ws://127.0.0.1:18789 --token abc --password def --timeout 5000 --deep --require-rpc --json",
      expected: {
        rpc: { url: "ws://127.0.0.1:18789", token: "abc", password: "def", timeout: "5000" },
        probe: true,
        requireRpc: true,
        deep: true,
        json: true,
      },
      singleArgument: true,
    },
    {
      command:
        "gateway health --url ws://127.0.0.1:18789 --token abc --password def --timeout 5000 --expect-final --json",
      expected: {
        rpc: {
          url: "ws://127.0.0.1:18789",
          token: "abc",
          password: "def",
          timeout: "5000",
          expectFinal: true,
          json: true,
        },
        localPortOverride: undefined,
      },
    },
    {
      command: "gateway --port 19083 health --json",
      expected: {
        rpc: {
          url: undefined,
          token: undefined,
          password: undefined,
          timeout: "10000",
          expectFinal: false,
          json: true,
        },
        localPortOverride: 19083,
      },
    },
    {
      command: "--log-level debug config get update.channel --json",
      expected: { path: "update.channel", json: true },
      singleArgument: true,
    },
    {
      command: "config unset --profile work update.channel",
      expected: {
        path: "update.channel",
        cliOptions: { dryRun: false, allowExec: false, json: false },
        localStateOwner: { method: "config unset", target: "update.channel" },
      },
      singleArgument: true,
    },
    {
      command: "config unset --dry-run --json --allow-exec update.channel",
      expected: {
        path: "update.channel",
        cliOptions: { dryRun: true, allowExec: true, json: true },
        localStateOwner: { method: "config unset", target: "update.channel" },
      },
      singleArgument: true,
    },
    {
      command: "models list --provider openai --all --local --json --plain",
      expected: { provider: "openai", all: true, local: true, json: true, plain: true },
    },
    {
      command:
        "models status --probe-provider openai --probe-timeout 5000 --probe-concurrency 2 --probe-max-tokens 64 --probe-profile fast --probe-profile safe --agent default --json --plain --check --probe",
      expected: {
        probeProvider: "openai",
        probeTimeout: "5000",
        probeConcurrency: "2",
        probeMaxTokens: "64",
        probeProfile: ["fast", "safe"],
        agent: "default",
        json: true,
        plain: true,
        check: true,
        probe: true,
      },
    },
  ])("forwards parsed arguments for $command", async ({ command, expected, singleArgument }) => {
    await expect(tryRouteCli(["node", "openclaw", ...command.split(" ")])).resolves.toBe(true);

    expect(runRouteMock).toHaveBeenCalledExactlyOnceWith(
      ...(singleArgument ? [expected] : [expected, defaultRuntime]),
    );
    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it.each(
    [
      ["status", "--timeout"],
      ["status", "--agent"],
      ...["0", "-5", "nope", "5s"].flatMap((value) => [
        ["status", "--timeout", value],
        ["health", "--timeout", value],
      ]),
      ["status", "--timeout", "5000", "--timeout", "nope"],
      ["--json", "status"],
      ["--json", "health"],
      ["--verbose", "health"],
      ["--timeout=5000", "health"],
      ["--timeout", "5000", "health"],
      ["sessions", "--", "--json"],
      ["agents", "list", "extra"],
      ["config", "unset", "gateway.port", "", "--dry-run"],
      ["gateway", "status", "--ssh", "host"],
      ["gateway", "status", "--ssh-auto"],
      ["gateway", "health"],
      ["gateway", "health", "--url", "ws://127.0.0.1:18789", "--port", "19083", "--json"],
      ["gateway", "health", "--timeout", "5s", "--json"],
      ["config", "get", "--json"],
      ["models", "status", "--probe-profile"],
      ...[
        ["gateway", "status"],
        ["models", "list"],
        ["channels", "list"],
        ["channels", "status"],
      ].map((command) => command.concat("--wat")),
    ].map((args) => ({ args })),
  )("defers malformed routed argv $args without observing startup", async ({ args }) => {
    await expect(tryRouteCli(["node", "openclaw", ...args])).resolves.toBe(false);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
    expect(emitCliBannerMock).not.toHaveBeenCalled();
    expect(runRouteMock).not.toHaveBeenCalled();
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it.each([
    ["status", "--json"],
    ["health"],
    ["channels", "list"],
    ["channels", "status", "--json"],
    ["plugins", "list", "--json"],
    ["gateway", "status", "--json"],
    ["sessions", "--json"],
  ])("dispatches %j without startup config observation or plugin activation", async (...args) => {
    await expect(tryRouteCli(["node", "openclaw", ...args])).resolves.toBe(true);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
    expect(runRouteMock).toHaveBeenCalledOnce();
  });

  it("suppresses config get machine output without running an observing startup guard", async () => {
    const captured: boolean[] = [];
    runRouteMock.mockImplementationOnce(async () => {
      captured.push(loggingState.forceConsoleToStderr);
      return true;
    });

    await expect(
      tryRouteCli(["node", "openclaw", "config", "get", "gateway.port"], {
        machineOutput: true,
      }),
    ).resolves.toBe(true);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(captured).toEqual([true]);
  });

  it("lets routed gateway health own its config read", async () => {
    await expect(tryRouteCli(["node", "openclaw", "gateway", "health", "--json"])).resolves.toBe(
      true,
    );

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("defers routed config mutation preparation to its state owner", async () => {
    await expect(
      tryRouteCli(["node", "openclaw", "config", "unset", "gateway.port"]),
    ).resolves.toBe(true);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
    expect(runRouteMock).toHaveBeenCalledExactlyOnceWith({
      path: "gateway.port",
      cliOptions: { allowExec: false, dryRun: false, json: false },
      localStateOwner: { method: "config unset", target: "gateway.port" },
    });
  });

  it("routes command-run logs to stderr for config-guard-skipping --json routes", async () => {
    const captured: boolean[] = [];
    runRouteMock.mockImplementationOnce(async () => {
      captured.push(loggingState.forceConsoleToStderr);
      return true;
    });

    await expect(tryRouteCli(["node", "openclaw", "models", "status", "--json"])).resolves.toBe(
      true,
    );

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(captured).toEqual([true]);
  });

  it("keeps human action output on stdout", async () => {
    const captured: boolean[] = [];
    runRouteMock.mockImplementationOnce(async () => {
      captured.push(loggingState.forceConsoleToStderr);
      return true;
    });

    await tryRouteCli(["node", "openclaw", "agents"]);

    expect(runRouteMock).toHaveBeenCalledOnce();
    expect(captured[0]).toBe(false);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("uses the last valid routed log level option", async () => {
    await expect(
      tryRouteCli(["node", "openclaw", "--log-level", "debug", "status", "--log-level=trace"]),
    ).resolves.toBe(true);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(runRouteMock).toHaveBeenCalledTimes(1);
    expect(process.env.OPENCLAW_LOG_LEVEL).toBe("trace");
  });

  it.each([
    ["missing value", ["node", "openclaw", "status", "--log-level"]],
    [
      "later invalid value",
      ["node", "openclaw", "--log-level", "debug", "status", "--log-level", "verbose"],
    ],
  ])("falls back for %s routed log level options before bootstrap", async (_name, argv) => {
    await expect(tryRouteCli(argv)).resolves.toBe(false);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
    expect(runRouteMock).not.toHaveBeenCalled();
    expect(process.env.OPENCLAW_LOG_LEVEL).toBeUndefined();
  });

  it("falls back before bootstrap when the route cannot parse the argv", async () => {
    await expect(
      tryRouteCli(["node", "openclaw", "sessions", "--json", "--unknown"]),
    ).resolves.toBe(false);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
    expect(runRouteMock).not.toHaveBeenCalled();
  });
});
