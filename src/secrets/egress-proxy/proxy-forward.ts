import {
  ServerResponse,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import { request as httpsRequest, type Agent as HttpsAgent } from "node:https";
import { PassThrough, type Readable, type Transform, type Writable } from "node:stream";
import {
  createSecretEgressBodyTransform,
  SecretEgressSubstitutionError,
  type SecretEgressRefusalReason,
} from "./stream-substitution.js";

export const REFUSAL_BODY = "Secret egress proxy refused the request.\n";
const UPSTREAM_ERROR_BODY = "Secret egress proxy could not reach the upstream host.\n";

export type UpgradeRequest = { stream: PassThrough };
export type RequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  upgrade?: UpgradeRequest,
) => void;

/**
 * Bodies the client declares at or below this length are substituted in memory
 * so the upstream request can carry the substituted byte length as
 * `Content-Length`. Origins that reject chunked uploads depend on that final
 * length: GitHub's attachment endpoint answers `400 Bad Content-Length` without
 * it. Larger and unknown-length bodies keep streaming, because no final length
 * can be promised for them.
 */
const PREPARED_BODY_MAX_BYTES = 1024 * 1024;

export function sendHttpRefusal(res: ServerResponse, status = 502, body = REFUSAL_BODY): void {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    Connection: "close",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end(body);
}

export function handleUpgradeRequest(
  handler: RequestHandler,
  request: IncomingMessage,
  head: Buffer,
): void {
  // Reuse normal HTTP refusals and upstream non-101 responses. Node relinquishes
  // HTTP ownership on upgrade, so close these responses unless forwarding detaches it.
  const response = new ServerResponse(request);
  try {
    response.assignSocket(request.socket);
  } catch {
    // A pipelined upgrade can arrive before the previous HTTP response releases
    // this socket. Do not steal it or let Node's ownership error crash the Gateway.
    request.socket.destroy();
    return;
  }
  // Buffer early frames with stream backpressure while waiting for the upstream
  // handshake. Unlike a paused socket, this still observes a disconnect with no data.
  const stream = new PassThrough();
  request.socket.once("close", () => stream.destroy());
  response.once("finish", () => {
    if (response.socket) {
      stream.destroy();
      response.socket.end();
    }
  });
  if (head.length > 0) {
    stream.write(head);
  }
  request.socket.pipe(stream);
  handler(request, response, { stream });
}

function readDeclaredBodyLength(request: IncomingMessage): number | undefined {
  const raw = request.headers["content-length"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || !/^\d+$/u.test(value)) {
    return undefined;
  }
  const declared = Number(value);
  return Number.isSafeInteger(declared) ? declared : undefined;
}

/**
 * Substitutes a body that must be forwarded with a final length, reusing the
 * streaming carry-window transform. Resolves `undefined` when the transform was
 * destroyed, which means the run was revoked or the client left mid-body.
 */
function collectTransformedBody(params: {
  request: IncomingMessage;
  transform: Transform;
}): Promise<Buffer | undefined> {
  return new Promise<Buffer | undefined>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (value: Buffer | undefined) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    params.transform.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    params.transform.once("error", (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    params.transform.once("end", () => settle(Buffer.concat(chunks)));
    params.transform.once("close", () => settle(undefined));
    params.request.pipe(params.transform);
  });
}

