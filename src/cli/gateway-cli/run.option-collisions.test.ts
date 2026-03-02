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
const readConfigFileSnapshot = vi.fn<() => Promise<Record<string, unknown>>>(async () => ({
  exists: false,
}));
const restoreConfigFromBackupFile = vi.fn(async () => ({
  ok: false,
  path: "/tmp/openclaw-test-missing-config.json",
  backupPath: "/tmp/openclaw-test-missing-config.json.bak",
}));
const snapshotConfigBackupFile = vi.fn(async () => ({
  ok: true,
  path: "/tmp/openclaw-test-missing-config.json",
  backupPath: "/tmp/openclaw-test-missing-config.json.bak",
}));

const { runtimeErrors, defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();

vi.mock("../../config/config.js", () => ({
  getConfigPath: () => "/tmp/openclaw-test-missing-config.json",
  loadConfig: () => ({}),
  readConfigFileSnapshot: () => readConfigFileSnapshot(),
  restoreConfigFromBackupFile: () => restoreConfigFromBackupFile(),
  resolveStateDir: () => "/tmp",
  resolveGatewayPort: () => 18789,
  snapshotConfigBackupFile: () => snapshotConfigBackupFile(),
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
    readConfigFileSnapshot.mockReset();
    readConfigFileSnapshot.mockResolvedValue({ exists: false });
    restoreConfigFromBackupFile.mockClear();
    restoreConfigFromBackupFile.mockResolvedValue({
      ok: false,
      path: "/tmp/openclaw-test-missing-config.json",
      backupPath: "/tmp/openclaw-test-missing-config.json.bak",
    });
    snapshotConfigBackupFile.mockClear();
    snapshotConfigBackupFile.mockResolvedValue({
      ok: true,
      path: "/tmp/openclaw-test-missing-config.json",
      backupPath: "/tmp/openclaw-test-missing-config.json.bak",
    });
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

  function expectAuthOverrideMode(mode: string) {
    expect(startGatewayServer).toHaveBeenCalledWith(
      18789,
      expect.objectContaining({
        auth: expect.objectContaining({
          mode,
        }),
      }),
    );
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

  it("accepts --auth none override", async () => {
    await runGatewayCli(["gateway", "run", "--auth", "none", "--allow-unconfigured"]);

    expectAuthOverrideMode("none");
  });

  it("accepts --auth trusted-proxy override", async () => {
    await runGatewayCli(["gateway", "run", "--auth", "trusted-proxy", "--allow-unconfigured"]);

    expectAuthOverrideMode("trusted-proxy");
  });

  it("prints all supported modes on invalid --auth value", async () => {
    await expect(
      runGatewayCli(["gateway", "run", "--auth", "bad-mode", "--allow-unconfigured"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain(
      'Invalid --auth (use "none", "token", "password", or "trusted-proxy")',
    );
  });

  it("blocks gateway run and prints validation issues when config is invalid", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      path: "/tmp/openclaw-test-missing-config.json",
      issues: [{ path: "agents.defaults.suppressToolErrorWarnings", message: "Unrecognized key" }],
    });

    await expect(runGatewayCli(["gateway", "run"])).rejects.toThrow("__exit__:1");

    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors).toContain(
      "Gateway start blocked: invalid config at /tmp/openclaw-test-missing-config.json.",
    );
    expect(runtimeErrors).toContain(
      "- agents.defaults.suppressToolErrorWarnings: Unrecognized key",
    );
    expect(runtimeErrors.some((line) => line.includes("openclaw config validate"))).toBe(true);
  });

  it("restores config from .bak and continues startup when backup is valid", async () => {
    readConfigFileSnapshot
      .mockResolvedValueOnce({
        exists: true,
        valid: false,
        path: "/tmp/openclaw-test-missing-config.json",
        issues: [{ path: "", message: "JSON5 parse failed: unterminated string" }],
      })
      .mockResolvedValueOnce({
        exists: true,
        valid: true,
        path: "/tmp/openclaw-test-missing-config.json",
      });
    restoreConfigFromBackupFile.mockResolvedValue({
      ok: true,
      path: "/tmp/openclaw-test-missing-config.json",
      backupPath: "/tmp/openclaw-test-missing-config.json.bak",
    });

    await runGatewayCli(["gateway", "run", "--allow-unconfigured"]);

    expect(startGatewayServer).toHaveBeenCalled();
    expect(runtimeErrors).toContain(
      "Recovered invalid config from backup: /tmp/openclaw-test-missing-config.json.bak -> /tmp/openclaw-test-missing-config.json.",
    );
  });

  it("does not restore from .bak for plugin validation failures", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      path: "/tmp/openclaw-test-missing-config.json",
      issues: [{ path: "plugins.allow[0]", message: "plugin not found: foo-plugin" }],
    });

    await expect(runGatewayCli(["gateway", "run"])).rejects.toThrow("__exit__:1");

    expect(restoreConfigFromBackupFile).not.toHaveBeenCalled();
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors).toContain(
      "Gateway start blocked: invalid config at /tmp/openclaw-test-missing-config.json.",
    );
  });

  it("does not restore from .bak for env substitution failures", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      path: "/tmp/openclaw-test-missing-config.json",
      issues: [
        { path: "", message: "Env var substitution failed: Missing required env var: API_KEY" },
      ],
    });

    await expect(runGatewayCli(["gateway", "run"])).rejects.toThrow("__exit__:1");

    expect(restoreConfigFromBackupFile).not.toHaveBeenCalled();
    expect(startGatewayServer).not.toHaveBeenCalled();
    expect(runtimeErrors).toContain(
      "Gateway start blocked: invalid config at /tmp/openclaw-test-missing-config.json.",
    );
  });

  it("applies --token before config snapshot validation", async () => {
    const previousGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    readConfigFileSnapshot.mockImplementation(async () => {
      if (process.env.OPENCLAW_GATEWAY_TOKEN === "tok_prevalidate") {
        return {
          exists: true,
          valid: true,
          path: "/tmp/openclaw-test-missing-config.json",
        };
      }
      return {
        exists: true,
        valid: false,
        path: "/tmp/openclaw-test-missing-config.json",
        issues: [{ path: "", message: "Env var substitution failed: Missing required env var" }],
      };
    });

    try {
      await runGatewayCli(["gateway", "run", "--token", "tok_prevalidate", "--allow-unconfigured"]);
      expect(startGatewayServer).toHaveBeenCalled();
      expect(runtimeErrors).not.toContain(
        "Gateway start blocked: invalid config at /tmp/openclaw-test-missing-config.json.",
      );
    } finally {
      if (previousGatewayToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previousGatewayToken;
      }
    }
  });
});
