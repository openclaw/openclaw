import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { createClientTestIdentity } from "./client.test-support.js";

const findIdentity = vi.hoisted(() => vi.fn());
const createIdentity = vi.hoisted(() => vi.fn());
const wsInstances: MockWebSocket[] = [];

class MockWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  readyState = 0;

  constructor() {
    super();
    wsInstances.push(this);
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
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
  loadDeviceIdentityIfPresentAsync: findIdentity,
  loadOrCreateDeviceIdentityAsync: createIdentity,
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
  findIdentity.mockReset().mockReturnValue(pending.promise);
  createIdentity.mockReset().mockReturnValue(pending.promise);
});

it.each([false, true])("prepares identity before transport (read-only: %s)", async (readOnly) => {
  const env = { OPENCLAW_STATE_DIR: "/fixture/client-identity" };
  const loadOrCreateDeviceIdentity = vi.fn(() => defaultIdentity);
  const client = makeClient({
    env,
    ...(readOnly ? { sharedStateMode: "read-only", hostDeps: { loadOrCreateDeviceIdentity } } : {}),
  });
  expect(createIdentity).not.toHaveBeenCalled();
  client.start();
  client.start();
  const [used, unused] = readOnly ? [findIdentity, createIdentity] : [createIdentity, findIdentity];
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

it.each(["stop", "stopAndWait"] as const)("joins pending identity after %s", async (method) => {
  const client = makeClient();
  client.start();
  void client[method]();
  const stopped = vi.fn();
  const stopping = client.stopAndWait().then(stopped);
  await Promise.resolve();
  expect(stopped).not.toHaveBeenCalled();
  pending.resolve(defaultIdentity);
  await stopping;
  client.start();
  expect(stopped).toHaveBeenCalledOnce();
  expect(wsInstances).toHaveLength(0);
  expect(createIdentity).toHaveBeenCalledOnce();
  expect(onConnectError).not.toHaveBeenCalled();
});

it("retains synchronous custom identity callbacks", async () => {
  const loadOrCreateDeviceIdentity = vi.fn(() => defaultIdentity);
  const client = makeClient({ hostDeps: { loadOrCreateDeviceIdentity } });
  expect(loadOrCreateDeviceIdentity).toHaveBeenCalledOnce();
  client.start();
  expect(wsInstances).toHaveLength(1);
  expect(createIdentity).not.toHaveBeenCalled();
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
