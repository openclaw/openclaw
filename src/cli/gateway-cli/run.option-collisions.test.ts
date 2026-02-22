import { Command } from "commander";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";

const startGatewayServer = vi.fn(async (_port: number, _opts?: unknown) => ({
  close: vi.fn(async () => {}),
}));
const setGatewayWsLogStyle = vi.fn((_style: string) => undefined);
const setVerbose = vi.fn((_enabled: boolean) => undefined);
const forceFreePortAndWait = vi.fn(async (_port: number, _opts: unknown) => ({
  killed: [],
  waitedMs: 0,
  escalatedToSigkill: false,
}));
const ensureDevGatewayConfig = vi.fn(async (_opts?: unknown) => {});
const runGatewayLoop = vi.fn(async ({ start }: { start: () => Promise<unknown> }) => {
  await start();
});
const resolveStateDir = vi.fn<(env?: NodeJS.ProcessEnv) => string>(() => "/tmp");
const resolveConfigPath = vi.fn((_env: NodeJS.ProcessEnv, stateDir: string) => {
  return `${stateDir}/openclaw.json`;
});

const { runtimeErrors, defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();

vi.mock("../../config/config.js", () => ({
  getConfigPath: () => "/tmp/openclaw-test-missing-config.json",
  loadConfig: () => ({}),
  readConfigFileSnapshot: async () => ({ exists: false }),
  resolveConfigPath: (env: NodeJS.ProcessEnv, stateDir: string) => resolveConfigPath(env, stateDir),
  resolveStateDir: (env?: NodeJS.ProcessEnv) => resolveStateDir(env),
  resolveGatewayPort: () => 18789,
}));

vi.mock("../../gateway/auth.js", () => ({
  resolveGatewayAuth: (params: { authConfig?: { token?: string }; env?: NodeJS.ProcessEnv }) => ({
    mode: "token",
    token: params.authConfig?.token ?? params.env?.OPENCLAW_GATEWAY_TOKEN,
    password: undefined,
    allowTailscale: false,
  }),
}));

vi.mock("../../gateway/server.js", () => ({
  startGatewayServer: (port: number, opts?: unknown) => startGatewayServer(port, opts),
}));

vi.mock("../../gateway/ws-logging.js", () => ({
  setGatewayWsLogStyle: (style: string) => setGatewayWsLogStyle(style),
}));

vi.mock("../../globals.js", () => ({
  setVerbose: (enabled: boolean) => setVerbose(enabled),
}));

vi.mock("../../infra/gateway-lock.js", () => ({
  GatewayLockError: class GatewayLockError extends Error {},
}));

vi.mock("../../infra/ports.js", () => ({
  formatPortDiagnostics: () => [],
  inspectPortUsage: async () => ({ status: "free" }),
}));

vi.mock("../../logging/console.js", () => ({
  setConsoleSubsystemFilter: () => undefined,
  setConsoleTimestampPrefix: () => undefined,
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../command-format.js", () => ({
  formatCliCommand: (cmd: string) => cmd,
}));

vi.mock("../ports.js", () => ({
  forceFreePortAndWait: (port: number, opts: unknown) => forceFreePortAndWait(port, opts),
}));

vi.mock("./dev.js", () => ({
  ensureDevGatewayConfig: (opts?: unknown) => ensureDevGatewayConfig(opts),
}));

vi.mock("./run-loop.js", () => ({
  runGatewayLoop: (params: { start: () => Promise<unknown> }) => runGatewayLoop(params),
}));

describe("gateway run option collisions", () => {
  let addGatewayRunCommand: typeof import("./run.js").addGatewayRunCommand;

  beforeAll(async () => {
    ({ addGatewayRunCommand } = await import("./run.js"));
  });

  beforeEach(() => {
    resetRuntimeCapture();
    startGatewayServer.mockClear();
    setGatewayWsLogStyle.mockClear();
    setVerbose.mockClear();
    forceFreePortAndWait.mockClear();
    ensureDevGatewayConfig.mockClear();
    runGatewayLoop.mockClear();
    resolveStateDir.mockReset();
    resolveStateDir.mockReturnValue("/tmp");
    resolveConfigPath.mockReset();
    resolveConfigPath.mockImplementation((_env: NodeJS.ProcessEnv, stateDir: string) => {
      return `${stateDir}/openclaw.json`;
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function runGatewayCli(argv: string[]) {
    await runRegisteredCli({
      register: ((program: Command) => {
        const gateway = addGatewayRunCommand(program.command("gateway"));
        addGatewayRunCommand(gateway.command("run"));
      }) as (program: Command) => void,
      argv,
    });
  }

  async function expectGatewayExit(argv: string[]) {
    await expect(runGatewayCli(argv)).rejects.toThrow("__exit__:1");
  }

  it("forwards parent-captured options to `gateway run` subcommand", async () => {
    await runGatewayCli([
      "gateway",
      "run",
      "--token",
      "tok_run",
      "--allow-unconfigured",
      "--ws-log",
      "full",
      "--force",
    ]);

    expect(forceFreePortAndWait).toHaveBeenCalledWith(18789, expect.anything());
    expect(setGatewayWsLogStyle).toHaveBeenCalledWith("full");
    expect(startGatewayServer).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({
        auth: expect.objectContaining({
          token: "tok_run",
        }),
      }),
    );
  });

  it("starts gateway when token mode has no configured token (startup bootstrap path)", async () => {
    await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

    expect(startGatewayServer).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({
        bind: "loopback",
      }),
    );
  });

  it("hard-stops --dev --reset when target resolves to default profile paths", async () => {
    vi.stubEnv("HOME", "/Users/test");
    resolveStateDir.mockReturnValue("/Users/test/.openclaw");
    resolveConfigPath.mockImplementation((_env: NodeJS.ProcessEnv, stateDir: string) => {
      return `${stateDir}/openclaw.json`;
    });

    await expectGatewayExit(["gateway", "run", "--dev", "--reset"]);

    expect(ensureDevGatewayConfig).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain(
      "Refusing to run `gateway --dev --reset` because the reset target is not dev-isolated.",
    );
    expect(runtimeErrors.join("\n")).toContain("/Users/test/.openclaw");
  });

  it("allows --dev --reset when target resolves to dev profile paths", async () => {
    vi.stubEnv("HOME", "/Users/test");
    resolveStateDir.mockReturnValue("/Users/test/.openclaw-dev");
    resolveConfigPath.mockImplementation((_env: NodeJS.ProcessEnv, stateDir: string) => {
      return `${stateDir}/openclaw.json`;
    });

    await runGatewayCli(["gateway", "run", "--dev", "--reset", "--allow-unconfigured"]);

    expect(ensureDevGatewayConfig).toHaveBeenCalledWith({ reset: true });
  });

  it("allows --dev --reset for explicit non-default custom state/config paths", async () => {
    vi.stubEnv("HOME", "/Users/test");
    vi.stubEnv("OPENCLAW_STATE_DIR", "/tmp/custom-dev");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", "/tmp/custom-dev/openclaw.json");
    resolveStateDir.mockReturnValue("/tmp/custom-dev");
    resolveConfigPath.mockReturnValue("/tmp/custom-dev/openclaw.json");

    await runGatewayCli(["gateway", "run", "--dev", "--reset", "--allow-unconfigured"]);

    expect(ensureDevGatewayConfig).toHaveBeenCalledWith({ reset: true });
  });
});
