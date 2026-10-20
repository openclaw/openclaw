import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
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
let pending: ReturnType<typeof createDeferred<DeviceIdentity | null>>;
let closed: ReturnType<typeof createDeferred<void>>;
const onConnectError = vi.fn();
const makeClient = (options: ConstructorParameters<typeof GatewayClient>[0] = {}) =>
  new GatewayClient({
    url: "ws://127.0.0.1:18789",
    onConnectError,
    onClose: () => closed.resolve(),
    ...options,
  });

beforeEach(() => {
  wsInstances.length = 0;
  pending = createDeferred<DeviceIdentity | null>();
  closed = createDeferred();
  onConnectError.mockReset();
  loadDeviceIdentityIfPresentAsyncMock.mockReset();
  loadOrCreateDeviceIdentityAsyncMock.mockReset().mockReturnValue(pending.promise);
});

it.each([false, true])("prepares identity before transport (read-only: %s)", async (readOnly) => {
  const env = { OPENCLAW_STATE_DIR: "/fixture/client-identity" };
  const loadOrCreateDeviceIdentity = vi.fn(() => defaultIdentity);
  loadDeviceIdentityIfPresentAsyncMock.mockReturnValue(pending.promise);
  const client = makeClient({
    env,
    ...(readOnly ? { sharedStateMode: "read-only", hostDeps: { loadOrCreateDeviceIdentity } } : {}),
  });
  expect(loadOrCreateDeviceIdentityAsyncMock).not.toHaveBeenCalled();
  client.start();
  client.start();
  const [used, unused] = readOnly
    ? [loadDeviceIdentityIfPresentAsyncMock, loadOrCreateDeviceIdentityAsyncMock]
    : [loadOrCreateDeviceIdentityAsyncMock, loadDeviceIdentityIfPresentAsyncMock];
  expect(used).toHaveBeenCalledExactlyOnceWith({ env });
  expect(wsInstances).toHaveLength(0);
  pending.resolve(readOnly ? null : defaultIdentity);
  await pending.promise;
  expect(wsInstances).toHaveLength(1);
  expect(client.getConnectionMetadata().hasDeviceIdentity).toBe(!readOnly);
  expect(unused).not.toHaveBeenCalled();
  expect(loadOrCreateDeviceIdentity).not.toHaveBeenCalled();
  await client.stopAndWait();
});

it.each(["stop", "stopAndWait"] as const)(
  "joins accepted identity admission after %s without opening a transport",
  async (stopMethod) => {
    const client = makeClient();
    client.start();
    void client[stopMethod]();
    const stopped = vi.fn();
    const stopping = client.stopAndWait().then(stopped);
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    pending.resolve(defaultIdentity);
    await stopping;
    client.start();
    expect(stopped).toHaveBeenCalledOnce();
    expect(wsInstances).toHaveLength(0);
    expect(loadOrCreateDeviceIdentityAsyncMock).toHaveBeenCalledOnce();
    expect(onConnectError).not.toHaveBeenCalled();
  },
);

it("retains synchronous custom identity callbacks", async () => {
  const loadOrCreateDeviceIdentity = vi.fn(() => defaultIdentity);
  const client = makeClient({ hostDeps: { loadOrCreateDeviceIdentity } });
  expect(loadOrCreateDeviceIdentity).toHaveBeenCalledOnce();
  client.start();
  expect(wsInstances).toHaveLength(1);
  expect(loadOrCreateDeviceIdentityAsyncMock).not.toHaveBeenCalled();
  await client.stopAndWait();
});

it("reports identity admission failure without opening the transport", async () => {
  const client = makeClient();
  client.start();
  const failure = new Error("identity store unavailable");
  pending.reject(failure);
  await closed.promise;
  await client.stopAndWait();
  expect(onConnectError).toHaveBeenCalledExactlyOnceWith(failure);
  expect(wsInstances).toHaveLength(0);
});
