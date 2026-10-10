/**
 * Shared body-stream cleanup for guarded fetch consumers (`fetchWithSsrFGuard`
 * callers that re-wrap streaming responses).
 */

// Catches wrapper bodies abandoned without cancel/consume so guarded dispatchers
// (and caller resources hooked into `cleanup`) do not leak with the stream.
const guardedBodyCleanupRegistry = new FinalizationRegistry<{ finalize: () => Promise<void> }>(
  (held) => {
    void held.finalize().catch(() => undefined);
  },
);

// Keep the listener and its detach callback outside the stream's closure scope.
// The finalizer retains detach, which must never retain the stream or controller.
function attachBodyAbort(
  signal: AbortSignal,
  controllerRef: WeakRef<ReadableStreamDefaultController<Uint8Array>>,
  cancel: (reason: unknown) => Promise<void>,
) {
  const abort = () => {
    const controller = controllerRef.deref();
    if (!controller) {
      return;
    }
    const reason = signal.reason ?? new DOMException("This operation was aborted", "AbortError");
    const cleanup = cancel(reason);
    controller.error(reason);
    void cleanup.catch(() => undefined);
  };
  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener("abort", abort, { once: true });
  }
  return () => signal.removeEventListener("abort", abort);
}

type BodyStreamOptions = {
  body: ReadableStream<Uint8Array>;
  cleanup: () => Promise<void> | void;
  refreshTimeout?: () => void;
  signal?: AbortSignal;
};

function wrapBodyStream(
  params: BodyStreamOptions,
  errorSource: "cancellation" | "release",
): ReadableStream<Uint8Array> {
  const reader = params.body.getReader();
  let finalized = false;
  let abortAttached = false;
  let detachAbort = () => {};
  const cleanupRegistrationToken = {};
  const finalize = async (
    cancelReader: () => Promise<void> = async () => {
      await reader.cancel().catch(() => undefined);
    },
  ) => {
    if (finalized) {
      return;
    }
    finalized = true;
    detachAbort();
    guardedBodyCleanupRegistry.unregister(cleanupRegistrationToken);
    // Start cancellation before cleanup so its reason reaches the reader, but
    // let request cleanup abort a retained capture tee before awaiting settlement.
    const [cancellation, readerRelease, cleanup] = await Promise.allSettled([
      cancelReader(),
      (async () => reader.releaseLock())(),
      (async () => await params.cleanup())(),
    ]);
    if (cleanup.status === "rejected" && errorSource === "release") {
      throw cleanup.reason;
    }
    if (readerRelease.status === "rejected") {
      throw readerRelease.reason;
    }
    if (cancellation.status === "rejected" && errorSource === "cancellation") {
      throw cancellation.reason;
    }
  };
  const cancel = async (reason: unknown) => await finalize(async () => await reader.cancel(reason));
  const wrappedBody = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const signal = params.signal;
        if (signal && !abortAttached) {
          abortAttached = true;
          detachAbort = attachBodyAbort(signal, new WeakRef(controller), cancel);
        }
        if (finalized) {
          return;
        }
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
            await finalize();
            return;
          }
          params.refreshTimeout?.();
          controller.enqueue(chunk.value);
        } catch (error) {
          if (finalized) {
            return;
          }
          // The SDK response contract exposes release failures; guarded streams
          // report the source failure immediately and release resources best-effort.
          if (errorSource === "release") {
            await finalize();
          }
          controller.error(error);
          await finalize();
        }
      },
      cancel,
    },
    params.signal ? { highWaterMark: 0 } : undefined,
  );
  guardedBodyCleanupRegistry.register(wrappedBody, { finalize }, cleanupRegistrationToken);
  return wrappedBody;
}

/** Wraps a guarded body with best-effort cleanup and explicit cancellation errors. */
export function wrapGuardedBodyStream(params: BodyStreamOptions): ReadableStream<Uint8Array> {
  return wrapBodyStream(params, "cancellation");
}

/** Preserves post-header request cancellation around runtime fetch body streams. */
export function responseWithAbortSignal(response: Response, signal?: AbortSignal): Response {
  if (!response.body || !signal) {
    return response;
  }
  const wrapped = new Response(
    wrapBodyStream({ body: response.body, cleanup: () => {}, signal }, "cancellation"),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
  const applyMetadata = (target: Response): Response => {
    Object.defineProperties(target, {
      headers: { value: response.headers },
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type },
      clone: {
        configurable: true,
        value: (): Response => applyMetadata(Response.prototype.clone.call(target)),
        writable: true,
      },
    });
    return target;
  };
  return applyMetadata(wrapped);
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** Keeps request ownership through body completion, failure, or cancellation. */
export function responseWithRelease(response: Response, release: () => Promise<void>): Response {
  if (!response.body || NULL_BODY_STATUSES.has(response.status)) {
    void (async () => await release())();
    return response;
  }
  return new Response(wrapBodyStream({ body: response.body, cleanup: release }, "release"), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
