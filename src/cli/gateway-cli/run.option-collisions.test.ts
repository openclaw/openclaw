import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

const { defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();

vi.mock("../../config/config.js", () => ({
  getConfigPath: () => "/tmp/openclaw-test-missing-config.json",
  loadConfig: () => ({}),
  readConfigFileSnapshot: async () => ({ exists: false }),
  resolveStateDir: () => "/tmp",
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
});
