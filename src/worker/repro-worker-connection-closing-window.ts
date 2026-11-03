import { once } from "node:events";
import { parentPort } from "node:worker_threads";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { WebSocket, WebSocketServer } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createWorkerConnection } from "./worker-connection.js";

const admission = {
  environmentId: "closing-window-worker",
  credential: "closing-window-credential",
  ownerEpoch: 1,
  rpcSetVersion: WORKER_RPC_SET_VERSION,
  handshake: {
    bundleHash: "a".repeat(64),
    openclawVersion: "closing-window-test",
    protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
  },
  sessionId: "closing-window-session",
  runId: "closing-window-run",
};

const connectParams = {
  minProtocol: 1,
  maxProtocol: 1,
  client: {
    id: GATEWAY_CLIENT_IDS.WORKER,
    version: "closing-window-test",
    platform: process.platform,
    mode: GATEWAY_CLIENT_MODES.WORKER,
  },
  role: "worker",
  admission,
} as const;

const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("closing-window test server did not allocate a TCP port");
}

let firstPeer: WebSocket | undefined;
let socketCount = 0;
let requestCount = 0;
let raceStarted = false;

server.on("connection", (peer) => {
  firstPeer ??= peer;
  peer.on("message", (data) => {
    const frame: unknown = JSON.parse(rawDataToString(data));
    if (typeof frame !== "object" || frame === null) {
      return;
    }
    const method = "method" in frame && typeof frame.method === "string" ? frame.method : undefined;
    const id = "id" in frame && typeof frame.id === "string" ? frame.id : undefined;
    if (method === "connect" && id) {
      peer.send(
        JSON.stringify({
          type: "res",
          id,
          ok: true,
          payload: {
            type: "worker-hello-ok",
            environmentId: admission.environmentId,
            sessionId: admission.sessionId,
            ownerEpoch: admission.ownerEpoch,
            rpcSetVersion: admission.rpcSetVersion,
            protocolFeatures: [...admission.handshake.protocolFeatures],
            credentialExpiresAtMs: Date.now() + 60_000,
            policy: { heartbeatIntervalMs: 60_000, maxPayload: 25 * 1024 * 1024 },
          },
        }),
      );
    } else if (method === "worker.gatewayTool.invoke" && id) {
      requestCount += 1;
      peer.send(
        JSON.stringify({
          type: "res",
          id,
          ok: true,
          payload: { content: [], details: { accepted: true } },
        }),
      );
    }
  });
});

const connection = createWorkerConnection({
  endpoint: { kind: "websocket", url: `ws://127.0.0.1:${address.port}/` },
  connectParams,
  reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
  createSocket: (url) => {
    const socket = new WebSocket(url);
    socketCount += 1;
    if (socketCount !== 1) {
      return socket;
    }
    const emit = socket.emit.bind(socket);
    const interceptEmit: typeof socket.emit = (event, ...args) => {
      if (event === "close" && !raceStarted) {
        raceStarted = true;
        parentPort?.postMessage({ type: "closing-window", readyState: socket.readyState }, []);
        const request = connection.invokeGatewayTool(
          {
            generation: "closing-window-surface",
            toolId: "sessions_send",
            toolCallId: "closing-window-call",
            arguments: {
              sessionKey: "agent:main:closing-window",
              message: "retry after reconnect",
            },
          },
          { replay: true },
        );
        void request.then(
          async (response) => {
            if (!response.ok) {
              parentPort?.postMessage({ type: "error", message: response.error.message }, []);
              return;
            }
            await connection.stop();
            for (const client of server.clients) {
              client.terminate();
            }
            await new Promise<void>((resolve) => {
              server.close(() => resolve());
            });
            parentPort?.postMessage(
              {
                type: "completed",
                requestCount,
                result: response.payload,
              },
              [],
            );
          },
          (error: unknown) => {
            parentPort?.postMessage(
              {
                type: "error",
                message: error instanceof Error ? error.message : String(error),
              },
              [],
            );
          },
        );
        setImmediate(() => {
          emit(event, ...args);
        });
        return true;
      }
      return emit(event, ...args);
    };
    socket.emit = interceptEmit;
    return socket;
  },
});

await Promise.all([connection.waitForReady(), connection.waitForReady(), connection.start()]);
await connection.invokeGatewayTool(
  {
    generation: "closing-window-surface",
    toolId: "sessions_send",
    toolCallId: "open-control-call",
    arguments: { sessionKey: "agent:main:closing-window", message: "open control" },
  },
  { replay: true },
);
parentPort?.on("message", (message: { type?: string }) => {
  if (message.type === "close") {
    firstPeer?.terminate();
  }
});
parentPort?.postMessage({ type: "ready" }, []);
