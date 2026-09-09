import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TLSSocket } from "node:tls";
import { stableStringify } from "@openclaw/normalization-core";
import { z } from "zod";
import { sendHttpRequestRejection } from "../infra/http-request-lifecycle.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import { readJsonBody } from "./hooks.js";
import { sendJson } from "./http-common.js";
import { attachGatewayConnection, type GatewayConnectionOptions } from "./server/connection.js";
import {
  OPERATOR_HTTP_LIMITS,
  type OperatorHttpBeginResponse,
  type OperatorHttpErrorCode,
  type OperatorHttpErrorResponse,
  type OperatorHttpFramesRequest,
  type OperatorHttpFramesResponse,
  type OperatorHttpPollRequest,
} from "./server/operator-http-contract.js";
import { captureGatewayOperatorHttpIngress } from "./server/operator-http-ingress.js";
import { GatewayOperatorHttpTransport } from "./server/operator-http-transport.js";
import type { PreauthConnectionBudget } from "./server/preauth-connection-budget.js";

const ackSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const beginSchema = z.strictObject({});
const framesSchema = z.strictObject({
  clientSeq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  ack: ackSchema,
  frame: z.unknown().refine((value) => value !== undefined),
}) satisfies z.ZodType<OperatorHttpFramesRequest>;
const pollSchema = z.strictObject({
  ack: ackSchema,
  waitMs: z.number().int().min(0).max(OPERATOR_HTTP_LIMITS.maxPollWaitMs),
}) satisfies z.ZodType<OperatorHttpPollRequest>;
const ENVELOPE_ALLOWANCE_BYTES = 1024;

export type OperatorHttpRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<boolean>;

function reject(
  response: ServerResponse,
  status: number,
  code: OperatorHttpErrorCode,
  message: string,
  resyncRequired?: true,
): void {
  const body: OperatorHttpErrorResponse = {
    error: { code, message, ...(resyncRequired ? { resyncRequired } : {}) },
  };
  sendJson(response, status, body);
}

