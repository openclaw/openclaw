import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { captureEnv, deleteTestEnvValue } from "../test-utils/env.js";
import { callGateway, callGatewayCli, type CallGatewayCliOptions } from "./call.js";
import type { GatewayClientOptions } from "./client.js";

const fixture = vi.hoisted(() => ({
  clientOptions: null as GatewayClientOptions | null,
  request: vi.fn(async () => ({ ok: true })),
  identity: {
    deviceId: "abort-test-device",
    publicKeyPem: "test-public-key",
    privateKeyPem: "test-private-key",
  } satisfies DeviceIdentity,
}));

vi.mock("../infra/device-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-identity.js")>()),
  loadOrCreateDeviceIdentity: () => fixture.identity,
  loadDeviceIdentityIfPresent: () => fixture.identity,
}));

vi.mock("./client.js", () => ({
  prepareGatewayClientDeviceAuth: async () => {},
  isGatewayConnectAssemblyError: () => false,
  GatewayClient: class {
    constructor(private readonly options: GatewayClientOptions) {
      fixture.clientOptions = options;
    }
    request = fixture.request;
    start() {
      this.options.onHelloOk?.({
        type: "hello-ok",
        protocol: PROTOCOL_VERSION,
        server: { version: "test", connId: "fresh-cli-connection" },
        features: {
          capabilities: [],
          methods: ["health", "chat.abort", "sessions.abort"],
          events: [],
        },
        snapshot: {
          presence: [],
          health: {},
          stateVersion: { presence: 0, health: 0 },
          uptimeMs: 0,
        },
        auth: { role: "operator", scopes: [] },
        policy: { maxPayload: 1, maxBufferedBytes: 1, tickIntervalMs: 1 },
      } satisfies HelloOk);
    }
    stop() {}
    async stopAndWait() {}
  },
}));

vi.mock("../../packages/gateway-client/src/event-loop-ready.js", () => ({
  waitForEventLoopReady: async () => ({
    ready: true,
    elapsedMs: 0,
    maxDriftMs: 0,
    checks: 1,
    aborted: false,
  }),
}));

const authEnvKeys = ["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD"];
let envSnapshot: ReturnType<typeof captureEnv>;

beforeEach(() => {
  envSnapshot = captureEnv(authEnvKeys);
  for (const key of authEnvKeys) {
    deleteTestEnvValue(key);
  }
  fixture.clientOptions = null;
  fixture.request.mockClear();
});

afterEach(() => {
  envSnapshot.restore();
});

const localConnection = {
  config: { gateway: { mode: "local", auth: { mode: "token" } } },
  url: "ws://127.0.0.1:18789",
  token: "local-token",
} satisfies Partial<CallGatewayCliOptions>;

describe.each(["chat.abort", "sessions.abort"])("%s cancellation scopes", (method) => {
  it.each<{
    label: string;
    options?: Partial<CallGatewayCliOptions>;
    backend?: boolean;
    scopes: string[];
    deviceIdentity: DeviceIdentity | null;
  }>([
    {
      label: "local shared token can cancel a run owned by another connection",
      scopes: ["operator.admin"],
      deviceIdentity: null,
    },
    {
      label: "local shared password can cancel a run owned by another connection",
      options: {
        config: { gateway: { auth: { mode: "password" } } },
        token: undefined,
        password: "local-password",
      },
      scopes: ["operator.admin"],
      deviceIdentity: null,
    },
    {
      label: "explicit write-only scopes remain restricted",
      options: { scopes: ["operator.write"] },
      scopes: ["operator.write"],
      deviceIdentity: null,
    },
    {
      label: "explicit empty scopes remain empty",
      options: { scopes: [] },
      scopes: [],
      deviceIdentity: null,
    },
    {
      label: "an explicitly supplied device retains ownership-based cancellation",
      options: { deviceIdentity: fixture.identity },
      scopes: ["operator.write"],
      deviceIdentity: fixture.identity,
    },
    {
      label: "remote shared-token calls do not acquire admin",
      options: { url: "wss://remote.example:18789" },
      scopes: ["operator.write"],
      deviceIdentity: fixture.identity,
    },
    {
      label: "inactive credentials under auth-none do not acquire admin",
      options: { config: { gateway: { auth: { mode: "none" } } } },
      scopes: ["operator.write"],
      deviceIdentity: fixture.identity,
    },
    {
      label: "backend shared-token calls retain least privilege",
      backend: true,
      scopes: ["operator.write"],
      deviceIdentity: null,
    },
  ])("$label", async ({ options, backend, scopes, deviceIdentity }) => {
    const params =
      method === "chat.abort"
        ? { sessionKey: "agent:main:running", runId: "running" }
        : { key: "agent:main:running", runId: "running" };
    const call = backend ? callGateway : callGatewayCli;

    await call({ ...localConnection, method, params, ...options });

    expect(fixture.clientOptions?.scopes).toEqual(scopes);
    expect(fixture.clientOptions?.deviceIdentity).toEqual(deviceIdentity);
    expect(fixture.request).toHaveBeenCalledExactlyOnceWith(method, params, expect.any(Object));
  });
});

it("keeps unrelated local shared-token CLI methods at least privilege", async () => {
  await callGatewayCli({ ...localConnection, method: "health" });

  expect(fixture.clientOptions?.scopes).toEqual(["operator.read"]);
  expect(fixture.clientOptions?.deviceIdentity).toBeNull();
  expect(fixture.request).toHaveBeenCalledExactlyOnceWith("health", undefined, expect.any(Object));
});
