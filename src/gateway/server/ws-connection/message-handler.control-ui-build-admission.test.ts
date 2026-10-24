// Raw WebSocket proof for the pre-registration Control UI build admission boundary.
import { once } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  ConnectErrorDetailCodes,
  readControlUiBuildMismatchId,
} from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import { ErrorCodes, PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { getPairedDevice, requestDevicePairing } from "../../../infra/device-pairing.js";
import { rawDataToString } from "../../../infra/ws.js";
import { GatewayConnectionWork } from "../../server-connection-work.js";
import type { GatewayRequestContext } from "../../server-methods/types.js";
import { gatewayTestTextTransport } from "../connection-transport.test-support.js";
import { createAdmissionHandler } from "./message-handler.admission.test-support.js";

const {
  handleGatewayRequestMock,
  resolveRuntimeServiceBuildIdMock,
  setLastFrameMetaMock,
  upsertPresenceMock,
} = vi.hoisted(() => ({
  handleGatewayRequestMock: vi.fn(),
  resolveRuntimeServiceBuildIdMock: vi.fn<() => string | null>(() => "gateway-build"),
  setLastFrameMetaMock: vi.fn(),
  upsertPresenceMock: vi.fn(),
}));

const gatewayConfig = {
  gateway: {
    auth: { mode: "token" as const, token: "test-token" },
    controlUi: { allowedOrigins: ["*"] },
  },
};

vi.mock("../../../config/config.js", () => ({
  getRuntimeConfig: () => gatewayConfig,
  loadConfig: () => gatewayConfig,
}));
vi.mock("../../../config/io.js", () => ({ getRuntimeConfig: () => gatewayConfig }));
vi.mock("../../../infra/system-presence.js", () => ({
  commitPresence: vi.fn(),
  upsertPresence: upsertPresenceMock,
  listSystemPresence: vi.fn(() => []),
}));
vi.mock("../../../state/user-profiles.js", () => ({
  adoptTailscaleProfileAvatar: vi.fn(),
  ensureProfileForEmail: vi.fn(async () => ({
    id: "profile-1",
    displayName: null,
    avatarRevision: "0",
    hasAvatar: false,
    updatedAt: 1,
  })),
  ensureProfileForTailscaleIdentity: vi.fn(),
  getUserProfileDisplay: vi.fn(() => ({
    id: "profile-1",
    displayName: null,
    avatarRevision: "0",
    hasAvatar: false,
    updatedAt: 1,
  })),
}));
vi.mock("../../server-methods.js", () => ({
  handleGatewayRequest: handleGatewayRequestMock,
}));
vi.mock("../health-state.js", () => ({
  buildGatewaySnapshot: vi.fn(() => ({
    presence: [],
    health: {},
    stateVersion: { presence: 1, health: 1 },
    uptimeMs: 1,
    sessionDefaults: {
      defaultAgentId: "main",
      mainKey: "main",
      mainSessionKey: "main",
      scope: "per-sender",
    },
  })),
  getHealthCache: vi.fn(() => null),
  getHealthVersion: vi.fn(() => 1),
}));
vi.mock("../../../version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../version.js")>();
  return { ...actual, resolveRuntimeServiceBuildId: resolveRuntimeServiceBuildIdMock };
});

import { createDeferred } from "../../../../test/helpers/promise.js";
import { attachGatewayWsMessageHandler } from "./message-handler.js";

// A stale Control UI browser still owns a device identity; the build check is
// only reachable once the device passes connect auth and silent local pairing.
const temporaryIdentityDirs = useAutoCleanupTempDirTracker(afterEach);

async function prepareSignedControlUiDevice(nonce: string) {
  const { buildDeviceAuthPayload } =
    await import("../../../../packages/gateway-client/src/device-auth.js");
  const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem, signDevicePayload } =
    await import("../../../infra/device-identity.js");
  const identityPath = path.join(
    temporaryIdentityDirs.make("openclaw-build-admission-"),
    "client",
    "credentials.sqlite",
  );
  const identity = loadOrCreateDeviceIdentity({ path: identityPath });
  const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
  // Prepare pairing workers before timing admission; connect must still approve this device.
  await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey,
    platform: "web",
    clientId: "openclaw-control-ui",
    clientMode: "webchat",
    role: "operator",
    scopes: [],
    remoteIp: "127.0.0.1",
    silent: true,
  });
  expect(await getPairedDevice(identity.deviceId)).toBeNull();
  const signedAtMs = Date.now();
  const payload = buildDeviceAuthPayload({
    deviceId: identity.deviceId,
    clientId: "openclaw-control-ui",
    clientMode: "webchat",
    role: "operator",
    scopes: [],
    signedAtMs,
    token: "test-token",
    nonce,
  });
  return {
    id: identity.deviceId,
    publicKey,
    signature: signDevicePayload(identity.privateKeyPem, payload),
    signedAt: signedAtMs,
    nonce,
  };
}

function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), 5_000);
      timer.unref?.();
    }),
  ]);
}

beforeEach(() => {
  setRuntimeConfigSnapshot(gatewayConfig);
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.clearAllMocks();
  resolveRuntimeServiceBuildIdMock.mockReturnValue("gateway-build");
});

