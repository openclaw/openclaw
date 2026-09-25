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

type BodyAbortOwner = { abort: () => void };

// A live body owns its abort callback. The signal listener keeps only a weak
// reference so a partially read, abandoned body can still reach finalization.
const guardedBodyAbortOwners = new WeakMap<ReadableStream<Uint8Array>, BodyAbortOwner>();

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
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let finalized = false;
  let abortAttached = false;
  let detachAbort = () => {};
  const cleanupRegistrationToken = {};
  const finalize = async (
    cancelReader: () => Promise<void> = async () => {
      await reader?.cancel().catch(() => undefined);
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
      (async () => reader?.releaseLock())(),
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
  const wrappedBody = new ReadableStream<Uint8Array>(
    {
      start() {
        reader = params.body.getReader();
      },
      async pull(controller) {
        const signal = params.signal;
        if (signal && !abortAttached) {
          abortAttached = true;
          const owner: BodyAbortOwner = {
            abort: () => {
              if (finalized) {
                return;
              }
              const reason =
                signal.reason ?? new DOMException("This operation was aborted", "AbortError");
              const cleanup = finalize(async () => await reader?.cancel(reason));
              controller.error(reason);
              void cleanup.catch(() => undefined);
            },
          };
          guardedBodyAbortOwners.set(wrappedBody, owner);
          const ownerRef = new WeakRef(owner);
          const abort = () => ownerRef.deref()?.abort();
          if (signal.aborted) {
            abort();
          } else {
            signal.addEventListener("abort", abort, { once: true });
            detachAbort = () => signal.removeEventListener("abort", abort);
          }
        }
        if (finalized) {
          return;
        }
        try {
          const chunk = await reader?.read();
          if (!chunk || chunk.done) {
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
      async cancel(reason) {
        await finalize(async () => await reader?.cancel(reason));
      },
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
