import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayOriginScope } from "../../packages/gateway-client/src/gateway-origin-scope.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { createStatusGatewayProbeBudget } from "../commands/status.gateway-probe-budget.js";
import { resolveGatewayProbeSnapshot } from "../commands/status.scan.shared.js";
import {
  storeDeviceAuthToken as seedDeviceAuthToken,
  storeOriginDeviceToken as seedOriginDeviceToken,
} from "../infra/device-auth-store.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-utils/temp-dir.js";

let onSocketCreated: ((socket: ProbeWebSocket) => void) | undefined;

class ProbeWebSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly firstSent = createDeferred<string>();
  readyState = ProbeWebSocket.CONNECTING;
  binaryType = "nodebuffer";
  constructor(_url: string, _options?: unknown) {
    super();
    onSocketCreated?.(this);
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
    this.emit("open");
  }

  emitClose(code: number, reason: string): void {
    this.readyState = ProbeWebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason));
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
type AuthFixture = { stateDir: string; env: NodeJS.ProcessEnv; deviceId: string };
type StoredTokens = { legacy?: string; origin: string; scope?: string };

function withAuth(tokens: StoredTokens, run: (fixture: AuthFixture) => Promise<void>) {
  return withTempDir("openclaw-probe-scope-", async (stateDir) => {
    const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" };
    const { deviceId } = loadOrCreateDeviceIdentity({ env });
    const lookup = { deviceId, role: "operator", env };
    if (tokens.legacy) {
      await seedDeviceAuthToken({ ...lookup, token: tokens.legacy });
    }
    await seedOriginDeviceToken({
      ...lookup,
      gatewayScope: gatewayOriginScope(tokens.scope ?? loopbackUrl),
      token: tokens.origin,
    });
    return run({ stateDir, env, deviceId });
  });
}

function challenge(socket: ProbeWebSocket, nonce: string) {
  socket.emitOpen();
  const payload = { nonce, ts: Date.now() };
  socket.emit("message", JSON.stringify({ type: "event", event: "connect.challenge", payload }));
}

const direct =
  (params: Omit<Parameters<typeof probeGateway>[0], "timeoutMs" | "env">) =>
  ({ env }: AuthFixture) =>
    probeGateway({ ...params, env, timeoutMs: 2_000, includeDetails: false });

const status =
  (mode: "local" | "remote", url: string, envOverride = false) =>
  ({ stateDir, env }: AuthFixture) => {
    vi.stubEnv("OPENCLAW_GATEWAY_URL", envOverride ? url : undefined);
    return resolveGatewayProbeSnapshot({
      cfg: { gateway: { mode, port: 18789, remote: { url } } },
      configPath: `${stateDir}/openclaw.json`,
      env,
      opts: {
        ...createStatusGatewayProbeBudget(2_000),
        detailLevel: "none",
        localStatusRpcFallback: false,
      },
    });
  };

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
    const payload = {
      type: "hello-ok",
      auth: { role: "operator", scopes: ["operator.read"] },
      server: { connId: "probe-scope-test", version: "test" },
    };
    socket.emit("message", JSON.stringify({ type: "res", id: connect.id, ok: true, payload }));
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
    await withAuth({ origin: "local-origin-token" }, async ({ stateDir, env }) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", `${stateDir}/openclaw.json`);
      vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", undefined);
      vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", undefined);
      let connect: ConnectFrame | undefined;
      onSocketCreated = (socket) =>
        queueMicrotask(() => {
          challenge(socket, "restart-probe-nonce");
          void socket.firstSent.promise.then((raw) => {
            connect = JSON.parse(raw) as ConnectFrame;
            socket.emitClose(1008, "unverified listener");
          });
        });
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

  const saved = { legacy: "local-token", origin: "scoped-token" };
  const remoteUrl = "wss://gateway.example";
  it.for<
    [
      string,
      StoredTokens,
      (fixture: AuthFixture) => Promise<unknown>,
      NonNullable<ConnectFrame["params"]>["auth"],
      boolean | "absent-id",
    ]
  >([
    ["local status", saved, status("local", loopbackUrl), { deviceToken: saved.legacy }, true],
    ["remote loopback status", saved, status("remote", loopbackUrl), undefined, "absent-id"],
    [
      "remote origin status",
      { ...saved, scope: remoteUrl },
      status("remote", remoteUrl),
      { deviceToken: saved.origin },
      true,
    ],
    ["URL override", saved, status("local", loopbackUrl, true), undefined, "absent-id"],
    [
      "foreign origin",
      { ...saved, scope: "wss://origin-a.example/rpc" },
      direct({ url: "wss://origin-b.example/rpc", originScopedDeviceAuth: false }),
      undefined,
      false,
    ],
    [
      "unverified loopback issuance",
      { origin: saved.origin },
      direct({ url: loopbackUrl }),
      undefined,
      "absent-id",
    ],
    [
      "forwarded SSH port",
      saved,
      direct({ url: loopbackUrl, suppressStoredDeviceAuth: true }),
      undefined,
      false,
    ],
    [
      "explicit remote token",
      saved,
      direct({
        url: loopbackUrl,
        originScopedDeviceAuth: true,
        auth: { token: "explicit-remote-token" },
      }),
      { token: "explicit-remote-token" },
      true,
    ],
  ])("binds credentials to %s", async ([_name, tokens, startProbe, auth, identity]) => {
    await withAuth(tokens, async (fixture) => {
      const connect = await captureConnectFrame(() => startProbe(fixture));
      expect(connect.params?.auth).toEqual(auth);
      expect(identity ? connect.params?.device?.id : connect.params?.device).toBe(
        identity === true ? fixture.deviceId : undefined,
      );
    });
  });
});
