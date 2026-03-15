import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvOverride } from "../config/test-helpers.js";
import { GatewayLockError } from "../infra/gateway-lock.js";
import type { GatewayTlsRuntime } from "../infra/tls/gateway.js";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

type DiscoveredBeacon = Awaited<
  ReturnType<typeof import("../infra/bonjour-discovery.js").discoverGatewayBeacons>
>[number];

const mockConfigState = vi.hoisted(() => ({
  config: {
    gateway: {
      mode: "local",
    },
  } as ReturnType<typeof import("../config/config.js").loadConfig>,
}));

const callGateway = vi.fn<(opts: unknown) => Promise<{ ok: true }>>(async () => ({ ok: true }));
const startGatewayServer = vi.fn<
  (port: number, opts?: unknown) => Promise<{ close: () => Promise<void> }>
>(async () => ({
  close: vi.fn(async () => {}),
}));
const probeGateway = vi.fn<
  (opts: unknown) => Promise<{
    ok: boolean;
    url: string;
    connectLatencyMs: number | null;
    error: string | null;
    close: null;
    health: unknown;
    status: unknown;
    presence: null;
    configSnapshot: unknown;
  }>
>(async (opts) => ({
  ok: false,
  url: String((opts as { url?: string }).url ?? "ws://127.0.0.1:18789"),
  connectLatencyMs: null,
  error: "timeout",
  close: null,
  health: null,
  status: null,
  presence: null,
  configSnapshot: null,
}));
const setVerbose = vi.fn();
const forceFreePortAndWait = vi.fn<
  (port: number) => Promise<{ killed: unknown[]; waitedMs: number; escalatedToSigkill: boolean }>
>(async () => ({
  killed: [],
  waitedMs: 0,
  escalatedToSigkill: false,
}));
const serviceIsLoaded = vi.fn().mockResolvedValue(true);
const discoverGatewayBeacons = vi.fn<(opts: unknown) => Promise<DiscoveredBeacon[]>>(
  async () => [],
);
const gatewayStatusCommand = vi.fn<(opts: unknown) => Promise<void>>(async () => {});
const inspectPortUsage = vi.fn(async (_port: number) => ({ status: "free" as const }));
const formatPortDiagnostics = vi.fn((_diagnostics: unknown) => [] as string[]);
const loadGatewayTlsRuntime = vi.fn<(cfg?: unknown) => Promise<GatewayTlsRuntime>>(
  async (_cfg?: unknown) => ({
    enabled: false,
    required: false,
    certPath: undefined,
    keyPath: undefined,
    caPath: undefined,
    fingerprintSha256: undefined,
    tlsOptions: undefined,
    error: undefined,
  }),
);

const { runtimeLogs, runtimeErrors, defaultRuntime, resetRuntimeCapture } =
  createCliRuntimeCapture();

vi.mock(
  new URL("../../gateway/call.ts", new URL("./gateway-cli/call.ts", import.meta.url)).href,
  () => ({
    callGateway: (opts: unknown) => callGateway(opts),
    randomIdempotencyKey: () => "rk_test",
  }),
);

vi.mock("../gateway/server.js", () => ({
  startGatewayServer: (port: number, opts?: unknown) => startGatewayServer(port, opts),
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway: (opts: unknown) => probeGateway(opts),
}));

vi.mock("../globals.js", () => ({
  info: (msg: string) => msg,
  isVerbose: () => false,
  setVerbose: (enabled: boolean) => setVerbose(enabled),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => mockConfigState.config,
    readConfigFileSnapshot: async () => ({
      exists: true,
      parsed: mockConfigState.config,
    }),
  };
});

vi.mock("./ports.js", () => ({
  forceFreePortAndWait: (port: number) => forceFreePortAndWait(port),
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    install: vi.fn(),
    uninstall: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    isLoaded: serviceIsLoaded,
    readCommand: vi.fn(),
    readRuntime: vi.fn().mockResolvedValue({ status: "running" }),
  }),
}));

vi.mock("../daemon/program-args.js", () => ({
  resolveGatewayProgramArguments: async () => ({
    programArguments: ["/bin/node", "cli", "gateway", "--port", "18789"],
  }),
}));

vi.mock("../infra/bonjour-discovery.js", () => ({
  discoverGatewayBeacons: (opts: unknown) => discoverGatewayBeacons(opts),
}));

