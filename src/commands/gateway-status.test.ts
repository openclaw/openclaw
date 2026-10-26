import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayProbeResult } from "../gateway/probe.js";
import type { GatewayBonjourBeacon } from "../infra/bonjour-discovery.js";
import type { SshResolvedConfig } from "../infra/ssh-config.js";
import type { inspectGatewayTlsCertificate as InspectGatewayTlsCertificate } from "../infra/tls/gateway.js";
import type { RuntimeEnv } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { gatewayStatusCommand } from "./gateway-status.js";
import {
  createUnreachableGatewayProbe,
  createSecretRefGatewayConfig,
} from "./gateway-status/test-support.js";

const mocks = vi.hoisted(() => {
  const sshStop = vi.fn(async () => {});
  const successfulProbe = (url: string): GatewayProbeResult => {
    const local = url.includes("127.0.0.1");
    const host = local ? "local" : "remote";
    const ip = local ? "127.0.0.1" : "100.64.0.2";
    return {
      ok: true,
      url,
      connectLatencyMs: local ? 12 : 34,
      error: null,
      close: null,
      auth: {
        role: "operator",
        scopes: [local ? "operator.read" : "operator.admin"],
        capability: local ? "read_only" : "admin_capable",
      },
      server: { version: "2026.4.24", connId: host },
      health: { ok: true },
      status: {},
      presence: [
        {
          mode: "gateway",
          reason: "self",
          host,
          ip,
          text: `Gateway: ${host} (${ip}) · app test · mode gateway · reason self`,
          ts: Date.now(),
        },
      ],
      configSnapshot: {
        path: local ? "/tmp/cfg.json" : "/tmp/remote.json",
        exists: true,
        valid: true,
        config: { gateway: { mode: local ? "local" : "remote" } },
        issues: [],
        legacyIssues: [],
      },
    };
  };
  return {
    successfulProbe,
    readBestEffortConfig: vi.fn<typeof import("../config/config.js").readBestEffortConfig>(
      async () => ({
        gateway: {
          mode: "remote",
          remote: { url: "wss://remote.example:18789", token: "rtok" },
          auth: { token: "ltok" },
        },
      }),
    ),
    resolveGatewayPort: vi.fn((_cfg?: unknown) => 18789),
    discoverGatewayBeacons: vi.fn(async (_opts?: unknown): Promise<GatewayBonjourBeacon[]> => []),
    pickPrimaryTailnetIPv4: vi.fn(() => "100.64.0.10"),
    sshStop,
    resolveSshConfig: vi.fn(async (_opts?: unknown): Promise<SshResolvedConfig | null> => null),
    startSshPortForward: vi.fn(async (_opts?: unknown) => ({
      localPort: 18789,
      pid: 123,
      closed: new Promise<void>(() => {}),
      isActive: () => true,
      stop: sshStop,
    })),
    inspectGatewayTlsCertificate: vi.fn(
      async (): ReturnType<typeof InspectGatewayTlsCertificate> => ({
        ok: true,
        value: { cert: "public-certificate", fingerprintSha256: "sha256:local-fingerprint" },
      }),
    ),
    inspectWindowsGatewayFirewall: vi.fn<() => Promise<unknown>>(async () => ({
      applies: false,
      severity: "info",
      code: "windows_firewall_not_applicable",
      message: "Windows LAN firewall diagnostics do not apply.",
      details: [],
    })),
    probeGateway: vi.fn<typeof import("../gateway/probe.js").probeGateway>(async ({ url }) =>
      successfulProbe(url),
    ),
  };
});

const {
  readBestEffortConfig,
  discoverGatewayBeacons,
  pickPrimaryTailnetIPv4,
  sshStop,
  resolveSshConfig,
  startSshPortForward,
  inspectGatewayTlsCertificate,
  probeGateway,
} = mocks;
const defaultConfigReader = expectDefined(
  readBestEffortConfig.getMockImplementation(),
  "default config reader",
);

vi.mock("../config/config.js", () => ({
  readBestEffortConfig: mocks.readBestEffortConfig,
  resolveGatewayPort: mocks.resolveGatewayPort,
}));

vi.mock("../infra/bonjour-discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/bonjour-discovery.js")>()),
  discoverGatewayBeacons: mocks.discoverGatewayBeacons,
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: mocks.pickPrimaryTailnetIPv4,
}));

