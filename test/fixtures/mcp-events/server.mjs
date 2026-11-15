import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  callbackUrl,
  constantTimeEqual,
  MAX_BODY_BYTES,
  postCallback,
  PROTOCOL_VERSION,
  signingKey,
} from "./callback.mjs";

const objectSchema = (properties, required) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const string = { type: "string", minLength: 1 };
const eventNames = ["comment.created", "comment.updated"];
const definitions = eventNames.map((name) => ({
  name,
  description: "Synthetic document review " + name + " event; filtered by document_id.",
  delivery: ["webhook"],
  inputSchema: objectSchema({ document_id: string, text_contains: string }, ["document_id"]),
  payloadSchema: objectSchema(
    { document_id: string, comment_id: string, text: string, url: string },
    ["document_id", "comment_id", "text", "url"],
  ),
}));
class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
const invalid = (message) => {
  throw new RpcError(-32602, message);
};
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = (value) => JSON.stringify(value, Object.keys(value).toSorted());
const cursor = (sequence) => "fixture:" + sequence;
function parseCursor(value, head) {
  if (value === undefined || value === null) {
    return head;
  }
  if (typeof value !== "string" || !/^fixture:[0-9]+$/.test(value)) {
    invalid("Unknown cursor");
  }
  const sequence = Number(value.slice(8));
  if (!Number.isSafeInteger(sequence) || sequence > head) {
    invalid("Cursor is ahead of history");
  }
  return sequence;
}
function requireFields(value, fields) {
  if (
    !isObject(value) ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    fields.some((key) => typeof value[key] !== "string" || !value[key].length)
  ) {
    invalid("Invalid arguments or payload");
  }
}
function category(error) {
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return "timeout";
  }
  if (/CERT|TLS|SSL|SELF_SIGNED/.test(error?.code ?? "")) {
    return "tls_error";
  }
  return "connection_refused";
}
function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
async function bodyJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new RpcError(-32600, "Request exceeds 256 KiB");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RpcError(-32700, "Invalid JSON");
  }
}
async function listen(server, port, host) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP listener");
  }
  return address.port;
}

