import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { vi } from "vitest";
import { WebSocketServer, type RawData } from "ws";
import type { ConnectParams } from "../../../packages/gateway-protocol/src/index.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../../gateway/minimal-gateway.test-helpers.js";
import { GatewayConnectionWork } from "../../gateway/server-connection-work.js";
import { admitGatewayConnect } from "../../gateway/server/ws-connection/connect-admission.js";
import {
  evaluateMissingDeviceIdentity,
  shouldClearUnboundScopesForMissingDeviceIdentity,
} from "../../gateway/server/ws-connection/connect-policy.js";
import {
  shouldPreserveLocalCliSharedAuthScopes,
  shouldSkipLocalBackendSelfPairing,
} from "../../gateway/server/ws-connection/handshake-auth-helpers.js";
import { createAdmissionHandler } from "../../gateway/server/ws-connection/message-handler.admission.test-support.js";
import { createGatewayWebSocketTransport } from "../../gateway/server/ws-transport.js";

export async function withProtocolGateway<T>(
  mode: "none" | "token",
  run: (fixture: {
    port: number;
    config: {
      gateway: { mode: "local"; auth: { mode: "none" | "token"; token?: string }; port: number };
    };
    observed: ConnectParams[];
    httpRequests: string[];
    requests: string[];
  }) => Promise<T>,
  options: { beforeChallenge?: () => Promise<void> } = {},
): Promise<T> {
  const auth = mode === "none" ? { mode } : { mode, token: "fixture-protocol-token" };
  const httpRequests: string[] = [];
  const http = createServer((req, res) => {
    httpRequests.push(req.url ?? "");
    const body =
      req.url === "/startupz"
        ? { ok: true, status: "started", version: "2026.10.23", buildId: "fixture-target" }
        : { ready: true, coreReady: true };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  const gateway = new WebSocketServer({ server: http });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const port = (http.address() as AddressInfo).port;
  const config = { gateway: { mode: "local" as const, auth, port } };
  const observed: ConnectParams[] = [];
  const requests: string[] = [];
  gateway.on("connection", (socket, upgradeReq) => {
    const send = (frame: unknown) => socket.send(JSON.stringify(frame));
    const fail = () => socket.terminate();
    let scopes: string[] = [];
    const handleMessage = async (data: RawData) => {
      const request = parseMinimalGatewayRequestFrame(data);
      if (!request.id || !request.method) {
        return;
      }
      requests.push(request.method);
      const reject = (code: string, message: string, errorOptions?: object) =>
        send({ type: "res", id: request.id, ok: false, error: { code, message, ...errorOptions } });
      if (request.method === "connect") {
        const connect = request.params as ConnectParams;
        observed.push(connect);
        const handler = createAdmissionHandler({
          socket: createGatewayWebSocketTransport(socket, upgradeReq.socket, undefined),
          upgradeReq,
          buildRequestContext: () => {
            throw new Error("No application dispatch in admission fixture");
          },
          getResolvedAuth: () => ({ ...auth, allowTailscale: false }),
          close: (code, reason) => socket.close(code, reason),
          isClosed: () => socket.readyState > 1,
          connectionWork: new GatewayConnectionWork(),
        });
        const admission = await admitGatewayConnect({
          handler,
          frame: { type: "req", id: request.id, method: "connect", params: connect },
          connectParams: connect,
          configSnapshot: config,
          trustedProxies: [],
          allowRealIpFallback: false,
          peerLabel: "fixture",
          hasProxyHeaders: false,
          isLocalClient: true,
          reportedClientIpSource: "direct",
          hasBrowserOriginHeader: false,
          clientLabel: "fixture",
          clientMeta: {},
          markHandshakeFailure: vi.fn(),
          sendHandshakeErrorResponse: reject,
          sendFrame: async (frame) => {
            send(frame);
          },
          onHelloDelivered: vi.fn(),
          onPairingWait: vi.fn(),
          isWebchatConnect: () => false,
          runDetachedConnectWork: () => {
            throw new Error("No detached work in admission fixture");
          },
          pendingNodePairingCleanup: {},
          broadcastNodePairingResult: vi.fn(),
          releasePendingNodePairingCleanup: async () => {},
        });
        if (!admission) {
          return;
        }
        const sharedAuthOk = mode === "token" && connect.auth?.token === "fixture-protocol-token";
        const policy = {
          connectParams: connect,
          locality: "direct_local" as const,
          hasBrowserOriginHeader: false,
          sharedAuthOk,
          authMethod: mode,
        };
        const backend = shouldSkipLocalBackendSelfPairing(policy);
        const decision = evaluateMissingDeviceIdentity({
          hasDeviceIdentity: Boolean(connect.device),
          role: "operator",
          isControlUi: false,
          localBackendSelfPairingOk: backend,
          sharedAuthOk,
          authOk: mode === "none" || sharedAuthOk,
          hasSharedAuth: mode !== "none",
        });
        if (decision.kind !== "allow") {
          reject("FORBIDDEN", "device identity required");
          socket.close(1008);
          return;
        }
        scopes =
          !backend &&
          !shouldPreserveLocalCliSharedAuthScopes(policy) &&
          shouldClearUnboundScopesForMissingDeviceIdentity({ decision, authMethod: mode })
            ? []
            : (connect.scopes ?? []);
        sendMinimalGatewayResponse(socket, request.id, {
          ...buildMinimalGatewayHelloOkPayload({ auth: { role: "operator", scopes } }),
          server: {
            version: "2026.10.23",
            buildId: "fixture-target",
            connId: "fixture-connection",
          },
        });
        return;
      }
      if (request.method !== "health" || !scopes.includes("operator.read")) {
        reject("FORBIDDEN", "health requires operator.read");
        return;
      }
      sendMinimalGatewayResponse(socket, request.id, {
        ok: true,
      });
    };
    void Promise.resolve()
      .then(() => options.beforeChallenge?.())
      .then(() => sendMinimalGatewayConnectChallenge(socket))
      .catch(fail);
    socket.on("message", (data) => {
      void handleMessage(data).catch(fail);
    });
  });
  try {
    return await run({ port, config, observed, httpRequests, requests });
  } finally {
    await closeMinimalGatewayServer(gateway);
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      http.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
