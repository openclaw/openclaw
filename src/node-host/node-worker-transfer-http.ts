import http, { type ClientRequest, type IncomingMessage } from "node:http";
import https from "node:https";
import type { TLSSocket } from "node:tls";
import { normalizeTlsFingerprint } from "../../packages/gateway-client/src/client-address-utils.js";
import {
  buildCloudflareAccessHeaders,
  type CloudflareAccessCredentials,
} from "../../packages/gateway-client/src/cloudflare-access.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";

type NodeWorkerTransferHttpErrorReason =
  | "invalid-gateway-transport"
  | "cloudflare-access-requires-tls"
  | "invalid-tls-fingerprint"
  | "tls-fingerprint-mismatch";

export class NodeWorkerTransferHttpError extends Error {
  constructor(
    readonly reason: NodeWorkerTransferHttpErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "NodeWorkerTransferHttpError";
  }
}

const validatedTlsSocketPins = new WeakMap<TLSSocket, string>();

function transferUrl(gatewayUrl: string, routePath: string): URL {
  const gateway = new URL(gatewayUrl);
  if (gateway.protocol !== "ws:" && gateway.protocol !== "wss:") {
    throw new NodeWorkerTransferHttpError(
      "invalid-gateway-transport",
      "worker transfer gateway must use WebSocket transport",
    );
  }
  const url = new URL(gateway.toString());
  url.protocol = gateway.protocol === "wss:" ? "https:" : "http:";
  const basePath = gateway.pathname.replace(/\/$/u, "");
  url.pathname = `${basePath}${routePath}`;
  url.search = "";
  url.hash = "";
  if (url.host !== gateway.host) {
    throw new NodeWorkerTransferHttpError(
      "invalid-gateway-transport",
      "worker transfer endpoint must stay on the connected gateway host",
    );
  }
  return url;
}

function waitForTlsPin(request: ClientRequest, expectedRaw?: string): Promise<void> {
  if (!expectedRaw?.trim()) {
    return Promise.resolve();
  }
  const expected = normalizeTlsFingerprint(expectedRaw);
  if (!expected) {
    return Promise.reject(
      new NodeWorkerTransferHttpError(
        "invalid-tls-fingerprint",
        "worker transfer gateway TLS fingerprint is invalid",
      ),
    );
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let tlsSocket: TLSSocket | undefined;
    let fail: (error: Error) => void = () => {};
    let verify: () => void = () => {};
    let bindSocket: (socket: import("node:net").Socket) => void = () => {};
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      request.off("error", fail);
      request.off("socket", bindSocket);
      tlsSocket?.off("secureConnect", verify);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    fail = (error: Error) => finish(error);
    request.once("error", fail);
    bindSocket = (socket) => {
      tlsSocket = socket as TLSSocket;
      const validated = validatedTlsSocketPins.get(tlsSocket);
      if (validated) {
        finish(
          validated === expected
            ? undefined
            : new NodeWorkerTransferHttpError(
                "tls-fingerprint-mismatch",
                "worker transfer gateway TLS fingerprint mismatch",
              ),
        );
        return;
      }
      verify = () => {
        const actual = normalizeTlsFingerprint(
          tlsSocket!.getPeerCertificate().fingerprint256 ?? "",
        );
        if (!actual || expected !== actual) {
          finish(
            new NodeWorkerTransferHttpError(
              "tls-fingerprint-mismatch",
              "worker transfer gateway TLS fingerprint mismatch",
            ),
          );
          return;
        }
        validatedTlsSocketPins.set(tlsSocket!, actual);
        finish();
      };
      const peerFingerprint = tlsSocket.getPeerCertificate().fingerprint256;
      if (request.reusedSocket || peerFingerprint) {
        verify();
      } else {
        tlsSocket.once("secureConnect", verify);
      }
    };
    request.once("socket", bindSocket);
  });
}

export type NodeWorkerTransferHttpRequest = {
  gatewayUrl: string;
  tlsFingerprint?: string;
  routePath: string;
  method: "GET" | "POST";
  token: string;
  cloudflareAccess?: CloudflareAccessCredentials;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  writeBody?: (write: (chunk: Buffer) => Promise<void>, signal: AbortSignal) => Promise<void>;
};

