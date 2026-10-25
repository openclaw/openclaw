import "../../test-utils/prepare-compiled-subprocesses.js";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import { registerGatewayCli } from "./register.js";
import { expectCallCount } from "./run-loop-cleanup.test-support.js";

const mocks = vi.hoisted(() => ({
  callGatewayCli: vi.fn(
    async (method: string, _opts: unknown, _params?: unknown): Promise<unknown> => {
      if (method === "gateway.suspend.prepare") {
        return {
          status: "ready",
          suspensionId: "suspension-1",
          expiresAtMs: 1_800_000_000_000,
          activeCount: 0,
          blockers: [],
        };
      }
      if (method === "gateway.suspend.resume") {
        return { ok: true, status: "running", resumed: true };
      }
      return { ok: true };
    },
  ),
  emitReachableGatewayAuthDiagnostic: vi.fn(async (_params: unknown) => false),
  formatHealthChannelLines: vi.fn(() => []),
  gatewayStatusCommand: vi.fn(async (_opts: unknown, _runtime: unknown) => {}),
  gatewayAuthTokenCommand: vi.fn(async (_runtime: unknown) => {}),
  consumeGatewayRestartHandoffSync: vi.fn(),
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../../infra/restart-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/restart-handoff.js")>()),
  consumeGatewayRestartHandoffSync: mocks.consumeGatewayRestartHandoffSync,
}));

const { callGatewayCli, emitReachableGatewayAuthDiagnostic, gatewayStatusCommand, defaultRuntime } =
  mocks;

vi.mock("../cli-utils.js", () => ({
  runCommandWithRuntime: async (
    _runtime: unknown,
    action: () => Promise<void>,
    onError: (err: unknown) => void,
  ) => {
    try {
      await action();
    } catch (err) {
      onError(err);
    }
  },
}));

vi.mock("../../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../../runtime.js")>("../../runtime.js")),
  defaultRuntime: mocks.defaultRuntime,
}));

// mock-isolation: Capture status options without probing a live Gateway.
vi.mock("../../commands/gateway-status.js", () => ({
  gatewayStatusCommand: mocks.gatewayStatusCommand,
}));
// mock-isolation: Capture token-reveal routing without reading credentials.
vi.mock("../../commands/gateway-auth-token.js", () => ({
  gatewayAuthTokenCommand: mocks.gatewayAuthTokenCommand,
}));

