import net from "node:net";
import os from "node:os";

import {
  getPairedNode,
  listNodePairing,
  type NodePairingPendingRequest,
  requestNodePairing,
  verifyNodeToken,
} from "../node-pairing.js";

type BridgeHelloFrame = {
  type: "hello";
  nodeId: string;
  displayName?: string;
  token?: string;
  platform?: string;
  version?: string;
};

type BridgePairRequestFrame = {
  type: "pair-request";
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  remoteAddress?: string;
};

type BridgeEventFrame = {
  type: "event";
  event: string;
  payloadJSON?: string | null;
};

type BridgePingFrame = { type: "ping"; id: string };
type BridgePongFrame = { type: "pong"; id: string };

type BridgeInvokeResponseFrame = {
  type: "invoke-res";
  id: string;
  ok: boolean;
  payloadJSON?: string | null;
  error?: { code: string; message: string } | null;
};

type BridgeHelloOkFrame = { type: "hello-ok"; serverName: string };
type BridgePairOkFrame = { type: "pair-ok"; token: string };
type BridgeErrorFrame = { type: "error"; code: string; message: string };

type AnyBridgeFrame =
  | BridgeHelloFrame
  | BridgePairRequestFrame
  | BridgeEventFrame
  | BridgePingFrame
  | BridgePongFrame
  | BridgeInvokeResponseFrame
  | BridgeHelloOkFrame
  | BridgePairOkFrame
  | BridgeErrorFrame
  | { type: string; [k: string]: unknown };

export type NodeBridgeServer = {
  port: number;
  close: () => Promise<void>;
};

export type NodeBridgeClientInfo = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  remoteIp?: string;
};

export type NodeBridgeServerOpts = {
  host: string;
  port: number; // 0 = ephemeral
  pairingBaseDir?: string;
  onEvent?: (nodeId: string, evt: BridgeEventFrame) => Promise<void> | void;
  onAuthenticated?: (node: NodeBridgeClientInfo) => Promise<void> | void;
  onDisconnected?: (node: NodeBridgeClientInfo) => Promise<void> | void;
  onPairRequested?: (
    request: NodePairingPendingRequest,
  ) => Promise<void> | void;
  serverName?: string;
};

function isTestEnv() {
  return process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);
}

function encodeLine(frame: AnyBridgeFrame) {
  return `${JSON.stringify(frame)}\n`;
}

