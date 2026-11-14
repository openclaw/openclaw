/** Relay fs-safe's synchronous mutation guard to the host that owns live authority. */
export function createWorkerMutationAuthority(assertCurrent: () => void, signal?: AbortSignal) {
  const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  let failure: { error: unknown } | undefined;
  const refuse = () => {
    failure ??= { error: signal?.reason };
    Atomics.store(decision, 0, 2);
    Atomics.notify(decision, 0);
  };
  signal?.throwIfAborted();
  signal?.addEventListener("abort", refuse, { once: true });
  return {
    buffer: decision.buffer,
    onNotification: () => {
      try {
        if (failure) {
          throw failure.error;
        }
        signal?.throwIfAborted();
        assertCurrent();
        signal?.throwIfAborted();
        Atomics.compareExchange(decision, 0, 0, 1);
        return true;
      } catch (error) {
        failure ??= { error };
        Atomics.store(decision, 0, 2);
        return false;
      } finally {
        Atomics.notify(decision, 0);
      }
    },
    throwIfRefused: () => {
      if (failure) {
        throw failure.error;
      }
    },
    dispose: () => signal?.removeEventListener("abort", refuse),
  };
}

export function workerMutationAssertion(
  buffer: SharedArrayBuffer,
  notify: () => void,
  throwIfCancelled: () => void,
): () => void {
  const decision = new Int32Array(buffer);
  return () => {
    throwIfCancelled();
    Atomics.store(decision, 0, 0);
    notify();
    while (Atomics.load(decision, 0) === 0) {
      // Retirement can suppress notifications; observe its cancellation fence
      // even while fs-safe's synchronous mutation callback cannot yield.
      Atomics.wait(decision, 0, 0, 1_000);
      throwIfCancelled();
    }
    throwIfCancelled();
    if (Atomics.load(decision, 0) !== 1) {
      throw new Error("Worker mutation authority refused");
    }
  };
}
