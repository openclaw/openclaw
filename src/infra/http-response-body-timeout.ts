// Applies idle and overall deadlines to fetch response-body reads.
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";

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
  let stoppedError: Error | undefined;

  return await new Promise<T>((resolve, reject) => {
    const clear = () => {
      params.signal?.removeEventListener("abort", onAbort);
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };

    const stop = (error: Error) => {
      if (stoppedError) {
        return;
      }
      stoppedError = error;
      clear();
      void params.cancel(error).catch(() => undefined);
      reject(error);
    };
    const onAbort = () => stop(toErrorObject(params.signal?.reason, "Response body read aborted"));
    params.signal?.addEventListener("abort", onAbort, { once: true });
    if (params.signal?.aborted) {
      onAbort();
      return;
    }

    if (params.timeoutMs !== undefined) {
      const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
      timeoutId = setTimeout(() => {
        stop(
          params.onTimeout?.({ timeoutMs }) ??
            createResponseBodyTimeoutError(`Response body timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      if (typeof timeoutId === "object" && "unref" in timeoutId) {
        timeoutId.unref();
      }
    }

    void Promise.resolve()
      .then(() => {
        if (stoppedError) {
          throw stoppedError;
        }
        return params.read(() => {
          // A late read must not restart a stopped deadline or consume another chunk.
          if (stoppedError) {
            throw stoppedError;
          }
          timeoutId?.refresh();
        });
      })
      .then(
        (value) => {
          clear();
          if (!stoppedError) {
            resolve(value);
          }
        },
        (error: unknown) => {
          clear();
          if (!stoppedError) {
            reject(toErrorObject(error, "Non-Error rejection"));
          }
        },
      );
  });
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
