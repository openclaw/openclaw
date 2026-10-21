import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    probeGateway: vi.fn(async (opts: { url: string }) => successfulProbe(opts.url)),
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
  return probeGateway.mock.calls.map(([call]) => call as ProbeGatewayCall);
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

async function runGatewayStatus(
  runtime: RuntimeEnv,
  opts: Parameters<typeof gatewayStatusCommand>[0],
) {
  await gatewayStatusCommand(opts, runtime);
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
  beforeEach(() => {
    vi.clearAllMocks();
    readBestEffortConfig.mockReset().mockImplementation(defaultConfigReader);
    probeGateway.mockReset().mockImplementation(async ({ url }) => mocks.successfulProbe(url));
  });

  it("prints human output by default", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();

    await runGatewayStatus(runtime, { timeout: "1000" });

    expect(runtimeErrors).toHaveLength(0);
    expect(runtimeLogs.join("\n")).toContain("Gateway Status");
    expect(runtimeLogs.join("\n")).toContain("Discovery (this machine)");
    expect(runtimeLogs.join("\n")).toContain("Targets");
  });

  it("warns with diagnostic next steps when no probes or Bonjour discovery find a gateway", async () => {
    const { runtime, runtimeLogs } = createRuntimeCapture();
    readBestEffortConfig.mockResolvedValueOnce(localGatewayConfig());
    probeGateway.mockImplementation(async ({ url }) =>
      createUnreachableGatewayProbe(url, "connection refused"),
    );

    await expect(runGatewayStatus(runtime, { timeout: "1000", json: true })).rejects.toThrow(
      "__exit__:1",
    );

    expect(JSON.parse(runtimeLogs.join("\n"))).toMatchObject({
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
    {
      name: "suppresses warning for SSH tunnel and configured remote with the same self identity",
      ssh: "user@gateway-host",
      localSelf: gatewayProcessSelf,
      remoteSelf: { ...gatewayProcessSelf, host: "GATEWAY-HOST" },
      expectedTargetIds: null,
      primaryTargetId: "sshTunnel",
    },
    {
      name: "suppresses warning for the same self identity on different transport ports",
      ssh: null,
      localSelf: gatewayProcessSelf,
      remoteSelf: gatewayProcessSelf,
      expectedTargetIds: null,
      primaryTargetId: "explicit",
    },
    {
      name: "warns when same-host probes do not report process identity",
      ssh: null,
      localSelf: gatewaySelf,
      remoteSelf: gatewaySelf,
      expectedTargetIds: ["explicit", "localLoopback"],
      primaryTargetId: "explicit",
    },
    {
      name: "warns when probes report distinct identities",
      ssh: "user@gateway-a",
      localSelf: { ...gatewayProcessSelf, host: "gateway-a", instanceId: "gateway-instance-a" },
      remoteSelf: {
        ...gatewayProcessSelf,
        host: "gateway-b",
        ip: "192.0.2.11",
        instanceId: "gateway-instance-b",
      },
      expectedTargetIds: ["sshTunnel", "configRemote"],
      primaryTargetId: "sshTunnel",
    },
    {
      name: "warns when probe identity is unknown",
      ssh: "user@gateway-host",
      localSelf: null,
      remoteSelf: null,
      expectedTargetIds: ["sshTunnel", "configRemote"],
      primaryTargetId: "sshTunnel",
    },
  ])("$name", async ({ ssh, localSelf, remoteSelf, expectedTargetIds, primaryTargetId }) => {
    const { runtime, runtimeLogs } = createRuntimeCapture();
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

    await runGatewayStatus(runtime, {
      timeout: "1000",
      json: true,
      ...(ssh ? { ssh } : { url: "ws://gateway-host:28789", token: "explicit-token" }),
    });

    expect(JSON.parse(runtimeLogs.join("\n"))).toMatchObject({
      ok: true,
      primaryTargetId,
      warnings: expectedTargetIds
        ? [
            {
              code: "multiple_gateways",
              message:
                "Unconventional setup: multiple reachable gateway identities detected. Usually one gateway per network is recommended unless you intentionally run isolated profiles, like a rescue bot (see docs: /gateway#multiple-gateways-same-host).",
              targetIds: expectedTargetIds,
            },
          ]
        : [],
    });
  });

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
            const { runtime } = createRuntimeCapture();
            await expect(
              runGatewayStatus(runtime, {
                timeout: "1000",
                json: true,
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
          const { runtime } = createRuntimeCapture();
          await runGatewayStatus(runtime, {
            timeout: "1000",
            json: true,
            url: explicitUrl,
            ...options,
          });

          expect(requireProbeCall(explicitUrl).auth).toEqual(expectedAuth);
        },
      );
    },
  );

  it("keeps status output working when tailnet discovery throws", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    pickPrimaryTailnetIPv4.mockImplementationOnce(() => {
      throw new Error("uv_interface_addresses failed");
    });

    await runGatewayStatus(runtime, { timeout: "1000", json: true });

    expect(runtimeErrors).toHaveLength(0);
    expect(JSON.parse(runtimeLogs.join("\n"))).toMatchObject({
      network: { tailnetIPv4: null, localTailnetUrl: null },
    });
  });

  it("treats missing-scope RPC probe failures as degraded but reachable", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    readBestEffortConfig.mockResolvedValueOnce(localGatewayConfig() as never);
    probeGateway.mockResolvedValueOnce({
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: 51,
      gatewayReached: true,
      error: "missing scope: operator.read",
      close: null,
      auth: {
        role: "operator",
        scopes: ["operator.write"],
        capability: "write_capable",
      },
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });

    await runGatewayStatus(runtime, { timeout: "1000", json: true });

    expect(runtimeErrors).toHaveLength(0);
    expect(JSON.parse(runtimeLogs.join("\n"))).toMatchObject({
      ok: true,
      degraded: true,
      capability: "write_capable",
      targets: [
        expect.objectContaining({
          connect: expect.objectContaining({ ok: true, rpcOk: false, scopeLimited: true }),
          auth: expect.objectContaining({ capability: "write_capable" }),
        }),
      ],
      warnings: expect.arrayContaining([
        expect.objectContaining({
          code: "probe_scope_limited",
          targetIds: expect.arrayContaining(["localLoopback"]),
        }),
      ]),
    });
  });

  it("surfaces unresolved SecretRef auth diagnostics when probe fails", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
    await withEnvAsync(
      { MISSING_GATEWAY_TOKEN: undefined, OPENCLAW_GATEWAY_TOKEN: undefined },
      async () => {
        mockLocalTokenEnvRefConfig();
        probeGateway.mockImplementation(async (opts: { url: string }) => {
          const { url } = opts;
          return createUnreachableGatewayProbe(url, "connection refused");
        });
        await expect(runGatewayStatus(runtime, { timeout: "1000", json: true })).rejects.toThrow(
          "__exit__:1",
        );
      },
    );

    expect(runtimeErrors).toHaveLength(0);
    const unresolvedWarning = requireUnresolvedSecretRefWarning(runtimeLogs);
    expect(unresolvedWarning.targetIds).toContain("localLoopback");
    expect(unresolvedWarning.message).toContain("env:default:MISSING_GATEWAY_TOKEN");
    expect(unresolvedWarning.message).not.toContain("missing or empty");
  });

  it("does not replace an unresolved local token SecretRef with OPENCLAW_GATEWAY_TOKEN", async () => {
    const { runtime, runtimeErrors } = createRuntimeCapture();
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        MISSING_GATEWAY_TOKEN: undefined,
      },
      async () => {
        mockLocalTokenEnvRefConfig();

        await runGatewayStatus(runtime, { timeout: "1000", json: true });
      },
    );

    expect(runtimeErrors).toHaveLength(0);
    const localProbeCall = requireProbeCall("ws://127.0.0.1:18789");
    expect(localProbeCall.auth?.token).toBeUndefined();
  });

  it("emits stable SecretRef auth configuration booleans in --json output", async () => {
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
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

    await runGatewayStatus(runtime, { timeout: "1000", json: true });

    expect(runtimeErrors).toHaveLength(0);
    const parsed = JSON.parse(runtimeLogs.join("\n")) as {
      targets?: Array<Record<string, unknown>>;
    };
    const configRemoteTarget = parsed.targets?.find((target) => target.kind === "configRemote");
    expect(configRemoteTarget?.config).toMatchInlineSnapshot(`
      {
        "discovery": {
          "wideAreaEnabled": true,
        },
        "exists": true,
        "gateway": {
          "authMode": "token",
          "authPasswordConfigured": true,
          "authTokenConfigured": true,
          "bind": null,
          "controlUiBasePath": null,
          "controlUiEnabled": null,
          "mode": "remote",
          "port": null,
          "remotePasswordConfigured": true,
          "remoteTokenConfigured": true,
          "remoteUrl": "wss://remote.example:18789",
          "tailscaleMode": null,
        },
        "issues": [],
        "legacyIssues": [],
        "path": "/tmp/secretref-config.json",
        "valid": true,
      }
    `);
  });

  it("supports SSH tunnel targets", async () => {
    const { runtime, runtimeLogs } = createRuntimeCapture();

    await runGatewayStatus(runtime, { timeout: "1000", json: true, ssh: "me@studio" });

    expect(startSshPortForward).toHaveBeenCalledTimes(1);
    expect(probeGateway).toHaveBeenCalled();
    const tunnelCall = readProbeCalls().find((call) => call.url.startsWith("ws://127.0.0.1:"));
    expect(tunnelCall?.auth?.token).toBe("rtok");
    expect(tunnelCall?.sshTunnel).toMatchObject({ target: "me@studio", remotePort: 18789 });
    const tunnelSignal = requireSshForwardCall().signal;
    expect(tunnelSignal).toBeInstanceOf(AbortSignal);
    expect(tunnelCall?.signal).toBe(tunnelSignal);
    expect(sshStop).toHaveBeenCalledTimes(1);

    const parsed = JSON.parse(runtimeLogs.join("\n")) as Record<string, unknown>;
    const targets = parsed.targets as Array<Record<string, unknown>>;
    const targetKinds = targets.map((target) => target.kind);
    expect(targetKinds).toContain("sshTunnel");
    const sshTarget = targets.find((target) => target.kind === "sshTunnel");
    expect(sshTarget?.tunnel).toEqual({
      kind: "ssh",
      target: "me@studio",
      localPort: 18789,
      remotePort: 18789,
      pid: 123,
    });
  });

  it("uses local TLS target strategy and fingerprint for local loopback probes", async () => {
    const { runtime } = createRuntimeCapture();
    readBestEffortConfig.mockResolvedValueOnce(localGatewayConfig("ltok", true) as never);

    await runGatewayStatus(runtime, { timeout: "15000", json: true });

    expect(inspectGatewayTlsCertificate).toHaveBeenCalledTimes(1);
    const localProbeCall = requireProbeCall("wss://127.0.0.1:18789");
    expect(localProbeCall.originScopedDeviceAuth).toBeUndefined();
    expect(localProbeCall.tlsFingerprint).toBe("sha256:local-fingerprint");
    expect(localProbeCall.timeoutMs).toBe(15_000);
  });

  it("warns when local TLS is enabled but the certificate fingerprint cannot be loaded", async () => {
    const { runtime, runtimeLogs } = createRuntimeCapture();
    inspectGatewayTlsCertificate.mockResolvedValueOnce({
      ok: false,
      error: "gateway tls: failed to load cert (missing certificate)",
    });
    readBestEffortConfig.mockResolvedValueOnce(localGatewayConfig("ltok", true) as never);

    await runGatewayStatus(runtime, { timeout: "15000", json: true });

    const localProbeCall = requireProbeCall("wss://127.0.0.1:18789");
    expect(localProbeCall.tlsFingerprint).toBeUndefined();

    expect(JSON.parse(runtimeLogs.join("\n"))).toMatchObject({
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
    const { runtime, runtimeLogs, runtimeErrors } = createRuntimeCapture();
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
        await runGatewayStatus(runtime, { timeout: "15000", json: true, port: "19080" });
      },
    );

    expect(runtimeErrors).toHaveLength(0);
    expect(readProbeCalls().map((call) => call.url)).toEqual(["ws://127.0.0.1:19080"]);
    expect(requireProbeCall("ws://127.0.0.1:19080").timeoutMs).toBe(15_000);
    expect(JSON.parse(runtimeLogs.join("\n"))).toMatchObject({
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
      const { runtime } = createRuntimeCapture();
      await withEnvAsync({ USER: "steipete" }, async () => {
        readBestEffortConfig.mockResolvedValueOnce(makeRemoteGatewayConfig("", "", "ltok"));
        discoverGatewayBeacons.mockResolvedValueOnce([
          { instanceName: "bad", tailnetDns: "-V" },
          resolved
            ? { host: "goodhost", sshPort: 2222, port: 18789, instanceName: "Gateway" }
            : { instanceName: "txt-only", tailnetDns: "goodhost" },
        ]);

        await runGatewayStatus(runtime, { timeout: "1000", json: true, sshAuto: true });

        expect(startSshPortForward).toHaveBeenCalledTimes(resolved ? 1 : 0);
        if (resolved) {
          expect(requireSshForwardCall().target).toBe("steipete@goodhost:2222");
        }
      });
    },
  );

  it("infers SSH target from gateway.remote.url and ssh config", async () => {
    const { runtime } = createRuntimeCapture();
    await withEnvAsync({ USER: "steipete" }, async () => {
      readBestEffortConfig.mockResolvedValueOnce(
        makeRemoteGatewayConfig("ws://peters-mac-studio-1.sheep-coho.ts.net:18789"),
      );
      resolveSshConfig.mockResolvedValueOnce({
        user: "steipete",
        host: "peters-mac-studio-1.sheep-coho.ts.net",
        port: 2222,
        identityFiles: ["/tmp/id_ed25519"],
      });

      await runGatewayStatus(runtime, { timeout: "1000", json: true });

      expect(startSshPortForward).toHaveBeenCalledTimes(1);
      const call = requireSshForwardCall();
      expect(call.target).toBe("steipete@peters-mac-studio-1.sheep-coho.ts.net:2222");
      expect(call.identity).toBe("/tmp/id_ed25519");
    });
  });

  it("falls back to host-only when USER is missing and ssh config is unavailable", async () => {
    const { runtime } = createRuntimeCapture();
    await withEnvAsync({ USER: "" }, async () => {
      readBestEffortConfig.mockResolvedValueOnce(
        makeRemoteGatewayConfig("wss://studio.example:18789"),
      );
      resolveSshConfig.mockResolvedValueOnce(null);

      await runGatewayStatus(runtime, { timeout: "1000", json: true });

      const call = requireSshForwardCall();
      expect(call.target).toBe("studio.example");
    });
  });

  it("keeps explicit SSH identity even when ssh config provides one", async () => {
    const { runtime } = createRuntimeCapture();

    readBestEffortConfig.mockResolvedValueOnce(
      makeRemoteGatewayConfig("wss://studio.example:18789"),
    );
    resolveSshConfig.mockResolvedValueOnce({
      user: "me",
      host: "studio.example",
      port: 22,
      identityFiles: ["/tmp/id_from_config"],
    });

    await runGatewayStatus(runtime, {
      timeout: "1000",
      json: true,
      sshIdentity: "/tmp/explicit_id",
    });

    const call = requireSshForwardCall();
    expect(call.identity).toBe("/tmp/explicit_id");
  });

  it("derives summary capability from reachable probes only in json output", async () => {
    const { runtime, runtimeLogs } = createRuntimeCapture();
    probeGateway.mockImplementation(async ({ url }) => ({
      ...mocks.successfulProbe(url),
      ...(url.includes("127.0.0.1") ? {} : { ok: false, connectLatencyMs: null, error: "timeout" }),
    }));

    await runGatewayStatus(runtime, { timeout: "5000", json: true });

    expect(runtimeLogs).toHaveLength(1);
    const payload = JSON.parse(runtimeLogs.join("\n")) as { ok?: unknown; capability?: unknown };
    expect(payload?.ok).toBe(true);
    expect(payload?.capability).toBe("read_only");
  });

  it("derives summary capability from reachable probes only in text output", async () => {
    const { runtime, runtimeLogs } = createRuntimeCapture();
    probeGateway.mockImplementation(async ({ url }) => ({
      ...mocks.successfulProbe(url),
      ok: false,
      ...(url.includes("127.0.0.1")
        ? { gatewayReached: true, error: "missing scope: operator.read" }
        : { connectLatencyMs: null, error: "timeout" }),
    }));

    await runGatewayStatus(runtime, { timeout: "5000" });

    expect(runtimeLogs.map(stripAnsi)).toContain("Capability: read-only");
  });

  it("reports post-connect detail failures as reachable but degraded in json output", async () => {
    const { runtime, runtimeLogs } = createRuntimeCapture();
    readBestEffortConfig.mockResolvedValueOnce(localGatewayConfig());
    probeGateway.mockImplementation(async ({ url }) => ({
      ...mocks.successfulProbe(url),
      ok: false,
      gatewayReached: true,
      connectLatencyMs: 40,
      error: "timeout",
      server: { version: "2026.4.24", buildId: "build-test", connId: "conn-test" },
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    }));

    await runGatewayStatus(runtime, { timeout: "5000", json: true });

    expect(runtimeLogs).toHaveLength(1);
    const payload: unknown = JSON.parse(runtimeLogs.join("\n"));
    expect(payload).toStrictEqual({
      ok: true,
      degraded: true,
      capability: "read_only",
      ts: expect.any(Number),
      durationMs: expect.any(Number),
      timeoutMs: 5_000,
      primaryTargetId: "localLoopback",
      warnings: [
        {
          code: "probe_detail_failed",
          message:
            "Gateway accepted the WebSocket connection, but follow-up read diagnostics failed: timeout",
          targetIds: ["localLoopback"],
        },
      ],
      network: {
        localLoopbackUrl: "ws://127.0.0.1:18789",
        localTailnetUrl: "ws://100.64.0.10:18789",
        tailnetIPv4: "100.64.0.10",
      },
      discovery: {
        timeoutMs: 1200,
        count: 0,
        beacons: [],
      },
      targets: [
        {
          id: "localLoopback",
          kind: "localLoopback",
          url: "ws://127.0.0.1:18789",
          active: true,
          tunnel: null,
          connect: {
            ok: true,
            rpcOk: false,
            scopeLimited: false,
            latencyMs: 40,
            error: "timeout",
            close: null,
          },
          auth: {
            role: "operator",
            scopes: ["operator.read"],
            capability: "read_only",
          },
          server: {
            version: "2026.4.24",
            buildId: "build-test",
            connId: "conn-test",
          },
          self: null,
          config: null,
          health: null,
          summary: null,
          presence: null,
        },
      ],
    });
  });
});
