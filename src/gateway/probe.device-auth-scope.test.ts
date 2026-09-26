// Probe device-auth scope tests exercise the real probe -> client -> connect-frame path.
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayOriginScope } from "../../packages/gateway-client/src/gateway-origin-scope.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  seedDeviceAuthToken,
  seedOriginDeviceToken,
} from "../infra/device-auth-store.test-support.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-utils/temp-dir.js";

type WebSocketEvent = "open" | "message" | "close" | "error" | "unexpected-response";

let onSocketCreated: ((socket: ProbeWebSocket) => void) | undefined;

class ProbeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly firstSent = createDeferred<string>();
  readyState = ProbeWebSocket.CONNECTING;
  binaryType = "nodebuffer";
  private readonly handlers: Record<WebSocketEvent, Array<(...args: unknown[]) => void>> = {
    open: [],
    message: [],
    close: [],
    error: [],
    "unexpected-response": [],
  };

  constructor(_url: string, _options?: unknown) {
    onSocketCreated?.(this);
  }

  on(event: WebSocketEvent, handler: (...args: unknown[]) => void): void {
    this.handlers[event].push(handler);
  }

  send(data: string): void {
    this.firstSent.resolve(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === ProbeWebSocket.CLOSED) {
      return;
    }
    this.emitClose(code, reason);
  }

  terminate(): void {
    this.emitClose(1006, "terminated");
  }

  emitOpen(): void {
    this.readyState = ProbeWebSocket.OPEN;
    for (const handler of this.handlers.open) {
      handler();
    }
  }

  emitMessage(data: string): void {
    for (const handler of this.handlers.message) {
      handler(data);
    }
  }

  emitClose(code: number, reason: string): void {
    this.readyState = ProbeWebSocket.CLOSED;
    for (const handler of this.handlers.close) {
      handler(code, Buffer.from(reason));
    }
  }
}

vi.mock("../../packages/gateway-client/src/websocket.js", () => ({ WebSocket: ProbeWebSocket }));

const { probeGateway } = await import("./probe.js");

type ConnectFrame = {
  id?: string;
  params?: {
    auth?: { token?: string; deviceToken?: string; password?: string };
    device?: { id?: string };
  };
};