// This is an external MCP server, not OpenClaw state. The caller explicitly owns
// this private artifact and must give each running fixture a distinct stateFile.
export async function startMcpEventsTestServer(options) {
  if (!options.stateFile || !options.token || !options.controlToken) {
    throw new Error("stateFile, token, controlToken are required");
  }
  if (options.token === options.controlToken) {
    throw new Error("MCP and control tokens must differ");
  }
  const maxTtlMs = options.maxTtlMs ?? 86_400_000;
  if (!Number.isSafeInteger(maxTtlMs) || maxTtlMs < 100 || maxTtlMs > 86_400_000) {
    throw new Error("maxTtlMs must be an integer from 100 to 86400000");
  }
  if (Boolean(options.loopbackOrigin) !== Boolean(options.ca)) {
    throw new Error("Loopback callback origin and CA must be supplied together");
  }
  if (options.loopbackOrigin) {
    const allowed = callbackUrl(options.loopbackOrigin);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(allowed.hostname) ||
      allowed.origin !== options.loopbackOrigin
    ) {
      throw new Error("Fixture callback exception must be an exact loopback HTTPS origin");
    }
  }
  const stateFile = resolve(options.stateFile);
  let state;
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    state = {
      version: 1,
      sequence: 0,
      subscriptions: {},
      events: [],
      pending: {},
      revokedDocuments: [],
    };
  }
  if (
    state.version !== 1 ||
    !isObject(state.subscriptions) ||
    !isObject(state.pending) ||
    !Array.isArray(state.events)
  ) {
    throw new Error("Invalid fixture state");
  }
  const save = () => {
    mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
    const temporary = stateFile + ".tmp";
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flush: true });
    renameSync(temporary, stateFile);
  };
  save();
  const principal = options.principal ?? "fixture-account";
  const reports = [];
  const requests = [];
  const verified = new Map();
  const positions = new Map();
  const tails = new Map();
  const queued = new Map();
  const controllers = new Set();
  let closing = false;
  const authorized = (subscription) =>
    !closing &&
    state.subscriptions[subscription.id] === subscription &&
    !state.revokedDocuments.includes(subscription.arguments.document_id) &&
    (subscription.refreshBefore === null || Date.parse(subscription.refreshBefore) > Date.now());
  const matches = (subscription, event) =>
    subscription.name === event.name &&
    subscription.arguments.document_id === event.data.document_id &&
    (!subscription.arguments.text_contains ||
      event.data.text.includes(subscription.arguments.text_contains));
  const record = (entry) => {
    reports.push(entry);
    if (reports.length > 500) {
      reports.shift();
    }
  };
  const outbound = { loopbackOrigin: options.loopbackOrigin, ca: options.ca };

  async function deliver(subscription, event, probe = {}) {
    if (!authorized(subscription)) {
      return { eventId: event.eventId, skipped: "inactive" };
    }
    const serialized = JSON.stringify(event);
    if (Buffer.byteLength(serialized) > MAX_BODY_BYTES && !probe.oversizeProbe) {
      throw new Error("Event payload exceeds 256 KiB");
    }
    const attempts = [];
    const controller = new AbortController();
    controllers.add(controller);
    try {
      for (let attempt = 0; attempt < (probe.singleAttempt ? 1 : 3); attempt++) {
        if (!authorized(subscription)) {
          break;
        }
        let response;
        try {
          response = await postCallback(subscription, serialized, event.eventId, {
            ...outbound,
            ...probe,
            signal: controller.signal,
            isActive: () => authorized(subscription),
          });
        } catch (error) {
          response = { status: 0, reason: category(error) };
        }
        const accepted = response.status >= 200 && response.status < 300;
        const receipt = {
          subscriptionId: subscription.id,
          eventId: event.eventId,
          attempt: attempt + 1,
          accepted,
          status: response.status,
          reason: response.reason,
          signatures:
            subscription.previousSecret && subscription.rotationUntil > Date.now() ? 2 : 1,
        };
        attempts.push(receipt);
        record(receipt);
        if (
          accepted ||
          response.status === 410 ||
          response.status === 413 ||
          (response.status >= 300 &&
            response.status < 500 &&
            ![408, 425, 429].includes(response.status))
        ) {
          break;
        }
        if (attempt === 2 || probe.singleAttempt) {
          break;
        }
        const retryAfter = response.retryAfter;
        const requestedDelay =
          retryAfter === undefined
            ? 0
            : /^[0-9]+$/.test(retryAfter)
              ? Number(retryAfter) * 1000
              : Date.parse(retryAfter) - Date.now();
        // Do not violate Retry-After to fit the bounded fixture retry window.
        if (requestedDelay > 30_000) {
          break;
        }
        await delay(Math.max(250 * 2 ** attempt, requestedDelay || 0), undefined, {
          signal: controller.signal,
        });
      }
    } catch (error) {
      if (!closing) {
        throw error;
      }
    } finally {
      controllers.delete(controller);
    }
    return { eventId: event.eventId, attempts };
  }
  function enqueue(subscription, event) {
    const key = subscription.id + ":" + event.eventId;
    if (queued.has(key)) {
      return queued.get(key);
    }
    state.pending[key] = { subscriptionId: subscription.id, event };
    save();
    const tail = (tails.get(subscription.id) ?? Promise.resolve()).then(async () => {
      const result = await deliver(subscription, event);
      if (!closing) {
        positions.set(subscription.id, event.cursor);
        delete state.pending[key];
        save();
      }
      queued.delete(key);
      return result;
    });
    queued.set(key, tail);
    tails.set(
      subscription.id,
      tail.catch(() => {}),
    );
    return tail;
  }
  function identity(params) {
    if (!eventNames.includes(params.name)) {
      throw new RpcError(-32011, "NotFound", { kind: "event" });
    }
    const args = params.arguments;
    if (
      !isObject(args) ||
      typeof args.document_id !== "string" ||
      !args.document_id ||
      Object.keys(args).some((key) => !["document_id", "text_contains"].includes(key)) ||
      (args.text_contains !== undefined &&
        (typeof args.text_contains !== "string" || !args.text_contains))
    ) {
      invalid("Invalid subscription arguments");
    }
    if (params.delivery?.mode !== "webhook") {
      throw new RpcError(-32014, "Unsupported", { feature: "deliveryMode" });
    }
    try {
      callbackUrl(params.delivery.url);
    } catch {
      invalid("Callback must be HTTPS without credentials or fragment");
    }
    const id =
      "sub_" +
      createHash("sha256")
        .update(
          JSON.stringify([
            principal,
            params.delivery.url,
            params.name,
            canonical(params.arguments),
          ]),
        )
        .digest("hex")
        .slice(0, 32);
    return {
      id,
      principal,
      name: params.name,
      arguments: params.arguments,
      url: params.delivery.url,
    };
  }
  async function subscribe(params) {
    const key = identity(params);
    if (state.revokedDocuments.includes(key.arguments.document_id)) {
      throw new RpcError(-32012, "Forbidden");
    }
    try {
      signingKey(params.delivery.secret);
    } catch (error) {
      invalid(error.message);
    }
    if (
      params.ttlMs !== undefined &&
      params.ttlMs !== null &&
      (!Number.isSafeInteger(params.ttlMs) || params.ttlMs < 0)
    ) {
      invalid("ttlMs must be a nonnegative integer or null");
    }
    const requestedPosition = parseCursor(params.cursor, state.sequence);
    const existing = state.subscriptions[key.id];
    const wasLive = existing && authorized(existing) && positions.has(key.id);
    const candidate = {
      ...key,
      secret: params.delivery.secret,
      refreshBefore:
        params.ttlMs === null
          ? null
          : new Date(
              Date.now() + Math.max(100, Math.min(params.ttlMs ?? 3_600_000, maxTtlMs)),
            ).toISOString(),
      verifiedAt: Date.now(),
      ...(existing?.previousSecret
        ? { previousSecret: existing.previousSecret, rotationUntil: existing.rotationUntil }
        : {}),
    };
    if (existing && existing.secret !== candidate.secret) {
      candidate.previousSecret = existing.secret;
      candidate.rotationUntil = Date.now() + 60_000;
    }
    const verificationKey = JSON.stringify([principal, key.url]);
    if ((verified.get(verificationKey) ?? 0) < Date.now()) {
      const challenge = randomBytes(24).toString("base64url");
      let response;
      try {
        response = await postCallback(
          candidate,
          JSON.stringify({ type: "verification", challenge }),
          "msg_verification_" + randomUUID(),
          outbound,
        );
      } catch (error) {
        throw new RpcError(-32015, "CallbackEndpointError", { reason: category(error) });
      }
      let returned;
      try {
        returned = JSON.parse(response.body).challenge;
      } catch {
        /* Invalid JSON cannot verify. */
      }
      if (
        response.status < 200 ||
        response.status >= 300 ||
        typeof returned !== "string" ||
        !constantTimeEqual(challenge, returned)
      ) {
        throw new RpcError(-32015, "CallbackEndpointError", {
          reason:
            response.status >= 500
              ? "http_5xx"
              : response.status >= 400
                ? "http_4xx"
                : "challenge_failed",
        });
      }
      verified.set(verificationKey, Date.now() + 60_000);
    }
    // Challenge is awaited before publishing the durable record or replying.
    if (closing || state.revokedDocuments.includes(key.arguments.document_id)) {
      throw new RpcError(-32012, "Forbidden");
    }
    const subscription = existing ? Object.assign(existing, candidate) : candidate;
    state.subscriptions[key.id] = subscription;
    save();
    const floor = state.events.length ? state.events[0].sequence - 1 : state.sequence;
    const position = Math.max(requestedPosition, floor);
    const pendingDelivery = Object.values(state.pending).some(
      (item) => item.subscriptionId === key.id,
    );
    const watermark = wasLive
      ? pendingDelivery
        ? positions.get(key.id)
        : cursor(state.sequence)
      : cursor(position);
    positions.set(key.id, watermark);
    const replay = wasLive
      ? []
      : state.events.filter(
          (entry) => entry.sequence > position && matches(subscription, entry.event),
        );
    const result = {
      id: key.id,
      refreshBefore: subscription.refreshBefore,
      cursor: watermark,
      truncated: !wasLive && position > requestedPosition,
    };
    return {
      result,
      afterResponse: () => {
        for (const entry of replay) {
          void enqueue(subscription, entry.event).catch((error) =>
            record({ error: error.message }),
          );
        }
      },
    };
  }
  async function rpc(method, params) {
    switch (method) {
      case "server/discover":
        return {
          result: {
            resultType: "complete",
            supportedVersions: [PROTOCOL_VERSION],
            capabilities: { events: {} },
          },
        };
      case "events/list": {
        if (params.cursor !== undefined && params.cursor !== "events:1") {
          invalid("Unknown catalog cursor");
        }
        const index = params.cursor === "events:1" ? 1 : 0;
        return {
          result: {
            events: [definitions[index]],
            ...(index === 0 ? { nextCursor: "events:1" } : {}),
          },
        };
      }
      case "events/subscribe":
        return await subscribe(params);
      case "events/unsubscribe": {
        const { id } = identity(params);
        delete state.subscriptions[id];
        positions.delete(id);
        for (const [key, item] of Object.entries(state.pending)) {
          if (item.subscriptionId === id) {
            delete state.pending[key];
          }
        }
        save();
        return { result: {} };
      }
      default:
        throw new RpcError(-32601, "Method not found");
    }
  }
  async function control(params) {
    switch (params.action) {
      case "status":
        return {
          sequence: state.sequence,
          subscriptions: Object.values(state.subscriptions).map((sub) => ({
            id: sub.id,
            name: sub.name,
            arguments: sub.arguments,
            refreshBefore: sub.refreshBefore,
            active: authorized(sub),
            cursor: positions.get(sub.id) ?? null,
          })),
          reports,
          requests,
        };
      case "emit":
      case "burst": {
        const count = params.action === "burst" ? (params.count ?? 10) : 1;
        if (!Number.isInteger(count) || count < 1 || count > 100) {
          invalid("count must be 1–100");
        }
        const name = params.name ?? "comment.created";
        if (!eventNames.includes(name)) {
          invalid("Unknown event");
        }
        requireFields(params.data, ["document_id", "comment_id", "text", "url"]);
        const events = [];
        for (let i = 0; i < count; i++) {
          const sequence = state.sequence + 1;
          const eventId = params.eventId && count === 1 ? params.eventId : "evt_" + randomUUID();
          if (typeof eventId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(eventId)) {
            invalid("Invalid eventId");
          }
          if (state.events.some((entry) => entry.event.eventId === eventId)) {
            invalid("Use retry for an existing eventId");
          }
          const event = {
            eventId,
            name,
            timestamp: new Date().toISOString(),
            data: params.data,
            cursor: cursor(sequence),
          };
          if (Buffer.byteLength(JSON.stringify(event)) > MAX_BODY_BYTES) {
            invalid("Event payload exceeds 256 KiB");
          }
          state.sequence = sequence;
          state.events.push({ sequence, event });
          events.push(event);
        }
        state.events = state.events.slice(-1000);
        save();
        const pending = [];
        for (const event of events) {
          for (const subscription of Object.values(state.subscriptions)) {
            if (matches(subscription, event)) {
              pending.push(enqueue(subscription, event));
            }
          }
        }
        return { events, deliveries: await Promise.all(pending) };
      }
      case "retry":
      case "invalid-signature":
      case "oversize": {
        const subscription = state.subscriptions[params.subscriptionId];
        const entry = state.events.find((item) => item.event.eventId === params.eventId);
        if (!subscription || !entry || !matches(subscription, entry.event)) {
          invalid("Matching subscriptionId and eventId required");
        }
        const event = structuredClone(entry.event);
        if (params.action === "oversize") {
          event.data.text = "x".repeat(MAX_BODY_BYTES);
        }
        return await deliver(subscription, event, {
          invalidSignature: params.action === "invalid-signature",
          oversizeProbe: params.action === "oversize",
          singleAttempt: params.action !== "retry",
        });
      }
      case "drain":
        await Promise.all(tails.values());
        return { reports };
      case "expire": {
        const sub = state.subscriptions[params.subscriptionId];
        if (!sub) {
          invalid("Unknown subscriptionId");
        }
        sub.refreshBefore = new Date(0).toISOString();
        save();
        return {};
      }
      case "revoke":
      case "grant": {
        if (typeof params.documentId !== "string") {
          invalid("documentId required");
        }
        state.revokedDocuments = state.revokedDocuments.filter((id) => id !== params.documentId);
        if (params.action === "revoke") {
          state.revokedDocuments.push(params.documentId);
        }
        save();
        return {};
      }
      case "truncate": {
        const through = parseCursor(params.throughCursor, state.sequence);
        state.events = state.events.filter((entry) => entry.sequence > through);
        save();
        return {};
      }
      default:
        throw new RpcError(-32602, "Unknown control action");
    }
  }
  // Serialize lifecycle mutations through the challenge await; control deliveries
  // remain independent so real subscribe/ingress races can be exercised.
  let rpcTail = Promise.resolve();
  const handler = async (request, response) => {
    if (!constantTimeEqual(request.headers.authorization ?? "", "Bearer " + options.token)) {
      return json(response, 401, { error: "Unauthorized" });
    }
    if (request.method !== "POST" || !["/mcp", "/mcp-sse"].includes(request.url)) {
      return json(response, 404, { error: "Not found" });
    }
    let id = null;
    try {
      const message = await bodyJson(request);
      id = message.id ?? null;
      if (
        message.jsonrpc !== "2.0" ||
        typeof message.method !== "string" ||
        !isObject(message.params)
      ) {
        throw new RpcError(-32600, "Invalid JSON-RPC request");
      }
      const meta = message.params._meta;
      if (
        request.headers["mcp-protocol-version"] !== PROTOCOL_VERSION ||
        meta?.["io.modelcontextprotocol/protocolVersion"] !== PROTOCOL_VERSION ||
        request.headers["mcp-method"] !== message.method ||
        !isObject(meta?.["io.modelcontextprotocol/clientCapabilities"])
      ) {
        return json(response, 400, { error: "MCP2 headers and request metadata required" });
      }
      requests.push({
        method: message.method,
        transport: request.url === "/mcp-sse" ? "sse" : "json",
        protocolVersion: PROTOCOL_VERSION,
      });
      if (requests.length > 100) {
        requests.shift();
      }
      const pending = rpcTail.then(() => rpc(message.method, message.params));
      rpcTail = pending.catch(() => {});
      const { result, afterResponse } = await pending;
      const envelope = { jsonrpc: "2.0", id, result };
      if (request.url === "/mcp-sse") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        response.end("event: message\ndata: " + JSON.stringify(envelope) + "\n\n");
      } else {
        json(response, 200, envelope);
      }
      afterResponse?.();
    } catch (error) {
      json(response, 200, {
        jsonrpc: "2.0",
        id,
        error: {
          code: error.code ?? -32603,
          message: error instanceof RpcError ? error.message : "Internal error",
          ...(error.data ? { data: error.data } : {}),
        },
      });
    }
  };
  const host = options.host ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host) && !options.tls) {
    throw new Error("Non-loopback MCP listener requires TLS");
  }
  const mcp = options.tls ? https.createServer(options.tls, handler) : http.createServer(handler);
  const controls = http.createServer(async (request, response) => {
    if (!constantTimeEqual(request.headers.authorization ?? "", "Bearer " + options.controlToken)) {
      return json(response, 401, { error: "Unauthorized" });
    }
    if (request.method !== "POST" || request.url !== "/control") {
      return json(response, 404, { error: "Not found" });
    }
    try {
      json(response, 200, await control(await bodyJson(request)));
    } catch (error) {
      json(response, 400, { error: error.message });
    }
  });
  mcp.requestTimeout = controls.requestTimeout = 15_000;
  let mcpPort;
  let controlPort;
  try {
    mcpPort = await listen(mcp, options.port ?? 0, host);
    controlPort = await listen(controls, options.controlPort ?? 0, "127.0.0.1");
  } catch (error) {
    mcp.close();
    controls.close();
    throw error;
  }
  for (const item of Object.values(state.pending)) {
    const subscription = state.subscriptions[item.subscriptionId];
    if (subscription) {
      void enqueue(subscription, item.event).catch((error) => record({ error: error.message }));
    }
  }
  return {
    mcpUrl:
      (options.tls ? "https" : "http") +
      "://" +
      (host.includes(":") ? "[" + host + "]" : host) +
      ":" +
      mcpPort +
      "/mcp",
    controlUrl: "http://127.0.0.1:" + controlPort + "/control",
    async close() {
      closing = true;
      for (const controller of controllers) {
        controller.abort();
      }
      mcp.closeAllConnections();
      controls.closeAllConnections();
      await Promise.all([
        new Promise((done) => {
          mcp.close(done);
        }),
        new Promise((done) => {
          controls.close(done);
        }),
        rpcTail,
        ...tails.values(),
      ]);
    },
  };
}