vi.mock("../gateway-rpc.js", async () => ({
  ...(await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js")),
  callGatewayFromCliWithTransport: mocks.callGatewayCli,
}));

vi.mock("./run-command.js", () => ({
  addGatewayRunCommand: (cmd: Command) =>
    cmd
      .option("--port <port>", "Port for the gateway WebSocket")
      .option("--token <token>", "Gateway token")
      .option("--password <password>", "Gateway password"),
}));

vi.mock("../daemon-cli/register-service-commands.js", () => ({
  addGatewayServiceCommands: () => undefined,
}));

// mock-isolation: Control health presentation without probing live services.
vi.mock("../../commands/health.js", () => ({
  emitReachableGatewayAuthDiagnostic: mocks.emitReachableGatewayAuthDiagnostic,
  formatHealthChannelLines: mocks.formatHealthChannelLines,
  readNonObservingHealthConfig: async () => ({}),
}));

vi.mock("../../config/read-best-effort-config.runtime.js", () => ({
  readBestEffortConfig: async () => ({}),
  readSourceConfigBestEffort: async () => ({}),
}));

// mock-isolation: Prevent network discovery in CLI option tests.
vi.mock("../../infra/bonjour-discovery.js", () => ({ discoverGatewayBeacons: async () => [] }));
// mock-isolation: Prevent DNS discovery in CLI option tests.
vi.mock("../../infra/widearea-dns.js", () => ({ resolveWideAreaDiscoveryDomain: () => undefined }));
vi.mock("../../../packages/terminal-core/src/health-style.js", () => ({
  styleHealthChannelLine: (line: string) => line,
}));
vi.mock("../../../packages/terminal-core/src/links.js", () => ({
  formatDocsLink: () => "docs.openclaw.ai/cli/gateway",
}));

vi.mock("../../../packages/terminal-core/src/theme.js", () => ({
  colorize: (_rich: boolean, _fn: (value: string) => string, value: string) => value,
  isRich: () => false,
  theme: {
    heading: (value: string) => value,
    muted: (value: string) => value,
    success: (value: string) => value,
  },
}));

vi.mock("../../utils/usage-format.js", () => ({
  formatTokenCount: () => "0",
  formatUsd: () => "$0.00",
}));

// mock-isolation: Keep help rendering out of the CLI routing fixture.
vi.mock("../help-format.js", () => ({ formatHelpExamples: () => "" }));

vi.mock("../progress.js", () => ({
  withProgress: async (_opts: unknown, fn: () => Promise<unknown>) => await fn(),
}));

vi.mock("./discover.js", () => ({
  dedupeBeacons: (beacons: unknown[]) => beacons,
  renderBeaconLines: () => [],
}));

function expectCliError(message: unknown) {
  expectCallCount(0, callGatewayCli, defaultRuntime.error);
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith({
    ok: false,
    error: { type: "cli_error", message },
  });
  expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
}

const parse = (...args: string[]) =>
  sharedProgram.parseAsync(["gateway", ...args], { from: "user" });
function createProgram(register = registerGatewayCli) {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}
const sharedProgram = createProgram();

describe("gateway register option collisions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires explicit confirmation before revealing the Gateway token", async () => {
    await parse("auth-token");

    expect(mocks.gatewayAuthTokenCommand).not.toHaveBeenCalled();
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Pass --show to confirm"),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("routes an explicitly confirmed token reveal through the output runtime", async () => {
    await parse("auth-token", "--show");

    expect(mocks.gatewayAuthTokenCommand).toHaveBeenCalledWith(defaultRuntime);
    expect(defaultRuntime.error).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "gives setup detection enough transport grace",
      argv: ["call", "openclaw.setup.detect", "--json"],
      method: "openclaw.setup.detect",
      opts: { timeout: "40000" },
    },
    {
      name: "projects gateway suspend --port and request id",
      argv: ["suspend", "--request-id", "host-operation", "--port", "19086", "--json"],
      method: "gateway.suspend.prepare",
      opts: { localPortOverride: 19086 },
      params: { requestId: "host-operation" },
      json: expect.objectContaining({ status: "ready", requestId: "host-operation" }),
    },
    {
      name: "inherits parent --port for gateway resume",
      argv: ["--port", "19087", "resume", "suspension-1", "--json"],
      method: "gateway.suspend.resume",
      opts: { localPortOverride: 19087 },
      params: { suspensionId: "suspension-1" },
      json: { ok: true, status: "running", resumed: true },
    },
    {
      name: "prefers the explicit usage-cost --port over the parent --port",
      argv: ["--port", "19090", "usage-cost", "--port", "19091", "--json"],
      method: "usage.cost",
      opts: { localPortOverride: 19091 },
      params: { days: 30 },
    },
    {
      name: "prefers the explicit live stability --port over the parent --port",
      argv: ["--port", "19094", "stability", "--port", "19095", "--json"],
      method: "diagnostics.stability",
      opts: { localPortOverride: 19095 },
      params: { limit: 25 },
    },
  ])("$name", async ({ argv, method, opts, params, json }) => {
    await parse(...argv);
    expect(defaultRuntime.error).not.toHaveBeenCalled();
    expect(callGatewayCli).toHaveBeenCalledOnce();
    expect(callGatewayCli.mock.calls[0]?.slice(0, 2)).toEqual([
      method,
      expect.objectContaining(opts),
    ]);
    if (params !== undefined) {
      expect(callGatewayCli.mock.calls[0]?.[2]).toEqual(params);
    }
    if (json !== undefined) {
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(json);
    }
  });

  it("inherits parent --port for gateway probe", async () => {
    await parse("--port", "19082", "probe", "--json");
    expect(gatewayStatusCommand).toHaveBeenCalledOnce();
    expect(gatewayStatusCommand.mock.calls[0]?.[0]).toMatchObject({ port: "19082" });
  });

  it("preserves one busy JSON result when suspend exits nonzero", async () => {
    const busy = {
      status: "busy",
      reason: "active-work",
      retryAfterMs: 200,
      activeCount: 1,
      blockers: [{ kind: "root-request", count: 1, message: "1 active request" }],
    };
    callGatewayCli.mockResolvedValueOnce(busy);
    const runtime = await vi.importActual<typeof import("../../runtime.js")>("../../runtime.js");

    await defaultRuntime.exit.withImplementation(runtime.defaultRuntime.exit, async () => {
      await expect(
        parse("suspend", "--request-id", "host-operation", "--json"),
      ).rejects.toMatchObject({ name: "ExitError", code: 1 });
    });

    expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith({
      ...busy,
      requestId: "host-operation",
    });
    expect(defaultRuntime.error).not.toHaveBeenCalled();
  });

  it("rejects non-decimal usage-cost --days values instead of silently defaulting", async () => {
    await parse("usage-cost", "--days", "1e3", "--json");

    expectCliError(expect.stringContaining("Invalid --days"));
  });

  it("rejects combining --url and --port for gateway call", async () => {
    await parse("call", "health", "--url", "ws://127.0.0.1:19084", "--port", "19084", "--json");

    expectCliError("Use either --url or --port, not both.");
  });

  it("uses the effective local port and timeout for gateway health auth diagnostics", async () => {
    const authError = new Error("gateway auth required");
    callGatewayCli.mockRejectedValueOnce(authError);
    emitReachableGatewayAuthDiagnostic.mockResolvedValueOnce(true);

    await parse("health", "--port", "19081", "--timeout", "1234", "--json");

    expect(emitReachableGatewayAuthDiagnostic).toHaveBeenCalledExactlyOnceWith({
      error: authError,
      config: {},
      runtime: defaultRuntime,
      timeoutMs: 1234,
      token: undefined,
      password: undefined,
      localPortOverride: 19081,
      json: true,
    });
  });

  it("loads health presentation only for text output", async () => {
    const loadGatewayHealthModule = vi.fn(async () => ({
      emitReachableGatewayAuthDiagnostic: mocks.emitReachableGatewayAuthDiagnostic,
      formatHealthChannelLines: mocks.formatHealthChannelLines,
      readNonObservingHealthConfig: async () => ({}),
    }));
    const loadHealthStyleModule = vi.fn(async () => ({
      styleHealthChannelLine: (line: string) => line,
    }));
    vi.resetModules();
    vi.doMock("../../commands/health.js", loadGatewayHealthModule);
    vi.doMock("../../../packages/terminal-core/src/health-style.js", loadHealthStyleModule);
    const { registerGatewayCli: registerFreshGatewayCli } = await import("./register.js");
    const program = createProgram(registerFreshGatewayCli);

    await program.parseAsync(["node", "openclaw", "gateway", "health", "--json"]);

    expect(callGatewayCli).toHaveBeenCalledWith(
      "health",
      expect.objectContaining({ json: true }),
      undefined,
      { defaultTimeoutMs: 10_000, sharedStateMode: "read-only" },
    );
    expectCallCount(0, loadGatewayHealthModule, loadHealthStyleModule);
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith({ ok: true });

    const textProgram = createProgram(registerFreshGatewayCli);
    await textProgram.parseAsync(["node", "openclaw", "gateway", "health"]);

    expectCallCount(1, loadGatewayHealthModule, loadHealthStyleModule);
    expect(defaultRuntime.log).toHaveBeenCalledWith("Gateway Health");
  });
});