function createEnv(stateDir: string): NodeJS.ProcessEnv {
  return { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" };
}

async function captureProbeConnectFrame(params: {
  url: string;
  env: NodeJS.ProcessEnv;
  auth?: { token?: string; password?: string };
  originScopedDeviceAuth?: boolean;
  suppressStoredDeviceAuth?: boolean;
}): Promise<ConnectFrame> {
  const created = createDeferred<ProbeWebSocket>();
  onSocketCreated = created.resolve;
  const probePromise = probeGateway({
    url: params.url,
    auth: params.auth,
    originScopedDeviceAuth: params.originScopedDeviceAuth,
    suppressStoredDeviceAuth: params.suppressStoredDeviceAuth,
    env: params.env,
    timeoutMs: 2_000,
    includeDetails: false,
  });
  const endedWithoutConnect = probePromise.then(() => {
    throw new Error("probe ended before its connect frame");
  });
  let socket: ProbeWebSocket | undefined;
  try {
    socket = await Promise.race([created.promise, endedWithoutConnect]);
    socket.emitOpen();
    socket.emitMessage(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "probe-scope-nonce", ts: Date.now() },
      }),
    );
    const rawConnect = await Promise.race([socket.firstSent.promise, endedWithoutConnect]);
    expect(rawConnect).toContain('"method":"connect"');
    const connect = JSON.parse(rawConnect) as ConnectFrame;
    socket.emitMessage(
      JSON.stringify({
        type: "res",
        id: connect.id,
        ok: true,
        payload: {
          type: "hello-ok",
          auth: { role: "operator", scopes: ["operator.read"] },
          server: { connId: "probe-scope-test", version: "test" },
        },
      }),
    );
    await probePromise;
    expect(socket.readyState).toBe(ProbeWebSocket.CLOSED);
    return connect;
  } finally {
    onSocketCreated = undefined;
    socket?.close();
    await probePromise;
  }
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("probeGateway device auth scope", () => {
  it.each([
    { url: "wss://origin-b.example/rpc", originScopedDeviceAuth: false },
    { url: "ws://127.0.0.1:18789", originScopedDeviceAuth: true },
  ])(
    "does not serialize origin-A legacy or scoped tokens to remote origin $url",
    async ({ url, originScopedDeviceAuth }) => {
      await withTempDir("openclaw-probe-origin-scope-", async (stateDir) => {
        const env = createEnv(stateDir);
        const identity = loadOrCreateDeviceIdentity({ env });
        seedDeviceAuthToken({
          deviceId: identity.deviceId,
          role: "operator",
          token: "origin-a-legacy-token",
          env,
        });
        seedOriginDeviceToken({
          gatewayScope: gatewayOriginScope("wss://origin-a.example/rpc"),
          deviceId: identity.deviceId,
          role: "operator",
          token: "origin-a-scoped-token",
          env,
        });

        const connect = await captureProbeConnectFrame({
          url,
          originScopedDeviceAuth,
          env,
        });

        expect(connect.params?.auth).toBeUndefined();
        expect(connect.params?.device).toBeUndefined();
      });
    },
  );

  it.each([
    { name: "local", localToken: "local-device-token", originToken: undefined },
    { name: "origin-scoped", localToken: undefined, originToken: "origin-device-token" },
    {
      name: "origin-scoped over local",
      localToken: "local-device-token",
      originToken: "origin-device-token",
    },
  ])(
    "uses cached $name device auth for local loopback probes",
    async ({ localToken, originToken }) => {
      await withTempDir("openclaw-probe-local-scope-", async (stateDir) => {
        const env = createEnv(stateDir);
        const identity = loadOrCreateDeviceIdentity({ env });
        const lookup = { deviceId: identity.deviceId, role: "operator", env };
        if (localToken) {
          seedDeviceAuthToken({ ...lookup, token: localToken });
        }
        if (originToken) {
          seedOriginDeviceToken({
            ...lookup,
            gatewayScope: "ws://127.0.0.1:18789",
            token: originToken,
          });
        }

        const connect = await captureProbeConnectFrame({
          url: "ws://127.0.0.1:18789",
          env,
        });

        expect(connect.params?.auth).toEqual({
          deviceToken: originToken ?? localToken,
        });
        expect(connect.params?.device?.id).toBe(identity.deviceId);
      });
    },
  );

  it("keeps explicit tokens authoritative for remote probes", async () => {
    await withTempDir("openclaw-probe-explicit-scope-", async (stateDir) => {
      const env = createEnv(stateDir);
      const identity = loadOrCreateDeviceIdentity({ env });
      seedDeviceAuthToken({
        deviceId: identity.deviceId,
        role: "operator",
        token: "legacy-device-token",
        env,
      });

      const connect = await captureProbeConnectFrame({
        url: "wss://origin-b.example/rpc",
        auth: { token: "explicit-remote-token" },
        env,
      });

      expect(connect.params?.auth).toEqual({ token: "explicit-remote-token" });
    });
  });

  it("does not reuse stored auth across SSH targets sharing a forwarded port", async () => {
    await withTempDir("openclaw-probe-ssh-scope-", async (stateDir) => {
      const env = createEnv(stateDir);
      const identity = loadOrCreateDeviceIdentity({ env });
      seedDeviceAuthToken({
        deviceId: identity.deviceId,
        role: "operator",
        token: "local-device-token",
        env,
      });
      seedOriginDeviceToken({
        gatewayScope: gatewayOriginScope("ws://127.0.0.1:18789"),
        deviceId: identity.deviceId,
        role: "operator",
        token: "prior-ssh-target-token",
        env,
      });

      const connect = await captureProbeConnectFrame({
        url: "ws://127.0.0.1:18789",
        suppressStoredDeviceAuth: true,
        env,
      });

      expect(connect.params?.auth).toBeUndefined();
      expect(connect.params?.device).toBeUndefined();
    });
  });

  it("keeps explicit auth available through SSH forwarded transports", async () => {
    await withTempDir("openclaw-probe-ssh-explicit-", async (stateDir) => {
      const env = createEnv(stateDir);
      const connect = await captureProbeConnectFrame({
        url: "ws://127.0.0.1:18789",
        auth: { token: "explicit-ssh-token" },
        suppressStoredDeviceAuth: true,
        env,
      });

      expect(connect.params?.auth).toEqual({ token: "explicit-ssh-token" });
    });
  });
});
