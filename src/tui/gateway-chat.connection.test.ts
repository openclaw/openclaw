import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadConfigMock as loadConfig,
  resolveConfigPathMock as resolveConfigPath,
  resolveGatewayPortMock as resolveGatewayPort,
  resolveStateDirMock as resolveStateDir,
} from "../gateway/gateway-connection.test-mocks.js";

const TLS_FINGERPRINT = "ab".repeat(32);

const readActiveGatewayLockPortMock = vi.hoisted(() => vi.fn());
const loadDeviceIdentityIfPresentMock = vi.hoisted(() => vi.fn());
const loadOriginDeviceTokenMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", async () => {
  const mocks = await import("../gateway/gateway-connection.test-mocks.js");
  return {
    getRuntimeConfig: mocks.loadConfigMock,
    loadConfig: mocks.loadConfigMock,
    resolveConfigPath: mocks.resolveConfigPathMock,
    resolveGatewayPort: mocks.resolveGatewayPortMock,
    resolveStateDir: mocks.resolveStateDirMock,
  };
});

vi.mock("../gateway/net.js", async () => {
  const mocks = await import("../gateway/gateway-connection.test-mocks.js");
  return {
    isLoopbackHost: mocks.isLoopbackHostMock,
    isSecureWebSocketUrl: mocks.isSecureWebSocketUrlMock,
    pickPrimaryLanIPv4: mocks.pickPrimaryLanIPv4Mock,
  };
});

vi.mock("../infra/gateway-lock.js", () => ({
  readActiveGatewayLockPort: readActiveGatewayLockPortMock,
}));

vi.mock("../infra/device-auth-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/device-auth-store.js")>();
  return {
    ...actual,
    loadOriginDeviceToken: (...args: unknown[]) => loadOriginDeviceTokenMock(...args),
  };
});

vi.mock("../infra/device-identity-async.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/device-identity-async.js")>();
  return {
    ...actual,
    loadDeviceIdentityIfPresentAsync: (...args: unknown[]) =>
      loadDeviceIdentityIfPresentMock(...args),
  };
});

const { GatewayChatClient } = await import("./gateway-chat.js");

const resolveBoundGatewayConnection = async (
  opts: Parameters<typeof GatewayChatClient.connectBound>[0],
) => (await GatewayChatClient.connectBound(opts)).connection;

const resolveGatewayConnection = async (opts: Parameters<typeof GatewayChatClient.connect>[0]) =>
  (await GatewayChatClient.connect(opts)).connection;

function setGateway(gateway: OpenClawConfig["gateway"]) {
  loadConfig.mockReturnValue({ gateway });
}

function pairOrigin(scope: string) {
  loadDeviceIdentityIfPresentMock.mockReturnValue({ deviceId: "device-1" });
  loadOriginDeviceTokenMock.mockImplementation(({ gatewayScope }: { gatewayScope: string }) =>
    gatewayScope === scope ? { token: "stored-origin-token", scopes: ["operator.read"] } : null,
  );
}

