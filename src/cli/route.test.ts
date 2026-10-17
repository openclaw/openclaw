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
    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  const route = (args: string[], options?: { machineOutput?: boolean }) =>
    tryRouteCli(["node", "openclaw", ...args], options);
  async function expectOutputRouting(args: string[], stderr: boolean, machineOutput?: boolean) {
    const captured: boolean[] = [];
    runRouteMock.mockImplementationOnce(async () => {
      captured.push(loggingState.forceConsoleToStderr);
      return true;
    });
    await expect(route(args, { machineOutput })).resolves.toBe(true);
    expect(captured).toEqual([stderr]);
  }

  it.each([
    ["status", "--json"],
    ["health"],
    ["channels", "list"],
    ["channels", "status", "--json"],
    ["plugins", "list", "--json"],
    ["gateway", "status", "--json"],
    ["sessions", "--json"],
  ])("dispatches %j without startup config observation or plugin activation", async (...args) => {
    await expect(route(args)).resolves.toBe(true);
    expect(runRouteMock).toHaveBeenCalledOnce();
  });

  it("suppresses config get machine output without running an observing startup guard", async () => {
    await expectOutputRouting(["config", "get", "gateway.port"], true, true);
  });

  it("lets routed gateway health own its config read", async () => {
    await expect(route(["gateway", "health", "--json"])).resolves.toBe(true);
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
    await expect(route(["config", "unset", "gateway.port"])).resolves.toBe(true);
    expect(events).toEqual(["state-owner", "action"]);
  });

  it("propagates state ownership failure before running the mutation", async () => {
    const error = new Error("synthetic state ownership refusal");
    runWithLocalStateOwnerMock.mockRejectedValueOnce(error);

    await expect(route(["config", "unset", "gateway.port"])).rejects.toBe(error);
    expect(runRouteMock).not.toHaveBeenCalled();
  });

  it("routes command-run logs to stderr for config-guard-skipping --json routes", async () => {
    await expectOutputRouting(["models", "status", "--json"], true);
  });

  it("keeps human action output on stdout", async () => {
    await expectOutputRouting(["agents"], false);
    expect(runRouteMock).toHaveBeenCalledOnce();
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("uses the last valid routed log level option", async () => {
    await expect(route(["--log-level", "debug", "status", "--log-level=trace"])).resolves.toBe(
      true,
    );
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

    expect(runRouteMock).not.toHaveBeenCalled();
    expect(process.env.OPENCLAW_LOG_LEVEL).toBeUndefined();
  });

  it("falls back before bootstrap when the route cannot parse the argv", async () => {
    await expect(route(["sessions", "--json", "--unknown"])).resolves.toBe(false);
    expect(runRouteMock).not.toHaveBeenCalled();
  });
});
