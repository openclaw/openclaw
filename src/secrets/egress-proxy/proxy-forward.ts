import { ServerResponse, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest, type Agent as HttpsAgent } from "node:https";
import { PassThrough, type Readable, type Writable } from "node:stream";
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
  const bodyTransform = forward.ownResource(
    createSecretEgressBodyTransform({
      onSubstitution: () => {
        substituted = true;
      },
      resolveSentinel: forward.resolveSentinel,
    }),
  );
  let refused = false;
  let upgraded = false;
  const upstream = forward.ownResource(
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
  forward.request.once("error", () => forward.response.destroy());
  const onResponseClose = () => {
    refused = true;
    forward.request.unpipe(bodyTransform);
    bodyTransform.destroy();
    upstream.destroy();
  };
  forward.response.once("close", onResponseClose);
  if (forward.upgrade) {
    forward.request.socket.once("end", () => {
      if (!upgraded) {
        forward.response.destroy();
      }
    });
  }
  // Upgrade handshakes have no transformed body. Record their credential egress
  // when the request is sent, even if the upstream rejects or stalls the upgrade.
  (forward.upgrade ? upstream : bodyTransform).once("finish", () => {
    if (!refused && forward.isActive()) {
      forward.audit({ kind: "forwarded", host, substituted });
    }
  });
  bodyTransform.once("error", (error) => {
    if (refused || !forward.isActive()) {
      return;
    }
    refused = true;
    forward.request.unpipe(bodyTransform);
    forward.request.resume();
    upstream.destroy();
    const reason =
      error instanceof SecretEgressSubstitutionError ? error.reason : "unresolved-sentinel";
    forward.audit({ kind: "refused", host, substituted, reason });
    sendHttpRefusal(
      forward.response,
      502,
      error instanceof SecretEgressSubstitutionError ? `${error.message}\n` : REFUSAL_BODY,
    );
  });
  upstream.once("error", () => {
    if (refused || !forward.isActive()) {
      return;
    }
    refused = true;
    forward.audit({ kind: "refused", host, substituted, reason: "upstream-error" });
    sendHttpRefusal(forward.response, 502, UPSTREAM_ERROR_BODY);
  });
  upstream.once("upgrade", (response, upstreamSocket, head) => {
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
  if (forward.upgrade) {
    upstream.end();
  } else {
    forward.request.pipe(bodyTransform).pipe(upstream);
  }
}
