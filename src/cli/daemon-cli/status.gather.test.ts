import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";

const callGatewayStatusProbe = vi.fn(async (_opts?: unknown) => ({ ok: true as const }));
const loadGatewayTlsRuntime = vi.fn(async (_cfg?: unknown) => ({
  enabled: true,
  required: true,
  fingerprintSha256: "sha256:11:22:33:44",
}));
const findExtraGatewayServices = vi.fn(async (_env?: unknown, _opts?: unknown) => []);
const inspectPortUsage = vi.fn(async (port: number) => ({
  port,
  status: "free" as const,
  listeners: [],
  hints: [],
}));
const readLastGatewayErrorLine = vi.fn(async (_env?: NodeJS.ProcessEnv) => null);
const auditGatewayServiceConfig = vi.fn(async (_opts?: unknown) => undefined);
const serviceIsLoaded = vi.fn(async (_opts?: unknown) => true);
const serviceReadRuntime = vi.fn(async (_env?: NodeJS.ProcessEnv) => ({ status: "running" }));
const serviceReadCommand = vi.fn(async (_env?: NodeJS.ProcessEnv) => ({
  programArguments: ["/bin/node", "cli", "gateway", "--port", "19001"],
  environment: {
    OPENCLAW_STATE_DIR: "/tmp/openclaw-daemon",
    OPENCLAW_CONFIG_PATH: "/tmp/openclaw-daemon/openclaw.json",
  },
}));
const resolveGatewayBindHost = vi.fn(
  async (_bindMode?: string, _customBindHost?: string) => "0.0.0.0",
);
const pickPrimaryTailnetIPv4 = vi.fn(() => "100.64.0.9");
const resolveGatewayPort = vi.fn((_cfg?: unknown, _env?: unknown) => 18789);
const resolveStateDir = vi.fn(
  (env: NodeJS.ProcessEnv) => env.OPENCLAW_STATE_DIR ?? "/tmp/openclaw-cli",
);
const resolveConfigPath = vi.fn((env: NodeJS.ProcessEnv, stateDir: string) => {
  return env.OPENCLAW_CONFIG_PATH ?? `${stateDir}/openclaw.json`;
});

vi.mock("../../config/config.js", () => ({
  createConfigIO: ({ configPath }: { configPath: string }) => {
    const isDaemon = configPath.includes("/openclaw-daemon/");
    return {
      readConfigFileSnapshot: async () => ({
        path: configPath,
        exists: true,
        valid: true,
        issues: [],
      }),
      loadConfig: () =>
        isDaemon
          ? {
              gateway: {
                bind: "lan",
                tls: { enabled: true },
                auth: { token: "daemon-token" },
              },
            }
          : {
              gateway: {
                bind: "loopback",
              },
            },
    };
  },
  resolveConfigPath: (env: NodeJS.ProcessEnv, stateDir: string) => resolveConfigPath(env, stateDir),
  resolveGatewayPort: (cfg?: unknown, env?: unknown) => resolveGatewayPort(cfg, env),
  resolveStateDir: (env: NodeJS.ProcessEnv) => resolveStateDir(env),
}));

vi.mock("../../daemon/diagnostics.js", () => ({
  readLastGatewayErrorLine: (env: NodeJS.ProcessEnv) => readLastGatewayErrorLine(env),
}));

vi.mock("../../daemon/inspect.js", () => ({
  findExtraGatewayServices: (env: unknown, opts?: unknown) => findExtraGatewayServices(env, opts),
}));

vi.mock("../../daemon/service-audit.js", () => ({
  auditGatewayServiceConfig: (opts: unknown) => auditGatewayServiceConfig(opts),
}));

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    isLoaded: serviceIsLoaded,
    readCommand: serviceReadCommand,
    readRuntime: serviceReadRuntime,
  }),
}));

vi.mock("../../gateway/net.js", () => ({
  resolveGatewayBindHost: (bindMode: string, customBindHost?: string) =>
    resolveGatewayBindHost(bindMode, customBindHost),
}));

vi.mock("../../infra/ports.js", () => ({
  inspectPortUsage: (port: number) => inspectPortUsage(port),
  formatPortDiagnostics: () => [],
}));

vi.mock("../../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: () => pickPrimaryTailnetIPv4(),
}));

vi.mock("../../infra/tls/gateway.js", () => ({
  loadGatewayTlsRuntime: (cfg: unknown) => loadGatewayTlsRuntime(cfg),
}));

vi.mock("./probe.js", () => ({
  probeGatewayStatus: (opts: unknown) => callGatewayStatusProbe(opts),
}));

const { gatherDaemonStatus } = await import("./status.gather.js");

describe("gatherDaemonStatus", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
    ]);
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-cli";
    process.env.OPENCLAW_CONFIG_PATH = "/tmp/openclaw-cli/openclaw.json";
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    callGatewayStatusProbe.mockClear();
    loadGatewayTlsRuntime.mockClear();
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("uses wss probe URL and forwards TLS fingerprint when daemon TLS is enabled", async () => {
    const status = await gatherDaemonStatus({
      rpc: {},
      probe: true,
      deep: false,
    });

    expect(loadGatewayTlsRuntime).toHaveBeenCalledTimes(1);
    expect(callGatewayStatusProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "wss://127.0.0.1:19001",
        tlsFingerprint: "sha256:11:22:33:44",
        token: "daemon-token",
      }),
    );
    expect(status.gateway?.probeUrl).toBe("wss://127.0.0.1:19001");
    expect(status.rpc?.url).toBe("wss://127.0.0.1:19001");
    expect(status.rpc?.ok).toBe(true);
  });

  it("does not force local TLS fingerprint when probe URL is explicitly overridden", async () => {
    const status = await gatherDaemonStatus({
      rpc: { url: "wss://override.example:18790" },
      probe: true,
      deep: false,
    });

    expect(loadGatewayTlsRuntime).not.toHaveBeenCalled();
    expect(callGatewayStatusProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "wss://override.example:18790",
        tlsFingerprint: undefined,
      }),
    );
    expect(status.gateway?.probeUrl).toBe("wss://override.example:18790");
    expect(status.rpc?.url).toBe("wss://override.example:18790");
  });

  it("skips TLS runtime loading when probe is disabled", async () => {
    const status = await gatherDaemonStatus({
      rpc: {},
      probe: false,
      deep: false,
    });

    expect(loadGatewayTlsRuntime).not.toHaveBeenCalled();
    expect(callGatewayStatusProbe).not.toHaveBeenCalled();
    expect(status.rpc).toBeUndefined();
  });
});
