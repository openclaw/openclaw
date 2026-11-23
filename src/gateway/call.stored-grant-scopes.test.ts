// A CLI device paired with only session scopes (a team guest) must request a
// scope its grant covers; asking for operator.read files a scope upgrade.
import { beforeEach, expect, it, vi } from "vitest";
import type { DeviceAuthEntry } from "../shared/device-auth.js";
import type { GatewayClientOptions } from "./client.js";

const state = vi.hoisted(() => ({
  grant: null as DeviceAuthEntry | null,
  clientOptions: null as GatewayClientOptions | null,
  connectErrors: [] as Error[],
  requestedScopes: [] as Array<string[] | undefined>,
  sharedStateModes: [] as Array<string | undefined>,
}));

vi.mock("../config/gateway-dispatch-config.js", async (importOriginal) => {
  const config = { gateway: { mode: "remote", remote: { url: "wss://gateway.example" } } };
  return {
    ...(await importOriginal<typeof import("../config/gateway-dispatch-config.js")>()),
    readGatewayDispatchConfig: () => config,
    readGatewayDispatchConfigWithShellEnvFallback: async () => config,
  };
});

vi.mock("../infra/device-auth-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-auth-store.js")>()),
  loadOriginDeviceToken: () => state.grant,
  loadOriginDeviceTokenReadOnly: () => state.grant,
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
      state.requestedScopes.push(state.clientOptions?.scopes);
      state.sharedStateModes.push(state.clientOptions?.sharedStateMode);
      const connectError = state.connectErrors.shift();
      if (connectError) {
        state.clientOptions?.onClose?.(1008, "pairing required", {
          phase: "pre-hello",
          socketOpened: true,
          transportValidated: true,
          transientPreHelloCleanClose: false,
          connectError,
        });
        return;
      }
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
  state.connectErrors = [];
  state.requestedScopes = [];
  state.sharedStateModes = [];
});

it.each([
  [
    "a session-only grant reads sessions",
    ["operator.sessions.write"],
    "sessions.list",
    ["operator.sessions.read"],
  ],
  ["a read grant keeps operator.read", ["operator.read"], "sessions.list", ["operator.read"]],
  [
    "a method without a session scope keeps its upgrade",
    ["operator.sessions.write"],
    "status",
    ["operator.read"],
  ],
])("%s", async (_name, grantedScopes, method, expected) => {
  state.grant = { token: "device-token", role: "operator", scopes: grantedScopes, updatedAtMs: 1 };

  await callGatewayCli({ method });

  expect(state.clientOptions?.scopes).toEqual(expected);
});

function scopeUpgradeRefusal(approvedScopes: string[]) {
  return Object.assign(new Error("scope upgrade pending approval"), {
    name: "GatewayClientRequestError",
    gatewayCode: "NOT_PAIRED",
    retryable: false,
    details: { code: "PAIRING_REQUIRED", reason: "scope-upgrade", approvedScopes },
  });
}

it("retries a refused request with the session grant the Gateway reports", async () => {
  // The stored token predates the admin narrowing this device to session scopes.
  state.grant = {
    token: "device-token",
    role: "operator",
    scopes: ["operator.read"],
    updatedAtMs: 1,
  };
  state.connectErrors = [scopeUpgradeRefusal(["operator.sessions.write"])];

  await callGatewayCli({ method: "sessions.list", sharedStateMode: "read-only" });

  expect(state.requestedScopes).toEqual([["operator.read"], ["operator.sessions.write"]]);
  // A read-only call stays read-only: the retry stores no device token.
  expect(state.sharedStateModes).toEqual(["read-only", "read-only"]);
});

it("does not retry when the approved grant cannot serve the method", async () => {
  state.grant = {
    token: "device-token",
    role: "operator",
    scopes: ["operator.read"],
    updatedAtMs: 1,
  };
  state.connectErrors = [scopeUpgradeRefusal(["operator.sessions.write"])];

  await expect(callGatewayCli({ method: "status" })).rejects.toThrow("scope upgrade pending");
  expect(state.requestedScopes).toEqual([["operator.read"]]);
});
