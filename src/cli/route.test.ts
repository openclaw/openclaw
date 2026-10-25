import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../runtime.js";
import { captureEnv } from "../test-utils/env.js";

const emitCliBannerMock = vi.hoisted(() => vi.fn());
const ensureConfigReadyMock = vi.hoisted(() =>
  vi.fn(async (_params: { runtime?: unknown; commandPath?: unknown }) => {}),
);
const ensurePluginRegistryLoadedMock = vi.hoisted(() => vi.fn());
const runRouteMock = vi.hoisted(() => vi.fn(async () => true));
const statusDefaults = { json: false, deep: false, all: false, usage: false, verbose: false };
const healthDefaults = {
  url: undefined,
  token: undefined,
  password: undefined,
  timeout: "10000",
  expectFinal: false,
  json: true,
};
const unsetArgs = (enabled: boolean) => ({
  path: "update.channel",
  cliOptions: { dryRun: enabled, allowExec: enabled, json: enabled },
  localStateOwner: { method: "config unset", target: "update.channel" },
});

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
  defaultRuntime: (
    await import("../test-utils/plugin-runtime-env.js")
  ).createNonExitingRuntimeEnv(),
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

  it("falls back before bootstrap when the route cannot parse the argv", async () => {
    await expect(
      tryRouteCli(["node", "openclaw", "sessions", "--json", "--unknown"]),
    ).resolves.toBe(false);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
    expect(runRouteMock).not.toHaveBeenCalled();
  });

  it.each<[string, object, boolean?]>([
    ["health --json --timeout 5000", { json: true, verbose: false, timeoutMs: 5000 }],
    [
      "status --json --deep --all --usage --agent beta --timeout 5000",
      { deep: true, all: true, usage: true, agent: "beta", timeoutMs: 5000 },
    ],
    ["health --timeout nope --timeout 5000", { json: false, verbose: false, timeoutMs: 5000 }],
    ["status --timeout 5000", { ...statusDefaults, timeoutMs: 5000 }],
    ["status --timeout 250", { ...statusDefaults, timeoutMs: 250 }],
    ["status", { ...statusDefaults, timeoutMs: undefined }],
    [
      "--profile work status --json",
      { deep: false, all: false, usage: false, timeoutMs: undefined },
    ],
    [
      "--profile work health --timeout=5000 --json",
      { json: true, verbose: false, timeoutMs: 5000 },
    ],
    [
      "sessions --agent=default --limit=25",
      {
        json: false,
        allAgents: false,
        agent: "default",
        store: undefined,
        active: undefined,
        limit: "25",
      },
    ],
    ["--log-level=debug agents list --json", { json: true, bindings: false, tree: false }, true],
    ["agents --json --bindings", { json: true, bindings: true, tree: false }, true],
    ["channels list", { json: false, all: false }],
    [
      "channels status --json",
      { channel: undefined, json: true, probe: false, timeout: undefined },
    ],
    ["plugins list --json", { json: true, enabled: false, verbose: false }],
    [
      "gateway status --url ws://127.0.0.1:18789 --token abc --password def --timeout 5000 --deep --require-rpc --json",
      {
        rpc: { url: "ws://127.0.0.1:18789", token: "abc", password: "def", timeout: "5000" },
        probe: true,
        requireRpc: true,
        deep: true,
        json: true,
      },
      true,
    ],
    [
      "gateway health --url ws://127.0.0.1:18789 --token abc --password def --timeout 5000 --expect-final --json",
      {
        rpc: {
          ...healthDefaults,
          url: "ws://127.0.0.1:18789",
          token: "abc",
          password: "def",
          timeout: "5000",
          expectFinal: true,
        },
        localPortOverride: undefined,
      },
    ],
    [
      "gateway --port 19083 health --json",
      {
        rpc: healthDefaults,
        localPortOverride: 19083,
      },
    ],
    [
      "--log-level debug config get update.channel --json",
      { path: "update.channel", json: true },
      true,
    ],
    ["config unset --profile work update.channel", unsetArgs(false), true],
    ["config unset --dry-run --json --allow-exec update.channel", unsetArgs(true), true],
    [
      "models list --provider openai --all --local --json --plain",
      { provider: "openai", all: true, local: true, json: true, plain: true },
    ],
    [
      "models status --probe-provider openai --probe-timeout 5000 --probe-concurrency 2 --probe-max-tokens 64 --probe-profile fast --probe-profile safe --agent default --json --plain --check --probe",
      {
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
    ],
  ])("forwards parsed arguments for %s", async (command, expected, singleArgument) => {
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
    ["config get gateway.port", true, true],
    ["models status --json", false, true],
    ["agents", false, false],
  ] as const)(
    "selects output stream for %s (machine=%s)",
    async (command, machineOutput, stderr) => {
      const captured: boolean[] = [];
      runRouteMock.mockImplementationOnce(async () => {
        captured.push(loggingState.forceConsoleToStderr);
        return true;
      });

      await expect(
        tryRouteCli(["node", "openclaw", ...command.split(" ")], { machineOutput }),
      ).resolves.toBe(true);
      expect(ensureConfigReadyMock).not.toHaveBeenCalled();
      expect(runRouteMock).toHaveBeenCalledOnce();
      expect(captured).toEqual([stderr]);
      if (!stderr) {
        expect(loggingState.forceConsoleToStderr).toBe(false);
      }
    },
  );

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
});
