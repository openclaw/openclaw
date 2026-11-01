import { listen } from "./reactive/listener.ts";

/** Subscriber identity and producer cancellation remain owned by the caller. */
export async function subscribeToSharedRequest<T, Subscriber extends object>(
  pending: {
    controller?: AbortController;
    promise: Promise<T>;
    subscribers: Set<Subscriber>;
  },
  subscriber: Subscriber,
  signal?: AbortSignal,
  onRelease?: () => void,
): Promise<T> {
  pending.subscribers.add(subscriber);
  let stopAbort: (() => void) | undefined;
  try {
    if (!signal) {
      return await pending.promise;
    }
    const { promise: aborted, reject: rejectAbort } = Promise.withResolvers<never>();
    const onAbort = () => {
      pending.subscribers.delete(subscriber);
      if (pending.subscribers.size === 0) {
        pending.controller?.abort(signal.reason);
      }
      rejectAbort(signal.reason);
    };
    stopAbort = listen(signal, "abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    return await Promise.race([pending.promise, aborted]);
  } finally {
    stopAbort?.();
    pending.subscribers.delete(subscriber);
    onRelease?.();
  }
}