vi.mock("../infra/ssh-tunnel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/ssh-tunnel.js")>()),
  startSshPortForward: mocks.startSshPortForward,
}));

vi.mock("../infra/ssh-config.js", () => ({
  resolveSshConfig: mocks.resolveSshConfig,
}));

vi.mock("../infra/tls/gateway.js", () => ({
  inspectGatewayTlsCertificate: mocks.inspectGatewayTlsCertificate,
}));

vi.mock("../infra/windows-gateway-firewall-diagnostics.js", () => ({
  inspectWindowsGatewayFirewall: mocks.inspectWindowsGatewayFirewall,
}));

vi.mock("../gateway/probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/probe.js")>()),
  probeGateway: mocks.probeGateway,
}));

function createRuntimeCapture() {
  const runtimeLogs: string[] = [];
  const runtimeErrors: string[] = [];
  const runtime: RuntimeEnv = {
    log: (msg) => runtimeLogs.push(String(msg)),
    error: (msg) => runtimeErrors.push(String(msg)),
    exit: (code: number) => {
      throw new Error(`__exit__:${code}`);
    },
  };
  return { runtime, runtimeLogs, runtimeErrors };
}

type ProbeGatewayCall = Parameters<typeof import("../gateway/probe.js").probeGateway>[0];

function readProbeCalls(): ProbeGatewayCall[] {
  return probeGateway.mock.calls.map(([call]) => call);
}

function requireProbeCall(url: string): ProbeGatewayCall {
  return expectDefined(
    readProbeCalls().find((candidate) => candidate.url === url),
    `Expected gateway probe call for ${url}`,
  );
}

function requireSshForwardCall(index = 0): Record<string, unknown> {
  const [call] = startSshPortForward.mock.calls[index] ?? [];
  if (!call || typeof call !== "object") {
    throw new Error(`Expected SSH forward call ${index}`);
  }
  return call as Record<string, unknown>;
}

function makeRemoteGatewayConfig(url: string, token = "rtok", localToken = "ltok"): OpenClawConfig {
  return {
    gateway: {
      mode: "remote",
      remote: { url, token },
      auth: { token: localToken },
    },
  };
}

function mockLocalTokenEnvRefConfig(envTokenId = "MISSING_GATEWAY_TOKEN") {
  readBestEffortConfig.mockResolvedValueOnce({
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
    gateway: {
      mode: "local",
      auth: {
        mode: "token",
        token: { source: "env", provider: "default", id: envTokenId },
      },
    },
  } as never);
}

function requireUnresolvedSecretRefWarning(runtimeLogs: string[]) {
  const parsed = JSON.parse(runtimeLogs.join("\n")) as {
    warnings?: Array<{ code?: string; message?: string; targetIds?: string[] }>;
  };
  return expectDefined(
    parsed.warnings?.find(
      (warning) =>
        warning.code === "auth_secretref_unresolved" &&
        warning.message?.includes("gateway.auth.token SecretRef is unresolved"),
    ),
    "expected unresolved gateway auth token SecretRef warning",
  );
}

const localGatewayConfig = (token = "ltok", tls = false): OpenClawConfig => ({
  gateway: {
    mode: "local",
    auth: { mode: "token", token },
    ...(tls ? { tls: { enabled: true } } : {}),
  },
});

const gatewaySelf = {
  text: "Gateway fixture",
  host: "gateway-host",
  ip: "192.0.2.10",
  version: "2026.5.22",
  platform: "linux",
};
const gatewayProcessSelf = { ...gatewaySelf, instanceId: "gateway-instance-1" };

