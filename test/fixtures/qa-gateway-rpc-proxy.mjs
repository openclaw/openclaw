import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";

/**
 * @typedef {"front-open" | "upstream-create-start" | "upstream-create-return" |
 *   "upstream-upgrade" | "upstream-open" | "challenge-received" |
 *   "challenge-write-ok" | "challenge-write-error" | "challenge-forward-unavailable" |
 *   "connect-received" | "front-close" | "upstream-close" | "front-error" |
 *   "upstream-error" | "front-terminate" | "upstream-terminate"} FirstConnectionTag
 * @typedef {"CONNECTING" | "OPEN" | "CLOSING" | "CLOSED" | "none" | "other"} SocketState
 * @typedef {"none" | "hold-reconnect" | "request-limit" | "response-dropped" |
 *   "front-close" | "upstream-close" | "front-error" | "upstream-error" |
 *   "stop"} TerminationCause
 * @typedef {"none" | "other" | "ECONNRESET" | "ECONNREFUSED" | "ETIMEDOUT" |
 *   "EHOSTUNREACH" | "ENETUNREACH" | "EPIPE"} SocketErrorCode
 * @typedef {{ state?: SocketState, localTermination?: TerminationCause,
 *   errorCode?: SocketErrorCode }} FirstConnectionFacts
 */

/**
 * @param {{
 *   backendPort: number,
 *   repoRoot: string,
 *   recordPath?: string,
 *   token?: string,
 *   port?: number,
 *   upstreamHeaders?: import("ws").ClientOptions["headers"],
 *   observedMethods?: readonly string[],
 *   mediaPaths?: ReadonlySet<string>
 * }} options
 */
