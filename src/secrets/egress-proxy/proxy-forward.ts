import {
  ServerResponse,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import { request as httpsRequest, type Agent as HttpsAgent } from "node:https";
import { PassThrough, Writable, type Readable } from "node:stream";
import {
  createSecretEgressBodyTransform,
  SecretEgressSubstitutionError,
  substituteSecretEgressBody,
  type SecretEgressRefusalReason,
} from "./stream-substitution.js";

export const REFUSAL_BODY = "Secret egress proxy refused the request.\n";
const UPSTREAM_ERROR_BODY = "Secret egress proxy could not reach the upstream host.\n";
const MAX_BUFFERED_REQUEST_BODY_BYTES = 100 * 1024 * 1024;

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
type ForwardRequest = {
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
};

function sendSecretEgressRequest(
  forward: ForwardRequest,
  body?: Buffer,
  releaseBody?: () => void,
): ClientRequest {
  const { target, headers, host } = forward;
  let { substituted } = forward;
  // Only this owner chooses outgoing framing, after accounting for substitution.
  delete headers["content-length"];
  delete headers["transfer-encoding"];
  if (body !== undefined) {
    headers["content-length"] = String(body.length);
    // Our HTTP server already acknowledges 100-continue. Forwarding Expect would
    // make Node commit upstream headers before the transformed length is known.
    delete headers.expect;
    delete headers.trailer;
  }
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
  const bodyTransform = forward.ownResource(
    createSecretEgressBodyTransform({
      onSubstitution: () => {
        substituted = true;
      },
      resolveSentinel: forward.resolveSentinel,
    }),
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
  // Preparation is not egress. Finish belongs to the actual upstream transport.
  upstream.once("close", () => releaseBody?.());
  upstream.once("finish", () => {
    releaseBody?.();
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
  } else if (body !== undefined) {
    bodyTransform.destroy();
    upstream.end(body);
  } else {
    forward.request.pipe(bodyTransform).pipe(upstream);
  }
  return upstream;
}

/** One proxy owns admission across all registrations, including bodies still being sent. */
export function createSecretEgressBodyBudget(): (length: number) => (() => void) | undefined {
  let bytes = 0;
  let count = 0;
  return (length) => {
    // Reserve payload plus headroom for each scanner, HTTP/TLS queues and metadata.
    // The independent count bound also covers zero/tiny bodies; this is not an RSS cap.
    const weight = length + 256 * 1024;
    if (count >= 64 || bytes + weight > 128 * 1024 * 1024) {
      return undefined;
    }
    bytes += weight;
    count++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        bytes -= weight;
        count--;
      }
    };
  };
}

/** Collect original bytes, then authorize/substitute synchronously at the send boundary. */
export function forwardSecretEgressRequest(
  forward: Omit<ForwardRequest, "target" | "headers" | "substituted"> & {
    prepareRequest: () => Pick<ForwardRequest, "target" | "headers" | "substituted">;
    acquireBody: ReturnType<typeof createSecretEgressBodyBudget>;
  },
): void {
  const length = Number(forward.request.headers["content-length"]);
  const buffered =
    !forward.upgrade &&
    forward.request.headers["content-length"] !== undefined &&
    forward.request.headers["transfer-encoding"] === undefined &&
    Number.isSafeInteger(length) &&
    length >= 0 &&
    length <= MAX_BUFFERED_REQUEST_BODY_BYTES;
  let body: Buffer | undefined;
  let collector: Writable | undefined;
  let upstream: ClientRequest | undefined;
  const releaseBudget = buffered ? forward.acquireBody(length) : undefined;
  let refused = false;
  let substituted = false;
  const release = () => {
    body = undefined;
    clearTimeout(timer);
    releaseBudget?.();
  };
  const refuse = (reason: SecretEgressRefusalReason, status = 502, message = REFUSAL_BODY) => {
    if (refused) {
      return;
    }
    refused = true;
    if (collector) {
      forward.request.unpipe(collector);
      collector.destroy();
    }
    forward.request.resume();
    if (upstream) {
      upstream.destroy();
    } else {
      release();
    }
    // An early refusal need not consume the declared body. Close the incoming
    // message after the reply too, so the registration releases that resource.
    forward.response.once("close", () => forward.request.destroy());
    forward.audit({ kind: "refused", host: forward.host, substituted, reason });
    sendHttpRefusal(forward.response, status, message);
  };
  // CONNECT's TLS HTTP servers are fed connection events without listen(); their
  // Node requestTimeout sweep is not a preparation/send deadline.
  const timer = releaseBudget
    ? setTimeout(
        () => refuse("request-timeout", 504, "Secret egress proxy upload timed out.\n"),
        300_000,
      )
    : undefined;
  timer?.unref();
  const send = () => {
    if (refused || !forward.isActive() || forward.response.destroyed) {
      release();
      return;
    }
    try {
      // No awaited work or retained plaintext precedes this current binding lookup.
      const prepared = forward.prepareRequest();
      substituted = prepared.substituted;
      const output =
        body === undefined
          ? undefined
          : substituteSecretEgressBody(body, {
              resolveSentinel: forward.resolveSentinel,
              onSubstitution: () => {
                substituted = true;
              },
            });
      upstream = sendSecretEgressRequest(
        { ...forward, ...prepared, substituted, isActive: () => !refused && forward.isActive() },
        output,
        release,
      );
      body = undefined;
    } catch (error) {
      refuse(
        error instanceof SecretEgressSubstitutionError ? error.reason : "upstream-error",
        error instanceof SecretEgressSubstitutionError && error.reason === "host-not-allowed"
          ? 403
          : 502,
        error instanceof SecretEgressSubstitutionError ? error.message + "\n" : REFUSAL_BODY,
      );
    }
  };
  if (!buffered) {
    send();
    return;
  }
  forward.request.once("error", () => forward.response.destroy());
  forward.response.once("close", () => {
    refused = true;
    if (collector) {
      forward.request.unpipe(collector);
      collector.destroy();
    }
    if (upstream) {
      upstream.destroy();
    } else {
      release();
    }
  });
  if (!releaseBudget) {
    refuse(
      "upload-capacity",
      503,
      "Secret egress proxy upload capacity is busy. Retry the request.\n",
    );
    return;
  }
  try {
    // One exact backing store: chunk count, BufferList nodes and shared slabs
    // cannot amplify retained memory. Every byte is initialized before scanning.
    body = Buffer.allocUnsafeSlow(length);
    let received = 0;
    collector = forward.ownResource(
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          if (!body || received + chunk.length > length) {
            callback(new Error("Invalid request body length"));
            return;
          }
          chunk.copy(body, received);
          received += chunk.length;
          callback();
        },
      }),
    );
    collector.once("error", () => refuse("upstream-error"));
    collector.once("finish", () => {
      if (received !== length) {
        refuse("upstream-error");
      } else {
        send();
      }
    });
    forward.request.pipe(collector);
  } catch {
    refuse("upstream-error");
  }
}
