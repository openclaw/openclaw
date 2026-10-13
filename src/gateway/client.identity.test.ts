import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { createClientTestIdentity } from "./client.test-support.js";

const loadDeviceIdentityIfPresentAsyncMock = vi.hoisted(() => vi.fn());
const loadOrCreateDeviceIdentityAsyncMock = vi.hoisted(() => vi.fn());
const wsInstances: MockWebSocket[] = [];

class MockWebSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = MockWebSocket.CONNECTING;

  constructor() {
    super();
    wsInstances.push(this);
  }

  close(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason));
  }

  terminate() {
    this.close();
  }
}

vi.mock("../../packages/gateway-client/src/websocket.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/gateway-client/src/websocket.js")>()),
  WebSocket: MockWebSocket,
}));

// mock-isolation: Control accepted identity work without opening real database state.
vi.mock("../infra/device-identity-async.js", () => ({
  loadDeviceIdentityIfPresentAsync: loadDeviceIdentityIfPresentAsyncMock,
  loadOrCreateDeviceIdentityAsync: loadOrCreateDeviceIdentityAsyncMock,
}));

// mock-isolation: Admission ordering must not alter process-wide proxy routing.
vi.mock("../infra/net/proxy/proxy-lifecycle.js", () => ({
  ensureInheritedManagedProxyRoutingActive: vi.fn(),
  registerManagedProxyGatewayLoopbackBypass: vi.fn(),
}));

const { GatewayClient } = await import("./client.js");
const defaultIdentity = createClientTestIdentity("fixture-client-device");

beforeEach(() => {
  loadDeviceIdentityIfPresentAsyncMock.mockReset();
  loadOrCreateDeviceIdentityAsyncMock.mockReset();
});

describe("GatewayClient identity admission", () => {
  beforeEach(() => {
    wsInstances.length = 0;
  });

  it("prepares default identity before opening the transport", async () => {
    const pending = createDeferred<DeviceIdentity>();
    loadOrCreateDeviceIdentityAsyncMock.mockReturnValue(pending.promise);
    const env = { OPENCLAW_STATE_DIR: "/fixture/client-identity" };
    const client = new GatewayClient({ url: "ws://127.0.0.1:18789", env });
    expect(loadOrCreateDeviceIdentityAsyncMock).not.toHaveBeenCalled();
    client.start();
    client.start();
    expect(loadOrCreateDeviceIdentityAsyncMock).toHaveBeenCalledExactlyOnceWith({ env });
    expect(wsInstances).toHaveLength(0);
    pending.resolve(defaultIdentity);
    await pending.promise;
    expect(wsInstances).toHaveLength(1);
    expect(client.getConnectionMetadata().hasDeviceIdentity).toBe(true);
    await client.stopAndWait();
  });

  it.each(["stop", "stopAndWait"] as const)(
    "joins accepted identity admission after %s without opening a transport",
    async (stopMethod) => {
      const pending = createDeferred<DeviceIdentity>();
      loadOrCreateDeviceIdentityAsyncMock.mockReturnValue(pending.promise);
      const onConnectError = vi.fn();
      const client = new GatewayClient({ url: "ws://127.0.0.1:18789", onConnectError });
      client.start();
      void client[stopMethod]();
      let stopped = false;
      const stopping = client.stopAndWait().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      pending.resolve(defaultIdentity);
      await stopping;
      client.start();
      expect(stopped).toBe(true);
      expect(wsInstances).toHaveLength(0);
      expect(loadOrCreateDeviceIdentityAsyncMock).toHaveBeenCalledOnce();
      expect(onConnectError).not.toHaveBeenCalled();
    },
  );

  it("keeps read-only discovery authoritative over a custom creating callback", async () => {
    const pending = createDeferred<DeviceIdentity | null>();
    loadDeviceIdentityIfPresentAsyncMock.mockReturnValue(pending.promise);
    const loadOrCreateDeviceIdentity = vi.fn(() => defaultIdentity);
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      sharedStateMode: "read-only",
      hostDeps: { loadOrCreateDeviceIdentity },
    });
    client.start();
    expect(wsInstances).toHaveLength(0);
    pending.resolve(null);
    await pending.promise;
    expect(wsInstances).toHaveLength(1);
    expect(client.getConnectionMetadata().hasDeviceIdentity).toBe(false);
    expect(loadOrCreateDeviceIdentity).not.toHaveBeenCalled();
    expect(loadOrCreateDeviceIdentityAsyncMock).not.toHaveBeenCalled();
    await client.stopAndWait();
  });

  it("retains synchronous custom identity callbacks", async () => {
    const loadOrCreateDeviceIdentity = vi.fn(() => defaultIdentity);
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      hostDeps: { loadOrCreateDeviceIdentity },
    });
    expect(loadOrCreateDeviceIdentity).toHaveBeenCalledOnce();
    client.start();
    expect(wsInstances).toHaveLength(1);
    expect(loadOrCreateDeviceIdentityAsyncMock).not.toHaveBeenCalled();
    await client.stopAndWait();
  });

  it("reports identity admission failure without opening the transport", async () => {
    const pending = createDeferred<DeviceIdentity>();
    const closed = createDeferred();
    const onConnectError = vi.fn();
    loadOrCreateDeviceIdentityAsyncMock.mockReturnValue(pending.promise);
    const client = new GatewayClient({
      url: "ws://127.0.0.1:18789",
      onConnectError,
      onClose: () => closed.resolve(),
    });
    client.start();
    const failure = new Error("identity store unavailable");
    pending.reject(failure);
    await closed.promise;
    await client.stopAndWait();
    expect(onConnectError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(wsInstances).toHaveLength(0);
  });
});