/** Ephemeral transport only: pairing, grants and RPC authority stay with their existing owners. */
export function createGatewayOperatorHttpRuntime(
  options: GatewayConnectionOptions & {
    basePath: string;
    preauthConnectionBudget: PreauthConnectionBudget;
  },
): { handleRequest: OperatorHttpRequestHandler; close: () => void } {
  const base = `${normalizeControlUiBasePath(options.basePath)}/api/operator/connections`;
  const sessions = new Map<string, { key: Buffer; transport: GatewayOperatorHttpTransport }>();
  const originCheckMetrics = { hostHeaderFallbackAccepted: 0 };
  let closed = false;
  const handleRequest: OperatorHttpRequestHandler = async (request, response) => {
    const url = URL.parse(request.url ?? "/", "http://localhost");
    if (!url || (url.pathname !== base && !url.pathname.startsWith(`${base}/`))) {
      return false;
    }
    response.setHeader("Cache-Control", "no-store");
    const ingress = captureGatewayOperatorHttpIngress(request);
    if (!ingress?.isCurrent()) {
      reject(response, 403, "ingress_changed", "Connection ingress is not allowed", true);
      return true;
    }
    const encrypted = request.socket instanceof TLSSocket && request.socket.encrypted;
    const trustedHttps =
      ingress.attribution.kind === "tailscale-serve" ||
      ingress.attribution.kind === "tailscale-funnel" ||
      (ingress.attribution.kind === "trusted-proxy" &&
        request.headers["x-forwarded-proto"] === "https");
    if (!encrypted && !trustedHttps && ingress.attribution.kind !== "direct-local") {
      reject(response, 403, "https_required", "Operator connections require HTTPS");
      return true;
    }
    if (url.search) {
      reject(response, 400, "invalid_request", "Query parameters are not accepted");
      return true;
    }
    if (closed || options.connectionWork.isClosing) {
      reject(response, 503, "unavailable", "Gateway is closing", true);
      return true;
    }
    const parts = url.pathname.slice(base.length).split("/").filter(Boolean);
    const id = parts[0] ?? "";
    const beginning = url.pathname === base;
    if (
      (!beginning && parts.length !== 1 && parts.length !== 2) ||
      (!beginning && !/^[0-9a-f-]{36}$/.test(id)) ||
      (parts.length === 2 && parts[1] !== "frames" && parts[1] !== "poll") ||
      url.pathname.endsWith("/")
    ) {
      reject(response, 404, "connection_not_found", "Connection not found; reconnect", true);
      return true;
    }
    const expectedMethod = !beginning && parts.length === 1 ? "DELETE" : "POST";
    if (request.method !== expectedMethod) {
      response.setHeader("Allow", expectedMethod);
      reject(response, 405, "method_not_allowed", `Use ${expectedMethod}`);
      return true;
    }
    const session = beginning ? undefined : sessions.get(id);
    if (!beginning) {
      const bearer = request.headers.authorization;
      const token =
        typeof bearer === "string" && /^Bearer [A-Za-z0-9_-]{43}$/.test(bearer)
          ? Buffer.from(bearer.slice(7), "base64url")
          : undefined;
      if (!token) {
        reject(response, 401, "unauthorized", "Connection key required");
        return true;
      }
      if (!session) {
        reject(response, 404, "connection_not_found", "Connection not found; reconnect", true);
        return true;
      }
      if (token.length !== session.key.length || !timingSafeEqual(token, session.key)) {
        reject(response, 401, "unauthorized", "Invalid connection key");
        return true;
      }
      if (!session.transport.admit(ingress)) {
        reject(response, 403, "ingress_changed", "Connection ingress changed; reconnect", true);
        return true;
      }
      if (expectedMethod === "DELETE") {
        session.transport.terminate();
        response.statusCode = 204;
        response.end();
        return true;
      }
    }
    if (
      request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
      request.headers["content-encoding"] !== undefined
    ) {
      reject(response, 400, "invalid_request", "An uncompressed application/json body is required");
      return true;
    }
    const limit = session?.transport.authenticated
      ? OPERATOR_HTTP_LIMITS.maxPayloadBytes
      : OPERATOR_HTTP_LIMITS.maxPreauthPayloadBytes;
    const body = await readJsonBody(
      request,
      parts[1] === "frames" ? limit + ENVELOPE_ALLOWANCE_BYTES : 1024,
    );
    if (!body.ok) {
      const status =
        body.error === "payload too large"
          ? 413
          : body.error === "request body timeout"
            ? 408
            : 400;
      const error: OperatorHttpErrorResponse = {
        error: {
          code:
            status === 413
              ? "payload_too_large"
              : status === 408
                ? "request_timeout"
                : "invalid_request",
          message: body.error,
        },
      };
      await sendHttpRequestRejection(
        request,
        response,
        status,
        JSON.stringify(error),
        "application/json; charset=utf-8",
      );
      return true;
    }
    if (closed || options.connectionWork.isClosing) {
      reject(response, 503, "unavailable", "Gateway is closing", true);
      return true;
    }
    if (response.destroyed) {
      return true;
    }
    if (!ingress.isCurrent() || (session && !session.transport.admit(ingress))) {
      reject(response, 403, "ingress_changed", "Connection ingress changed; reconnect", true);
      return true;
    }
    if (beginning) {
      if (!beginSchema.safeParse(body.value).success) {
        reject(response, 400, "invalid_request", "Begin requires an empty JSON object");
        return true;
      }
      if (
        sessions.size >= OPERATOR_HTTP_LIMITS.maxConnections ||
        !options.preauthConnectionBudget.acquire(ingress.attribution.clientIp)
      ) {
        reject(response, 429, "connection_limit", "Connection capacity exceeded; retry later");
        return true;
      }
      let connectionId: string | undefined = undefined;
      let holdsPreauthBudget = true;
      const releasePreauth = () => {
        if (holdsPreauthBudget) {
          holdsPreauthBudget = false;
          options.preauthConnectionBudget.release(ingress.attribution.clientIp);
        }
      };
      const transport = new GatewayOperatorHttpTransport(ingress, () => {
        releasePreauth();
        if (connectionId) {
          sessions.delete(connectionId);
        }
      });
      let connection: ReturnType<typeof attachGatewayConnection>;
      try {
        connection = attachGatewayConnection({
          ...options,
          socket: transport,
          connectionKind: "gateway",
          operatorDeviceTokenOnly: true,
          request,
          ingressAttribution: ingress.attribution,
          releasePreauth: (reason) => {
            // Rejected HTTP connections retain terminal state after owner close.
            // Keep that state charged to its IP until the transport removes it.
            if (reason === "authenticated") {
              releasePreauth();
            }
          },
          addresses: {},
          pluginNodeCapabilities: [],
          originCheckMetrics,
          resolveFrameIngress: transport.resolveFrameIngress,
          prepareAuthenticatedReceive: () => ({ ok: true, value: () => {} }),
          attachTransport: (owner) => transport.bindOwner(owner),
        });
      } catch (error) {
        transport.terminate();
        releasePreauth();
        throw error;
      }
      if (!connection) {
        transport.terminate();
        releasePreauth();
        reject(response, 503, "unavailable", "Gateway connection unavailable", true);
        return true;
      }
      connectionId = connection.connId;
      const key = randomBytes(32);
      sessions.set(connectionId, { key, transport });
      const result: OperatorHttpBeginResponse = {
        connectionId,
        connectionKey: key.toString("base64url"),
        challenge: connection.challenge,
        handshakeExpiresAtMs: connection.handshakeExpiresAtMs,
        limits: OPERATOR_HTTP_LIMITS,
      };
      response.once("close", () => {
        if (!response.writableFinished) {
          transport.terminate();
        }
      });
      sendJson(response, 201, result);
      return true;
    }
    if (!session) {
      return true;
    }
    if (parts[1] === "frames") {
      const parsed = framesSchema.safeParse(body.value);
      if (!parsed.success) {
        reject(response, 400, "invalid_request", "Invalid frame envelope");
        return true;
      }
      if (session.transport.readyState !== 1) {
        reject(response, 410, "connection_closed", "Connection closed; reconnect", true);
        return true;
      }
      const frame = stableStringify(parsed.data.frame);
      if (Buffer.byteLength(frame) > limit) {
        reject(response, 413, "payload_too_large", "Gateway frame exceeds connection limit");
        return true;
      }
      if (!session.transport.acknowledge(parsed.data.ack)) {
        reject(
          response,
          409,
          "ack_conflict",
          "ACK must be monotonic and refer to delivered output",
        );
        return true;
      }
      if (!session.transport.accept(parsed.data.clientSeq, frame, ingress)) {
        reject(
          response,
          409,
          "sequence_conflict",
          "Retry the identical last frame or send the next clientSeq",
        );
        return true;
      }
      const result: OperatorHttpFramesResponse = {
        acceptedClientSeq: session.transport.acceptedClientSeq,
      };
      sendJson(response, 202, result);
      return true;
    }
    const parsed = pollSchema.safeParse(body.value);
    if (!parsed.success) {
      reject(response, 400, "invalid_request", "Invalid poll envelope");
      return true;
    }
    if (!session.transport.acknowledge(parsed.data.ack)) {
      reject(response, 409, "ack_conflict", "ACK must be monotonic and refer to delivered output");
      return true;
    }
    if (!(await session.transport.pollFrames(response, ingress, parsed.data.waitMs))) {
      reject(response, 409, "poll_conflict", "Only one poll may be active");
    }
    return true;
  };
  return {
    handleRequest,
    close: () => {
      closed = true;
      for (const session of sessions.values()) {
        session.transport.terminate();
      }
      sessions.clear();
    },
  };
}
