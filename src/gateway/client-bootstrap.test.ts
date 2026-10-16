import { beforeEach, expect, it, vi } from "vitest";
import type { GatewayRemoteConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { inspectGatewayTlsCertificate } from "../infra/tls/gateway.js";
import type { buildGatewayConnectionDetailsWithResolvers } from "./connection-details.js";
import type { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";

const mocks = vi.hoisted(() => ({
  details: vi.fn<typeof buildGatewayConnectionDetailsWithResolvers>(),
  certificate: vi.fn<typeof inspectGatewayTlsCertificate>(),
  credentials: vi.fn<typeof resolveGatewayCredentialsWithSecretInputs>(),
}));

vi.mock("../infra/tls/gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/tls/gateway.js")>()),
  inspectGatewayTlsCertificate: mocks.certificate,
}));

vi.mock("./connection-details.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./connection-details.js")>()),
  buildGatewayConnectionDetailsWithResolvers: mocks.details,
}));

vi.mock("./credentials-secret-inputs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./credentials-secret-inputs.js")>()),
  resolveGatewayCredentialsWithSecretInputs: mocks.credentials,
}));
const { resolveGatewayClientBootstrap: bootstrap } = await import("./client-bootstrap.js");

const LOCAL_PIN = "ab".repeat(32);
const REMOTE_PIN = "cd".repeat(32);
const LOCAL_URL = "wss://127.0.0.1:18789";
const LOCAL_WS = "ws://127.0.0.1:18789";
const REMOTE_URL = "wss://gateway.example/ws";
const OVERRIDE_URL = "wss://override.example/ws";
const OTHER_SSH_SCOPE =
  "remote:ssh:5edeb1113b126b3d30a9ee533ab3395392e63d47c36eaf64e487d373ac34f46d";
const OTHER_PORT_SSH_SCOPE =
  "remote:ssh:e993208b4f1479276efe8579fa25f72cd56d0fcecb4d04744167d753c7b07124";
const HTTP_SSH_SCOPE =
  "remote:ssh:6c8c5d79c1d9004541ae70273a98b22705fafb16ecc4ee40547602a2277e1272";
const TLS_CONFIG = { enabled: true };
const SSH_SCOPE = "remote:ssh:9d0708e04e550511a6fc9dba41c94ffc895fdd5029a3e5c779f2c0bc16bd4c44";

function remoteConfig(
  remote: GatewayRemoteConfig,
  gateway: Pick<NonNullable<OpenClawConfig["gateway"]>, "auth" | "tls"> = {},
): OpenClawConfig {
  return { gateway: { mode: "remote", remote, ...gateway } };
}

function connection(url: string, urlSource: string) {
  return { url, urlSource, message: `Gateway target: ${url}` };
}

function inspectLocalCertificate() {
  mocks.certificate.mockResolvedValue({
    ok: true,
    value: { cert: "public-certificate", fingerprintSha256: LOCAL_PIN },
  });
}

function expectCertificateInspection(inspect: boolean) {
  expect(mocks.certificate.mock.calls).toEqual(inspect ? [[TLS_CONFIG]] : []);
}

function localTlsExpectation(source: string) {
  return { url: LOCAL_URL, source, pin: LOCAL_PIN, inspect: true, scope: undefined };
}

function remoteTlsCase(name: string, url: string, pin = REMOTE_PIN, scope?: string) {
  return {
    name,
    url,
    source: "config gateway.remote.url",
    config: remoteConfig({ url, tlsFingerprint: `sha256:${pin}` }),
    pin,
    inspect: false,
    scope,
  };
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.credentials.mockResolvedValue({});
});

it.each([
  [OVERRIDE_URL, "cli --url", "cli"],
  [REMOTE_URL, "config gateway.remote.url", undefined],
] as const)("preserves auth provenance for %s", async (url, urlSource, source) => {
  const details = connection(url, urlSource);
  mocks.details.mockReturnValueOnce(details);

  const result = await bootstrap({
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
    auth: { token: undefined, password: undefined },
  });
  const [params] = mocks.credentials.mock.lastCall ?? [];
  expect(params).toMatchObject({
    urlOverride: source ? url : undefined,
    urlOverrideSource: source,
  });
  expect(params?.env).toBe(process.env);
});