export async function withNodeWorkerTransferHttpRequest<T>(
  params: NodeWorkerTransferHttpRequest,
  consume: (response: IncomingMessage) => Promise<T>,
): Promise<T> {
  const url = transferUrl(params.gatewayUrl, params.routePath);
  if (params.cloudflareAccess && url.protocol !== "https:") {
    throw new NodeWorkerTransferHttpError(
      "cloudflare-access-requires-tls",
      "Cloudflare Access credentials require HTTPS worker transfer",
    );
  }
  const transport = url.protocol === "https:" ? https : http;
  const request = transport.request(url, {
    method: params.method,
    headers: {
      ...params.headers,
      authorization: `Bearer ${params.token}`,
      ...(params.cloudflareAccess ? buildCloudflareAccessHeaders(params.cloudflareAccess) : {}),
    },
    signal: params.signal,
    ...(url.protocol === "https:" && params.tlsFingerprint
      ? { rejectUnauthorized: false, session: Buffer.alloc(0) }
      : {}),
  });
  const responseReady = createDeferredCore<IncomingMessage>();
  const requestClosed = createDeferredCore();
  const stopWriter = new AbortController();
  const writerSignal = params.signal
    ? AbortSignal.any([params.signal, stopWriter.signal])
    : stopWriter.signal;
  let receivedResponse: IncomingMessage | undefined;
  let responseAccepted = false;
  let bodyCompleted = false;
  let writtenBytes = 0;
  let pendingDrain: Deferred | undefined;
  const declaredBytes = Number(request.getHeader("content-length"));
  const bodySubmitted = () =>
    Number.isSafeInteger(declaredBytes) && declaredBytes >= 0
      ? writtenBytes === declaredBytes
      : bodyCompleted;
  const onResponse = (response: IncomingMessage) => {
    receivedResponse = response;
    responseReady.resolve(response);
  };
  const onError = (error: Error) => {
    stopWriter.abort(error);
    responseReady.reject(error);
  };
  const onDrain = () => pendingDrain?.resolve();
  const onWriterAbort = () => pendingDrain?.reject(writerSignal.reason);
  request.once("response", onResponse);
  request.on("error", onError);
  request.on("drain", onDrain);
  writerSignal.addEventListener("abort", onWriterAbort, { once: true });
  request.once("close", () => {
    const error = new Error("worker transfer request closed before completion");
    if (!receivedResponse) {
      responseReady.reject(error);
    }
    if (!bodySubmitted()) {
      stopWriter.abort(error);
    }
    requestClosed.resolve();
  });
  const send = async () => {
    if (url.protocol === "https:") {
      await waitForTlsPin(request, params.tlsFingerprint);
    }
    writerSignal.throwIfAborted();
    await params.writeBody?.(async (chunk) => {
      writerSignal.throwIfAborted();
      if (request.destroyed) {
        throw (
          request.errored ?? new Error("worker transfer request closed before its body completed")
        );
      }
      const ready = request.write(chunk);
      writtenBytes += chunk.byteLength;
      if (!ready) {
        const drain = createDeferredCore();
        pendingDrain = drain;
        if (writerSignal.aborted) {
          drain.reject(writerSignal.reason);
        } else if (responseAccepted && bodySubmitted()) {
          drain.resolve();
        }
        try {
          await drain.promise;
        } finally {
          pendingDrain = undefined;
        }
      }
    }, writerSignal);
    bodyCompleted = true;
    if (!request.destroyed) {
      request.end();
    }
  };
  const sent = send().then(
    () => ({ ok: true as const }),
    (error: unknown) => {
      stopWriter.abort(error);
      // Keep complete responses readable so server diagnostics can still win.
      if (!receivedResponse?.complete) {
        const cause = error instanceof Error ? error : new Error(String(error));
        receivedResponse?.destroy(cause);
        request.destroy(cause);
      }
      return { ok: false as const, error };
    },
  );
  let response: IncomingMessage | undefined;
  let consumed: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    response = await responseReady.promise;
    const result = await consume(response);
    responseAccepted = true;
    // A verified response may precede the last drain event, even after all bytes arrived.
    if (bodySubmitted()) {
      pendingDrain?.resolve();
    }
    consumed = { ok: true, value: result };
  } catch (error) {
    consumed = { ok: false, error };
  }
  // A final response can arrive while a file read or drain still owns upload bytes.
  // Preserve its body first, then stop incomplete writes and join their cleanup.
  const incomplete = !bodySubmitted();
  const earlyResponse = new Error("worker transfer response completed before its request body");
  if (!consumed.ok || incomplete) {
    stopWriter.abort(earlyResponse);
  }
  const outcome = await sent;
  if (!outcome.ok || !response?.readableEnded || incomplete) {
    response?.destroy();
    request.destroy();
  }
  await requestClosed.promise;
  request.off("error", onError);
  request.off("response", onResponse);
  request.off("drain", onDrain);
  writerSignal.removeEventListener("abort", onWriterAbort);
  if (!consumed.ok) {
    throw consumed.error;
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  if (incomplete) {
    throw earlyResponse;
  }
  params.signal?.throwIfAborted();
  return consumed.value;
}
