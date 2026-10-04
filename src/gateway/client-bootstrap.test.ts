// Gateway client bootstrap tests keep URL override provenance wired into shared
// auth resolution so CLI and env callers authenticate against the intended target.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { inspectGatewayTlsCertificate } from "../infra/tls/gateway.js";
import type { buildGatewayConnectionDetailsWithResolvers } from "./connection-details.js";
import type { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";

const mockState = vi.hoisted(() => ({
  buildGatewayConnectionDetails: vi.fn<typeof buildGatewayConnectionDetailsWithResolvers>(),
  inspectGatewayTlsCertificate: vi.fn<typeof inspectGatewayTlsCertificate>(),
  resolveGatewayCredentialsWithSecretInputs:
    vi.fn<typeof resolveGatewayCredentialsWithSecretInputs>(),
}));

vi.mock("../infra/tls/gateway.js", () => ({
  inspectGatewayTlsCertificate: mockState.inspectGatewayTlsCertificate,
}));

vi.mock("./connection-details.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./connection-details.js")>()),
  buildGatewayConnectionDetailsWithResolvers: mockState.buildGatewayConnectionDetails,
}));

vi.mock("./credentials-secret-inputs.js", () => ({
  resolveGatewayCredentialsWithSecretInputs: mockState.resolveGatewayCredentialsWithSecretInputs,
}));
const { resolveGatewayClientBootstrap } = await import("./client-bootstrap.js");

const LOCAL_TLS_FINGERPRINT = "ab".repeat(32);
const REMOTE_TLS_FINGERPRINT = "cd".repeat(32);
const LOCAL_URL = "wss://127.0.0.1:18789";
const TLS_CONFIG = { enabled: true };
const SSH_SCOPE = "remote:ssh:9d0708e04e550511a6fc9dba41c94ffc895fdd5029a3e5c779f2c0bc16bd4c44";

function remoteTlsConfig(url: string, fingerprint: string): OpenClawConfig {
  return { gateway: { mode: "remote", remote: { url, tlsFingerprint: `sha256:${fingerprint}` } } };
}

function connection(url: string, urlSource: string) {
  return { url, urlSource, message: `Gateway target: ${url}` };
}