it.each([
  [18789, " me@studio ", 18789, SSH_SCOPE],
  [19876, "me@studio", 18789, SSH_SCOPE],
  [18789, "me@other", 18789, OTHER_SSH_SCOPE],
  [18789, "me@studio", 19876, OTHER_PORT_SSH_SCOPE],
  [80, "me@studio", undefined, HTTP_SSH_SCOPE],
] as const)(
  "binds device auth on local port %s to %s:%s",
  async (localPort, target, remotePort, scope) => {
    const url = `ws://127.0.0.1:${localPort}`;
    mocks.details.mockReturnValue(connection(url, "config gateway.remote.url"));
    const result = await bootstrap({
      config: remoteConfig({
        url,
        transport: "ssh",
        sshTarget: target,
        remotePort,
        sshIdentity: "/tmp/key",
        sshHostKeyPolicy: "openssh",
      }),
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
  ["direct transport", "direct", LOCAL_WS, "cli", false],
  ["different explicit URL", "ssh", "ws://127.0.0.1:19876", "cli", false],
  ["same explicit URL", "ssh", LOCAL_WS, "cli", false],
  ["same environment URL", "ssh", LOCAL_WS, "env", false],
  ["allowed exact-target resume", "ssh", LOCAL_WS, "cli", true],
] as const)("selects SSH ownership for %s", async (_name, transport, url, source, allowExact) => {
  mocks.details.mockReturnValue(
    connection(url, source === "cli" ? "cli --url" : "env OPENCLAW_GATEWAY_URL"),
  );
  const result = await bootstrap({
    config: remoteConfig({ url: LOCAL_WS, transport, sshTarget: "me@studio" }),
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
  const config = remoteConfig(
    { url: "wss://primary.example", token: "remote-token" },
    { auth: { token: "local-token" } },
  );
  mocks.details.mockReturnValue(connection("ws://127.0.0.1:19876", "local loopback"));
  const { resolveGatewayCredentialsWithSecretInputs: resolveCredentials } = await vi.importActual<
    typeof import("./credentials-secret-inputs.js")
  >("./credentials-secret-inputs.js");
  mocks.credentials.mockImplementation(resolveCredentials);

  const result = await bootstrap({
    config,
    localPortOverride: 19876,
    env: { OPENCLAW_GATEWAY_URL: "wss://environment.example" },
  });

  expect(result.url).toBe("ws://127.0.0.1:19876");
  expect(result.auth.token).toBe("local-token");
  expect(result.urlOverrideSource).toBeUndefined();
  expect(result.deviceAuthScope).toBeUndefined();
  expect(result.sshTunnel).toBeUndefined();
  expect(mocks.details).toHaveBeenCalledWith({
    config,
    url: undefined,
    ignoreEnvUrlOverride: true,
    localPortOverride: 19876,
  });
});

it.each([
  {
    name: "configured local listener",
    config: { gateway: { tls: TLS_CONFIG } },
    ...localTlsExpectation("local loopback"),
  },
  {
    name: "remote fallback to local",
    config: remoteConfig({ tlsFingerprint: REMOTE_PIN }, { tls: TLS_CONFIG }),
    ...localTlsExpectation("missing gateway.remote.url (fallback local)"),
  },
  ...["config gateway.remote.url", "env OPENCLAW_GATEWAY_URL", "cli --url"].map((source) =>
    Object.assign(remoteTlsCase(source, REMOTE_URL, REMOTE_PIN.toUpperCase()), {
      url: source === "config gateway.remote.url" ? REMOTE_URL : OVERRIDE_URL,
      source,
      pin: source === "cli --url" ? undefined : REMOTE_PIN,
    }),
  ),
  remoteTlsCase("plaintext remote target fails closed", LOCAL_WS),
  ...[
    [LOCAL_PIN, "remote:tls:f40b2abc628c46b0d05315dada50e36a2d04147d5d7d5c290a8ccecad5ac26ad"],
    [REMOTE_PIN, "remote:tls:684dff5e10578007130807c7d9aa95d045019428f2d404c7d708f38f2d7b5fa2"],
  ].map(([pin, scope]) => remoteTlsCase(`loopback scope ${pin}`, LOCAL_URL, pin, scope)),
])("selects TLS ownership for $name", async ({ url, source, config, pin, scope, inspect }) => {
  mocks.details.mockReturnValue(connection(url, source));
  inspectLocalCertificate();
  const result = await bootstrap({
    config,
    gatewayUrl: source === "cli --url" ? url : undefined,
  });
  expect(result.tlsFingerprint).toBe(pin);
  expectCertificateInspection(inspect);
  if (scope) {
    expect(result.deviceAuthScope).toBe(scope);
    expect(result.sshTunnel).toBeUndefined();
  }
});

it.each([
  ["public origin", "gateway.example", "https://gateway.example", false, undefined],
  ["direct local target", "127.0.0.1:18789", undefined, true, LOCAL_PIN],
  ["public origin matching local", "127.0.0.1:18789", "https://127.0.0.1:18789", false, LOCAL_PIN],
] as const)(
  "retains auth and TLS ownership for an exact %s",
  async (_name, host, publicOrigin, explicit, pin) => {
    const url = `wss://${host}/openclaw`;
    mocks.details
      .mockReturnValueOnce(connection(url, "cli --url"))
      .mockReturnValueOnce(connection(LOCAL_URL, "local loopback"));
    inspectLocalCertificate();
    const result = await bootstrap({
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
    });
    expect(result.auth.token).toBe(explicit ? "explicit-token" : "configured-token");
    expect(result.tlsFingerprint).toBe(pin);
    expectCertificateInspection(Boolean(pin));
  },
);

it("rejects an invalid explicit TLS fingerprint", async () => {
  mocks.details.mockReturnValue(connection(REMOTE_URL, "cli --url"));

  await expect(
    bootstrap({
      config: {},
      gatewayUrl: REMOTE_URL,
      explicitTlsFingerprint: "sha256:abc123",
    }),
  ).rejects.toThrow("Invalid TLS fingerprint");
});
