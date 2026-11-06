import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const TLS_FINGERPRINT = "ab".repeat(32);
const loadConfig = vi.hoisted(() => vi.fn());
const readActiveGatewayLockPortMock = vi.hoisted(() => vi.fn());
const loadDeviceIdentityIfPresentMock = vi.hoisted(() => vi.fn());
const loadOriginDeviceTokenMock = vi.hoisted(() => vi.fn());

// mock-isolation: Resolve fixture config without reading operator config or device credentials.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: loadConfig,
  captureRuntimeConfigAsyncReader: () => async () => loadConfig(),
  loadConfig,
}));

vi.mock("../infra/gateway-lock.js", () => ({
  readActiveGatewayLockPort: readActiveGatewayLockPortMock,
}));

vi.mock("../infra/device-auth-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-auth-store.js")>()),
  loadOriginDeviceToken: loadOriginDeviceTokenMock,
}));

vi.mock("../infra/device-identity-async.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-identity-async.js")>()),
  loadDeviceIdentityIfPresentAsync: loadDeviceIdentityIfPresentMock,
}));

const { GatewayChatClient } = await import("./gateway-chat.js");

const connectBound = async (opts: Parameters<typeof GatewayChatClient.connectBound>[0]) =>
  (await GatewayChatClient.connectBound(opts)).connection;

const connect = async (opts: Parameters<typeof GatewayChatClient.connect>[0]) =>
  (await GatewayChatClient.connect(opts)).connection;
const expectConnection = async (
  opts: Parameters<typeof GatewayChatClient.connect>[0],
  expected: Partial<InstanceType<typeof GatewayChatClient>["connection"]>,
) => expect(await connect(opts)).toMatchObject(expected);

function setGateway(gateway: OpenClawConfig["gateway"]) {
  loadConfig.mockReturnValue({ gateway });
}

function remote(url: string, options: NonNullable<OpenClawConfig["gateway"]>["remote"] = {}) {
  return { mode: "remote" as const, remote: { url, ...options } };
}

const sshScope = "remote:ssh:9d0708e04e550511a6fc9dba41c94ffc895fdd5029a3e5c779f2c0bc16bd4c44";
const ssh = { transport: "ssh" as const, sshTarget: "me@studio" };
const noAuth = { token: undefined, password: undefined };

function pairOrigin(scope: string) {
  loadDeviceIdentityIfPresentMock.mockReturnValue({ deviceId: "device-1" });
  loadOriginDeviceTokenMock.mockImplementation(({ gatewayScope }: { gatewayScope: string }) =>
    gatewayScope === scope ? { token: "stored-origin-token", scopes: ["operator.read"] } : null,
  );
}

beforeEach(() => {
  for (const name of ["URL", "PORT", "TOKEN", "PASSWORD"]) {
    vi.stubEnv(`OPENCLAW_GATEWAY_${name}`, undefined);
  }
  loadConfig.mockReset();
  loadDeviceIdentityIfPresentMock.mockReset().mockReturnValue(null);
  loadOriginDeviceTokenMock.mockReset().mockReturnValue(null);
  readActiveGatewayLockPortMock.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

it("keeps a bound auth-free Gateway isolated from global config and env auth", async () => {
  setGateway(remote("wss://global.example/ws", { token: "global-token" }));
  vi.stubEnv("OPENCLAW_GATEWAY_URL", "wss://env.example/ws");
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "test-token");
  const url = "wss://selected.example/ws";
  await expect(
    connectBound({
      config: { gateway: remote(url) },
      url,
      tlsFingerprint: TLS_FINGERPRINT,
    }),
  ).resolves.toEqual({
    url,
    deviceAuthScope: url,
    ...noAuth,
    tlsFingerprint: TLS_FINGERPRINT,
  });
  expect(loadConfig).not.toHaveBeenCalled();
});

it("preserves the configured SSH route through a bound handoff", async () => {
  const url = "ws://127.0.0.1:18789";
  const result = await connectBound({
    config: { gateway: remote(url, ssh) },
    url,
    configuredRemote: true,
  });
  expect([result.deviceAuthScope, result.sshTunnel]).toEqual([
    sshScope,
    { target: "me@studio", remotePort: 18789 },
  ]);
});

it("reuses local interactive auth for an exact resume target with the active port and base path", async () => {
  setGateway({
    mode: "local",
    port: 18789,
    controlUi: { basePath: "/control" },
    auth: { token: "configured-token" },
  });
  readActiveGatewayLockPortMock.mockResolvedValue(48789);
  const url = "ws://127.0.0.1:48789/control";
  await expectConnection(
    { url, allowConfiguredAuthForExactTarget: true },
    { url, token: "configured-token" },
  );
});

it("suppresses ambient Gateway auth fallback for an exact handoff target", async () => {
  setGateway({ mode: "local", controlUi: { basePath: "/control" } });
  const url = "ws://127.0.0.1:18789/control";
  pairOrigin(url);
  vi.stubEnv("OPENCLAW_GATEWAY_URL", "wss://gateway-b.example/ws");
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "gateway-b-token");
  await expectConnection(
    { url, allowConfiguredAuthForExactTarget: true, suppressEnvAuthFallback: true },
    { deviceAuthScope: url, ...noAuth },
  );
});

