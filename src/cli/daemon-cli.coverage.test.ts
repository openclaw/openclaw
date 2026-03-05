import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { registerDaemonCli } from "./daemon-cli.js";

const probeGatewayStatus = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
const resolveGatewayProgramArguments = vi.fn(async (_opts?: unknown) => ({
  programArguments: ["/bin/node", "cli", "gateway", "--port", "18789"],
}));
const serviceInstall = vi.fn().mockResolvedValue(undefined);
const serviceStage = vi.fn().mockResolvedValue(undefined);
const serviceUninstall = vi.fn().mockResolvedValue(undefined);
const serviceStop = vi.fn().mockResolvedValue(undefined);
const serviceRestart = vi.fn().mockResolvedValue({ outcome: "completed" });
const serviceIsLoaded = vi.fn().mockResolvedValue(false);
const serviceReadCommand = vi.fn().mockResolvedValue(null);
const serviceReadRuntime = vi.fn().mockResolvedValue({ status: "running" });
const resolveGatewayProbeAuthWithSecretInputs = vi.fn(async (_opts?: unknown) => ({}));
const findExtraGatewayServices = vi.fn(async (_env: unknown, _opts?: unknown) => []);
const auditGatewayServiceConfig = vi.fn(async (_opts?: unknown) => undefined);
const inspectPortUsage = vi.fn(async (port: number) => ({
  port,
  status: "free",
  listeners: [],
  hints: [],
}));
const resolveGatewayBindHost = vi.fn(
  async (_bindMode?: string, _customBindHost?: string) => "127.0.0.1",
);
const pickPrimaryTailnetIPv4 = vi.fn(() => "100.64.0.9");
const loadGatewayTlsRuntime = vi.fn(async (_cfg?: unknown) => ({
  enabled: false,
  required: false,
}));
const resolveGatewayPort = vi.fn((_cfg?: unknown, env?: NodeJS.ProcessEnv) => {
  const fromEnv = env?.OPENCLAW_GATEWAY_PORT;
  return fromEnv ? Number(fromEnv) : 18789;
});
const resolveStateDir = vi.fn(
  (env: NodeJS.ProcessEnv) => env.OPENCLAW_STATE_DIR ?? "/tmp/openclaw-cli-state",
);
const resolveConfigPath = vi.fn((env: NodeJS.ProcessEnv, stateDir: string) => {
  return env.OPENCLAW_CONFIG_PATH ?? `${stateDir}/openclaw.json`;
});
const buildGatewayInstallPlan = vi.fn(
  async (params: { port: number; token?: string; env?: NodeJS.ProcessEnv }) => ({
    programArguments: ["/bin/node", "cli", "gateway", "--port", String(params.port)],
    workingDirectory: process.cwd(),
    environment: {
      OPENCLAW_GATEWAY_PORT: String(params.port),
      ...(params.token ? { OPENCLAW_GATEWAY_TOKEN: params.token } : {}),
    },
  }),
);