describe("gateway-status command", () => {
  let capture: ReturnType<typeof createRuntimeCapture>;
  const run = (opts: Parameters<typeof gatewayStatusCommand>[0] = {}) =>
    gatewayStatusCommand({ timeout: "1000", json: true, ...opts }, capture.runtime);
  const output = <T = unknown>() => JSON.parse(capture.runtimeLogs.join("\n")) as T;
  beforeEach(() => {
    capture = createRuntimeCapture();
    vi.clearAllMocks();
    readBestEffortConfig.mockReset().mockImplementation(defaultConfigReader);
    probeGateway.mockReset().mockImplementation(async ({ url }) => mocks.successfulProbe(url));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks known targets during discovery and cancels unfinished checks at the overall deadline", async () => {
    vi.useFakeTimers();
    readBestEffortConfig.mockResolvedValueOnce(localGatewayConfig());
    discoverGatewayBeacons.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve([]), 1000);
        }),
    );
    probeGateway.mockImplementation(async (opts) => {
      if (opts.url.includes("127.0.0.1")) {
        return mocks.successfulProbe(opts.url);
      }
      return await new Promise<GatewayProbeResult>((resolve) => {
        const timer = setTimeout(
          () => resolve(createUnreachableGatewayProbe(opts.url, "late timeout")),
          2000,
        );
        opts.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve(createUnreachableGatewayProbe(opts.url, "aborted"));
        });
      });
    });

    const command = run({
      url: "wss://slow.example:18789",
      token: "explicit-token",
    });
    await vi.advanceTimersByTimeAsync(500);
    const startedDuringDiscovery = readProbeCalls().map((call) => call.url);
    await vi.advanceTimersByTimeAsync(2500);
    await command;

    expect(startedDuringDiscovery).toEqual(["wss://slow.example:18789", "ws://127.0.0.1:18789"]);
    expect(output()).toMatchObject({
      ok: true,
      durationMs: 1000,
      primaryTargetId: "localLoopback",
      targets: [
        { id: "explicit", connect: { ok: false, error: "timeout" } },
        { id: "localLoopback", connect: { ok: true } },
      ],
    });
  });

  it("prints human output by default", async () => {
    await gatewayStatusCommand({ timeout: "1000" }, capture.runtime);

    expect(capture.runtimeErrors).toHaveLength(0);
    expect(capture.runtimeLogs.join("\n")).toContain("Gateway Status");
    expect(capture.runtimeLogs.join("\n")).toContain("Discovery (this machine)");
    expect(capture.runtimeLogs.join("\n")).toContain("Targets");
    expect(stripAnsi(capture.runtimeLogs.join("\n"))).toContain(
      "Remote (configured) wss://remote.example:18789",
    );
    expect(stripAnsi(capture.runtimeLogs.join("\n"))).toContain(
      "Remote over SSH ws://127.0.0.1:18789",
    );
  });

  it("warns with diagnostic next steps when no probes or Bonjour discovery find a gateway", async () => {
    readBestEffortConfig.mockResolvedValueOnce(localGatewayConfig());
    probeGateway.mockImplementation(async ({ url }) =>
      createUnreachableGatewayProbe(url, "connection refused"),
    );

    await expect(run()).rejects.toThrow("__exit__:1");

    expect(output()).toMatchObject({
      ok: false,
      primaryTargetId: null,
      warnings: [
        {
          code: "no_gateway_reachable",
          message:
            "No gateway answered any check and Bonjour discovery returned no local gateways. Run `openclaw gateway status --deep --require-rpc` to inspect service state, config paths, listener owners, and logs; include `ss -ltnp` or `lsof -nP -iTCP:<port> -sTCP:LISTEN` for the configured port when filing a report.",
          targetIds: ["localLoopback"],
        },
      ],
    });
  });

  it.each([
    [
      "same process via SSH",
      true,
      gatewayProcessSelf,
      { ...gatewayProcessSelf, host: "GATEWAY-HOST" },
      false,
    ],
    ["same process on different ports", false, gatewayProcessSelf, gatewayProcessSelf, false],
    ["same host without process identity", false, gatewaySelf, gatewaySelf, true],
    [
      "distinct processes",
      true,
      gatewayProcessSelf,
      { ...gatewayProcessSelf, host: "other-host", instanceId: "other-instance" },
      true,
    ],
    ["unknown identity", true, null, null, true],
  ] as const)(
    "detects multiple gateways: %s",
    async (_name, useSsh, localSelf, remoteSelf, warn) => {
      const ssh = useSsh ? "user@gateway-host" : null;
      const primaryTargetId = useSsh ? "sshTunnel" : "explicit";
      readBestEffortConfig.mockResolvedValueOnce(
        ssh ? makeRemoteGatewayConfig("ws://gateway-host:18789") : localGatewayConfig(),
      );
      probeGateway.mockImplementation(async ({ url }) => {
        const self = url.includes("127.0.0.1") ? localSelf : remoteSelf;
        return {
          ...mocks.successfulProbe(url),
          presence: self ? [{ ...self, ts: 0, mode: "gateway", reason: "self" }] : null,
        };
      });

      await run(ssh ? { ssh } : { url: "ws://gateway-host:28789", token: "explicit-token" });

      expect(output()).toMatchObject({
        ok: true,
        primaryTargetId,
        warnings: warn
          ? [
              {
                code: "multiple_gateways",
                message:
                  "Unconventional setup: multiple reachable gateway identities detected. Usually one gateway per network is recommended unless you intentionally run isolated profiles, like a rescue bot (see docs: /gateway#multiple-gateways-same-host).",
                targetIds: [primaryTargetId, useSsh ? "configRemote" : "localLoopback"],
              },
            ]
          : [],
      });
    },
  );

  it("rejects configured and ambient credentials before probing an explicit URL", async () => {
    const configuredGateway = localGatewayConfig("configured-local-token");
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: "ambient-token",
        OPENCLAW_GATEWAY_PASSWORD: "ambient-password",
      },
      async () => {
        await readBestEffortConfig.withImplementation(
          async () => configuredGateway as never,
          async () => {
            await expect(
              run({
                url: "wss://attacker.example:18789",
              }),
            ).rejects.toMatchObject({
              name: "GatewayExplicitAuthRequiredError",
              message: expect.stringContaining(
                "gateway url override requires explicit credentials",
              ),
            });

            for (const effect of [
              readBestEffortConfig,
              discoverGatewayBeacons,
              startSshPortForward,
              probeGateway,
            ]) {
              expect(effect).not.toHaveBeenCalled();
            }
          },
        );
      },
    );
  });

  it.each([
    {
      credential: "token",
      options: { token: "explicit-remote-token" },
      expectedAuth: { token: "explicit-remote-token", password: undefined },
    },
    {
      credential: "password",
      options: { password: "explicit-remote-password" },
      expectedAuth: { token: undefined, password: "explicit-remote-password" },
    },
  ])(
    "honors an explicit $credential for an explicit Gateway URL",
    async ({ options, expectedAuth }) => {
      const explicitUrl = "wss://attacker.example:18789";
      readBestEffortConfig.mockResolvedValueOnce(
        localGatewayConfig("configured-local-token") as never,
      );

      await withEnvAsync(
        {
          OPENCLAW_GATEWAY_TOKEN: "ambient-local-token",
          OPENCLAW_GATEWAY_PASSWORD: "ambient-local-password",
        },
        async () => {
          await run({
            url: explicitUrl,
            ...options,
          });

          expect(requireProbeCall(explicitUrl).auth).toEqual(expectedAuth);
        },
      );
    },
  );

  it("keeps status output working when tailnet discovery throws", async () => {
    pickPrimaryTailnetIPv4.mockImplementationOnce(() => {
      throw new Error("uv_interface_addresses failed");
    });

    await run();

    expect(capture.runtimeErrors).toHaveLength(0);
    expect(output()).toMatchObject({
      network: { tailnetIPv4: null, localTailnetUrl: null },
    });
  });

  it("surfaces unresolved SecretRef auth diagnostics when probe fails", async () => {
    await withEnvAsync(
      { MISSING_GATEWAY_TOKEN: undefined, OPENCLAW_GATEWAY_TOKEN: undefined },
      async () => {
        mockLocalTokenEnvRefConfig();
        probeGateway.mockImplementation(async (opts: { url: string }) => {
          const { url } = opts;
          return createUnreachableGatewayProbe(url, "connection refused");
        });
        await expect(run()).rejects.toThrow("__exit__:1");
      },
    );

    expect(capture.runtimeErrors).toHaveLength(0);
    const unresolvedWarning = requireUnresolvedSecretRefWarning(capture.runtimeLogs);
    expect(unresolvedWarning.targetIds).toContain("localLoopback");
    expect(unresolvedWarning.message).toContain("env:default:MISSING_GATEWAY_TOKEN");
    expect(unresolvedWarning.message).not.toContain("missing or empty");
  });

  it("does not replace an unresolved local token SecretRef with OPENCLAW_GATEWAY_TOKEN", async () => {
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        MISSING_GATEWAY_TOKEN: undefined,
      },
      async () => {
        mockLocalTokenEnvRefConfig();

        await run();
      },
    );

    expect(capture.runtimeErrors).toHaveLength(0);
    const localProbeCall = requireProbeCall("ws://127.0.0.1:18789");
    expect(localProbeCall.auth?.token).toBeUndefined();
  });

  it("emits stable SecretRef auth configuration booleans in --json output", async () => {
    probeGateway.mockImplementation(async (opts: { url: string }) => ({
      ...mocks.successfulProbe(opts.url),
      server: undefined,
      connectLatencyMs: 20,
      auth: {
        role: "operator",
        scopes: ["operator.read"],
        capability: "read_only",
      },
      presence: mocks.successfulProbe("wss://remote.example:18789").presence,
      configSnapshot: {
        path: "/tmp/secretref-config.json",
        exists: true,
        valid: true,
        config: {
          ...createSecretRefGatewayConfig({ gatewayMode: "remote" }),
          discovery: {
            wideArea: { domain: "openclaw.internal" },
          },
        },
        issues: [],
        legacyIssues: [],
      },
    }));

    await run();

    expect(capture.runtimeErrors).toHaveLength(0);
    const parsed = output() as {
      targets?: Array<Record<string, unknown>>;
    };
    const configRemoteTarget = parsed.targets?.find((target) => target.kind === "configRemote");
    expect(configRemoteTarget?.config).toEqual({
      discovery: { wideAreaEnabled: true },
      exists: true,
      gateway: {
        authMode: "token",
        authPasswordConfigured: true,
        authTokenConfigured: true,
        bind: null,
        controlUiBasePath: null,
        controlUiEnabled: null,
        mode: "remote",
        port: null,
        remotePasswordConfigured: true,
        remoteTokenConfigured: true,
        remoteUrl: "wss://remote.example:18789",
        tailscaleMode: null,
      },
      issues: [],
      legacyIssues: [],
      path: "/tmp/secretref-config.json",
      valid: true,
    });
  });

  it("supports SSH tunnel targets", async () => {
    await run({ ssh: "me@studio" });

    expect(startSshPortForward).toHaveBeenCalledTimes(1);
    const tunnelCall = readProbeCalls().find((call) => call.sshTunnel);
    expect(tunnelCall?.auth?.token).toBe("rtok");
    expect(tunnelCall?.sshTunnel).toMatchObject({ target: "me@studio", remotePort: 18789 });
    const tunnelSignal = requireSshForwardCall().signal;
    expect(tunnelSignal).toBeInstanceOf(AbortSignal);
    expect(tunnelCall?.signal).toBe(tunnelSignal);
    expect(sshStop).toHaveBeenCalledTimes(1);

    const sshTarget = output<{ targets: Array<{ kind: string; tunnel: unknown }> }>().targets.find(
      (target: { kind: string }) => target.kind === "sshTunnel",
    );
    expect(sshTarget?.tunnel).toEqual({
      kind: "ssh",
      target: "me@studio",
      localPort: 18789,
      remotePort: 18789,
      pid: 123,
    });
  });

  it("finishes same-port loopback checks before binding the SSH tunnel", async () => {
    readBestEffortConfig.mockResolvedValueOnce(localGatewayConfig());
    const directStarted = Promise.withResolvers<void>();
    const finishDirect = Promise.withResolvers<void>();
    const completed: string[] = [];
    probeGateway.mockImplementation(async ({ url, sshTunnel }) => {
      if (!sshTunnel) {
        directStarted.resolve();
        await finishDirect.promise;
        completed.push(url);
      }
      return mocks.successfulProbe(url);
    });
    const command = run({
      ssh: "me@studio",
      url: "ws://localhost:18789",
      token: "explicit-token",
    });
    await directStarted.promise;
    await vi.dynamicImportSettled();
    const startedBeforeChecksFinished = startSshPortForward.mock.calls.length;
    finishDirect.resolve();
    await command;

    expect(startedBeforeChecksFinished).toBe(0);
    expect(completed).toEqual(["ws://localhost:18789", "ws://127.0.0.1:18789"]);
    expect(startSshPortForward).toHaveBeenCalledOnce();
    expect(sshStop).toHaveBeenCalledOnce();
  });

  it("uses local TLS target strategy and fingerprint for local loopback probes", async () => {
    readBestEffortConfig.mockResolvedValueOnce(localGatewayConfig("ltok", true) as never);

    await run({ timeout: "15000", json: true });

    expect(inspectGatewayTlsCertificate).toHaveBeenCalledTimes(1);
    const localProbeCall = requireProbeCall("wss://127.0.0.1:18789");
    expect(localProbeCall.originScopedDeviceAuth).toBeUndefined();
    expect(localProbeCall.tlsFingerprint).toBe("sha256:local-fingerprint");
    expect(localProbeCall.timeoutMs).toBeGreaterThan(0);
    expect(localProbeCall.timeoutMs).toBeLessThanOrEqual(15_000);
    expect(output<{ network: { localLoopbackUrl: string } }>().network.localLoopbackUrl).toBe(
      "wss://127.0.0.1:18789",
    );
  });

  it("warns when local TLS is enabled but the certificate fingerprint cannot be loaded", async () => {
    inspectGatewayTlsCertificate.mockResolvedValueOnce({
      ok: false,
      error: "gateway tls: failed to load cert (missing certificate)",
    });
    readBestEffortConfig.mockResolvedValueOnce(localGatewayConfig("ltok", true) as never);

    await run({ timeout: "15000", json: true });

    const localProbeCall = requireProbeCall("wss://127.0.0.1:18789");
    expect(localProbeCall.tlsFingerprint).toBeUndefined();

    expect(output()).toMatchObject({
      warnings: expect.arrayContaining([
        expect.objectContaining({
          code: "local_tls_runtime_unavailable",
          targetIds: ["localLoopback"],
          message: expect.stringContaining("gateway tls: failed to load cert"),
        }),
      ]),
    });
  });

  it("lets --port select the local probe despite gateway env and configured remote targets", async () => {
    readBestEffortConfig.mockResolvedValueOnce({
      gateway: {
        mode: "remote",
        port: 18789,
        remote: { url: "wss://remote.example:18789", token: "rtok" },
        auth: { mode: "token", token: "ltok" },
      },
    } as never);

    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_PORT: "19001",
        OPENCLAW_GATEWAY_URL: "wss://env-gateway.example/ws",
      },
      async () => {
        await run({ timeout: "15000", json: true, port: "19080" });
      },
    );

    expect(capture.runtimeErrors).toHaveLength(0);
    expect(readProbeCalls().map((call) => call.url)).toEqual(["ws://127.0.0.1:19080"]);
    expect(requireProbeCall("ws://127.0.0.1:19080").timeoutMs).toBeGreaterThan(0);
    expect(requireProbeCall("ws://127.0.0.1:19080").timeoutMs).toBeLessThanOrEqual(15_000);
    expect(output()).toMatchObject({
      network: { localLoopbackUrl: "ws://127.0.0.1:19080" },
      primaryTargetId: "localLoopback",
      targets: [
        expect.objectContaining({
          id: "localLoopback",
          kind: "localLoopback",
          url: "ws://127.0.0.1:19080",
        }),
      ],
    });
  });

  it.each([false, true])(
    "requires a resolved discovery host for ssh-auto (resolved=%s)",
    async (resolved) => {
      await withEnvAsync({ USER: "steipete" }, async () => {
        readBestEffortConfig.mockResolvedValueOnce(makeRemoteGatewayConfig("", "", "ltok"));
        discoverGatewayBeacons.mockResolvedValueOnce([
          { instanceName: "bad", tailnetDns: "-V" },
          resolved
            ? { host: "goodhost", sshPort: 2222, port: 18789, instanceName: "Gateway" }
            : { instanceName: "txt-only", tailnetDns: "goodhost" },
        ]);

        await run({ sshAuto: true });

        expect(startSshPortForward).toHaveBeenCalledTimes(resolved ? 1 : 0);
        if (resolved) {
          expect(requireSshForwardCall().target).toBe("steipete@goodhost:2222");
        }
      });
    },
  );

  it.each([
    { ssh: undefined, port: 2222, explicitPort: false },
    { ssh: "alias:22", port: 22, explicitPort: true },
  ])("resolves SSH port $port with explicit=$explicitPort", async ({ ssh, port, explicitPort }) => {
    await withEnvAsync({ USER: "steipete" }, async () => {
      readBestEffortConfig.mockResolvedValueOnce(
        makeRemoteGatewayConfig("ws://peters-mac-studio-1.sheep-coho.ts.net:18789"),
      );
      resolveSshConfig.mockResolvedValueOnce({
        user: "steipete",
        host: "peters-mac-studio-1.sheep-coho.ts.net",
        port,
        identityFiles: ["/tmp/id_ed25519"],
      });

      await run({ ssh });

      expect(startSshPortForward).toHaveBeenCalledTimes(1);
      expect(resolveSshConfig).toHaveBeenCalledWith(expect.anything(), {
        explicitPort,
        identity: undefined,
        timeoutMs: 800,
        signal: expect.any(AbortSignal),
      });
      const call = requireSshForwardCall();
      expect(call.target).toBe(`steipete@peters-mac-studio-1.sheep-coho.ts.net:${port}`);
      expect(call.identity).toBe("/tmp/id_ed25519");
    });
  });

  it("falls back to host-only when USER is missing and ssh config is unavailable", async () => {
    await withEnvAsync({ USER: "" }, async () => {
      readBestEffortConfig.mockResolvedValueOnce(
        makeRemoteGatewayConfig("wss://studio.example:18789"),
      );
      resolveSshConfig.mockResolvedValueOnce(null);

      await run();

      const call = requireSshForwardCall();
      expect(call.target).toBe("studio.example");
    });
  });

  it("keeps explicit SSH identity even when ssh config provides one", async () => {
    readBestEffortConfig.mockResolvedValueOnce(
      makeRemoteGatewayConfig("wss://studio.example:18789"),
    );
    resolveSshConfig.mockResolvedValueOnce({
      user: "me",
      host: "studio.example",
      port: 22,
      identityFiles: ["/tmp/id_from_config"],
    });

    await run({
      sshIdentity: "/tmp/explicit_id",
    });

    const call = requireSshForwardCall();
    expect(call.identity).toBe("/tmp/explicit_id");
  });

  it("derives summary capability from reachable probes only in json output", async () => {
    probeGateway.mockImplementation(async ({ url }) => ({
      ...mocks.successfulProbe(url),
      ...(url.includes("127.0.0.1") ? {} : { ok: false, connectLatencyMs: null, error: "timeout" }),
    }));

    await run({ timeout: "5000", json: true });

    expect(capture.runtimeLogs).toHaveLength(1);
    expect(output()).toMatchObject({ ok: true, capability: "read_only" });
  });

  it("derives summary capability from reachable probes only in text output", async () => {
    probeGateway.mockImplementation(async ({ url }) => ({
      ...mocks.successfulProbe(url),
      ok: false,
      ...(url.includes("127.0.0.1")
        ? { gatewayReached: true, error: "missing scope: operator.read" }
        : { connectLatencyMs: null, error: "timeout" }),
    }));

    await run({ timeout: "5000", json: false });

    expect(capture.runtimeLogs.map(stripAnsi)).toContain("Capability: read-only");
  });

  it.each([
    [
      "missing scope: operator.read",
      "operator.write",
      "write_capable",
      "probe_scope_limited",
      true,
    ],
    ["timeout", "operator.read", "read_only", "probe_detail_failed", false],
  ] as const)(
    "reports %s after connection as reachable but degraded",
    async (error, scope, capability, code, scopeLimited) => {
      readBestEffortConfig.mockResolvedValueOnce(localGatewayConfig());
      probeGateway.mockImplementation(async ({ url }) => ({
        ...createUnreachableGatewayProbe(url, error),
        gatewayReached: true,
        connectLatencyMs: 40,
        auth: { role: "operator", scopes: [scope], capability },
        server: { version: "2026.4.24", buildId: "build-test", connId: "conn-test" },
      }));
      await run();
      expect(capture.runtimeErrors).toHaveLength(0);
      expect(capture.runtimeLogs).toHaveLength(1);
      expect(output()).toMatchObject({
        ok: true,
        degraded: true,
        capability,
        timeoutMs: 1000,
        primaryTargetId: "localLoopback",
        warnings: [
          {
            code,
            targetIds: ["localLoopback"],
            message: scopeLimited
              ? "Read-check diagnostics are limited by gateway scopes (missing operator.read). Connection succeeded, but read-only status calls are incomplete. Hint: pair device identity or use credentials with operator.read."
              : "Gateway accepted the WebSocket connection, but follow-up read diagnostics failed: timeout",
          },
        ],
        targets: [
          {
            id: "localLoopback",
            connect: { ok: true, rpcOk: false, scopeLimited, latencyMs: 40, error, close: null },
            auth: { role: "operator", scopes: [scope], capability },
            server: { version: "2026.4.24", buildId: "build-test", connId: "conn-test" },
            self: null,
            config: null,
            health: null,
            summary: null,
            presence: null,
          },
        ],
      });
    },
  );
});