describe("gateway restart-handoff commands", () => {
  const run = (...args: string[]) =>
    runRegisteredCli({
      register: registerGatewayCli,
      argv: ["gateway", "restart-handoff", ...args, "--json"],
    });
  const expectJson = (fields: Record<string, unknown>) =>
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith({
      protocol: "openclaw.gateway.restart-handoff",
      protocolVersion: 1,
      ...fields,
    });
  function expectError(reason: string, exitCode: number) {
    expectJson({ ok: false, status: "error", reason });
    expect(defaultRuntime.exit).toHaveBeenCalledWith(exitCode);
  }
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.consumeGatewayRestartHandoffSync.mockReset();
  });
  it("keeps the machine command group out of normal gateway help", () => {
    const gateway = sharedProgram.commands.find((command) => command.name() === "gateway");
    expect(gateway).toBeDefined();
    expect(gateway?.helpInformation()).not.toContain("restart-handoff");
  });
  it("reports protocol version 1 capabilities", async () => {
    await run("capabilities");
    expectJson({ ok: true, operations: ["consume"] });
  });
  it("forwards a validated expected PID and wraps the consume result", async () => {
    mocks.consumeGatewayRestartHandoffSync.mockReturnValue({ status: "none", reason: "missing" });
    await run("consume", "--expected-pid", "4242");
    expect(mocks.consumeGatewayRestartHandoffSync).toHaveBeenCalledWith({ expectedPid: 4242 });
    expectJson({ ok: true, status: "none", reason: "missing" });
  });
  it.each([
    { name: "missing", args: [] },
    { name: "valueless", args: ["--expected-pid"] },
    { name: "unsafe", args: ["--expected-pid", "9007199254740992"] },
    { name: "dash-prefixed malformed", args: ["--expected-pid", "-invalid"] },
    { name: "valid with an unknown option", args: ["--expected-pid", "4242", "--unknown"] },
    { name: "repeated", args: ["--expected-pid", "111", "--expected-pid", "222"] },
  ])("rejects $name expected PID values before touching the handoff store", async ({ args }) => {
    await run("consume", ...args);
    expect(mocks.consumeGatewayRestartHandoffSync).not.toHaveBeenCalled();
    expectError("invalid-expected-pid", 2);
  });
  it("returns a stable machine error when the handoff store is unavailable", async () => {
    mocks.consumeGatewayRestartHandoffSync.mockImplementation(() => {
      throw new Error("database locked");
    });
    await run("consume", "--expected-pid", "4242");
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      "Gateway restart handoff consume failed: Error: database locked",
    );
    expectError("store-unavailable", 1);
  });
});
