// Route CLI tests cover route command registration, channel routing, and output.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";

const emitCliBannerMock = vi.hoisted(() => vi.fn());
const ensureConfigReadyMock = vi.hoisted(() =>
  vi.fn(async (_params: { runtime?: unknown; commandPath?: unknown }) => {}),
);
const ensurePluginRegistryLoadedMock = vi.hoisted(() => vi.fn());
const runRouteMock = vi.hoisted(() => vi.fn(async () => true));
const runWithLocalStateOwnerMock = vi.hoisted(() =>
  vi.fn(async ({ runLocal }: { runLocal: () => Promise<void> }) => runLocal()),
);

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

// mock-isolation: Process tests cover state ownership; this suite covers startup and dispatch.
vi.mock("./local-state-owner.js", () => ({
  runWithLocalStateOwner: runWithLocalStateOwnerMock,
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

vi.mock("../runtime.js", () => ({
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
    const events: string[] = [];
    runWithLocalStateOwnerMock.mockImplementationOnce(async ({ runLocal }) => {
      events.push("state-owner");
      await runLocal();
    });
    runRouteMock.mockImplementationOnce(async () => {
      events.push("action");
      return true;
    });
    await expect(
      tryRouteCli(["node", "openclaw", "config", "unset", "gateway.port"]),
    ).resolves.toBe(true);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
    expect(events).toEqual(["state-owner", "action"]);
  });

  it("propagates state ownership failure before running the mutation", async () => {
    const error = new Error("synthetic state ownership refusal");
    runWithLocalStateOwnerMock.mockRejectedValueOnce(error);

    await expect(tryRouteCli(["node", "openclaw", "config", "unset", "gateway.port"])).rejects.toBe(
      error,
    );

    expect(runRouteMock).not.toHaveBeenCalled();
    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
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
