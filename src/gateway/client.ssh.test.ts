import assert from "node:assert/strict";
import { beforeEach, expect, it, vi } from "vitest";
import type { GatewayClientOptions as BaseGatewayClientOptions } from "../../packages/gateway-client/src/client.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { SshTunnel, startSshPortForward } from "../infra/ssh-tunnel.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";

type CapturedClient = {
  options: BaseGatewayClientOptions;
  start: ReturnType<typeof vi.fn>;
  connected: boolean;
};

const fixture = vi.hoisted(() => ({
  clients: [] as CapturedClient[],
  startSsh: vi.fn<typeof startSshPortForward>(),
  loadOrigin: vi.fn(),
  storeOrigin: vi.fn(),
  clearOrigin: vi.fn(),
  onStart: undefined as ((client: CapturedClient) => void) | undefined,
  onStop: undefined as (() => void) | undefined,
}));

// mock-isolation: Observe SSH transport ownership without opening a real WebSocket.
vi.mock("../../packages/gateway-client/src/client.js", () => ({
  GatewayClient: class {
    connected = false;

    constructor(readonly options: BaseGatewayClientOptions) {
      fixture.clients.push(this);
    }

    start = vi.fn(() => {
      this.options.hostDeps?.beforeConnect?.();
      this.connected = true;
      fixture.onStart?.(this);
    });

    stop() {
      this.connected = false;
      fixture.onStop?.();
    }

    async stopAndWait() {
      this.stop();
    }
  },
}));

vi.mock("../infra/ssh-tunnel.js", () => ({ startSshPortForward: fixture.startSsh }));
vi.mock("../infra/device-auth-store.js", () => ({
  clearDeviceAuthToken: vi.fn(),
  clearOriginDeviceToken: fixture.clearOrigin,
  loadDeviceAuthToken: vi.fn(),
  loadDeviceAuthTokenReadOnly: vi.fn(),
  loadOriginDeviceToken: fixture.loadOrigin,
  loadOriginDeviceTokenReadOnly: vi.fn(),
  prepareDeviceAuthStore: vi.fn(),
  storeDeviceAuthToken: vi.fn(),
  storeOriginDeviceToken: fixture.storeOrigin,
}));
vi.mock("../infra/net/proxy/proxy-lifecycle.js", () => ({
  ensureInheritedManagedProxyRoutingActive: vi.fn(),
  registerManagedProxyGatewayLoopbackBypass: vi.fn(),
}));

const { startSsh, loadOrigin, storeOrigin, clearOrigin } = fixture;

beforeEach(() => {
  fixture.clients.length = 0;
  [startSsh, loadOrigin, storeOrigin, clearOrigin].forEach((mock) => mock.mockReset());
  Object.assign(fixture, { onStart: undefined, onStop: undefined });
});

function controlledTunnel(localPort: number, waitForExitOnStop = false) {
  const exited = createDeferred();
  const stopRequested = createDeferred();
  let active = true;
  const close = () => {
    active = false;
    exited.resolve();
  };
  const stop = vi.fn(() => {
    active = false;
    stopRequested.resolve();
    if (!waitForExitOnStop) {
      close();
    }
    return exited.promise;
  });
  const tunnel: SshTunnel = {
    localPort,
    pid: 123,
    closed: exited.promise,
    isActive: () => active,
    stop,
  };
  return { tunnel, close, stop, stopRequested: stopRequested.promise };
}

const route = { target: "alice@gateway.example.test:2222", remotePort: 18789 };
const deviceAuthScope = "remote:ssh:fixture-selected-route";

function createClient(overrides: GatewayClientOptions = {}) {
  return new GatewayClient({
    url: "ws://127.0.0.1:18789",
    deviceIdentity: null,
    deviceAuthScope,
    sshTunnel: route,
    ...overrides,
  });
}

async function startClient(client: GatewayClient) {
  const started = createDeferred<CapturedClient>();
  fixture.onStart = started.resolve;
  client.start();
  await vi.dynamicImportSettled();
  return started.promise;
}