vi.mock("../commands/gateway-status.js", () => ({
  gatewayStatusCommand: (opts: unknown) => gatewayStatusCommand(opts),
}));

vi.mock("../infra/ports.js", () => ({
  inspectPortUsage: (port: number) => inspectPortUsage(port),
  formatPortDiagnostics: (diagnostics: unknown) => formatPortDiagnostics(diagnostics),
}));

vi.mock("../infra/tls/gateway.js", () => ({
  loadGatewayTlsRuntime: (cfg?: unknown) => loadGatewayTlsRuntime(cfg),
}));

const { registerGatewayCli } = await import("./gateway-cli.js");
let gatewayProgram: Command;

function createGatewayProgram() {
  const program = new Command();
  program.exitOverride();
  registerGatewayCli(program);
  return program;
}

async function runGatewayCommand(args: string[]) {
  await gatewayProgram.parseAsync(args, { from: "user" });
}

async function expectGatewayExit(args: string[]) {
  await expect(runGatewayCommand(args)).rejects.toThrow("__exit__:1");
}

describe("gateway-cli coverage", () => {
  beforeEach(() => {
    gatewayProgram = createGatewayProgram();
    delete process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS;
    mockConfigState.config = {
      gateway: {
        mode: "local",
      },
    };
    inspectPortUsage.mockClear();
    formatPortDiagnostics.mockClear();
    probeGateway.mockClear();
    loadGatewayTlsRuntime.mockClear();
  });

  it("registers call/health commands and routes to callGateway", async () => {
    resetRuntimeCapture();
    callGateway.mockClear();

    await runGatewayCommand(["gateway", "call", "health", "--params", '{"x":1}', "--json"]);

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(runtimeLogs.join("\n")).toContain('"ok": true');
  });

  it("registers gateway probe and routes to gatewayStatusCommand", async () => {
    resetRuntimeCapture();
    gatewayStatusCommand.mockClear();

    await runGatewayCommand(["gateway", "probe", "--json"]);

    expect(gatewayStatusCommand).toHaveBeenCalledTimes(1);
  });

  it("registers gateway discover and prints json output", async () => {
    resetRuntimeCapture();
    discoverGatewayBeacons.mockClear();
    discoverGatewayBeacons.mockResolvedValueOnce([
      {
        instanceName: "Studio (OpenClaw)",
        displayName: "Studio",
        domain: "openclaw.internal.",
        host: "studio.openclaw.internal",
        lanHost: "studio.local",
        tailnetDns: "studio.tailnet.ts.net",
        gatewayPort: 18789,
        sshPort: 22,
      },
    ]);

    await runGatewayCommand(["gateway", "discover", "--json"]);

    expect(discoverGatewayBeacons).toHaveBeenCalledTimes(1);
    const out = runtimeLogs.join("\n");
    expect(out).toContain('"beacons"');
    expect(out).toContain("ws://");
  });

  it("validates gateway discover timeout", async () => {
    resetRuntimeCapture();
    discoverGatewayBeacons.mockClear();
    await expectGatewayExit(["gateway", "discover", "--timeout", "0"]);

    expect(runtimeErrors.join("\n")).toContain("gateway discover failed:");
    expect(discoverGatewayBeacons).not.toHaveBeenCalled();
  });

  it("fails gateway call on invalid params JSON", async () => {
    resetRuntimeCapture();
    callGateway.mockClear();
    await expectGatewayExit(["gateway", "call", "status", "--params", "not-json"]);

    expect(callGateway).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Gateway call failed:");
  });

  it("validates gateway ports and handles force/start errors", async () => {
    resetRuntimeCapture();

    // Invalid port
    await expectGatewayExit(["gateway", "--port", "0", "--token", "test-token"]);

    // Force free failure
    forceFreePortAndWait.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    await expectGatewayExit([
      "gateway",
      "--port",
      "18789",
      "--token",
      "test-token",
      "--force",
      "--allow-unconfigured",
    ]);

    // Start failure (generic)
    startGatewayServer.mockRejectedValueOnce(new Error("nope"));
    const beforeSigterm = new Set(process.listeners("SIGTERM"));
    const beforeSigint = new Set(process.listeners("SIGINT"));
    await expectGatewayExit([
      "gateway",
      "--port",
      "18789",
      "--token",
      "test-token",
      "--allow-unconfigured",
    ]);
    for (const listener of process.listeners("SIGTERM")) {
      if (!beforeSigterm.has(listener)) {
        process.removeListener("SIGTERM", listener);
      }
    }
    for (const listener of process.listeners("SIGINT")) {
      if (!beforeSigint.has(listener)) {
        process.removeListener("SIGINT", listener);
      }
    }
  });

  it("prints stop hints on GatewayLockError when service is loaded", async () => {
    resetRuntimeCapture();
    serviceIsLoaded.mockResolvedValue(true);
    startGatewayServer.mockRejectedValueOnce(
      new GatewayLockError("another gateway instance is already listening"),
    );
    await expectGatewayExit(["gateway", "--token", "test-token", "--allow-unconfigured"]);

    expect(startGatewayServer).toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Gateway failed to start:");
    expect(runtimeErrors.join("\n")).toContain("gateway stop");
  });

  it("probes the bind-aware TLS URL with auth before exiting 0 on port conflict", async () => {
    resetRuntimeCapture();
    mockConfigState.config = {
      gateway: {
        mode: "local",
        bind: "custom",
        customBindHost: "10.0.0.5",
        tls: { enabled: true },
      },
    };
    loadGatewayTlsRuntime.mockResolvedValueOnce({
      enabled: true,
      required: true,
      fingerprintSha256: "sha256:11:22:33:44",
    });
    startGatewayServer.mockRejectedValueOnce(
      new GatewayLockError("another gateway instance is already listening", {
        code: "EADDRINUSE",
      }),
    );
    probeGateway.mockResolvedValueOnce({
      ok: true,
      url: "wss://10.0.0.5:18789",
      connectLatencyMs: 5,
      error: null,
      close: null,
      health: { ok: true },
      status: { ok: true },
      presence: null,
      configSnapshot: { ok: true },
    });

    await expect(
      runGatewayCommand(["gateway", "--token", "test-token", "--allow-unconfigured"]),
    ).rejects.toThrow("__exit__:0");

    expect(probeGateway).toHaveBeenCalledWith({
      url: "wss://10.0.0.5:18789",
      auth: { token: "test-token", password: undefined },
      tlsFingerprint: "sha256:11:22:33:44",
      headers: undefined,
      timeoutMs: 3000,
    });
    expect(runtimeLogs.join("\n")).toContain("existing listener is healthy");
    expect(runtimeErrors).toEqual([]);
  });

  it("falls back to loopback as a secondary probe target when the primary bind URL fails", async () => {
    resetRuntimeCapture();
    mockConfigState.config = {
      gateway: {
        mode: "local",
        bind: "custom",
        customBindHost: "10.0.0.5",
        tls: { enabled: true },
      },
    };
    loadGatewayTlsRuntime.mockResolvedValueOnce({
      enabled: true,
      required: true,
      fingerprintSha256: "sha256:11:22:33:44",
    });
    startGatewayServer.mockRejectedValueOnce(
      new GatewayLockError("another gateway instance is already listening", {
        code: "EADDRINUSE",
      }),
    );
    probeGateway
      .mockResolvedValueOnce({
        ok: false,
        url: "wss://10.0.0.5:18789",
        connectLatencyMs: null,
        error: "timeout",
        close: null,
        health: null,
        status: null,
        presence: null,
        configSnapshot: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        url: "wss://127.0.0.1:18789",
        connectLatencyMs: 6,
        error: null,
        close: null,
        health: { ok: true },
        status: { ok: true },
        presence: null,
        configSnapshot: { ok: true },
      });

    await expect(
      runGatewayCommand(["gateway", "--token", "test-token", "--allow-unconfigured"]),
    ).rejects.toThrow("__exit__:0");

    expect(probeGateway).toHaveBeenNthCalledWith(1, {
      url: "wss://10.0.0.5:18789",
      auth: { token: "test-token", password: undefined },
      tlsFingerprint: "sha256:11:22:33:44",
      headers: undefined,
      timeoutMs: 3000,
    });
    expect(probeGateway).toHaveBeenNthCalledWith(2, {
      url: "wss://127.0.0.1:18789",
      auth: { token: "test-token", password: undefined },
      tlsFingerprint: "sha256:11:22:33:44",
      headers: undefined,
      timeoutMs: 3000,
    });
  });

  it("skips non-loopback plaintext probe URLs that GatewayClient would reject", async () => {
    resetRuntimeCapture();
    mockConfigState.config = {
      gateway: {
        mode: "local",
        bind: "custom",
        customBindHost: "10.0.0.5",
        tls: { enabled: false },
      },
    };
    startGatewayServer.mockRejectedValueOnce(
      new GatewayLockError("another gateway instance is already listening", {
        code: "EADDRINUSE",
      }),
    );
    probeGateway.mockResolvedValueOnce({
      ok: true,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: 6,
      error: null,
      close: null,
      health: { ok: true },
      status: { ok: true },
      presence: null,
      configSnapshot: { ok: true },
    });

    await expect(
      runGatewayCommand(["gateway", "--token", "test-token", "--allow-unconfigured"]),
    ).rejects.toThrow("__exit__:0");

    expect(probeGateway).toHaveBeenCalledTimes(1);
    expect(probeGateway).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:18789",
      auth: { token: "test-token", password: undefined },
      tlsFingerprint: undefined,
      headers: undefined,
      timeoutMs: 3000,
    });
  });

  it("includes private plaintext probe URLs only with the break-glass override", async () => {
    await withEnvOverride({ OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1" }, async () => {
      resetRuntimeCapture();
      mockConfigState.config = {
        gateway: {
          mode: "local",
          bind: "custom",
          customBindHost: "10.0.0.5",
          tls: { enabled: false },
        },
      };
      startGatewayServer.mockRejectedValueOnce(
        new GatewayLockError("another gateway instance is already listening", {
          code: "EADDRINUSE",
        }),
      );
      probeGateway.mockResolvedValueOnce({
        ok: true,
        url: "ws://10.0.0.5:18789",
        connectLatencyMs: 5,
        error: null,
        close: null,
        health: { ok: true },
        status: { ok: true },
        presence: null,
        configSnapshot: { ok: true },
      });

      await expect(
        runGatewayCommand(["gateway", "--token", "test-token", "--allow-unconfigured"]),
      ).rejects.toThrow("__exit__:0");

      expect(probeGateway).toHaveBeenCalledTimes(1);
      expect(probeGateway).toHaveBeenCalledWith({
        url: "ws://10.0.0.5:18789",
        auth: { token: "test-token", password: undefined },
        tlsFingerprint: undefined,
        headers: undefined,
        timeoutMs: 3000,
      });
    });
  });

  it("uses trusted-proxy headers instead of shared-secret auth for port-conflict probes", async () => {
    resetRuntimeCapture();
    mockConfigState.config = {
      gateway: {
        mode: "local",
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "x-auth-user",
            requiredHeaders: ["x-auth-gateway"],
            allowUsers: ["alice"],
          },
        },
        trustedProxies: ["127.0.0.1/32"],
      },
    };
    startGatewayServer.mockRejectedValueOnce(
      new GatewayLockError("another gateway instance is already listening", {
        code: "EADDRINUSE",
      }),
    );
    probeGateway.mockResolvedValueOnce({
      ok: true,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: 5,
      error: null,
      close: null,
      health: { ok: true },
      status: { ok: true },
      presence: null,
      configSnapshot: { ok: true },
    });

    await expect(runGatewayCommand(["gateway", "--allow-unconfigured"])).rejects.toThrow(
      "__exit__:0",
    );

    expect(probeGateway).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:18789",
      auth: { token: undefined, password: undefined },
      tlsFingerprint: undefined,
      headers: {
        "x-auth-gateway": "openclaw-self-probe",
        "x-auth-user": "alice",
      },
      timeoutMs: 3000,
    });
  });

  it("uses env/config port when --port is omitted", async () => {
    await withEnvOverride({ OPENCLAW_GATEWAY_PORT: "19001" }, async () => {
      resetRuntimeCapture();
      startGatewayServer.mockClear();

      startGatewayServer.mockRejectedValueOnce(new Error("nope"));
      await expectGatewayExit(["gateway", "--token", "test-token", "--allow-unconfigured"]);

      expect(startGatewayServer).toHaveBeenCalledWith(19001, expect.anything());
    });
  });
});