export async function startQaGatewayRpcProxy({
  backendPort,
  repoRoot,
  recordPath,
  token,
  port = 0,
  upstreamHeaders,
  observedMethods = [],
  mediaPaths = new Set(),
}) {
  const { WebSocket, WebSocketServer } = createRequire(path.join(repoRoot, "package.json"))("ws");
  const peers = new Set();
  const httpRequests = new Set();
  const media = { requests: 0, matched: 0, completed: 0, succeeded: 0 };
  let events = [];
  let sequence = 0;
  let connection = 0;
  let dropResponse = false;
  let holdHello = false;
  let held;
  let holdMethod;
  let heldResponse;
  /** @type {((error?: Error) => void) | undefined} */
  let heldWaiter;
  let mediaTask;
  /** @type {Array<{ tag: FirstConnectionTag, elapsedMs: number } & FirstConnectionFacts>} */
  const firstConnection = [];
  /** @type {{ front: TerminationCause, upstream: TerminationCause }} */
  const firstTerminations = { front: "none", upstream: "none" };
  let firstConnectionStartedAt = 0;
  // Diagnostics must not throw through socket callbacks or consume the RPC evidence limit.
  /** @param {number} id @param {FirstConnectionTag} tag @param {FirstConnectionFacts} [facts] */
  const recordFirstConnection = (id, tag, facts = {}) => {
    if (
      id !== 1 ||
      firstConnection.length >= 16 ||
      firstConnection.some((entry) => entry.tag === tag)
    ) {
      return;
    }
    firstConnection.push({
      tag,
      elapsedMs: Math.max(0, Math.floor(performance.now() - firstConnectionStartedAt)),
      ...facts,
    });
  };
  /** @param {number | undefined} state @returns {SocketState} */
  const socketState = (state) => {
    switch (state) {
      case WebSocket.CONNECTING:
        return "CONNECTING";
      case WebSocket.OPEN:
        return "OPEN";
      case WebSocket.CLOSING:
        return "CLOSING";
      case WebSocket.CLOSED:
        return "CLOSED";
      case undefined:
        return "none";
      default:
        return "other";
    }
  };
  /** @param {unknown} error @returns {SocketErrorCode} */
  const socketErrorCode = (error) => {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    switch (code) {
      case undefined:
        return "none";
      case "ECONNRESET":
      case "ECONNREFUSED":
      case "ETIMEDOUT":
      case "EHOSTUNREACH":
      case "ENETUNREACH":
      case "EPIPE":
        return code;
      default:
        return "other";
    }
  };
  /**
   * @param {number} id @param {"front" | "upstream"} endpoint
   * @param {import("ws").WebSocket} socket @param {TerminationCause} cause
   */
  const recordFirstTermination = (id, endpoint, socket, cause) => {
    if (id !== 1 || firstTerminations[endpoint] !== "none") {
      return;
    }
    // A later close/error cascade must not overwrite the initiating local action.
    firstTerminations[endpoint] = cause;
    recordFirstConnection(id, endpoint === "front" ? "front-terminate" : "upstream-terminate", {
      state: socketState(socket.readyState),
      localTermination: cause,
    });
  };
  const snapshot = () => ({
    events: [...events],
    firstConnection: firstConnection.map(
      ({ tag, elapsedMs, state, localTermination, errorCode }) => ({
        tag,
        elapsedMs,
        state,
        localTermination,
        errorCode,
      }),
    ),
    media: { ...media },
    held: Boolean(held),
    heldResponse: heldResponse?.summary,
    pid: process.pid,
  });
  const record = (kind, facts = {}) => {
    if (events.length >= 256) {
      throw new Error("proxy evidence limit exceeded");
    }
    const event = { sequence: ++sequence, kind, ...facts };
    events.push(event);
    if (recordPath) {
      appendFileSync(recordPath, `${JSON.stringify(event)}\n`);
    }
  };
  if (recordPath) {
    writeFileSync(recordPath, "");
  }
  const server = createServer((req, res) => {
    if (req.url === "/__fixture") {
      if (!token || req.headers["x-qa-fixture-token"] !== token) {
        res.writeHead(403).end();
        return;
      }
      void (async () => {
        let text = "";
        for await (const chunk of req) {
          text += chunk;
          if (text.length > 1024) {
            throw new Error("fixture control limit exceeded");
          }
        }
        const input = text ? JSON.parse(text) : {};
        const action = input.action ?? "snapshot";
        if (action === "reset") {
          events = [];
          sequence = 0;
          dropResponse = false;
          if (recordPath) {
            writeFileSync(recordPath, "");
          }
        } else if (action === "hold-response") {
          if (
            !["users.self", "chat.send", "media.get", "plugin.surface.refresh"].includes(
              input.method,
            ) ||
            holdMethod ||
            heldResponse
          ) {
            throw new Error("invalid or overlapping response hold");
          }
          holdMethod = input.method;
        } else if (action === "wait-held") {
          if (!heldResponse) {
            if (!holdMethod || heldWaiter) {
              throw new Error("no response hold or another waiter is active");
            }
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                heldWaiter = undefined;
                reject(new Error("response hold timed out"));
              }, 30_000);
              heldWaiter = (error) => {
                clearTimeout(timer);
                heldWaiter = undefined;
                if (error) {
                  reject(error);
                } else {
                  resolve();
                }
              };
            });
          }
        } else if (action === "release-response") {
          if (!heldResponse) {
            throw new Error("no held response");
          }
          const releasing = heldResponse;
          heldResponse = undefined;
          const delivered = await releasing.release();
          record("response-released", { ...releasing.summary, delivered });
        } else if (action === "drop-response") {
          dropResponse = true;
        } else if (action === "hold-reconnect") {
          holdHello = true;
          for (const peer of peers) {
            recordFirstTermination(peer.id, "front", peer.front, "hold-reconnect");
            peer.front.terminate();
            recordFirstTermination(peer.id, "upstream", peer.back, "hold-reconnect");
            peer.back.terminate();
          }
        } else if (action === "release-hello") {
          if (!held) {
            throw new Error("no held hello");
          }
          record("hello-released", { connection: held.connection });
          const releasing = held;
          held = undefined;
          for (const raw of releasing.frames) {
            releasing.front.send(raw);
          }
        } else if (action !== "snapshot") {
          throw new Error("unknown fixture action");
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(snapshot()));
      })().catch(() => res.writeHead(500).end("fixture control failed"));
      return;
    }
    // Inspect only the pathname. Ticket queries and HTTP headers never enter evidence.
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    const observedMedia = req.method === "GET" && mediaPaths.has(pathname);
    if (mediaPaths.size > 0 && req.method === "GET" && ++media.requests > 32) {
      res.writeHead(429).end();
      return;
    }
    if (observedMedia) {
      media.matched += 1;
    }
    const upstream = request(
      { hostname: "127.0.0.1", port: backendPort, path: req.url, method: req.method },
      (response) => {
        if (observedMedia) {
          response.once("end", () => {
            media.completed += 1;
            if (response.statusCode === 200) {
              media.succeeded += 1;
            }
          });
        }
        if (observedMedia && holdMethod === "media.get") {
          mediaTask = (async () => {
            const chunks = [];
            let sizeBytes = 0;
            for await (const chunk of response) {
              sizeBytes += chunk.length;
              if (sizeBytes > 1024 * 1024) {
                throw new Error("held media response exceeded limit");
              }
              chunks.push(chunk);
            }
            const data = Buffer.concat(chunks);
            holdMethod = undefined;
            heldResponse = {
              summary: {
                method: "media.get",
                ok: response.statusCode === 200,
                sizeBytes,
                sha256: createHash("sha256").update(data).digest("hex"),
              },
              release: async () => {
                if (res.destroyed) {
                  return false;
                }
                res.writeHead(response.statusCode ?? 503, response.headers);
                // A queued write is not completed delivery; close/error must
                // keep the retirement proof from passing on HTTP cancellation.
                const completion = finished(res, { cleanup: true }).then(
                  () => true,
                  () => false,
                );
                res.end(data);
                return await completion;
              },
            };
            record("response-held", heldResponse.summary);
            heldWaiter?.();
          })().catch(() => {
            holdMethod = undefined;
            heldWaiter?.(new Error("held media response failed"));
            res.destroy();
          });
          return;
        }
        res.writeHead(response.statusCode ?? 503, response.headers);
        response.pipe(res);
      },
    );
    httpRequests.add(upstream);
    upstream.once("close", () => httpRequests.delete(upstream));
    upstream.on("error", () => res.writeHead(503).end());
    req.pipe(upstream);
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (front) => {
    const id = ++connection;
    if (id === 1) {
      firstConnectionStartedAt = performance.now();
    }
    recordFirstConnection(id, "front-open");
    let challengeReceived = false;
    // Native ws:// clients deliberately omit custom headers. This fixture acts
    // as their trusted proxy without changing signed client/device identity.
    recordFirstConnection(id, "upstream-create-start");
    const back = new WebSocket(`ws://127.0.0.1:${backendPort}`, {
      headers: upstreamHeaders,
    });
    recordFirstConnection(id, "upstream-create-return");
    const peer = { id, front, back };
    peers.add(peer);
    const methods = new Map();
    const pending = [];
    front.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "req") {
        if (methods.size >= 128 || pending.length >= 128) {
          recordFirstTermination(id, "front", front, "request-limit");
          front.terminate();
          return;
        }
        methods.set(frame.id, frame.method);
        if (observedMethods.includes(frame.method)) {
          record("rpc-request", {
            connection: id,
            requestId: frame.id,
            method: frame.method,
            ...(frame.method === "plugin.surface.refresh"
              ? { expectedProfileId: frame.expectedProfileId, surface: frame.params?.surface }
              : {}),
          });
        }
        if (frame.method === "connect") {
          recordFirstConnection(id, "connect-received");
          record("connect-request", {
            connection: id,
            clientId: frame.params?.client?.id,
            deviceId: frame.params?.device?.id,
          });
        }
        if (frame.method === "sessions.create") {
          record("mutation-request", { connection: id, requestId: frame.id });
        }
      }
      if (back.readyState === WebSocket.OPEN) {
        back.send(raw);
      } else {
        pending.push(raw);
      }
    });
    // ws emits upgrade before validation; open marks a validated WebSocket upgrade.
    back.on("upgrade", () => recordFirstConnection(id, "upstream-upgrade"));
    back.on("open", () => {
      recordFirstConnection(id, "upstream-open");
      for (const raw of pending.splice(0)) {
        back.send(raw);
      }
    });
    back.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      const firstChallenge =
        id === 1 &&
        !challengeReceived &&
        frame.type === "event" &&
        frame.event === "connect.challenge";
      if (firstChallenge) {
        challengeReceived = true;
        recordFirstConnection(id, "challenge-received");
      }
      const method = methods.get(frame.id);
      if (frame.type === "res") {
        methods.delete(frame.id);
        if (observedMethods.includes(method)) {
          record("rpc-response", {
            connection: id,
            requestId: frame.id,
            method,
            ok: frame.ok,
            ...(method === "plugin.surface.refresh"
              ? { reason: frame.error?.details?.reason }
              : {}),
          });
        }
        if (method === "connect" && frame.ok) {
          const canvas = frame.payload?.pluginSurfaceUrls?.canvas;
          // Keep only the advertised HTTP authority, never the capability token.
          const canvasURL = typeof canvas === "string" ? URL.parse(canvas) : null;
          const canvasOrigin =
            canvasURL && ["http:", "https:"].includes(canvasURL.protocol)
              ? canvasURL.origin
              : undefined;
          record("connect-success", {
            connection: id,
            scopes: frame.payload?.auth?.scopes,
            canvasOrigin,
          });
        }
        if (method === "chat.send") {
          record("send-response", {
            connection: id,
            ok: frame.ok,
            runId: frame.payload?.runId,
            status: frame.payload?.status,
          });
        }
        if (holdMethod && method === holdMethod) {
          holdMethod = undefined;
          heldResponse = {
            release: () => {
              if (front.readyState !== WebSocket.OPEN) {
                return false;
              }
              front.send(raw);
              return true;
            },
            summary: {
              method,
              connection: id,
              ok: frame.ok,
              runId: frame.payload?.runId,
              status: frame.payload?.status,
            },
          };
          record("response-held", heldResponse.summary);
          heldWaiter?.();
          return;
        }
      }
      if (frame.type === "res" && method === "sessions.create") {
        record(frame.ok ? "mutation-success" : "mutation-error", {
          connection: id,
          requestId: frame.id,
          ...(frame.ok
            ? { key: frame.payload?.key }
            : {
                labelCollision: frame.error?.message?.startsWith("label already in use") === true,
              }),
        });
        if (frame.ok && dropResponse) {
          // A successful real response proves commit before the only injected loss.
          dropResponse = false;
          record("response-dropped", {
            connection: id,
            requestId: frame.id,
            key: frame.payload?.key,
          });
          recordFirstTermination(id, "front", front, "response-dropped");
          front.terminate();
          recordFirstTermination(id, "upstream", back, "response-dropped");
          back.terminate();
          return;
        }
      }
      if (frame.type === "res" && method === "connect" && frame.ok && holdHello) {
        holdHello = false;
        held = { connection: id, front, frames: [raw] };
        record("hello-held", { connection: id });
        return;
      }
      if (firstChallenge && (held?.front === front || front.readyState !== WebSocket.OPEN)) {
        recordFirstConnection(id, "challenge-forward-unavailable");
      }
      if (held?.front === front) {
        if (held.frames.length >= 128) {
          throw new Error("held frame limit exceeded");
        }
        held.frames.push(raw);
      } else if (front.readyState === WebSocket.OPEN) {
        front.send(
          raw,
          firstChallenge
            ? (error) =>
                recordFirstConnection(id, error ? "challenge-write-error" : "challenge-write-ok")
            : undefined,
        );
      }
    });
    front.on("close", () => {
      recordFirstConnection(id, "front-close");
      recordFirstTermination(id, "upstream", back, "front-close");
      back.terminate();
      peers.delete(peer);
      if (held?.front === front) {
        held = undefined;
      }
    });
    back.on("close", () => {
      recordFirstConnection(id, "upstream-close");
      recordFirstTermination(id, "front", front, "upstream-close");
      front.terminate();
    });
    front.on("error", (error) => {
      recordFirstConnection(id, "front-error", {
        state: socketState(front.readyState),
        localTermination: firstTerminations.front,
        errorCode: socketErrorCode(error),
      });
      recordFirstTermination(id, "upstream", back, "front-error");
      back.terminate();
    });
    back.on("error", (error) => {
      recordFirstConnection(id, "upstream-error", {
        state: socketState(back.readyState),
        localTermination: firstTerminations.upstream,
        errorCode: socketErrorCode(error),
      });
      recordFirstTermination(id, "front", front, "upstream-error");
      front.terminate();
    });
  });
  let stopping;
  const stop = () =>
    (stopping ??= (async () => {
      heldWaiter?.(new Error("proxy stopped"));
      heldResponse = undefined;
      for (const peer of peers) {
        recordFirstTermination(peer.id, "front", peer.front, "stop");
        peer.front.terminate();
        recordFirstTermination(peer.id, "upstream", peer.back, "stop");
        peer.back.terminate();
      }
      for (const upstream of httpRequests) {
        upstream.destroy();
      }
      await mediaTask;
      heldResponse = undefined;
      server.closeAllConnections();
      await new Promise((resolve) => {
        sockets.close(resolve);
      });
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    })());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `ws://127.0.0.1:${address.port}`,
    controlUrl: `http://127.0.0.1:${address.port}/__fixture`,
    snapshot,
    stop,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [backendPort, repoRoot, recordPath, command, ...args] = process.argv.slice(2);
  if (command === "models") {
    for await (const chunk of process.stdin) {
      // The packaged-bootstrap fixture consumes synthetic auth without retaining it.
      void chunk;
    }
  } else if (command === "update") {
    if (args.includes("--help")) {
      process.stdout.write("--accept-capabilities\n");
    }
  } else if (command === "gateway") {
    const proxy = await startQaGatewayRpcProxy({
      backendPort: Number(backendPort),
      repoRoot,
      recordPath,
      token: process.env.OPENCLAW_GATEWAY_TOKEN,
      port: Number(args[args.indexOf("--port") + 1]),
    });
    const stop = () =>
      void proxy.stop().catch(() => {
        process.exitCode = 1;
      });
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    setTimeout(stop, 240_000).unref();
  } else {
    throw new Error("unexpected proxy fixture command");
  }
}