it.each([
  [40101, "/fixture/old-key", "localhost", "localhost"],
  [40102, "/fixture/new-key", "127.0.0.1", "127.0.0.1"],
  [40103, "/fixture/new-key", "[::1]", "::1"],
] as const)(
  "keeps route-bound credentials and TLS identity on port %s",
  async (localPort, identity, host, tlsServerName) => {
    const entry = { token: "fixture-route-token" };
    loadOrigin.mockResolvedValue(entry);
    const device = { deviceId: "fixture-device", role: "operator" };

    const owned = controlledTunnel(localPort);
    startSsh.mockResolvedValueOnce(owned.tunnel);
    const client = createClient({
      url: `wss://${host}:18789/gateway/ws?profile=work`,
      sshTunnel: { ...route, identity },
    });

    const base = await startClient(client);
    expect(startSsh).toHaveBeenLastCalledWith(expect.objectContaining({ ...route, identity }));
    try {
      expect(base.options).toMatchObject({
        url: `wss://127.0.0.1:${localPort}/gateway/ws?profile=work`,
        tlsServerName,
      });
      const deps = base.options.hostDeps;
      assert(deps?.loadDeviceAuthToken && deps.storeDeviceAuthToken && deps.clearDeviceAuthToken);
      expect(await deps.loadDeviceAuthToken(device)).toEqual(entry);
      await deps.storeDeviceAuthToken({ ...device, token: "fixture-issued", scopes: [] });
      await deps.clearDeviceAuthToken({ ...device, expectedToken: "fixture-issued" });
      for (const mock of [loadOrigin, storeOrigin, clearOrigin]) {
        expect(mock).toHaveBeenLastCalledWith(
          expect.objectContaining({ ...device, gatewayScope: deviceAuthScope }),
        );
      }
    } finally {
      await client.stopAndWait();
    }
    expect(owned.stop).toHaveBeenCalled();
  },
);

it("joins a canceled pending tunnel before stopping without opening the Gateway transport", async () => {
  const pending = createDeferred<SshTunnel>();
  const owned = controlledTunnel(40103, true);
  startSsh.mockReturnValueOnce(pending.promise);
  const onConnectError = vi.fn();
  const client = createClient({ onConnectError });

  client.start();
  await vi.dynamicImportSettled();
  expect(startSsh).toHaveBeenCalledOnce();
  expect(fixture.clients).toHaveLength(0);
  const settled = vi.fn();
  const stopping = client.stopAndWait().then(settled);
  expect(startSsh.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  pending.resolve(owned.tunnel);
  await owned.stopRequested;
  expect(settled).not.toHaveBeenCalled();
  expect(fixture.clients).toHaveLength(0);
  owned.close();
  await stopping;
  expect(settled).toHaveBeenCalledOnce();
  expect(onConnectError).not.toHaveBeenCalled();
});

it("rejects a reconnect as soon as the SSH child exits and never reuses its released port", async () => {
  const owned = controlledTunnel(40104);
  startSsh.mockResolvedValueOnce(owned.tunnel);
  const stopped = createDeferred();
  fixture.onStop = stopped.resolve;
  const beforeConnect = vi.fn();
  const client = createClient({ hostDeps: { beforeConnect } });
  const base = await startClient(client);
  expect(startSsh).toHaveBeenCalledOnce();
  expect(beforeConnect).toHaveBeenCalledOnce();
  expect(client.connected).toBe(true);
  owned.close();
  // The child is already dead even before its promise observer can stop the client.
  expect(() => base.options.hostDeps?.beforeConnect?.()).toThrow(/SSH|tunnel/i);
  await stopped.promise;
  expect(client.connected).toBe(false);
  client.start();
  await client.stopAndWait();
  expect(startSsh).toHaveBeenCalledOnce();
  expect(fixture.clients).toHaveLength(1);
  expect(base.start).toHaveBeenCalledOnce();
});

it("settles SSH teardown and close notification even when the error callback throws", async () => {
  const owned = controlledTunnel(40105);
  startSsh.mockResolvedValueOnce(owned.tunnel);
  const closed = createDeferred();
  const fail = () => {
    throw new Error("synthetic failure");
  };
  const client = createClient({
    hostDeps: { beforeConnect: fail },
    onConnectError: fail,
    onClose: () => closed.resolve(),
  });
  client.start();
  await closed.promise;
  await client.stopAndWait();
  expect(owned.stop).toHaveBeenCalled();
  expect(client.connected).toBe(false);
});
