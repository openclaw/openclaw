// A CLI behind an identity-aware proxy has only gateway.remote.edgeAuth: the
// proxy authenticates the upgrade, so the first connect must still be sent.
import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { GatewayClientOptions } from "./client.js";

const state = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
  clientOptions: null as GatewayClientOptions | null,
  starts: 0,
}));

vi.mock("../config/gateway-dispatch-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/gateway-dispatch-config.js")>()),
  readGatewayDispatchConfig: () => state.config,
  readGatewayDispatchConfigWithShellEnvFallback: async () => state.config,
}));

vi.mock("../infra/device-auth-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-auth-store.js")>()),
  loadDeviceAuthToken: () => null,
  loadDeviceAuthTokenReadOnly: () => null,
  loadOriginDeviceToken: () => null,
  loadOriginDeviceTokenReadOnly: () => null,
}));

vi.mock("../infra/device-identity-async.js", async (importOriginal) => {
  const identity = { deviceId: "guest-device", publicKeyPem: "pub", privateKeyPem: "priv" };
  return {
    ...(await importOriginal<typeof import("../infra/device-identity-async.js")>()),
    loadOrCreateDeviceIdentityAsync: async () => identity,
    loadDeviceIdentityIfPresentAsync: async () => identity,
  };
});

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  GatewayClient: class {
    constructor(opts: GatewayClientOptions) {
      state.clientOptions = opts;
    }
    async request() {
      return { ok: true };
    }
    start() {
      state.starts += 1;
      state.clientOptions?.onHelloOk?.({
        type: "hello-ok",
        protocol: 1,
        server: { version: "test", connId: "test-connection" },
        features: { capabilities: [], methods: [], events: [] },
        snapshot: {
          presence: [],
          health: {},
          stateVersion: { presence: 0, health: 0 },
          uptimeMs: 0,
        },
        auth: { role: "operator", scopes: [] },
        policy: { maxPayload: 1, maxBufferedBytes: 1, tickIntervalMs: 1 },
      });
    }
    stop() {}
    async stopAndWait() {}
  },
}));

const { callGatewayCli } = await import("./call.js");

beforeEach(() => {
  vi.stubEnv("OPENCLAW_GATEWAY_URL", undefined);
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", undefined);
  vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", undefined);
  state.clientOptions = null;
  state.starts = 0;
});

it.each([undefined, "wss://gateway.example"])(
  "opens the websocket for an edgeAuth remote without shared or paired credentials (url %s)",
  async (url) => {
    state.config = {
      gateway: {
        mode: "remote",
        remote: { url: "wss://gateway.example", edgeAuth: { "Cf-Access-Token": "access-token" } },
      },
    };

    await callGatewayCli({ method: "sessions.list", ...(url ? { url } : {}) });

    expect(state.starts).toBe(1);
    expect(state.clientOptions).toMatchObject({
      url: "wss://gateway.example",
      token: undefined,
      password: undefined,
      edgeAuthHeaders: { "Cf-Access-Token": "access-token" },
    });
  },
);

it("still requires credentials for a remote without edgeAuth", async () => {
  state.config = { gateway: { mode: "remote", remote: { url: "wss://gateway.example" } } };

  await expect(callGatewayCli({ method: "sessions.list" })).rejects.toMatchObject({
    name: "GatewayCredentialsRequiredError",
  });
  expect(state.starts).toBe(0);
});
