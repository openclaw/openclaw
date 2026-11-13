// Private ingress for the OpenClaw ID tunnel child (the ingress contract):
// - a Unix socket (0600, in a 0700 directory) that only the Gateway's own
//   user can reach, instead of a loopback TCP port;
// - a per-boot proxy token the child receives over IPC and must present on
//   every request, so no other local process can pose as the tunnel;
// - the authenticated peer key passed out of band from client headers: the
//   child sets it from the QUIC handshake after stripping client copies.
// Requests that pass are marked as relayed (`openclaw-id-tunnel`) before the
// Gateway sees them, so they can never count as direct loopback. Requests for
// the OpenClaw ID tunnel API (`/_openclaw-id/v1/`) go to `handleApi` instead.
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import {
  INGRESS_HEADERS,
  isIrohEndpointKey,
  syntheticPeerAddress,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { markGatewayIngressTransport } from "../ingress-attribution.js";
import { isTunnelApiRequest } from "./tunnel-api.js";

/** A running ingress listener. */
export type OpenClawIdIngressListener = {
  socketPath: string;
  /** Per-boot token; handed to the tunnel child over IPC only. */
  proxyToken: string;
  close(): Promise<void>;
};

type IngressLogger = { warn: (message: string) => void };

/** Serves an OpenClaw ID tunnel API request from the authenticated device `peerKey`. */
export type TunnelApiHandler = (
  req: IncomingMessage,
  res: http.ServerResponse,
  peerKey: string,
) => Promise<void>;

/**
 * Listens on `socketPath` and hands every authenticated request or upgrade to
 * `gatewayServer` (the Gateway's primary listener) after marking it relayed.
 */
export async function startOpenClawIdIngressListener(params: {
  socketPath: string;
  gatewayServer: () => HttpServer | undefined;
  log: IngressLogger;
  handleApi?: TunnelApiHandler;
}): Promise<OpenClawIdIngressListener> {
  const proxyToken = randomBytes(32).toString("base64url");
  const expected = Buffer.from(proxyToken);

  // Checks the token, then strips the contract headers and marks the request.
  // Returns the authenticated peer key, or undefined when refused.
  const admit = async (req: IncomingMessage): Promise<string | undefined> => {
    const token = req.headers[INGRESS_HEADERS.proxyToken];
    const peerKey = req.headers[INGRESS_HEADERS.peerKey];
    if (
      typeof token !== "string" ||
      token.length !== expected.length ||
      !timingSafeEqual(Buffer.from(token), expected) ||
      !isIrohEndpointKey(peerKey)
    ) {
      params.log.warn("openclaw-id: refused an ingress request without a valid proxy token");
      return undefined;
    }
    stripContractHeaders(req);
    markGatewayIngressTransport(req, {
      kind: "openclaw-id-tunnel",
      peerKey,
      clientIp: await syntheticPeerAddress(peerKey),
    });
    return peerKey;
  };

  const server = http.createServer();
  server.on("request", (req, res) => {
    void admit(req).then((peerKey) => {
      const ok = peerKey !== undefined;
      if (ok && params.handleApi && isTunnelApiRequest(req)) {
        params.handleApi(req, res, peerKey).catch((error: unknown) => {
          params.log.warn(`openclaw-id: tunnel API request failed: ${String(error)}`);
          if (!res.headersSent) {
            res.writeHead(500, { connection: "close" });
          }
          res.end();
        });
        return;
      }
      const gateway = params.gatewayServer();
      if (!ok || !gateway) {
        res.writeHead(ok ? 503 : 403, { connection: "close" }).end();
        return;
      }
      gateway.emit("request", req, res);
    });
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.once("error", () => socket.destroy());
    void admit(req).then((peerKey) => {
      const ok = peerKey !== undefined;
      const gateway = params.gatewayServer();
      if (!ok || !gateway) {
        socket.end(
          `HTTP/1.1 ${ok ? "503 Service Unavailable" : "403 Forbidden"}\r\nConnection: close\r\n\r\n`,
        );
        return;
      }
      gateway.emit("upgrade", req, socket, head);
    });
  });
  await listenPrivateSocket(server, params.socketPath);
  return {
    socketPath: params.socketPath,
    proxyToken,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        fs.rmSync(params.socketPath, { force: true });
      }),
  };
}

// Removes the ingress contract headers so nothing downstream can read or forward them.
// Node builds `headers` and `headersDistinct` lazily from `rawHeaders` using the
// header count it parsed, so both views are built and cleaned before rawHeaders
// shrinks; a view built afterwards would read past the end of the shorter array.
function stripContractHeaders(req: IncomingMessage): void {
  const names = new Set<string>([INGRESS_HEADERS.proxyToken, INGRESS_HEADERS.peerKey]);
  const distinct = req.headersDistinct;
  for (const name of names) {
    delete req.headers[name];
    delete distinct[name];
  }
  const raw = req.rawHeaders;
  const kept: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (!names.has(raw[i]!.toLowerCase())) {
      kept.push(raw[i]!, raw[i + 1]!);
    }
  }
  raw.splice(0, raw.length, ...kept);
}

// Binds a Unix socket only the Gateway user can open: 0700 directory, 0600 socket.
async function listenPrivateSocket(server: HttpServer, socketPath: string): Promise<void> {
  if (process.platform !== "win32") {
    const dir = socketPath.slice(0, socketPath.lastIndexOf("/"));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    // A socket left by a crashed Gateway would make listen fail with EADDRINUSE.
    fs.rmSync(socketPath, { force: true });
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") {
    fs.chmodSync(socketPath, 0o600);
  }
}
