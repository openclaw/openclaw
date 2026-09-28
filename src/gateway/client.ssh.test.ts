import assert from "node:assert/strict";
import { beforeEach, expect, it, vi } from "vitest";
import type { GatewayClientOptions as BaseGatewayClientOptions } from "../../packages/gateway-client/src/client.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { SshTunnel, startSshPortForward } from "../infra/ssh-tunnel.js";
import { GatewayClient } from "./client.js";

type CapturedClient = {
  options: BaseGatewayClientOptions;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
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

vi.mock("../../packages/gateway-client/src/index.js", () => ({
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

    stop = vi.fn(() => {
      this.connected = false;
      fixture.onStop?.();
    });

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

beforeEach(() => {
  fixture.clients.length = 0;
  fixture.startSsh.mockReset();
  fixture.loadOrigin.mockReset();
  fixture.storeOrigin.mockReset();
  fixture.clearOrigin.mockReset();
  fixture.onStart = undefined;
  fixture.onStop = undefined;
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

it("keeps route-bound credentials and TLS identity when the local listener changes", async () => {
  const entry = {
    token: "fixture-route-token",
    role: "operator",
    scopes: ["operator.read"],
    updatedAtMs: 1,
  };
  fixture.loadOrigin.mockResolvedValue(entry);
  const device = { deviceId: "fixture-device", role: "operator" };

  for (const [localPort, identity, host, tlsServerName] of [
    [40101, "/fixture/old-key", "localhost", "localhost"],
    [40102, "/fixture/new-key", "127.0.0.1", "127.0.0.1"],
    [40103, "/fixture/new-key", "[::1]", "::1"],
  ] as const) {
    const owned = controlledTunnel(localPort);
    fixture.startSsh.mockResolvedValueOnce(owned.tunnel);
    const started = createDeferred<CapturedClient>();
    fixture.onStart = started.resolve;
    const client = new GatewayClient({
      url: `wss://${host}:18789/gateway/ws?profile=work`,
      deviceAuthScope,
      sshTunnel: { ...route, identity },
    });

    client.start();
    await vi.dynamicImportSettled();
    expect(fixture.startSsh).toHaveBeenLastCalledWith(
      expect.objectContaining({ ...route, identity }),
    );
    const base = await started.promise;
    try {
      expect(base.options.url).toBe(`wss://127.0.0.1:${localPort}/gateway/ws?profile=work`);
      expect(base.options.tlsServerName).toBe(tlsServerName);
      const deps = base.options.hostDeps;
      assert(deps?.loadDeviceAuthToken && deps.storeDeviceAuthToken && deps.clearDeviceAuthToken);
      expect(await deps.loadDeviceAuthToken(device)).toEqual(entry);
      expect(fixture.loadOrigin).toHaveBeenLastCalledWith(
        expect.objectContaining({ ...device, gatewayScope: deviceAuthScope }),
      );
      await deps.storeDeviceAuthToken({ ...device, token: "fixture-issued", scopes: [] });
      expect(fixture.storeOrigin).toHaveBeenLastCalledWith(
        expect.objectContaining({ ...device, gatewayScope: deviceAuthScope }),
      );
      await deps.clearDeviceAuthToken({ ...device, expectedToken: "fixture-issued" });
      expect(fixture.clearOrigin).toHaveBeenLastCalledWith(
        expect.objectContaining({ ...device, gatewayScope: deviceAuthScope }),
      );
    } finally {
      await client.stopAndWait();
    }
    expect(owned.stop).toHaveBeenCalled();
  }
});

it("joins a canceled pending tunnel before stopping without opening the Gateway transport", async () => {
  const pending = createDeferred<SshTunnel>();
  const owned = controlledTunnel(40103, true);
  fixture.startSsh.mockReturnValueOnce(pending.promise);
  const onConnectError = vi.fn();
  const client = new GatewayClient({
    url: "ws://127.0.0.1:18789",
    deviceAuthScope,
    sshTunnel: route,
    onConnectError,
  });

  client.start();
  await vi.dynamicImportSettled();
  expect(fixture.startSsh).toHaveBeenCalledOnce();
  expect(fixture.clients).toHaveLength(0);
  let stopped = false;
  const stopping = client.stopAndWait().then(() => {
    stopped = true;
  });
  expect(fixture.startSsh.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  pending.resolve(owned.tunnel);
  await owned.stopRequested;
  expect(stopped).toBe(false);
  expect(fixture.clients).toHaveLength(0);
  owned.close();
  await stopping;
  expect(stopped).toBe(true);
  expect(onConnectError).not.toHaveBeenCalled();
});

it("rejects a reconnect as soon as the SSH child exits and never reuses its released port", async () => {
  const owned = controlledTunnel(40104);
  fixture.startSsh.mockResolvedValueOnce(owned.tunnel);
  const started = createDeferred<CapturedClient>();
  const stopped = createDeferred();
  fixture.onStart = started.resolve;
  fixture.onStop = stopped.resolve;
  const beforeConnect = vi.fn();
  const client = new GatewayClient({
    url: "ws://127.0.0.1:18789",
    deviceAuthScope,
    sshTunnel: route,
    hostDeps: { beforeConnect },
  });

  client.start();
  await vi.dynamicImportSettled();
  expect(fixture.startSsh).toHaveBeenCalledOnce();
  const base = await started.promise;
  expect(beforeConnect).toHaveBeenCalledOnce();
  expect(client.connected).toBe(true);
  assert(base.options.hostDeps?.beforeConnect);
  owned.close();
  // The child is already dead even before its promise observer can stop the client.
  expect(() => base.options.hostDeps?.beforeConnect?.()).toThrow(/SSH|tunnel/i);
  await stopped.promise;
  expect(client.connected).toBe(false);
  client.start();
  await client.stopAndWait();
  expect(fixture.startSsh).toHaveBeenCalledOnce();
  expect(fixture.clients).toHaveLength(1);
  expect(base.start).toHaveBeenCalledOnce();
});

it("settles SSH teardown and close notification even when the error callback throws", async () => {
  const owned = controlledTunnel(40105);
  fixture.startSsh.mockResolvedValueOnce(owned.tunnel);
  const closed = createDeferred();
  const client = new GatewayClient({
    url: "ws://127.0.0.1:18789",
    deviceAuthScope,
    sshTunnel: route,
    hostDeps: {
      beforeConnect: () => {
        throw new Error("synthetic start failure");
      },
    },
    onConnectError: () => {
      throw new Error("synthetic callback failure");
    },
    onClose: () => closed.resolve(),
  });
  client.start();
  await closed.promise;
  await client.stopAndWait();
  expect(owned.stop).toHaveBeenCalled();
  expect(client.connected).toBe(false);
});