describe("resolveGatewayClientBootstrap", () => {
  beforeEach(() => {
    mockState.buildGatewayConnectionDetails.mockReset();
    mockState.inspectGatewayTlsCertificate.mockReset();
    mockState.inspectGatewayTlsCertificate.mockResolvedValue({
      ok: false,
      error: "gateway tls is disabled",
    });
    mockState.resolveGatewayCredentialsWithSecretInputs.mockReset();
    mockState.resolveGatewayCredentialsWithSecretInputs.mockResolvedValue({
      token: undefined,
      password: undefined,
    });
  });

  it.each([
    ["wss://override.example/ws", "cli --url", "cli"],
    ["wss://gateway.example/ws", "config gateway.remote.url", undefined],
  ] as const)("preserves auth provenance for %s", async (url, urlSource, source) => {
    const details = connection(url, urlSource);
    mockState.buildGatewayConnectionDetails.mockReturnValueOnce(details);

    const result = await resolveGatewayClientBootstrap({
      config: {},
      gatewayUrl: source ? url : undefined,
      env: process.env,
    });

    expect(result).toEqual({
      url,
      urlSource,
      connectionDetails: details,
      urlOverrideSource: source,
      deviceAuthScope: url,
      preauthHandshakeTimeoutMs: undefined,
      auth: {
        token: undefined,
        password: undefined,
      },
    });
    const [params] = mockState.resolveGatewayCredentialsWithSecretInputs.mock.lastCall ?? [];
    expect(params?.env).toBe(process.env);
    expect(params).toMatchObject({
      urlOverride: source ? url : undefined,
      urlOverrideSource: source,
    });
  });

  it.each([
    [18789, " me@studio ", 18789, SSH_SCOPE],
    [19876, "me@studio", 18789, SSH_SCOPE],
    [
      18789,
      "me@other",
      18789,
      "remote:ssh:5edeb1113b126b3d30a9ee533ab3395392e63d47c36eaf64e487d373ac34f46d",
    ],
    [
      18789,
      "me@studio",
      19876,
      "remote:ssh:e993208b4f1479276efe8579fa25f72cd56d0fcecb4d04744167d753c7b07124",
    ],
    [
      80,
      "me@studio",
      undefined,
      "remote:ssh:6c8c5d79c1d9004541ae70273a98b22705fafb16ecc4ee40547602a2277e1272",
    ],
  ] as const)(
    "binds device auth on local port %s to %s:%s",
    async (localPort, target, remotePort, scope) => {
      const url = `ws://127.0.0.1:${localPort}`;
      mockState.buildGatewayConnectionDetails.mockReturnValue(
        connection(url, "config gateway.remote.url"),
      );
      const result = await resolveGatewayClientBootstrap({
        config: {
          gateway: {
            mode: "remote",
            remote: {
              url,
              transport: "ssh",
              sshTarget: target,
              remotePort,
              sshIdentity: "/tmp/key",
              sshHostKeyPolicy: "openssh",
            },
          },
        },
        env: {},
      });

      expect(result.deviceAuthScope).toBe(scope);
      expect(result.sshTunnel).toEqual({
        target: target.trim(),
        remotePort: remotePort ?? localPort,
        identity: "/tmp/key",
        hostKeyPolicy: "openssh",
      });
    },
  );

  it.each([
    ["direct transport", "direct", "ws://127.0.0.1:18789", "cli", false],
    ["different explicit URL", "ssh", "ws://127.0.0.1:19876", "cli", false],
    ["same explicit URL", "ssh", "ws://127.0.0.1:18789", "cli", false],
    ["same environment URL", "ssh", "ws://127.0.0.1:18789", "env", false],
    ["allowed exact-target resume", "ssh", "ws://127.0.0.1:18789", "cli", true],
  ] as const)("selects SSH ownership for %s", async (_name, transport, url, source, allowExact) => {
    mockState.buildGatewayConnectionDetails.mockReturnValue(
      connection(url, source === "cli" ? "cli --url" : "env OPENCLAW_GATEWAY_URL"),
    );
    const result = await resolveGatewayClientBootstrap({
      config: {
        gateway: {
          mode: "remote",
          remote: { url: "ws://127.0.0.1:18789", transport, sshTarget: "me@studio" },
        },
      },
      ...(source === "cli" ? { gatewayUrl: url } : {}),
      allowConfiguredAuthForExactTarget: allowExact,
      env: source === "env" ? { OPENCLAW_GATEWAY_URL: url } : {},
    });

    expect(result.deviceAuthScope).toBe(allowExact ? SSH_SCOPE : url);
    expect(result.sshTunnel).toEqual(
      allowExact ? { target: "me@studio", remotePort: 18789 } : undefined,
    );
  });

  it("selects local credentials for a hosted Gateway port with a remote primary", async () => {
    const config = {
      gateway: {
        mode: "remote" as const,
        auth: { token: "local-token" },
        remote: { url: "wss://primary.example", token: "remote-token" },
      },
    };
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url: "ws://127.0.0.1:19876",
      urlSource: "local loopback",
      message: "Gateway target: ws://127.0.0.1:19876",
    });
    const credentials = await vi.importActual<typeof import("./credentials-secret-inputs.js")>(
      "./credentials-secret-inputs.js",
    );
    mockState.resolveGatewayCredentialsWithSecretInputs.mockImplementation(
      credentials.resolveGatewayCredentialsWithSecretInputs,
    );

    const result = await resolveGatewayClientBootstrap({
      config,
      localPortOverride: 19876,
      env: { OPENCLAW_GATEWAY_URL: "wss://environment.example" },
    });

    expect(result.url).toBe("ws://127.0.0.1:19876");
    expect(result.auth.token).toBe("local-token");
    expect(result.urlOverrideSource).toBeUndefined();
    expect(result.deviceAuthScope).toBeUndefined();
    expect(result.sshTunnel).toBeUndefined();
    expect(mockState.buildGatewayConnectionDetails).toHaveBeenCalledWith({
      config,
      url: undefined,
      ignoreEnvUrlOverride: true,
      localPortOverride: 19876,
    });
  });

  it.each<{
    name: string;
    url: string;
    source: string;
    config: OpenClawConfig;
    pin?: string;
    scope?: string;
    inspect?: boolean;
  }>([
    {
      name: "configured local listener",
      url: LOCAL_URL,
      source: "local loopback",
      config: { gateway: { tls: TLS_CONFIG } },
      pin: LOCAL_TLS_FINGERPRINT,
      inspect: true,
    },
    {
      name: "remote fallback to local",
      url: LOCAL_URL,
      source: "missing gateway.remote.url (fallback local)",
      config: {
        gateway: {
          mode: "remote",
          tls: TLS_CONFIG,
          remote: { tlsFingerprint: REMOTE_TLS_FINGERPRINT },
        },
      },
      pin: LOCAL_TLS_FINGERPRINT,
      inspect: true,
    },
    ...["config gateway.remote.url", "env OPENCLAW_GATEWAY_URL", "cli --url"].map((source) => ({
      name: source,
      url:
        source === "config gateway.remote.url"
          ? "wss://gateway.example/ws"
          : "wss://override.example/ws",
      source,
      config: remoteTlsConfig("wss://gateway.example/ws", REMOTE_TLS_FINGERPRINT.toUpperCase()),
      pin: source === "cli --url" ? undefined : REMOTE_TLS_FINGERPRINT,
    })),
    {
      name: "plaintext remote target fails closed",
      url: "ws://127.0.0.1:18789",
      source: "config gateway.remote.url",
      config: remoteTlsConfig("ws://127.0.0.1:18789", REMOTE_TLS_FINGERPRINT),
      pin: REMOTE_TLS_FINGERPRINT,
    },
    ...(
      [
        [
          LOCAL_TLS_FINGERPRINT,
          "remote:tls:f40b2abc628c46b0d05315dada50e36a2d04147d5d7d5c290a8ccecad5ac26ad",
        ],
        [
          REMOTE_TLS_FINGERPRINT,
          "remote:tls:684dff5e10578007130807c7d9aa95d045019428f2d404c7d708f38f2d7b5fa2",
        ],
      ] as const
    ).map(([pin, scope]) => ({
      name: `loopback scope ${pin}`,
      url: LOCAL_URL,
      source: "config gateway.remote.url",
      config: remoteTlsConfig(LOCAL_URL, pin),
      pin,
      scope,
    })),
  ])("selects TLS ownership for $name", async ({ url, source, config, pin, scope, inspect }) => {
    mockState.buildGatewayConnectionDetails.mockReturnValue(connection(url, source));
    mockState.inspectGatewayTlsCertificate.mockResolvedValue({
      ok: true,
      value: { cert: "public-certificate", fingerprintSha256: LOCAL_TLS_FINGERPRINT },
    });
    const result = await resolveGatewayClientBootstrap({
      config,
      gatewayUrl: source === "cli --url" ? url : undefined,
      env: process.env,
    });
    expect(result.tlsFingerprint).toBe(pin);
    if (inspect) {
      expect(mockState.inspectGatewayTlsCertificate).toHaveBeenCalledWith(TLS_CONFIG);
    } else {
      expect(mockState.inspectGatewayTlsCertificate).not.toHaveBeenCalled();
    }
    if (scope) {
      expect(result.deviceAuthScope).toBe(scope);
      expect(result.sshTunnel).toBeUndefined();
    }
  });

  it.each([
    {
      name: "public origin",
      host: "gateway.example",
      publicOrigin: "https://gateway.example",
      explicit: false,
      pin: undefined,
    },
    {
      name: "direct local target",
      host: "127.0.0.1:18789",
      publicOrigin: undefined,
      explicit: true,
      pin: LOCAL_TLS_FINGERPRINT,
    },
    {
      name: "public origin matching local",
      host: "127.0.0.1:18789",
      publicOrigin: "https://127.0.0.1:18789",
      explicit: false,
      pin: LOCAL_TLS_FINGERPRINT,
    },
  ])(
    "retains auth and TLS ownership for an exact $name",
    async ({ host, publicOrigin, explicit, pin }) => {
      const url = `wss://${host}/openclaw`;
      mockState.buildGatewayConnectionDetails
        .mockReturnValueOnce(connection(url, "cli --url"))
        .mockReturnValueOnce(connection(LOCAL_URL, "local loopback"));
      mockState.inspectGatewayTlsCertificate.mockResolvedValue({
        ok: true,
        value: { cert: "public-certificate", fingerprintSha256: LOCAL_TLS_FINGERPRINT },
      });
      const result = await resolveGatewayClientBootstrap({
        config: {
          gateway: {
            mode: "local",
            publicOrigin,
            controlUi: { basePath: "/openclaw" },
            tls: TLS_CONFIG,
            auth: { mode: "token", token: "configured-token" },
          },
        },
        gatewayUrl: url,
        ...(explicit ? { explicitAuth: { token: "explicit-token" } } : {}),
        authPolicy: "interactive",
        allowConfiguredAuthForExactTarget: true,
        env: process.env,
      });
      expect(result.auth.token).toBe(explicit ? "explicit-token" : "configured-token");
      expect(result.tlsFingerprint).toBe(pin);
      if (pin) {
        expect(mockState.inspectGatewayTlsCertificate).toHaveBeenCalledWith(TLS_CONFIG);
      } else {
        expect(mockState.inspectGatewayTlsCertificate).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects an invalid explicit TLS fingerprint", async () => {
    mockState.buildGatewayConnectionDetails.mockReturnValue({
      url: "wss://gateway.example/ws",
      urlSource: "cli --url",
      message: "Gateway target: wss://gateway.example/ws",
    });

    await expect(
      resolveGatewayClientBootstrap({
        config: {},
        gatewayUrl: "wss://gateway.example/ws",
        explicitTlsFingerprint: "sha256:abc123",
        env: process.env,
      }),
    ).rejects.toThrow("Invalid TLS fingerprint");
  });
});
