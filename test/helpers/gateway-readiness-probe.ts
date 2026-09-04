import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { Agent, get, type IncomingMessage } from "node:http";
import net from "node:net";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { WebSocket } from "ws";
import { GatewayProtocolClient } from "../../packages/gateway-client/src/protocol-client.js";
import { rawDataToString } from "../../packages/gateway-client/src/websocket-data.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { resolveGatewayProbeCredentialsFromConfig } from "../../src/gateway/credentials.js";
import {
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../src/infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../src/infra/node-sqlite.js";
import type { DB } from "../../src/state/openclaw-state-db.generated.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";

type GatewayReadinessProbeOptions = {
  port: number;
  configPath: string;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  pid: number | undefined;
  startedAt: number;
  signal: AbortSignal;
};

function ownsGatewayBoot(params: GatewayReadinessProbeOptions, bootId: string): boolean {
  const pathname = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: params.stateDir });
  if (!params.pid || !fs.existsSync(pathname)) {
    return false;
  }
  // Read only this fixture's canonical file. Never create/migrate state or follow
  // a redirected database into another fixture or the operator's installation.
  const relative = path.relative(fs.realpathSync(params.stateDir), fs.realpathSync(pathname));
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }
  const db = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    const kysely = getNodeSqliteKysely<Pick<DB, "gateway_boot_lifecycle">>(db);
    // Crash-loop recovery can close a history segment without replacing its server.
    // The same-connection hello, not row completion, proves this boot is serving.
    const boot = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("gateway_boot_lifecycle")
        .select("boot_id")
        .where("boot_id", "=", bootId)
        .where("pid", "=", params.pid)
        .where("started_at_ms", ">=", params.startedAt),
    );
    return boot !== undefined;
  } finally {
    db.close();
  }
}

/** Bind the readiness response and Gateway hello to one TCP connection and child boot. */
export async function probeOwnedGatewayReadiness(
  params: GatewayReadinessProbeOptions,
): Promise<boolean> {
  params.signal.throwIfAborted();
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  let socket: net.Socket | undefined;
  let socketClosed: Promise<void> | undefined;
  let websocket: WebSocket | undefined;
  let client: GatewayProtocolClient<undefined> | undefined;
  // HTTP keep-alive followed by the standard WS upgrade must reuse this socket.
  // Reconnection would permit a different listener to supply either half of the proof.
  agent.createConnection = (_options, callback) => {
    if (socket) {
      callback?.(new Error("readiness connection was replaced"), socket);
      return socket;
    }
    const connection = net.createConnection({ host: "127.0.0.1", port: params.port });
    socket = connection;
    socketClosed = new Promise((resolve) => {
      connection.once("close", () => resolve());
    });
    return connection;
  };
  const abort = () => {
    websocket?.terminate();
    socket?.destroy();
  };
  params.signal.addEventListener("abort", abort, { once: true });
  try {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      get(
        { host: "127.0.0.1", port: params.port, path: "/readyz", agent, signal: params.signal },
        resolve,
      ).on("error", reject);
    });
    let body = "";
    for await (const chunk of response) {
      body += String(chunk);
      if (Buffer.byteLength(body) > 16 * 1024) {
        throw new Error("gateway readiness response exceeded 16 KiB");
      }
    }
    const readiness: unknown = JSON.parse(body);
    if (response.statusCode !== 200 || !isRecord(readiness) || readiness.ready !== true) {
      return false;
    }
    params.signal.throwIfAborted();
    // Fixtures can rewrite auth after creation (including direct-local proxy
    // passwords). Resolve only their current file/env through the normal probe policy.
    const auth = resolveGatewayProbeCredentialsFromConfig({
      cfg: JSON.parse(fs.readFileSync(params.configPath, "utf8")) as OpenClawConfig,
      env: params.env,
      mode: "local",
    });
    return await new Promise<boolean>((resolve, reject) => {
      client = new GatewayProtocolClient({
        createSocket: (handlers) => {
          const ws = new WebSocket(`ws://127.0.0.1:${params.port}`, {
            agent,
            maxPayload: 1024 * 1024,
          });
          websocket = ws;
          ws.on("open", handlers.open);
          ws.on("message", (data) => handlers.message(rawDataToString(data)));
          ws.on("close", (code, reason) => handlers.close(code, reason.toString()));
          ws.on("error", handlers.error);
          return {
            isOpen: () => ws.readyState === WebSocket.OPEN,
            send: (data) => ws.send(data),
            close: () => ws.terminate(),
          };
        },
        createRequestId: randomUUID,
        buildConnectPlan: () => undefined,
        buildConnectParams: () => ({
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            // This first-party local controller uses the server's device-less
            // backend admission contract, including explicit auth:none fixtures.
            id: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            version: "1.0.0",
            platform: process.platform,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
          role: "operator",
          scopes: [],
          auth,
        }),
        handshake: { mode: "require-challenge", timeoutMs: 1_000 },
        reconnect: { initialMs: 1, multiplier: 1, maxMs: 1 },
        resolveClose: () => ({ retry: false, notify: true }),
        onClose: () => resolve(false),
        onConnectError: reject,
        onSocketFactoryError: reject,
        onHello: (hello) => {
          try {
            const bootId = hello.server?.bootId;
            resolve(
              !params.signal.aborted &&
                typeof bootId === "string" &&
                ownsGatewayBoot(params, bootId),
            );
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
      });
      client.start();
    });
  } finally {
    params.signal.removeEventListener("abort", abort);
    client?.stop();
    abort();
    agent.destroy();
    await socketClosed;
  }
}
