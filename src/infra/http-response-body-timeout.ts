// Applies idle and overall deadlines to fetch response-body reads.
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { racePromiseWithAbortSignal } from "./abort-signal.js";

type TimeoutErrorFactory = (params: { timeoutMs: number }) => Error;

function createResponseBodyTimeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

export async function withResponseBodyTimeout<T>(params: {
  timeoutMs: number | undefined;
  onTimeout: TimeoutErrorFactory | undefined;
  signal?: AbortSignal;
  cancel: (error: Error) => Promise<unknown>;
  read: (refreshTimeout?: () => void) => Promise<T>;
}): Promise<T> {
  if (params.timeoutMs === undefined && !params.signal) {
    return await params.read();
  }
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let signal = params.signal;
  try {
    if (params.timeoutMs !== undefined) {
      const deadline = new AbortController();
      signal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
      const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
      timeoutId = setTimeout(() => {
        deadline.abort(
          params.onTimeout?.({ timeoutMs }) ??
            createResponseBodyTimeoutError(`Response body timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs).unref();
    }

    return await racePromiseWithAbortSignal(
      () =>
        Promise.resolve().then(() => {
          signal?.throwIfAborted();
          return params.read(() => {
            // A late read must not restart a stopped deadline or consume another chunk.
            signal?.throwIfAborted();
            timeoutId?.refresh();
          });
        }),
      signal,
      (aborted) => toErrorObject(aborted.reason, "Response body read aborted"),
    );
  } catch (error) {
    const failure = toErrorObject(error, "Non-Error rejection");
    if (signal?.aborted) {
      // Reject the observation before cancellation can synchronously finish a pending read.
      void params.cancel(failure).catch(() => undefined);
    }
    throw failure;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Owns one refreshable idle deadline for a bounded response-body operation. */
export function withResponseBodyIdleTimeout<T>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunkTimeoutMs: number | undefined,
  onIdleTimeout: ((params: { chunkTimeoutMs: number }) => Error) | undefined,
  read: (refreshTimeout?: () => void) => Promise<T>,
): Promise<T> {
  if (chunkTimeoutMs === undefined) {
    return read();
  }
  return withResponseBodyTimeout({
    timeoutMs: chunkTimeoutMs,
    onTimeout: ({ timeoutMs }) =>
      onIdleTimeout?.({ chunkTimeoutMs: timeoutMs }) ??
      createResponseBodyTimeoutError(`Media download stalled: no data received for ${timeoutMs}ms`),
    // Cancellation releases fetch sockets and buffers instead of letting the
    // pending read continue after the caller has failed.
    cancel: async (error) => await reader.cancel(error),
    read,
  });
}

/** Reads one chunk, rejecting and cancelling the reader after an idle timeout. */
export async function readChunkWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunkTimeoutMs: number,
  onIdleTimeout?: (params: { chunkTimeoutMs: number }) => Error,
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  return await withResponseBodyIdleTimeout(reader, chunkTimeoutMs, onIdleTimeout, () =>
    reader.read(),
  );
}