describe("Control UI build admission over WebSocket", () => {
  it.each([
    { buildId: undefined, protocol: PROTOCOL_VERSION },
    { buildId: "stale-build", protocol: PROTOCOL_VERSION },
    { buildId: "stale-build", protocol: PROTOCOL_VERSION + 1 },
    { buildId: "stale-build", protocol: PROTOCOL_VERSION - 1 },
  ])("rejects $protocol / $buildId", async ({ buildId, protocol }) => {
    const connectionWork = new GatewayConnectionWork();
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await withDeadline(once(wss, "listening"), "listen");
    const address = wss.address();
    if (!address || typeof address === "string") {
      throw new Error("WebSocket test server did not expose a port");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    let handler: ReturnType<typeof createAdmissionHandler> | undefined;
    // Hold the injected close until the post-rejection frame reaches the handler;
    // otherwise socket timing can make the no-RPC assertion vacuous.
    const { promise: postRejectionFrameObserved, resolve: releasePostRejectionFrame } =
      createDeferred();
    let closeRequested = false;

    wss.on("connection", (socket, request) => {
      const send = (value: unknown) => {
        socket.send(JSON.stringify(value));
        return { kind: "sent" } as const;
      };
      handler = createAdmissionHandler({
        socket: gatewayTestTextTransport(socket),
        connectionWork,
        upgradeReq: request,
        requestOrigin:
          typeof request.headers.origin === "string" ? request.headers.origin : undefined,
        connectNonce: "legacy-build-nonce",
        getResolvedAuth: () => ({
          mode: "token",
          token: "test-token",
          allowTailscale: false,
        }),
        buildRequestContext: () =>
          ({
            broadcast: vi.fn(),
            publishPresence: vi.fn(),
          }) as unknown as GatewayRequestContext,
        send,
        close: (code, reason) => {
          if (closeRequested) {
            return;
          }
          closeRequested = true;
          void postRejectionFrameObserved.then(() => socket.close(code, reason));
        },
        isClosed: () => socket.readyState >= WebSocket.CLOSING,
        setLastFrameMeta: (meta) => {
          setLastFrameMetaMock(meta);
          if (meta.method === "health" && meta.id === "post-rejection-rpc") {
            releasePostRejectionFrame();
          }
        },
      });
      attachGatewayWsMessageHandler(handler);
    });

    const device = await prepareSignedControlUiDevice("legacy-build-nonce");
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}`, { headers: { origin } });
    try {
      await withDeadline(once(ws, "open"), "open");
      const response = withDeadline(
        new Promise<Record<string, unknown>>((resolve) => {
          ws.once("message", (data) => {
            resolve(JSON.parse(rawDataToString(data)) as Record<string, unknown>);
          });
        }),
        "connect rejection",
      );
      const closed = new Promise<number>((resolve) => {
        ws.once("close", resolve);
      });
      ws.send(
        JSON.stringify({
          type: "req",
          id: "connect-legacy-build",
          method: "connect",
          params: {
            minProtocol: protocol,
            maxProtocol: protocol,
            client: {
              id: "openclaw-control-ui",
              version: "2026.8.1",
              platform: "web",
              mode: "webchat",
              ...(buildId ? { buildId } : {}),
            },
            role: "operator",
            caps: [],
            auth: { token: "test-token" },
            device,
          },
        }),
      );

      const rejection = await response;
      expect(rejection).toMatchObject({
        ok: false,
        error: {
          code: protocol === PROTOCOL_VERSION ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
          message: expect.stringContaining("protocol mismatch"),
          retryable: false,
          details: {
            code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
            gatewayBuildId: "gateway-build",
            reloadRequired: true,
            ...(protocol === PROTOCOL_VERSION
              ? {}
              : {
                  clientMinProtocol: protocol,
                  clientMaxProtocol: protocol,
                  minProtocol: PROTOCOL_VERSION,
                  maxProtocol: PROTOCOL_VERSION,
                  expectedProtocol: PROTOCOL_VERSION,
                }),
          },
        },
      });
      expect(
        readControlUiBuildMismatchId(
          (rejection.error as { details?: unknown } | undefined)?.details,
        ),
      ).toBe("gateway-build");
      ws.send(
        JSON.stringify({
          type: "req",
          id: "post-rejection-rpc",
          method: "health",
          params: {},
        }),
      );
      expect(await withDeadline(closed, "socket close")).toBe(
        protocol === PROTOCOL_VERSION ? 1008 : 1002,
      );
      expect(handler?.getClient()).toBeNull();
      expect(await getPairedDevice(device.id)).toBeNull();
      expect(upsertPresenceMock).not.toHaveBeenCalled();
      expect(setLastFrameMetaMock).toHaveBeenCalledWith({
        type: "req",
        method: "health",
        id: "post-rejection-rpc",
      });
      expect(handleGatewayRequestMock).not.toHaveBeenCalled();
    } finally {
      releasePostRejectionFrame();
      ws.terminate();
      for (const socket of wss.clients) {
        socket.terminate();
      }
      connectionWork.beginClose();
      try {
        await withDeadline(
          new Promise<void>((resolve) => {
            wss.close(() => resolve());
          }),
          "cleanup",
        );
      } finally {
        await connectionWork.drain();
      }
    }
  });
});
