import type { HeadersLike } from "../infra/fetch-headers.js";
import { withResponseBodyTimeout } from "../infra/http-response-body-timeout.js";
import { reportCapturePersistenceFailure, type CaptureOwner } from "./runtime-owner.js";

export type HttpCaptureParams = {
  url: string;
  method: string;
  requestHeaders?: HeadersLike | Record<string, string> | undefined;
  requestBody?: BodyInit | Buffer | string | null;
  response: Response;
  signal?: AbortSignal;
  transport?: "http" | "sse";
  flowId?: string;
  meta?: Record<string, unknown>;
};

export type HttpCaptureErrorParams = Omit<HttpCaptureParams, "response"> & { error: unknown };

// Bound the diagnostic clone independently of the caller's response body.
const MAX_CAPTURED_RESPONSE_BODY_BYTES = 16 * 1024 * 1024;
// A stalled clone can retain the caller's transport until both tee branches
// cancel. Match the shared body reader's idle limit in src/infra/http-body.ts.
const CAPTURED_RESPONSE_BODY_IDLE_TIMEOUT_MS = 10_000;

/** Distinguishes the capture deadline from a genuine response-stream failure. */
class CaptureReadIdleTimeoutError extends Error {}

export type CapturedResponseBodyResult =
  | { status: "captured"; buffer: Buffer }
  | { status: "stalled" | "finalized"; buffer: Buffer }
  | { status: "failed"; buffer: Buffer; error: unknown }
  | { status: "too-large" | "unavailable" };

// Oversized or non-streaming bodies produce metadata-only captures. Never await
// reader.cancel(): this clone's cancellation waits for the still-live caller's
// tee branch and would hang capture finalization.
export function readCapturedResponseBodyBounded(
  response: Response,
  owner: CaptureOwner,
  record: (result: CapturedResponseBodyResult) => void,
  signal?: AbortSignal,
  asynchronous = false,
): void {
  const recordMetadata = (status: "unavailable" | "too-large") => {
    try {
      record({ status });
    } catch (error) {
      reportCapturePersistenceFailure(owner, error);
    }
  };
  if (typeof response.clone !== "function") {
    recordMetadata("unavailable");
    return;
  }
  const declaredLength = parseDeclaredCaptureContentLength(
    typeof response.headers?.get === "function"
      ? response.headers.get("content-length")
      : undefined,
  );
  if (declaredLength !== undefined && declaredLength > BigInt(MAX_CAPTURED_RESPONSE_BODY_BYTES)) {
    recordMetadata("too-large");
    return;
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let chunks: Buffer[] = [];
  let total = 0;
  let finished = false;
  let canceled = false;
  let detachAbort = () => {};
  const cancel = (reason?: unknown) => {
    if (!reader || canceled) {
      return;
    }
    canceled = true;
    // A clone is one tee branch: awaiting cancel can wait for the live caller.
    try {
      void reader.cancel(reason).catch(() => undefined);
    } catch (error) {
      owner.errors.push(error);
    }
  };
  const release = () => {
    try {
      reader?.releaseLock();
    } catch {
      // A pending read releases its lock when the canceled read settles.
    }
  };
  const finish = (result: CapturedResponseBodyResult) => {
    if (finished) {
      return;
    }
    finished = true;
    detachAbort();
    owner.pending.delete(finalize);
    try {
      if (!asynchronous && owner.store.isClosed) {
        throw new Error("Capture store closed before its response could be finalized.");
      }
      record(result);
    } catch (error) {
      // Persistence failure is not a second stream error. Preserve it for close.
      reportCapturePersistenceFailure(owner, error);
    } finally {
      chunks = [];
      cancel();
      release();
    }
  };
  const finalize = () => finish({ status: "finalized", buffer: Buffer.concat(chunks, total) });
  owner.pending.add(finalize);
  if (signal) {
    const onAbort = () => {
      // Bun can deliver the caller's abort in the same turn as a clean body
      // EOF. Give the pending stream read one poll turn to record that EOF.
      setTimeout(() => {
        if (finished) {
          return;
        }
        finish({
          status: "failed",
          buffer: Buffer.concat(chunks, total),
          error:
            signal.reason instanceof Error
              ? signal.reason
              : new Error("Response capture aborted", { cause: signal.reason }),
        });
      }, 0);
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
      detachAbort = () => signal.removeEventListener("abort", onAbort);
    }
  }
  if (finished) {
    return;
  }
  void (async () => {
    try {
      const clone = response.clone();
      const body = clone.body;
      if (!body || typeof body.getReader !== "function") {
        finish(
          clone instanceof Response && clone.body === null
            ? { status: "captured", buffer: Buffer.alloc(0) }
            : { status: "unavailable" },
        );
        return;
      }
      reader = body.getReader();
      for (;;) {
        if (finished || !owner.active) {
          return;
        }
        const { done, value } = await withResponseBodyTimeout({
          timeoutMs: CAPTURED_RESPONSE_BODY_IDLE_TIMEOUT_MS,
          onTimeout: ({ timeoutMs }) =>
            new CaptureReadIdleTimeoutError(`capture read stalled: no data for ${timeoutMs}ms`),
          cancel: async (error) => cancel(error),
          read: () => reader!.read(),
        });
        // Finalize may have synchronously recorded and closed this exact store.
        if (finished || !owner.active) {
          return;
        }
        if (done) {
          finish({ status: "captured", buffer: Buffer.concat(chunks, total) });
          return;
        }
        if (!value?.length) {
          continue;
        }
        if (total + value.length > MAX_CAPTURED_RESPONSE_BODY_BYTES) {
          finish({ status: "too-large" });
          return;
        }
        chunks.push(Buffer.from(value));
        total += value.length;
      }
    } catch (error) {
      if (!finished && owner.active) {
        finish(
          error instanceof CaptureReadIdleTimeoutError
            ? { status: "stalled", buffer: Buffer.concat(chunks, total) }
            : { status: "failed", buffer: Buffer.concat(chunks, total), error },
        );
      }
    } finally {
      release();
    }
  })();
}

function parseDeclaredCaptureContentLength(raw: string | null | undefined): bigint | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  return BigInt(trimmed);
}