/** Forwards one authorized HTTPS request, retaining ownership across a WebSocket upgrade. */
export function forwardSecretEgressRequest(forward: {
  request: IncomingMessage;
  response: ServerResponse;
  upgrade?: UpgradeRequest;
  target: URL;
  headers: IncomingHttpHeaders;
  host: string;
  substituted: boolean;
  upstreamTlsAgent: HttpsAgent;
  isActive: () => boolean;
  ownResource: <T extends Readable | Writable>(resource: T) => T;
  releaseResponse: () => void;
  resolveSentinel: (sentinel: string) => string | undefined;
  audit: (event: {
    kind: "forwarded" | "refused";
    host: string;
    substituted: boolean;
    reason?: SecretEgressRefusalReason;
  }) => void;
}): void {
  const { target, headers, host } = forward;
  let { substituted } = forward;
  let refused = false;
  let upgraded = false;
  let upstream: ClientRequest | undefined;
  const bodyTransform = forward.ownResource(
    createSecretEgressBodyTransform({
      onSubstitution: () => {
        substituted = true;
      },
      resolveSentinel: forward.resolveSentinel,
    }),
  );

  const refuseSubstitution = (error: unknown) => {
    if (refused || !forward.isActive()) {
      return;
    }
    refused = true;
    forward.request.unpipe(bodyTransform);
    forward.request.resume();
    upstream?.destroy();
    const reason =
      error instanceof SecretEgressSubstitutionError ? error.reason : "unresolved-sentinel";
    forward.audit({ kind: "refused", host, substituted, reason });
    sendHttpRefusal(
      forward.response,
      502,
      error instanceof SecretEgressSubstitutionError ? `${error.message}\n` : REFUSAL_BODY,
    );
  };
  bodyTransform.once("error", refuseSubstitution);
  forward.request.once("error", () => forward.response.destroy());
  const onResponseClose = () => {
    refused = true;
    forward.request.unpipe(bodyTransform);
    bodyTransform.destroy();
    upstream?.destroy();
  };
  forward.response.once("close", onResponseClose);
  if (forward.upgrade) {
    forward.request.socket.once("end", () => {
      if (!upgraded) {
        forward.response.destroy();
      }
    });
  }

  const openUpstream = (): ClientRequest => {
    const opened = forward.ownResource(
      httpsRequest(
        {
          hostname: target.hostname,
          port: target.port || 443,
          path: `${target.pathname}${target.search}`,
          method: forward.request.method,
          headers,
          agent: forward.upstreamTlsAgent,
        },
        (upstreamResponse) => {
          forward.ownResource(upstreamResponse);
          if (refused || !forward.isActive()) {
            upstreamResponse.destroy();
            return;
          }
          upstreamResponse.once("error", () => forward.response.destroy());
          forward.response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(forward.response);
        },
      ),
    );
    opened.once("error", () => {
      if (refused || !forward.isActive()) {
        return;
      }
      refused = true;
      forward.audit({ kind: "refused", host, substituted, reason: "upstream-error" });
      sendHttpRefusal(forward.response, 502, UPSTREAM_ERROR_BODY);
    });
    opened.once("upgrade", (response, upstreamSocket, head) => {
      forward.ownResource(upstreamSocket);
      if (refused || !forward.isActive()) {
        upstreamSocket.destroy();
        return;
      }
      if (
        !forward.upgrade ||
        response.statusCode !== 101 ||
        response.headers.upgrade?.toLowerCase() !== "websocket"
      ) {
        refused = true;
        forward.audit({ kind: "refused", host, substituted, reason: "upstream-error" });
        upstreamSocket.destroy();
        sendHttpRefusal(forward.response);
        return;
      }
      const clientSocket = forward.ownResource(forward.request.socket);
      // The handshake is an HTTP request; subsequent bytes are WebSocket frames,
      // not HTTP bodies. Forward them opaquely, including both parsers' head buffers.
      forward.response.off("close", onResponseClose);
      upgraded = true;
      forward.response.writeHead(101, response.headers);
      forward.response.end();
      forward.response.detachSocket(clientSocket);
      forward.releaseResponse();
      bodyTransform.destroy();
      clientSocket.once("close", () => upstreamSocket.destroy());
      upstreamSocket.once("close", () => clientSocket.destroy());
      if (head.length > 0) {
        clientSocket.write(head);
      }
      forward.upgrade.stream.pipe(upstreamSocket).pipe(clientSocket);
    });
    return opened;
  };

  // Upgrade handshakes have no transformed body. Record their credential egress
  // when the request is sent, even if the upstream rejects or stalls the upgrade.
  const auditForwarded = (sent: Writable) => {
    sent.once("finish", () => {
      if (!refused && forward.isActive()) {
        forward.audit({ kind: "forwarded", host, substituted });
      }
    });
  };

  const declaredLength = forward.upgrade ? undefined : readDeclaredBodyLength(forward.request);
  if (declaredLength !== undefined && declaredLength <= PREPARED_BODY_MAX_BYTES) {
    void (async () => {
      const prepared = await collectTransformedBody({
        request: forward.request,
        transform: bodyTransform,
      });
      if (prepared === undefined || refused || !forward.isActive()) {
        return;
      }
      // Declare the substituted length rather than the client's, because
      // substitution can resize the body. A known-length origin needs the exact
      // final byte count, and the body is already complete so it cannot lie.
      headers["content-length"] = String(prepared.length);
      upstream = openUpstream();
      auditForwarded(upstream);
      upstream.end(prepared);
    })().catch(refuseSubstitution);
    return;
  }

  upstream = openUpstream();
  auditForwarded(forward.upgrade ? upstream : bodyTransform);
  if (forward.upgrade) {
    upstream.end();
  } else {
    forward.request.pipe(bodyTransform).pipe(upstream);
  }
}