const mocks = vi.hoisted(() => {
  const runtimeLogs: string[] = [];
  const stringifyArgs = (args: unknown[]) => args.map((value) => String(value)).join(" ");
  const defaultRuntime = {
    log: vi.fn((...args: unknown[]) => {
      runtimeLogs.push(stringifyArgs(args));
    }),
    error: vi.fn(),
    writeStdout: vi.fn((value: string) => {
      defaultRuntime.log(value.endsWith("\n") ? value.slice(0, -1) : value);
    }),
    writeJson: vi.fn((value: unknown, space = 2) => {
      defaultRuntime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return { runtimeLogs, defaultRuntime };
});

const { runtimeLogs } = mocks;

vi.mock("./daemon-cli/probe.js", () => ({
  probeGatewayStatus: (opts: unknown) => probeGatewayStatus(opts),
}));

vi.mock("../gateway/probe-auth.js", () => ({
  resolveGatewayProbeAuthWithSecretInputs: (opts: unknown) =>
    resolveGatewayProbeAuthWithSecretInputs(opts),
}));

vi.mock("../daemon/program-args.js", () => ({
  resolveGatewayProgramArguments: (opts: unknown) => resolveGatewayProgramArguments(opts),
}));

vi.mock("../daemon/service.js", async () => {
  const actual =
    await vi.importActual<typeof import("../daemon/service.js")>("../daemon/service.js");
  return {
    ...actual,
    resolveGatewayService: () => ({
      label: "LaunchAgent",
      loadedText: "loaded",
      notLoadedText: "not loaded",
      stage: serviceStage,
      install: serviceInstall,
      uninstall: serviceUninstall,
      stop: serviceStop,
      restart: serviceRestart,
      isLoaded: serviceIsLoaded,
      readCommand: serviceReadCommand,
      readRuntime: serviceReadRuntime,
    }),
  };
});

vi.mock("../daemon/legacy.js", () => ({
  findLegacyGatewayServices: async () => [],
}));

vi.mock("../daemon/inspect.js", () => ({
  findExtraGatewayServices: (env: unknown, opts?: unknown) => findExtraGatewayServices(env, opts),
  renderGatewayServiceCleanupHints: () => [],
}));

vi.mock("../daemon/service-audit.js", () => ({
  auditGatewayServiceConfig: (opts: unknown) => auditGatewayServiceConfig(opts),
}));

vi.mock("../infra/ports.js", () => ({
  inspectPortUsage: (port: number) => inspectPortUsage(port),
  formatPortDiagnostics: () => ["Port 18789 is already in use."],
}));

vi.mock("../gateway/net.js", () => ({
  resolveGatewayBindHost: (bindMode: string, customBindHost?: string) =>
    resolveGatewayBindHost(bindMode, customBindHost),
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: () => pickPrimaryTailnetIPv4(),
}));

vi.mock("../infra/tls/gateway.js", () => ({
  loadGatewayTlsRuntime: (cfg: unknown) => loadGatewayTlsRuntime(cfg),
}));

vi.mock("../config/config.js", () => ({
  createConfigIO: ({ configPath }: { configPath: string }) => ({
    readConfigFileSnapshot: async () => ({
      path: configPath,
      exists: true,
      valid: true,
      issues: [],
    }),
    loadConfig: () => ({}),
  }),
  loadConfig: () => ({}),
  readBestEffortConfig: async () => ({}),
  resolveConfigPath: (env: NodeJS.ProcessEnv, stateDir: string) => resolveConfigPath(env, stateDir),
  resolveGatewayPort: (cfg?: unknown, env?: NodeJS.ProcessEnv) => resolveGatewayPort(cfg, env),
  resolveStateDir: (env: NodeJS.ProcessEnv) => resolveStateDir(env),
}));

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../commands/daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: (params: { port: number; token?: string; env?: NodeJS.ProcessEnv }) =>
    buildGatewayInstallPlan(params),
}));

vi.mock("./deps.js", () => ({
  createDefaultDeps: () => {},
}));

vi.mock("./progress.js", () => ({
  withProgress: async (_opts: unknown, fn: () => Promise<unknown>) => await fn(),
}));

let daemonProgram: Command;

function createDaemonProgram() {
  const program = new Command();
  program.exitOverride();
  registerDaemonCli(program);
  return program;
}

async function runDaemonCommand(args: string[]) {
  await daemonProgram.parseAsync(args, { from: "user" });
}

function parseFirstJsonRuntimeLine<T>() {
  const jsonLine = runtimeLogs.find((line) => line.trim().startsWith("{"));
  return JSON.parse(jsonLine ?? "{}") as T;
}

