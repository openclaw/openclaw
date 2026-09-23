import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { createRequire } from "node:module";
import path from "node:path";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const READINESS_METHODS = new Set([
  "connect",
  "users.self",
  "chat.history",
  "agents.list",
  "sessions.messages.subscribe",
  "sessions.branches.list",
  "health",
  "sessions.list",
  "models.list",
]);
const READINESS_ERROR_CODES = new Set([
  "NOT_LINKED",
  "NOT_PAIRED",
  "AGENT_TIMEOUT",
  "INVALID_REQUEST",
  "UNAVAILABLE",
]);

/**
 * @typedef {"front-open" | "upstream-create-start" | "upstream-create-return" |
 *   "upstream-upgrade" | "upstream-open" | "challenge-received" |
 *   "challenge-write-ok" | "challenge-write-error" | "challenge-forward-unavailable" |
 *   "connect-received" | "front-close" | "upstream-close" | "front-error" |
 *   "upstream-error" | "front-terminate" | "upstream-terminate"} FirstConnectionTag
 * @typedef {"CONNECTING" | "OPEN" | "CLOSING" | "CLOSED" | "none" | "other"} SocketState
 * @typedef {"none" | "hold-reconnect" | "request-limit" | "response-dropped" |
 *   "front-close" | "upstream-close" | "front-error" | "upstream-error" |
 *   "node-fault" | "stop"} TerminationCause
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
 *   observeMobileHandoff?: boolean,
 *   observeNativeActions?: boolean,
 *   captureReadiness?: boolean,
 *   mediaPaths?: ReadonlySet<string>,
 *   tls?: { key: string, cert: string }
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
  observeMobileHandoff = false,
  observeNativeActions = false,
  captureReadiness = false,
  mediaPaths = new Set(),
  tls,
}) {
  const { WebSocket, WebSocketServer } = createRequire(path.join(repoRoot, "package.json"))("ws");
  // Installed proof retains bounded selector facts, never prompt or auth payloads.
  const nativeMethods = new Set([
    "users.self",
    "chat.send",
    "chat.abort",
    "agent.wait",
    "chat.history",
    "sessions.create",
    "sessions.fork",
    "sessions.reset",
    "approval.get",
  ]);
  const observes = (method) =>
    observedMethods.includes(method) || (observeNativeActions && nativeMethods.has(method));
  const selector = (value) =>
    typeof value === "string" && value.length <= 512 ? value : undefined;
  // Only equality leaves this bounded in-memory handoff map; no bearer is recorded.
  const operatorHandoffTokens = new Map();
  const peers = new Set();
  const httpRequests = new Set();
  const media = { requests: 0, matched: 0, completed: 0, succeeded: 0 };
  let events = [];
  let sequence = 0;
  let connectionCount = 0;
  let dropResponse = false;
  let holdHello = false;
  let held;
  let holdMethod;
  let holdSelector;
  let holdConnection;
  let approvalReservation;
  let rejectCreate;
  let nodeFault = false;
  const controlTasks = new Set();
  const fixtureWrites = new Set();
  const acceptedSockets = new Map();
  const requestSelector = (frame) => ({
    expectedProfileId: selector(frame.expectedProfileId),
    sessionKey: selector(frame.params?.sessionKey),
    key: selector(frame.params?.key),
    entryId: selector(frame.params?.entryId),
    parentSessionKey: selector(frame.params?.parentSessionKey),
    agentId: selector(frame.params?.agentId),
    runId: selector(frame.params?.runId),
    approvalId: selector(frame.params?.id),
    inputRunId:
      Array.isArray(frame.params?.inputRunIds) && frame.params.inputRunIds.length === 1
        ? selector(frame.params.inputRunIds[0])
        : undefined,
  });
  const matchesSelector = (facts, expected) =>
    !expected || Object.entries(expected).every(([key, value]) => facts?.[key] === value);
  const readSelector = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("missing fixture producer selector");
    }
    const keys = Object.keys(value);
    if (
      !keys.length ||
      keys.some(
        (key) =>
          ![
            "expectedProfileId",
            "sessionKey",
            "agentId",
            "runId",
            "approvalId",
            "inputRunId",
          ].includes(key) ||
          typeof value[key] !== "string" ||
          value[key].length === 0 ||
          value[key].length > 512,
      )
    ) {
      throw new Error("invalid fixture producer selector");
    }
    return { ...value };
  };
  let heldResponse;
  /** @type {((error?: Error) => void) | undefined} */
  let heldWaiter;
  let mediaTask;
  let responseReleaseTask;
  // This public failure projection is separate from private assertion evidence.
  // Saturation stops recording, never forwarding; raw correlation IDs stay private.
  const readiness = [];
  let readinessTruncated = false;
  const readinessStartedAt = performance.now();
  const readinessTime = () => Math.max(0, Math.floor(performance.now() - readinessStartedAt));
  const readinessConnection = (id) => (captureReadiness ? readiness[id - 1] : undefined);
  const readinessSnapshot = () => ({
    truncated: readinessTruncated,
    connections: readiness.map(({ connection, handshake, lifecycle, requests, truncated }) => ({
      connection,
      truncated,
      handshake: {
        requestReadyMs: handshake.requestReadyMs,
        tcpConnectedMs: handshake.tcpConnectedMs,
        requestFinishedMs: handshake.requestFinishedMs,
        socketAssigned: handshake.socketAssigned
          ? {
              elapsedMs: handshake.socketAssigned.elapsedMs,
              connecting: handshake.socketAssigned.connecting,
            }
          : undefined,
        httpResponse: handshake.httpResponse
          ? {
              elapsedMs: handshake.httpResponse.elapsedMs,
              statusCode: handshake.httpResponse.statusCode,
            }
          : undefined,
      },
      lifecycle: lifecycle.map(({ tag, elapsedMs, state, localTermination, errorCode }) => ({
        tag,
        elapsedMs,
        state,
        localTermination,
        errorCode,
      })),
      requests: requests.map((entry) => ({
        ordinal: entry.ordinal,
        method: entry.method,
        observedMs: entry.observedMs,
        queued: entry.queued,
        upstreamStartedMs: entry.upstreamStartedMs,
        upstreamWrite: entry.upstreamWrite
          ? {
              elapsedMs: entry.upstreamWrite.elapsedMs,
              outcome: entry.upstreamWrite.outcome,
            }
          : undefined,
        response: entry.response
          ? {
              elapsedMs: entry.response.elapsedMs,
              outcome: entry.response.outcome,
              code: entry.response.code,
            }
          : undefined,
        frontWrite: entry.frontWrite
          ? {
              elapsedMs: entry.frontWrite.elapsedMs,
              outcome: entry.frontWrite.outcome,
            }
          : undefined,
      })),
    })),
  });
  // Freeze the existing 4 × 32 capture before an awaited private timeline read.
  // Reused IDs and saturated captures cannot establish an exact request owner.
  const captureHistoryRequestMatcher = () => {
    const incomplete =
      !captureReadiness || readinessTruncated || readiness.some((row) => row.truncated);
    const frozenRequests = readiness.flatMap(({ connection, requests }) =>
      requests
        .filter((row) => row.method === "chat.history")
        .map((row) => ({
          id: row.privateRequestId,
          connection,
          request: row.ordinal,
        })),
    );
    /** @param {unknown} id @returns {{ status: "matched", connection: number, request: number } | { status: "unknown" }} */
    function matchHistoryRequest(id) {
      if (incomplete || typeof id !== "string" || id.length === 0 || id.length > 128) {
        return { status: "unknown" };
      }
      const matches = frozenRequests.filter((row) => row.id === id);
      return matches.length === 1
        ? { status: "matched", connection: matches[0].connection, request: matches[0].request }
        : { status: "unknown" };
    }
    return matchHistoryRequest;
  };
  /** @type {Array<{ tag: FirstConnectionTag, elapsedMs: number } & FirstConnectionFacts>} */
  const firstConnection = [];
  /** @type {{ front: TerminationCause, upstream: TerminationCause }} */
  const firstTerminations = { front: "none", upstream: "none" };
  let firstConnectionStartedAt = 0;
  // Diagnostics must not throw through socket callbacks or consume the RPC evidence limit.
  /** @param {number} id @param {FirstConnectionTag} tag @param {FirstConnectionFacts} [facts] */
  const recordFirstConnection = (id, tag, facts = {}) => {
    const diagnostic = readinessConnection(id);
    if (diagnostic && !diagnostic.lifecycle.some((entry) => entry.tag === tag)) {
      if (diagnostic.lifecycle.length < 16) {
        diagnostic.lifecycle.push({
          tag,
          elapsedMs: readinessTime(),
          ...facts,
          ...(tag === "front-error" || tag === "upstream-error"
            ? {
                localTermination:
                  diagnostic.terminations[tag === "front-error" ? "front" : "upstream"],
              }
            : {}),
        });
      } else {
        diagnostic.truncated = readinessTruncated = true;
      }
    }
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
    const diagnostic = readinessConnection(id);
    if (diagnostic && diagnostic.terminations[endpoint] === "none") {
      diagnostic.terminations[endpoint] = cause;
      recordFirstConnection(id, endpoint === "front" ? "front-terminate" : "upstream-terminate", {
        state: socketState(socket.readyState),
        localTermination: cause,
      });
    }
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
    approval: approvalReservation ? { ...approvalReservation } : undefined,
    nodeFault,
    acceptedConnections: acceptedSockets.size,
    connectedOperators: [...peers].filter(
      (peer) =>
        peer.role === "operator" &&
        peer.connected &&
        peer.front.readyState === WebSocket.OPEN &&
        peer.back.readyState === WebSocket.OPEN,
    ).length,
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
  const invalidateApproval = (reason) => {
    if (!approvalReservation) {
      return;
    }
    approvalReservation.status = "invalid";
    approvalReservation.reason ??= reason;
    if (holdConnection === approvalReservation.connection) {
      holdMethod = holdSelector = holdConnection = undefined;
    }
    heldWaiter?.(new Error("approval producer binding invalidated"));
  };
  const handleRequest = (req, res) => {
    if (req.url === "/__fixture") {
      if (!token || req.headers["x-qa-fixture-token"] !== token) {
        res.writeHead(403).end();
        return;
      }
      const controlTask = (async () => {
        if (stopping || controlTasks.size >= 8) {
          throw new Error("fixture control admission closed");
        }
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
          if (
            holdMethod ||
            heldResponse ||
            responseReleaseTask ||
            rejectCreate ||
            fixtureWrites.size ||
            nodeFault ||
            (approvalReservation && !["released", "invalid"].includes(approvalReservation.status))
          ) {
            throw new Error("cannot reset an active fixture producer");
          }
          approvalReservation = undefined;
          events = [];
          sequence = 0;
          dropResponse = false;
          if (recordPath) {
            writeFileSync(recordPath, "");
          }
        } else if (action === "hold-approval-response") {
          if (
            approvalReservation ||
            holdMethod ||
            heldResponse ||
            responseReleaseTask ||
            rejectCreate ||
            fixtureWrites.size ||
            mediaTask ||
            held ||
            holdHello ||
            dropResponse
          ) {
            throw new Error("overlapping approval producer reservation");
          }
          const expected = readSelector(input.selector);
          if (
            Object.keys(expected).length !== 3 ||
            !expected.expectedProfileId ||
            !expected.sessionKey ||
            !expected.agentId ||
            !Number.isSafeInteger(input.connection)
          ) {
            throw new Error("approval reservation requires its exact native producer");
          }
          const peer = [...peers].find((candidate) => candidate.id === input.connection);
          if (
            !peer ||
            peer.role !== "operator" ||
            peer.clientId !== "openclaw-ios" ||
            !peer.connected ||
            peer.profileId !== expected.expectedProfileId ||
            peer.front.readyState !== WebSocket.OPEN ||
            peer.back.readyState !== WebSocket.OPEN
          ) {
            throw new Error("approval native owner is not live");
          }
          approvalReservation = { connection: peer.id, ...expected, status: "waiting-event" };
        } else if (action === "hold-response") {
          if (
            ![
              "users.self",
              "chat.send",
              "chat.history",
              "sessions.create",
              "media.get",
              "plugin.surface.refresh",
            ].includes(input.method) ||
            holdMethod ||
            approvalReservation ||
            rejectCreate ||
            fixtureWrites.size ||
            heldResponse ||
            mediaTask ||
            responseReleaseTask
          ) {
            throw new Error("invalid or overlapping response hold");
          }
          if (input.method === "sessions.create" && dropResponse) {
            throw new Error("create delivery already has an injected loss");
          }
          const requiresSelector = ["chat.history", "sessions.create"].includes(input.method);
          holdSelector =
            requiresSelector || input.selector !== undefined
              ? readSelector(input.selector)
              : undefined;
          if (requiresSelector && !holdSelector.expectedProfileId) {
            throw new Error("native hold requires the profile producer");
          }
          if (input.method === "chat.history" && !holdSelector.sessionKey) {
            throw new Error("history hold requires its session producer");
          }
          holdMethod = input.method;
        } else if (action === "wait-held") {
          if (!heldResponse) {
            if ((!holdMethod && approvalReservation?.status !== "waiting-event") || heldWaiter) {
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
          // Consume once, but reserve the hold until HTTP completion or the
          // WebSocket callback settles so controls cannot rearm during delivery.
          responseReleaseTask = (async () => {
            const delivered = await releasing.release();
            record("response-released", { ...releasing.summary, delivered });
            if (
              approvalReservation &&
              approvalReservation.requestId === releasing.summary.requestId &&
              approvalReservation.connection === releasing.summary.connection
            ) {
              if (delivered && approvalReservation.status === "held") {
                approvalReservation.status = "released";
              } else {
                invalidateApproval("delivery-failed");
              }
            }
          })().finally(() => {
            responseReleaseTask = undefined;
          });
          await responseReleaseTask;
        } else if (action === "reject-create") {
          if (
            rejectCreate ||
            dropResponse ||
            holdMethod ||
            heldResponse ||
            responseReleaseTask ||
            mediaTask ||
            fixtureWrites.size ||
            approvalReservation
          ) {
            throw new Error("overlapping controlled create fault");
          }
          rejectCreate = readSelector(input.selector);
          if (!rejectCreate.expectedProfileId || !rejectCreate.agentId) {
            rejectCreate = undefined;
            throw new Error("create fault requires profile and agent");
          }
        } else if (action === "fail-node") {
          const operators = [...peers].filter(
            (peer) =>
              peer.role === "operator" &&
              peer.connected &&
              peer.front.readyState === WebSocket.OPEN &&
              peer.back.readyState === WebSocket.OPEN,
          );
          const nodes = [...peers].filter(
            (peer) =>
              peer.role === "node" &&
              peer.connected &&
              peer.front.readyState === WebSocket.OPEN &&
              peer.back.readyState === WebSocket.OPEN,
          );
          if (nodeFault || operators.length !== 1 || nodes.length !== 1) {
            throw new Error("node fault requires distinct live node and operator owners");
          }
          nodeFault = true;
          record("controlled-node-fault", {
            connection: nodes[0].id,
            operatorConnection: operators[0].id,
          });
          for (const peer of nodes) {
            recordFirstTermination(peer.id, "front", peer.front, "node-fault");
            peer.front.terminate();
            recordFirstTermination(peer.id, "upstream", peer.back, "node-fault");
            peer.back.terminate();
          }
          await Promise.all(nodes.map((peer) => peer.closed));
          if (
            operators[0].front.readyState !== WebSocket.OPEN ||
            operators[0].back.readyState !== WebSocket.OPEN
          ) {
            throw new Error("operator authority did not survive the controlled node fault");
          }
        } else if (action === "release-node") {
          if (!nodeFault) {
            throw new Error("no controlled node fault");
          }
          nodeFault = false;
        } else if (action === "drop-response") {
          if (
            holdMethod === "sessions.create" ||
            heldResponse?.summary.method === "sessions.create" ||
            responseReleaseTask ||
            rejectCreate ||
            fixtureWrites.size ||
            approvalReservation
          ) {
            throw new Error("create producer already has a controlled boundary");
          }
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
      })().catch(() => {
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end("fixture control failed");
      });
      controlTasks.add(controlTask);
      void controlTask.finally(() => controlTasks.delete(controlTask));
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
        if (observedMedia && holdMethod === "media.get" && !mediaTask) {
          // Reserve collection before the first body read yields. Later matching
          // responses must not replace this hold or the task that stop joins.
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
          })()
            .catch(() => {
              holdMethod = undefined;
              heldWaiter?.(new Error("held media response failed"));
              res.destroy();
            })
            .finally(() => {
              mediaTask = undefined;
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
  };
  const server = tls ? createSecureServer(tls, handleRequest) : createServer(handleRequest);
  // HTTPS closeAllConnections does not own sockets waiting for a TLS handshake.
  // Install their close receipts at admission, before a cancelled probe can leave.
  server.on("connection", (socket) => {
    const closed = new Promise((resolve) => {
      socket.once("close", resolve);
    });
    acceptedSockets.set(socket, closed);
    void closed.then(() => acceptedSockets.delete(socket));
    if (stopping) {
      socket.destroy();
    }
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (front) => {
    const id = ++connectionCount;
    if (captureReadiness) {
      if (id <= 4) {
        readiness.push({
          connection: id,
          handshake: {},
          lifecycle: [],
          requests: [],
          truncated: false,
          terminations: { front: "none", upstream: "none" },
        });
      } else {
        readinessTruncated = true;
      }
    }
    if (id === 1) {
      firstConnectionStartedAt = performance.now();
    }
    recordFirstConnection(id, "front-open");
    let challengeReceived = false;
    const diagnostic = readinessConnection(id);
    // Native ws:// clients deliberately omit custom headers. This fixture acts
    // as their trusted proxy without changing signed client/device identity.
    recordFirstConnection(id, "upstream-create-start");
    const back = new WebSocket(`ws://127.0.0.1:${backendPort}`, {
      headers: upstreamHeaders,
      /** @param {import("node:http").ClientRequest} req */
      finishRequest(req) {
        // CONNECTING abort can close ws before its request. Upgrade emits the
        // request close after handing the established socket to the ws owner.
        httpRequests.add(req);
        req.once("close", () => httpRequests.delete(req));
        if (diagnostic) {
          const { handshake } = diagnostic;
          handshake.requestReadyMs = readinessTime();
          req.once("socket", (socket) => {
            handshake.socketAssigned = {
              elapsedMs: readinessTime(),
              connecting: socket.connecting,
            };
            socket.once("connect", () => {
              handshake.tcpConnectedMs = readinessTime();
            });
          });
          req.once("finish", () => {
            // This is local OS handoff, not receipt by the Gateway.
            handshake.requestFinishedMs = readinessTime();
          });
          req.once("response", (response) => {
            const status = response.statusCode;
            handshake.httpResponse = {
              elapsedMs: readinessTime(),
              statusCode:
                typeof status === "number" &&
                Number.isInteger(status) &&
                status >= 100 &&
                status <= 599
                  ? status
                  : "other",
            };
          });
        }
        // ws installs its abort/upgrade handlers before this hook. Keep
        // its default synchronous end; observing unexpected-response would disable abort.
        req.end();
      },
    });
    recordFirstConnection(id, "upstream-create-return");
    const closed = Promise.all(
      [front, back].map(
        (socket) =>
          new Promise((resolve) => {
            socket.once("close", resolve);
          }),
      ),
    );
    const peer = {
      id,
      front,
      back,
      closed,
      role: "other",
      connected: false,
      clientId: undefined,
      profileId: undefined,
    };
    peers.add(peer);
    // The frontend can close before its upstream receiver finishes. Keep both
    // endpoints owned until their close handlers have run, including before stop.
    void closed.then(() => peers.delete(peer));
    const methods = new Map();
    const requestSelectors = new Map();
    const diagnosticRequests = new Map();
    const sendUpstream = (raw, trace) => {
      if (trace) {
        trace.upstreamStartedMs = readinessTime();
      }
      back.send(
        raw,
        trace
          ? (error) => {
              trace.upstreamWrite = { elapsedMs: readinessTime(), outcome: error ? "error" : "ok" };
            }
          : undefined,
      );
    };
    const pending = [];
    let nativeDeviceId;
    front.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      let trace;
      if (frame.type === "req") {
        if (methods.size >= 128 || pending.length >= 128) {
          recordFirstTermination(id, "front", front, "request-limit");
          front.terminate();
          return;
        }
        methods.set(frame.id, frame.method);
        requestSelectors.set(frame.id, requestSelector(frame));
        if (
          approvalReservation?.connection === id &&
          frame.method === "approval.get" &&
          frame.params?.id === approvalReservation.approvalId
        ) {
          if (
            approvalReservation.status !== "bound" ||
            approvalReservation.requestId ||
            !selector(frame.id) ||
            peer.profileId !== approvalReservation.expectedProfileId ||
            (frame.expectedProfileId !== undefined &&
              frame.expectedProfileId !== approvalReservation.expectedProfileId)
          ) {
            invalidateApproval("ambiguous-lookup");
          } else {
            approvalReservation.requestId = frame.id;
          }
        }
        if (diagnostic && READINESS_METHODS.has(frame.method)) {
          if (diagnostic.requests.length < 32) {
            trace = {
              ordinal: diagnostic.requests.length + 1,
              method: frame.method,
              privateRequestId:
                typeof frame.id === "string" && frame.id.length > 0 && frame.id.length <= 128
                  ? frame.id
                  : undefined,
              observedMs: readinessTime(),
              queued: back.readyState !== WebSocket.OPEN,
            };
            diagnostic.requests.push(trace);
            diagnosticRequests.set(frame.id, trace);
          } else {
            diagnostic.truncated = readinessTruncated = true;
          }
        }
        if (observes(frame.method)) {
          record("rpc-request", {
            connection: id,
            requestId: frame.id,
            method: frame.method,
            ...(observeNativeActions && nativeMethods.has(frame.method)
              ? {
                  expectedProfileId: selector(frame.expectedProfileId),
                  sessionKey: selector(frame.params?.sessionKey),
                  key: selector(frame.params?.key),
                  agentId: selector(frame.params?.agentId),
                  runId: selector(frame.params?.runId),
                  approvalId: selector(frame.params?.id),
                  ...(frame.method === "chat.history"
                    ? {
                        inputRunIds: Array.isArray(frame.params?.inputRunIds)
                          ? frame.params.inputRunIds.slice(0, 16).map(selector).filter(Boolean)
                          : [],
                        inputRunIdsTruncated:
                          Array.isArray(frame.params?.inputRunIds) &&
                          frame.params.inputRunIds.length > 16,
                      }
                    : {}),
                }
              : {}),
            ...(frame.method === "plugin.surface.refresh"
              ? { expectedProfileId: frame.expectedProfileId, surface: frame.params?.surface }
              : {}),
          });
        }
        if (frame.method === "connect") {
          nativeDeviceId = frame.params?.device?.id;
          peer.clientId = selector(frame.params?.client?.id);
          peer.role = ["node", "operator"].includes(frame.params?.role)
            ? frame.params.role
            : "other";
          recordFirstConnection(id, "connect-received");
          record("connect-request", {
            connection: id,
            clientId: frame.params?.client?.id,
            deviceId: frame.params?.device?.id,
            ...(observeMobileHandoff
              ? {
                  role: ["node", "operator"].includes(frame.params?.role)
                    ? frame.params.role
                    : "other",
                  usesBootstrapToken: typeof frame.params?.auth?.bootstrapToken === "string",
                  operatorHandoffMatched:
                    frame.params?.role === "operator" &&
                    operatorHandoffTokens.has(nativeDeviceId) &&
                    operatorHandoffTokens.get(nativeDeviceId) ===
                      (frame.params?.auth?.deviceToken ?? frame.params?.auth?.token),
                }
              : {}),
          });
        }
        if (frame.method === "sessions.create") {
          record("mutation-request", { connection: id, requestId: frame.id });
        }
      }
      const controlledCreate =
        frame.type === "req" &&
        frame.method === "sessions.create" &&
        rejectCreate &&
        matchesSelector(requestSelectors.get(frame.id), rejectCreate);
      const controlledNode =
        frame.type === "req" && frame.method === "connect" && peer.role === "node" && nodeFault;
      if (controlledCreate || controlledNode) {
        if (controlledCreate) {
          rejectCreate = undefined;
        }
        methods.delete(frame.id);
        requestSelectors.delete(frame.id);
        diagnosticRequests.delete(frame.id);
        record("controlled-request-refusal", {
          connection: id,
          requestId: frame.id,
          method: frame.method,
        });
        const write = new Promise((resolve) => {
          front.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: { code: "UNAVAILABLE", message: "Controlled fixture request refusal" },
            }),
            (error) => {
              record("controlled-refusal-written", {
                connection: id,
                requestId: frame.id,
                delivered: !error,
              });
              resolve();
            },
          );
        });
        fixtureWrites.add(write);
        void write.finally(() => fixtureWrites.delete(write));
        return;
      }
      if (back.readyState === WebSocket.OPEN) {
        sendUpstream(raw, trace);
      } else {
        pending.push({ raw, trace });
      }
    });
    // ws emits upgrade before validation; open marks a validated WebSocket upgrade.
    back.on("upgrade", () => recordFirstConnection(id, "upstream-upgrade"));
    back.on("open", () => {
      recordFirstConnection(id, "upstream-open");
      for (const { raw, trace } of pending.splice(0)) {
        sendUpstream(raw, trace);
      }
    });
    back.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      const firstChallenge =
        (id === 1 || diagnostic !== undefined) &&
        !challengeReceived &&
        frame.type === "event" &&
        frame.event === "connect.challenge";
      if (firstChallenge) {
        challengeReceived = true;
        recordFirstConnection(id, "challenge-received");
      }
      // Freeze the real event identity before forwarding it. The reservation never
      // follows another connection, and foreign WebView/admin reads cannot consume it.
      if (
        approvalReservation?.connection === id &&
        frame.type === "event" &&
        frame.event === "openclaw.approval.requested" &&
        frame.payload?.request?.sessionKey === approvalReservation.sessionKey &&
        frame.payload?.request?.agentId === approvalReservation.agentId
      ) {
        const payload = frame.payload;
        if (approvalReservation.status !== "waiting-event") {
          invalidateApproval("ambiguous-event");
        } else if (
          payload.approvalKind !== "system-agent" ||
          !selector(payload.id) ||
          !selector(payload.request.runId) ||
          typeof payload.request.proposalHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(payload.request.proposalHash) ||
          peer.front.readyState !== WebSocket.OPEN ||
          peer.back.readyState !== WebSocket.OPEN
        ) {
          invalidateApproval("invalid-event");
        } else {
          Object.assign(approvalReservation, {
            status: "bound",
            approvalId: payload.id,
            runId: payload.request.runId,
            proposalHash: payload.request.proposalHash,
          });
          holdMethod = "approval.get";
          // The native approval fetch omits expectedProfileId. Its already verified
          // users.self profile belongs to this exact connection, never another reader.
          holdSelector = { approvalId: payload.id };
          holdConnection = id;
        }
      }
      const method = methods.get(frame.id);
      const producer = requestSelectors.get(frame.id);
      const trace = diagnosticRequests.get(frame.id);
      if (frame.type === "res") {
        methods.delete(frame.id);
        requestSelectors.delete(frame.id);
        diagnosticRequests.delete(frame.id);
        if (trace) {
          trace.response = {
            elapsedMs: readinessTime(),
            outcome: frame.ok === true ? "ok" : "error",
            code:
              frame.ok === true
                ? "none"
                : READINESS_ERROR_CODES.has(frame.error?.code)
                  ? frame.error.code
                  : "other",
          };
        }
        if (observes(method)) {
          record("rpc-response", {
            connection: id,
            requestId: frame.id,
            method,
            ok: frame.ok,
            ...(observeNativeActions && method === "agent.wait"
              ? {
                  status: ["ok", "error", "timeout"].includes(frame.payload?.status)
                    ? frame.payload.status
                    : "other",
                }
              : {}),
            ...(method === "plugin.surface.refresh"
              ? { reason: frame.error?.details?.reason }
              : {}),
          });
        }
        if (method === "connect" && frame.ok) {
          peer.connected = true;
          const auth = frame.payload?.auth;
          const handoff =
            observeMobileHandoff && auth?.method === "bootstrap-token"
              ? [auth, ...(Array.isArray(auth.deviceTokens) ? auth.deviceTokens.slice(0, 2) : [])]
              : [];
          const operatorToken = handoff.find((entry) => entry?.role === "operator")?.deviceToken;
          if (
            typeof nativeDeviceId === "string" &&
            nativeDeviceId.length <= 128 &&
            typeof operatorToken === "string" &&
            operatorToken.length <= 1024 &&
            operatorHandoffTokens.size < 8
          ) {
            operatorHandoffTokens.set(nativeDeviceId, operatorToken);
          }
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
            ...(observeMobileHandoff
              ? {
                  authMethod: ["bootstrap-token", "trusted-proxy", "device-token"].includes(
                    auth?.method,
                  )
                    ? auth.method
                    : "other",
                  role: ["node", "operator"].includes(auth?.role) ? auth.role : "other",
                  handoffRoles: handoff
                    .map((entry) => entry?.role)
                    .filter((role) => role === "node" || role === "operator")
                    .toSorted((a, b) => a.localeCompare(b)),
                }
              : {}),
          });
        }
        if ((observeMobileHandoff || observeNativeActions) && method === "users.self" && frame.ok) {
          const profileId = frame.payload?.profile?.id;
          peer.profileId =
            typeof profileId === "string" && profileId.length <= 128 ? profileId : undefined;
          if (
            approvalReservation?.connection === id &&
            peer.profileId !== approvalReservation.expectedProfileId
          ) {
            invalidateApproval("profile-changed");
          }
          record("native-profile", {
            connection: id,
            requestId: frame.id,
            profileId:
              typeof profileId === "string" && profileId.length <= 128 ? profileId : undefined,
          });
        }
        if (method === "chat.send") {
          record("send-response", {
            connection: id,
            ...(observeNativeActions ? { requestId: frame.id } : {}),
            ok: frame.ok,
            runId: frame.payload?.runId,
            status: frame.payload?.status,
          });
        }
        // Record the real producer outcome before holding its delivery. A controlled
        // pre-upstream refusal never enters this authoritative response path.
        if (method === "sessions.create") {
          record(frame.ok ? "mutation-success" : "mutation-error", {
            connection: id,
            requestId: frame.id,
            ...(frame.ok
              ? { key: frame.payload?.key }
              : {
                  labelCollision: frame.error?.message?.startsWith("label already in use") === true,
                }),
          });
        }
        if (observeNativeActions && method === "sessions.fork") {
          const attachments = frame.payload?.editorAttachments;
          const image =
            Array.isArray(attachments) && attachments.length === 1 ? attachments[0] : undefined;
          const data =
            typeof image?.data === "string" && image.data.length <= 1024 * 1024
              ? Buffer.from(image.data, "base64")
              : undefined;
          record("fork-result", {
            connection: id,
            requestId: frame.id,
            ok: frame.ok,
            sourceSessionKey: producer?.sessionKey,
            entryId: producer?.entryId,
            key: selector(frame.payload?.sessionKey),
            editorTextSHA256:
              typeof frame.payload?.editorText === "string" &&
              frame.payload.editorText.length <= 1024 * 1024
                ? createHash("sha256").update(frame.payload.editorText).digest("hex")
                : undefined,
            attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
            imageMimeType: selector(image?.mimeType),
            imageBytes: data?.length,
            imageSHA256: data ? createHash("sha256").update(data).digest("hex") : undefined,
          });
        }
        if (
          holdConnection === id &&
          method === "approval.get" &&
          matchesSelector(producer, holdSelector)
        ) {
          const approval = frame.payload?.approval;
          if (
            approvalReservation.status !== "bound" ||
            approvalReservation.requestId !== frame.id ||
            frame.ok !== true ||
            approval?.id !== approvalReservation.approvalId ||
            approval?.status !== "pending" ||
            approval?.presentation?.kind !== "system-agent" ||
            approval?.presentation?.proposalHash !== approvalReservation.proposalHash
          ) {
            invalidateApproval("response-owner-mismatch");
          }
        }
        if (
          holdMethod &&
          method === holdMethod &&
          matchesSelector(producer, holdSelector) &&
          (holdConnection === undefined || holdConnection === id)
        ) {
          if (holdConnection !== undefined) {
            approvalReservation.status = "held";
          }
          if (trace) {
            trace.held = true;
          }
          holdMethod = undefined;
          holdSelector = undefined;
          holdConnection = undefined;
          heldResponse = {
            release: () => {
              if (front.readyState !== WebSocket.OPEN) {
                return false;
              }
              // Completion confirms a local write, not consumption by the peer.
              return new Promise((resolve) => {
                front.send(raw, (error) => {
                  if (trace) {
                    trace.frontWrite = {
                      elapsedMs: readinessTime(),
                      outcome: error ? "error" : "ok",
                    };
                  }
                  resolve(!error);
                });
              });
            },
            summary: {
              method,
              connection: id,
              requestId: frame.id,
              ...producer,
              requestedRunId: producer?.runId,
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
        if (trace) {
          trace.held = true;
        }
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
          firstChallenge || trace
            ? (error) => {
                if (firstChallenge) {
                  recordFirstConnection(id, error ? "challenge-write-error" : "challenge-write-ok");
                }
                if (trace) {
                  trace.frontWrite = {
                    elapsedMs: readinessTime(),
                    outcome: error ? "error" : "ok",
                  };
                }
              }
            : undefined,
        );
      }
    });
    front.on("close", () => {
      if (approvalReservation?.connection === id && approvalReservation.status !== "released") {
        invalidateApproval("owner-retired");
      }
      diagnosticRequests.clear();
      recordFirstConnection(id, "front-close");
      recordFirstTermination(id, "upstream", back, "front-close");
      back.terminate();
      if (held?.front === front) {
        held = undefined;
      }
    });
    back.on("close", () => {
      if (approvalReservation?.connection === id && approvalReservation.status !== "released") {
        invalidateApproval("owner-retired");
      }
      diagnosticRequests.clear();
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
  /** @type {Promise<void> | undefined} */
  let stopping;
  /** @returns {Promise<void>} */
  const stop = () =>
    (stopping ??= (async () => {
      operatorHandoffTokens.clear();
      // Close admission before draining media: an aborted body iterator can
      // settle later, after an already accepted upgrade reaches this server.
      const websocketClosed = new Promise((resolve, reject) => {
        sockets.close(
          /** @param {Error} [error] */
          (error) => (error ? reject(error) : resolve()),
        );
      });
      const serverClosed = new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (approvalReservation?.status !== "released") {
        invalidateApproval("proxy-stopped");
      }
      heldWaiter?.(new Error("proxy stopped"));
      heldResponse = undefined;
      const closingPeers = [...peers];
      const closingRequests = [...httpRequests];
      const closingSockets = [...acceptedSockets];
      const requestsClosed = closingRequests.map(
        (upstream) =>
          new Promise((resolve) => {
            upstream.once("close", resolve);
          }),
      );
      for (const peer of closingPeers) {
        recordFirstTermination(peer.id, "front", peer.front, "stop");
        peer.front.terminate();
        recordFirstTermination(peer.id, "upstream", peer.back, "stop");
        peer.back.terminate();
      }
      for (const upstream of closingRequests) {
        upstream.destroy();
      }
      server.closeAllConnections();
      for (const [socket] of closingSockets) {
        socket.destroy();
      }
      const results = await Promise.allSettled([
        mediaTask,
        responseReleaseTask,
        ...controlTasks,
        ...fixtureWrites,
        ...closingSockets.map(([, closed]) => closed),
        websocketClosed,
        serverClosed,
        ...closingPeers.map((peer) => peer.closed),
        ...requestsClosed,
      ]);
      heldResponse = undefined;
      const errors = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "QA proxy shutdown failed");
      }
    })());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `${tls ? "wss" : "ws"}://127.0.0.1:${address.port}`,
    controlUrl: `${tls ? "https" : "http"}://127.0.0.1:${address.port}/__fixture`,
    snapshot,
    readinessSnapshot,
    captureHistoryRequestMatcher,
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
