// Probe device-auth scope tests exercise the real probe -> client -> connect-frame path.
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayOriginScope } from "../../packages/gateway-client/src/gateway-origin-scope.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { createStatusGatewayProbeBudget } from "../commands/status.gateway-probe-budget.js";
import { resolveGatewayProbeSnapshot } from "../commands/status.scan.shared.js";
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
vi.mock("../cli/daemon-cli/diagnostic-readiness.js", () => ({
  waitForGatewayDiagnosticReadiness: async () => undefined,
}));
vi.mock("../infra/gateway-processes.js", async (original) => ({
  ...(await original<typeof import("../infra/gateway-processes.js")>()),
  findVerifiedGatewayListenerPidsOnPortSync: () => [],
  signalVerifiedGatewayPidSync: () => {
    throw new Error("An unverified listener must not be signaled");
  },
}));

const { probeGateway } = await import("./probe.js");
const { signalGatewayRestart } = await import("../cli/daemon-cli/lifecycle-unmanaged.js");

type ConnectFrame = {
  id?: string;
  params?: {
    auth?: { token?: string; deviceToken?: string; password?: string };
    device?: { id?: string };
  };
};

const loopbackUrl = "ws://127.0.0.1:18789";

function withAuth(
  tokens: { legacy?: string; origin: string; scope?: string },
  run: (fixture: { stateDir: string; env: NodeJS.ProcessEnv; deviceId: string }) => Promise<void>,
) {
  return withTempDir("openclaw-probe-scope-", async (stateDir) => {
    const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" };
    const { deviceId } = loadOrCreateDeviceIdentity({ env });
    const lookup = { deviceId, role: "operator", env };
    if (tokens.legacy) {
      seedDeviceAuthToken({ ...lookup, token: tokens.legacy });
    }
    seedOriginDeviceToken({
      ...lookup,
      gatewayScope: gatewayOriginScope(tokens.scope ?? loopbackUrl),
      token: tokens.origin,
    });
    return run({ stateDir, env, deviceId });
  });
}

function challenge(socket: ProbeWebSocket, nonce: string) {
  socket.emitOpen();
  socket.emitMessage(
    JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce, ts: Date.now() },
    }),
  );
}

async function captureProbeConnectFrame(params: {
  url: string;
  env: NodeJS.ProcessEnv;
  auth?: { token?: string; password?: string };
  originScopedDeviceAuth?: boolean;
  suppressStoredDeviceAuth?: boolean;
}): Promise<ConnectFrame> {
  return captureConnectFrame(() =>
    probeGateway({ ...params, timeoutMs: 2_000, includeDetails: false }),
  );
}

async function captureConnectFrame(startProbe: () => Promise<unknown>): Promise<ConnectFrame> {
  const created = createDeferred<ProbeWebSocket>();
  onSocketCreated = created.resolve;
  const probePromise = startProbe();
  const endedWithoutConnect = probePromise.then(() => {
    throw new Error("probe ended before its connect frame");
  });
  let socket: ProbeWebSocket | undefined;
  try {
    socket = await Promise.race([created.promise, endedWithoutConnect]);
    challenge(socket, "probe-scope-nonce");
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
  vi.unstubAllEnvs();
});