describe("daemon-cli coverage", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    daemonProgram = createDaemonProgram();
    envSnapshot = captureEnv([
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_GATEWAY_PORT",
      "OPENCLAW_PROFILE",
    ]);
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-cli-state";
    process.env.OPENCLAW_CONFIG_PATH = "/tmp/openclaw-cli-state/openclaw.json";
    delete process.env.OPENCLAW_GATEWAY_PORT;
    delete process.env.OPENCLAW_PROFILE;
    serviceInstall.mockClear();
    serviceUninstall.mockClear();
    serviceStop.mockClear();
    serviceRestart.mockClear();
    serviceIsLoaded.mockReset().mockResolvedValue(false);
    serviceReadRuntime.mockReset().mockResolvedValue({ status: "running" });
    findExtraGatewayServices.mockClear();
    inspectPortUsage.mockClear();
    probeGatewayStatus.mockClear();
    auditGatewayServiceConfig.mockClear();
    serviceReadCommand.mockResolvedValue(null);
    resolveGatewayProbeAuthWithSecretInputs.mockClear();
    buildGatewayInstallPlan.mockClear();
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("probes gateway status by default", async () => {
    runtimeLogs.length = 0;
    probeGatewayStatus.mockClear();

    await runDaemonCommand(["daemon", "status"]);

    expect(probeGatewayStatus).toHaveBeenCalledTimes(1);
    expect(probeGatewayStatus).toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://127.0.0.1:18789" }),
    );
    expect(findExtraGatewayServices).toHaveBeenCalled();
    expect(inspectPortUsage).toHaveBeenCalled();
  });

  it("derives probe URL from service args + env (json)", async () => {
    runtimeLogs.length = 0;
    probeGatewayStatus.mockClear();
    inspectPortUsage.mockClear();

    serviceReadCommand.mockResolvedValueOnce({
      programArguments: ["/bin/node", "cli", "gateway", "--port", "19001"],
      environment: {
        OPENCLAW_PROFILE: "dev",
        OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon-state",
        OPENCLAW_CONFIG_PATH: "/tmp/openclaw-daemon-state/openclaw.json",
        OPENCLAW_GATEWAY_PORT: "19001",
      },
      sourcePath: "/tmp/ai.openclaw.gateway.plist",
    });

    await runDaemonCommand(["daemon", "status", "--json"]);

    expect(probeGatewayStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:19001",
      }),
    );
    expect(inspectPortUsage).toHaveBeenCalledWith(19001);

    const parsed = parseFirstJsonRuntimeLine<{
      gateway?: { port?: number; portSource?: string; probeUrl?: string };
      config?: { mismatch?: boolean };
      rpc?: { url?: string; ok?: boolean };
    }>();
    expect(parsed.gateway?.port).toBe(19001);
    expect(parsed.gateway?.portSource).toBe("service args");
    expect(parsed.gateway?.probeUrl).toBe("ws://127.0.0.1:19001");
    expect(parsed.config?.mismatch).toBe(true);
    expect(parsed.rpc?.url).toBe("ws://127.0.0.1:19001");
    expect(parsed.rpc?.ok).toBe(true);
  });

  it("passes deep scan flag for daemon status", async () => {
    findExtraGatewayServices.mockClear();

    await runDaemonCommand(["daemon", "status", "--deep"]);

    expect(findExtraGatewayServices).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ deep: true }),
    );
  });

  it("installs the daemon (json output)", async () => {
    runtimeLogs.length = 0;
    serviceIsLoaded.mockResolvedValueOnce(false);
    serviceInstall.mockClear();

    await runDaemonCommand([
      "daemon",
      "install",
      "--port",
      "18789",
      "--token",
      "test-token",
      "--json",
    ]);

    expect(serviceInstall).toHaveBeenCalledTimes(1);
    const parsed = parseFirstJsonRuntimeLine<{
      ok?: boolean;
      action?: string;
      result?: string;
    }>();
    expect(parsed.ok).toBe(true);
    expect(parsed.action).toBe("install");
    expect(parsed.result).toBe("installed");
  });

  it("starts and stops daemon (json output)", async () => {
    runtimeLogs.length = 0;
    serviceRestart.mockClear();
    serviceStop.mockClear();
    serviceIsLoaded.mockResolvedValue(true);

    await runDaemonCommand(["daemon", "start", "--json"]);
    await runDaemonCommand(["daemon", "stop", "--json"]);

    expect(serviceRestart).toHaveBeenCalledTimes(1);
    expect(serviceStop).toHaveBeenCalledTimes(1);
    const jsonLines = runtimeLogs.filter((line) => line.trim().startsWith("{"));
    const parsed = jsonLines.map((line) => JSON.parse(line) as { action?: string; ok?: boolean });
    expect(parsed.some((entry) => entry.action === "start" && entry.ok === true)).toBe(true);
    expect(parsed.some((entry) => entry.action === "stop" && entry.ok === true)).toBe(true);
  });
});
