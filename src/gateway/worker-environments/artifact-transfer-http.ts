import type { FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { redactSensitiveText } from "../../logging/redact.js";
import { AUTH_RATE_LIMIT_SCOPE_WORKER_TRANSFER, type AuthRateLimiter } from "../auth-rate-limit.js";
import { sendJson, watchClientDisconnect } from "../http-common.js";
import { withSerializedRateLimitAttempt } from "../rate-limit-attempt-serialization.js";
import {
  ArtifactTransferBusyError,
  type ArtifactTransferService,
} from "./artifact-transfer-service.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type ArtifactTransferHttpCallback = (params: {
  req: IncomingMessage;
  res: ServerResponse;
  artifactKey: string;
  bearer: string;
}) => Promise<
  { kind: "unauthorized" } | { kind: "authorized"; handle: () => Promise<void> | void }
>;

export type ArtifactTransferHttpRequest = {
  req: IncomingMessage;
  res: ServerResponse;
  clientIp: string | undefined;
  rateLimiter?: AuthRateLimiter;
};

function sendOpaqueNotFound(res: ServerResponse): void {
  sendJson(res, 404, { error: "not_found" });
}

function streamInterruptionReason(error: unknown, token: string, tarballPath: string): string {
  const message = (error instanceof Error ? error.message : String(error))
    .replaceAll(token, "[redacted]")
    .replaceAll(tarballPath, "[artifact]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu, "[url]")
    .replace(/(["'])[^"'<>]*[\\/][^"'<>]*\1/gu, "[path]")
    .replace(/[^\s"'<>(),;=]*[\\/][^\s"'<>(),;]*/gu, "[path]");
  const redacted = redactSensitiveText(message, { mode: "tools" }).replace(/\s+/gu, " ").trim();
  return `stream error (${truncateUtf16Safe(redacted || "unknown error", 240)})`;
}

export async function handleArtifactTransferHttpRequest(
  params: ArtifactTransferHttpRequest & {
    classifyPath: (pathname: string) => "namespace" | "outside";
    routePrefix: string;
    callback?: ArtifactTransferHttpCallback;
  },
): Promise<boolean> {
  const parsed = URL.parse(params.req.url ?? "/", "http://localhost");
  if (!parsed || params.classifyPath(parsed.pathname) === "outside") {
    return false;
  }
  params.res.setHeader("Cache-Control", "no-store");
  const prefix = params.routePrefix;
  const artifactKey = parsed.pathname.startsWith(prefix)
    ? parsed.pathname.slice(prefix.length)
    : "";
  if (
    params.req.method !== "GET" ||
    !SHA256_PATTERN.test(artifactKey) ||
    parsed.search ||
    parsed.hash
  ) {
    sendOpaqueNotFound(params.res);
    return true;
  }
  return handleWorkerTransferHttpRequest(params, (bearer) =>
    params.callback?.({ req: params.req, res: params.res, artifactKey, bearer }),
  );
}

export async function handleWorkerTransferHttpRequest(
  params: ArtifactTransferHttpRequest,
  authorize: (bearer: string) => ReturnType<ArtifactTransferHttpCallback> | undefined,
): Promise<boolean> {
  const authorization = normalizeOptionalString(params.req.headers.authorization);
  const bearer = authorization?.toLowerCase().startsWith("bearer ")
    ? normalizeOptionalString(authorization.slice(7))
    : undefined;
  const admission = await withSerializedRateLimitAttempt<
    | { kind: "rate-limited"; retryAfterMs: number }
    | Awaited<ReturnType<ArtifactTransferHttpCallback>>
  >({
    ip: params.clientIp,
    scope: AUTH_RATE_LIMIT_SCOPE_WORKER_TRANSFER,
    run: async () => {
      const rateCheck = params.rateLimiter?.check(
        params.clientIp,
        AUTH_RATE_LIMIT_SCOPE_WORKER_TRANSFER,
      );
      if (rateCheck && !rateCheck.allowed) {
        return { kind: "rate-limited", retryAfterMs: rateCheck.retryAfterMs };
      }
      const pendingAuthorization = bearer ? authorize(bearer) : undefined;
      const outcome = pendingAuthorization
        ? await pendingAuthorization
        : ({ kind: "unauthorized" } as const);
      if (outcome.kind === "unauthorized") {
        params.rateLimiter?.recordFailure(params.clientIp, AUTH_RATE_LIMIT_SCOPE_WORKER_TRANSFER);
      } else {
        params.rateLimiter?.reset(params.clientIp, AUTH_RATE_LIMIT_SCOPE_WORKER_TRANSFER);
      }
      return outcome;
    },
  });
  if (admission.kind === "rate-limited") {
    if (admission.retryAfterMs > 0) {
      params.res.setHeader("Retry-After", String(Math.ceil(admission.retryAfterMs / 1000)));
    }
    sendJson(params.res, 429, { error: "rate_limited" });
    return true;
  }
  if (admission.kind === "unauthorized") {
    sendOpaqueNotFound(params.res);
    return true;
  }
  await admission.handle();
  return true;
}

export function createArtifactTransferHttpCallback(
  service: Omit<ArtifactTransferService, "prepare">,
): ArtifactTransferHttpCallback {
  return async ({ req, res, artifactKey, bearer }) => {
    let authorization: ReturnType<ArtifactTransferService["authorize"]>;
    try {
      authorization = service.authorize({ token: bearer, artifactKey });
    } catch (error) {
      if (!(error instanceof ArtifactTransferBusyError)) {
        throw error;
      }
      return {
        kind: "authorized",
        handle: () => sendJson(res, 503, { error: "transfer_in_progress" }),
      };
    }
    if (!authorization) {
      return { kind: "unauthorized" };
    }
    const { capability } = authorization;
    return {
      kind: "authorized",
      handle: async () => {
        let servedBytes = 0;
        let interruptionReason: string | undefined;
        const authoritySignal = service.authorizationSignal(authorization);
        const recordAuthorityClosure = () => {
          interruptionReason ??= `authority closed (${capability.revocationReason ?? "authorization lost"})`;
        };
        authoritySignal.addEventListener("abort", recordAuthorityClosure, { once: true });
        if (authoritySignal.aborted) {
          recordAuthorityClosure();
        }
        const clientAbort = new AbortController();
        const stopWatchingDisconnect = watchClientDisconnect(req, res, clientAbort, () => {
          interruptionReason ??= "client disconnected";
        });
        const signal = AbortSignal.any([authoritySignal, clientAbort.signal]);
        let fileHandle: FileHandle | undefined;
        try {
          const file = await service.openFile(authorization);
          fileHandle = file?.handle;
          if (!file || signal.aborted || !service.isAuthorizationCurrent(authorization)) {
            sendOpaqueNotFound(res);
            return;
          }
          const range = req.headers.range;
          const start = range === undefined ? 0 : Number(/^bytes=(\d+)-$/u.exec(range)?.[1]);
          if (range !== undefined && (!Number.isSafeInteger(start) || start >= file.bytes)) {
            res.setHeader("Content-Range", `bytes */${file.bytes}`);
            sendJson(res, 416, { error: "range_not_satisfiable" });
            return;
          }
          // Observers see the client's delivered position, so a ranged serve starts at its offset.
          servedBytes = start;
          const checkAuthority = new Transform({
            transform(chunk: Buffer, _encoding, next) {
              if (!service.isAuthorizationCurrent(authorization)) {
                next(new Error("Worker artifact transfer authority closed"));
                return;
              }
              servedBytes += chunk.length;
              try {
                capability.onProgress?.(servedBytes);
              } catch {
                // Progress observers cannot interrupt an authorized transfer.
              }
              next(null, chunk);
            },
          });
          res.writeHead(range === undefined ? 200 : 206, {
            "content-type": "application/octet-stream",
            "content-length": String(file.bytes - start),
            "accept-ranges": "bytes",
            ...(range === undefined
              ? {}
              : { "content-range": `bytes ${start}-${file.bytes - 1}/${file.bytes}` }),
            "x-openclaw-content-sha256": file.sha256,
          });
          // An extra EOF read can outlive the client's Content-Length-complete response
          // and let owner revocation destroy its reused keep-alive socket.
          const stream = file.handle.createReadStream({
            start,
            end: file.bytes - 1,
            autoClose: false,
          });
          stream.once("error", (error) => {
            interruptionReason ??= streamInterruptionReason(
              error,
              capability.token,
              capability.artifact.tarballPath,
            );
          });
          await pipeline(stream, checkAuthority, res, { signal });
        } catch (error) {
          interruptionReason ??= streamInterruptionReason(
            error,
            capability.token,
            capability.artifact.tarballPath,
          );
          if (!res.headersSent && !res.destroyed) {
            sendOpaqueNotFound(res);
          } else if (!res.destroyed) {
            res.destroy();
          }
        } finally {
          stopWatchingDisconnect();
          authoritySignal.removeEventListener("abort", recordAuthorityClosure);
          if (servedBytes !== capability.artifact.tarballBytes || !res.writableFinished) {
            try {
              capability.onInterrupted?.(servedBytes, interruptionReason ?? "stream error");
            } catch {
              // Interruption observers cannot prevent capability/descriptor cleanup.
            }
          }
          try {
            await fileHandle?.close();
          } finally {
            service.finish(authorization);
          }
        }
      },
    };
  };
}