describe("probeGateway device auth scope", () => {
  it("does not send a connect frame to an unverified unmanaged restart listener", async () => {
    await withTempDir("openclaw-restart-probe-scope-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" };
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", `${stateDir}/openclaw.json`);
      vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", undefined);
      vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", undefined);
      const { deviceId } = loadOrCreateDeviceIdentity({ env });
      seedOriginDeviceToken({
        deviceId,
        role: "operator",
        gatewayScope: loopbackUrl,
        token: "local-origin-token",
        env,
      });
      let connect: ConnectFrame | undefined;
      onSocketCreated = (socket) => {
        queueMicrotask(() => {
          challenge(socket, "restart-probe-nonce");
          void socket.firstSent.promise.then((raw) => {
            connect = JSON.parse(raw) as ConnectFrame;
            socket.emitClose(1008, "unverified listener");
          });
        });
      };
      try {
        await expect(
          signalGatewayRestart(18789, {
            enforceRestartConfig: true,
            processLabel: "unmanaged",
            auditSource: "cli",
            env,
          }),
        ).resolves.toBeNull();
        expect(connect).toBeUndefined();
      } finally {
        onSocketCreated = undefined;
      }
    });
  });

  it.each([
    { mode: "local" as const, url: loopbackUrl, envOverride: false, expectedToken: "local-token" },
    { mode: "remote" as const, url: loopbackUrl, envOverride: false, expectedToken: undefined },
    {
      mode: "remote" as const,
      url: "wss://gateway.example",
      envOverride: false,
      expectedToken: "scoped-token",
    },
    { mode: "local" as const, url: loopbackUrl, envOverride: true, expectedToken: undefined },
  ])(
    "binds status credentials to the $mode target at $url (env override=$envOverride)",
    async ({ mode, url, envOverride, expectedToken }) => {
      vi.stubEnv("OPENCLAW_GATEWAY_URL", envOverride ? url : undefined);
      await withAuth(
        { legacy: "local-token", origin: "scoped-token", scope: url },
        async ({ stateDir, env, deviceId }) => {
          const connect = await captureConnectFrame(() =>
            resolveGatewayProbeSnapshot({
              cfg: { gateway: { mode, port: 18789, remote: { url } } },
              configPath: `${stateDir}/openclaw.json`,
              env,
              opts: {
                ...createStatusGatewayProbeBudget(2_000),
                detailLevel: "none",
                localStatusRpcFallback: false,
              },
            }),
          );

          expect(connect.params?.auth).toEqual(
            expectedToken ? { deviceToken: expectedToken } : undefined,
          );
          expect(connect.params?.device?.id).toBe(expectedToken ? deviceId : undefined);
        },
      );
    },
  );

  it("does not serialize origin-A legacy or scoped tokens to a remote origin", async () => {
    await withAuth(
      {
        legacy: "origin-a-legacy-token",
        origin: "origin-a-scoped-token",
        scope: "wss://origin-a.example/rpc",
      },
      async ({ env }) => {
        const connect = await captureProbeConnectFrame({
          url: "wss://origin-b.example/rpc",
          originScopedDeviceAuth: false,
          env,
        });

        expect(connect.params?.auth).toBeUndefined();
        expect(connect.params?.device).toBeUndefined();
      },
    );
  });

  it("rejects unverified origin-only device auth for a local loopback probe", async () => {
    await withAuth({ origin: "retired-tunnel-device-token" }, async ({ env }) => {
      const connect = await captureProbeConnectFrame({ url: loopbackUrl, env });
      expect(connect.params?.auth).toBeUndefined();
      expect(connect.params?.device?.id).toBeUndefined();
    });
  });

  it("keeps explicit tokens authoritative for a paired remote loopback probe", async () => {
    await withAuth(
      { legacy: "legacy-device-token", origin: "cached-origin-token" },
      async ({ env, deviceId }) => {
        const connect = await captureProbeConnectFrame({
          url: loopbackUrl,
          originScopedDeviceAuth: true,
          auth: { token: "explicit-remote-token" },
          env,
        });

        expect(connect.params?.auth).toEqual({ token: "explicit-remote-token" });
        expect(connect.params?.device?.id).toBe(deviceId);
      },
    );
  });

  it("does not reuse stored auth across SSH targets sharing a forwarded port", async () => {
    await withAuth(
      { legacy: "local-device-token", origin: "prior-ssh-target-token" },
      async ({ env }) => {
        const connect = await captureProbeConnectFrame({
          url: loopbackUrl,
          suppressStoredDeviceAuth: true,
          env,
        });

        expect(connect.params?.auth).toBeUndefined();
        expect(connect.params?.device).toBeUndefined();
      },
    );
  });
});