it("requires explicit auth and drops the configured TLS pin for a mismatched target", async () => {
  setGateway(
    remote("wss://127.0.0.1/gateway", {
      token: "configured-remote-token",
      tlsFingerprint: `sha256:${TLS_FINGERPRINT}`,
    }),
  );
  const opts = { url: "wss://other.example/gateway", allowConfiguredAuthForExactTarget: true };
  await expect(connect(opts)).rejects.toThrow(
    /pass --token or --password once to request pairing/i,
  );
  const connection = await connect({ ...opts, token: "explicit-token" });
  expect(connection.token).toBe("explicit-token");
  expect(connection.tlsFingerprint).toBeUndefined();
});

it("keeps the TLS pin on an auth-free local Gateway", async () => {
  setGateway({ mode: "local", tls: { enabled: true }, auth: { mode: "none" } });
  await expectConnection(
    { tlsFingerprint: `sha256:${TLS_FINGERPRINT}` },
    { url: "wss://127.0.0.1:18789", tlsFingerprint: TLS_FINGERPRINT },
  );
});

it("keeps an explicit Gateway port ahead of active lock metadata", async () => {
  setGateway({ mode: "local", port: 18789, auth: { token: "config-token" } });
  readActiveGatewayLockPortMock.mockResolvedValue(48789);
  vi.stubEnv("OPENCLAW_GATEWAY_PORT", "19001");
  expect((await connect({})).url).toBe("ws://127.0.0.1:19001");
  expect(readActiveGatewayLockPortMock).not.toHaveBeenCalled();
});

it("reuses paired credentials for the configured SSH route without shared auth", async () => {
  const url = "ws://127.0.0.1:19876";
  setGateway(remote(url, { ...ssh, remotePort: 18789 }));
  pairOrigin(sshScope);
  await expectConnection({}, { url, deviceAuthScope: sshScope, ...noAuth });
});

it.each([
  [
    { mode: "local", auth: { token: "config-token", password: "ambiguous-pass" } },
    "gateway.auth.mode is unset. Set gateway.auth.mode to token or password.",
  ],
  [remote("wss://remote.example/rpc"), "Missing gateway auth credentials."],
] as const)("rejects invalid configured auth: %j", async (config, error) => {
  setGateway(config);
  await expect(connect({})).rejects.toThrow(error);
});

it("points to local chat instead of a token when no local Gateway is running", async () => {
  loadConfig.mockReturnValue({});
  await expect(connect({})).rejects.toThrow(
    /No Gateway is running on this machine\.\nFix: run `openclaw chat`/,
  );
  readActiveGatewayLockPortMock.mockResolvedValue(18789);
  await expect(connect({})).rejects.toThrow("Missing gateway auth token.");
});