describe("GatewayChatClient connections", () => {
  beforeEach(() => {
    for (const name of ["URL", "PORT", "TOKEN", "PASSWORD"]) {
      vi.stubEnv(`OPENCLAW_GATEWAY_${name}`, undefined);
    }
    loadConfig.mockReset();
    loadDeviceIdentityIfPresentMock.mockReset().mockReturnValue(null);
    loadOriginDeviceTokenMock.mockReset().mockReturnValue(null);
    readActiveGatewayLockPortMock.mockReset().mockResolvedValue(undefined);
    resolveGatewayPort.mockReset().mockReturnValue(18789);
    resolveStateDir
      .mockReset()
      .mockImplementation((env: NodeJS.ProcessEnv) => env.OPENCLAW_STATE_DIR ?? "/tmp/openclaw");
    resolveConfigPath
      .mockReset()
      .mockImplementation(
        (env: NodeJS.ProcessEnv, stateDir: string) =>
          env.OPENCLAW_CONFIG_PATH ?? `${stateDir}/openclaw.json`,
      );
  });
  afterEach(() => vi.unstubAllEnvs());

  it("keeps a bound auth-free Gateway isolated from global config and env auth", async () => {
    setGateway({
      mode: "remote",
      remote: { url: "wss://global.example/ws", token: "global-token" },
    });
    vi.stubEnv("OPENCLAW_GATEWAY_URL", "wss://env.example/ws");
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "test-token");
    const url = "wss://selected.example/ws";
    await expect(
      resolveBoundGatewayConnection({
        config: { gateway: { mode: "remote", remote: { url } } },
        url,
        tlsFingerprint: TLS_FINGERPRINT,
      }),
    ).resolves.toEqual({
      url,
      deviceAuthScope: url,
      token: undefined,
      password: undefined,
      tlsFingerprint: TLS_FINGERPRINT,
    });
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("preserves the configured SSH route through a bound handoff", async () => {
    const url = "ws://127.0.0.1:18789";
    const result = await resolveBoundGatewayConnection({
      config: {
        gateway: { mode: "remote", remote: { url, transport: "ssh", sshTarget: "me@studio" } },
      },
      url,
      configuredRemote: true,
    });
    expect(result.deviceAuthScope).toBe(
      "remote:ssh:9d0708e04e550511a6fc9dba41c94ffc895fdd5029a3e5c779f2c0bc16bd4c44",
    );
    expect(result.sshTunnel).toEqual({ target: "me@studio", remotePort: 18789 });
  });

  it("reuses local interactive auth for an exact resume target with the active port and base path", async () => {
    setGateway({
      mode: "local",
      port: 18789,
      controlUi: { basePath: "/control" },
      auth: { token: "configured-token" },
    });
    readActiveGatewayLockPortMock.mockResolvedValue(48789);
    await expect(
      resolveGatewayConnection({
        url: "ws://127.0.0.1:48789/control",
        allowConfiguredAuthForExactTarget: true,
      }),
    ).resolves.toMatchObject({
      url: "ws://127.0.0.1:48789/control",
      token: "configured-token",
    });
  });

  it("suppresses ambient Gateway auth fallback for an exact handoff target", async () => {
    setGateway({ mode: "local", controlUi: { basePath: "/control" } });
    const url = "ws://127.0.0.1:18789/control";
    pairOrigin(url);
    vi.stubEnv("OPENCLAW_GATEWAY_URL", "wss://gateway-b.example/ws");
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "gateway-b-token");
    await expect(
      resolveGatewayConnection({
        url,
        allowConfiguredAuthForExactTarget: true,
        suppressEnvAuthFallback: true,
      }),
    ).resolves.toMatchObject({
      deviceAuthScope: url,
      token: undefined,
      password: undefined,
    });
  });

  it.each(["wss://other.example/gateway"])(
    "requires explicit auth and drops the configured TLS pin for mismatched target %s",
    async (url) => {
      setGateway({
        mode: "remote",
        remote: {
          url: "wss://127.0.0.1/gateway",
          token: "configured-remote-token",
          tlsFingerprint: `sha256:${TLS_FINGERPRINT}`,
        },
      });
      const opts = { url, allowConfiguredAuthForExactTarget: true };
      await expect(resolveGatewayConnection(opts)).rejects.toThrow(
        /pass --token or --password once to request pairing/i,
      );
      const explicit = await resolveGatewayConnection({ ...opts, token: "explicit-token" });
      expect(explicit.token).toBe("explicit-token");
      expect(explicit.tlsFingerprint).toBeUndefined();
    },
  );

  it("keeps the TLS pin on an auth-free local Gateway", async () => {
    setGateway({ mode: "local", tls: { enabled: true }, auth: { mode: "none" } });
    const result = await resolveGatewayConnection({ tlsFingerprint: `sha256:${TLS_FINGERPRINT}` });
    expect(result.url).toBe("wss://127.0.0.1:18789");
    expect(result.tlsFingerprint).toBe(TLS_FINGERPRINT);
  });

  it("keeps an explicit Gateway port ahead of active lock metadata", async () => {
    setGateway({ mode: "local", port: 18789, auth: { token: "config-token" } });
    readActiveGatewayLockPortMock.mockResolvedValue(48789);
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "19001");
    expect((await resolveGatewayConnection({})).url).toBe("ws://127.0.0.1:19001");
    expect(readActiveGatewayLockPortMock).not.toHaveBeenCalled();
  });

  it("fails when local token and password are configured without an auth mode", async () => {
    setGateway({
      mode: "local",
      auth: {
        token: "config-token",
        password: "ambiguous-mode-pass-value", // pragma: allowlist secret
      },
    });
    await expect(resolveGatewayConnection({})).rejects.toThrow(
      "gateway.auth.mode is unset. Set gateway.auth.mode to token or password.",
    );
  });

  it("reuses paired credentials for the configured SSH route without shared auth", async () => {
    const url = "ws://127.0.0.1:19876";
    setGateway({
      mode: "remote",
      remote: { url, transport: "ssh", sshTarget: "me@studio", remotePort: 18789 },
    });
    const scope = "remote:ssh:9d0708e04e550511a6fc9dba41c94ffc895fdd5029a3e5c779f2c0bc16bd4c44";
    pairOrigin(scope);
    await expect(resolveGatewayConnection({})).resolves.toMatchObject({
      url,
      deviceAuthScope: scope,
      token: undefined,
      password: undefined,
    });
  });

  it("keeps configured remote auth required when no origin device token exists", async () => {
    setGateway({ mode: "remote", remote: { url: "wss://remote.example/rpc" } });
    await expect(resolveGatewayConnection({})).rejects.toThrow("Missing gateway auth credentials.");
  });
});