async function sleep(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function startNodeBridgeServer(
  opts: NodeBridgeServerOpts,
): Promise<NodeBridgeServer> {
  if (isTestEnv() && process.env.CLAWDIS_ENABLE_BRIDGE_IN_TESTS !== "1") {
    return {
      port: 0,
      close: async () => {},
    };
  }

  const serverName =
    typeof opts.serverName === "string" && opts.serverName.trim()
      ? opts.serverName.trim()
      : os.hostname();

  const connections = new Map<string, net.Socket>();

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);

    let buffer = "";
    let isAuthenticated = false;
    let nodeId: string | null = null;
    let nodeInfo: NodeBridgeClientInfo | null = null;
    const invokeWaiters = new Map<
      string,
      {
        resolve: (value: BridgeInvokeResponseFrame) => void;
        reject: (err: Error) => void;
      }
    >();

    const abort = new AbortController();
    const stop = () => {
      if (!abort.signal.aborted) abort.abort();
      if (nodeId) connections.delete(nodeId);
      for (const [, waiter] of invokeWaiters) {
        waiter.reject(new Error("bridge connection closed"));
      }
      invokeWaiters.clear();
    };

    const send = (frame: AnyBridgeFrame) => {
      try {
        socket.write(encodeLine(frame));
      } catch {
        // ignore
      }
    };

    const sendError = (code: string, message: string) => {
      send({ type: "error", code, message } satisfies BridgeErrorFrame);
    };

    const remoteAddress = (() => {
      const addr = socket.remoteAddress?.trim();
      return addr && addr.length > 0 ? addr : undefined;
    })();

    const handleHello = async (hello: BridgeHelloFrame) => {
      nodeId = String(hello.nodeId ?? "").trim();
      if (!nodeId) {
        sendError("INVALID_REQUEST", "nodeId required");
        return;
      }

      const token = typeof hello.token === "string" ? hello.token.trim() : "";
      if (!token) {
        const paired = await getPairedNode(nodeId, opts.pairingBaseDir);
        sendError(paired ? "UNAUTHORIZED" : "NOT_PAIRED", "pairing required");
        return;
      }

      const verified = await verifyNodeToken(
        nodeId,
        token,
        opts.pairingBaseDir,
      );
      if (!verified.ok || !verified.node) {
        sendError("UNAUTHORIZED", "invalid token");
        return;
      }

      isAuthenticated = true;
      connections.set(nodeId, socket);
      nodeInfo = {
        nodeId,
        displayName: verified.node.displayName ?? hello.displayName,
        platform: verified.node.platform ?? hello.platform,
        version: verified.node.version ?? hello.version,
        remoteIp: remoteAddress,
      };
      send({ type: "hello-ok", serverName } satisfies BridgeHelloOkFrame);
      await opts.onAuthenticated?.(nodeInfo);
    };

    const waitForApproval = async (request: {
      requestId: string;
      nodeId: string;
      ts: number;
      isRepair?: boolean;
    }): Promise<
      { ok: true; token: string } | { ok: false; reason: string }
    > => {
      const deadline = Date.now() + 5 * 60 * 1000;
      while (!abort.signal.aborted && Date.now() < deadline) {
        const list = await listNodePairing(opts.pairingBaseDir);
        const stillPending = list.pending.some(
          (p) => p.requestId === request.requestId,
        );
        if (stillPending) {
          await sleep(250);
          continue;
        }

        const paired = await getPairedNode(request.nodeId, opts.pairingBaseDir);
        if (!paired) return { ok: false, reason: "pairing rejected" };

        // For a repair, ensure this approval happened after the request was created.
        if (paired.approvedAtMs < request.ts) {
          return { ok: false, reason: "pairing rejected" };
        }

        return { ok: true, token: paired.token };
      }

      return {
        ok: false,
        reason: abort.signal.aborted ? "disconnected" : "pairing expired",
      };
    };

    const handlePairRequest = async (req: BridgePairRequestFrame) => {
      nodeId = String(req.nodeId ?? "").trim();
      if (!nodeId) {
        sendError("INVALID_REQUEST", "nodeId required");
        return;
      }

      const result = await requestNodePairing(
        {
          nodeId,
          displayName: req.displayName,
          platform: req.platform,
          version: req.version,
          remoteIp: remoteAddress,
        },
        opts.pairingBaseDir,
      );
      if (result.created) {
        await opts.onPairRequested?.(result.request);
      }

      const wait = await waitForApproval(result.request);
      if (!wait.ok) {
        sendError("UNAUTHORIZED", wait.reason);
        return;
      }

      isAuthenticated = true;
      connections.set(nodeId, socket);
      nodeInfo = {
        nodeId,
        displayName: req.displayName,
        platform: req.platform,
        version: req.version,
        remoteIp: remoteAddress,
      };
      send({ type: "pair-ok", token: wait.token } satisfies BridgePairOkFrame);
      send({ type: "hello-ok", serverName } satisfies BridgeHelloOkFrame);
      await opts.onAuthenticated?.(nodeInfo);
    };

    const handleEvent = async (evt: BridgeEventFrame) => {
      if (!isAuthenticated || !nodeId) {
        sendError("UNAUTHORIZED", "not authenticated");
        return;
      }
      await opts.onEvent?.(nodeId, evt);
    };

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx === -1) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const trimmed = line.trim();
        if (!trimmed) continue;

        void (async () => {
          let frame: AnyBridgeFrame;
          try {
            frame = JSON.parse(trimmed) as AnyBridgeFrame;
          } catch (err) {
            sendError("INVALID_REQUEST", String(err));
            return;
          }

          const type = typeof frame.type === "string" ? frame.type : "";
          try {
            switch (type) {
              case "hello":
                await handleHello(frame as BridgeHelloFrame);
                break;
              case "pair-request":
                await handlePairRequest(frame as BridgePairRequestFrame);
                break;
              case "event":
                await handleEvent(frame as BridgeEventFrame);
                break;
              case "ping": {
                if (!isAuthenticated) {
                  sendError("UNAUTHORIZED", "not authenticated");
                  break;
                }
                const ping = frame as BridgePingFrame;
                send({
                  type: "pong",
                  id: String(ping.id ?? ""),
                } satisfies BridgePongFrame);
                break;
              }
              case "invoke-res": {
                if (!isAuthenticated) {
                  sendError("UNAUTHORIZED", "not authenticated");
                  break;
                }
                const res = frame as BridgeInvokeResponseFrame;
                const waiter = invokeWaiters.get(res.id);
                if (waiter) {
                  invokeWaiters.delete(res.id);
                  waiter.resolve(res);
                }
                break;
              }
              case "pong":
                // ignore
                break;
              default:
                sendError("INVALID_REQUEST", "unknown type");
            }
          } catch (err) {
            sendError("INVALID_REQUEST", String(err));
          }
        })();
      }
    });

    socket.on("close", () => {
      const info = nodeInfo;
      stop();
      if (info && isAuthenticated) void opts.onDisconnected?.(info);
    });
    socket.on("error", () => {
      // close handler will run after close
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });

  const address = server.address();
  const port =
    typeof address === "object" && address ? address.port : opts.port;

  return {
    port,
    close: async () => {
      for (const sock of connections.values()) {
        try {
          sock.destroy();
        } catch {
          /* ignore */
        }
      }
      connections.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
