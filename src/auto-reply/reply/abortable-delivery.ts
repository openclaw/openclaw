export async function runAbortableDelivery<T>(params: {
  shouldAbort: () => boolean;
  outerSignal?: AbortSignal;
  run: (abortSignal: AbortSignal) => Promise<T>;
  pollMs?: number;
}): Promise<{ completed: true; result: T } | { completed: false }> {
  if (params.shouldAbort()) {
    return { completed: false };
  }

  const pollMs = Math.max(10, params.pollMs ?? 25);
  const abortController = new AbortController();
  const abortSignals = [abortController.signal, params.outerSignal].filter(
    (signal): signal is AbortSignal => Boolean(signal),
  );
  const abortSignal = abortSignals.length === 1 ? abortSignals[0] : AbortSignal.any(abortSignals);

  let timer: NodeJS.Timeout | undefined;
  let disposed = false;
  const scheduleAbortCheck = () => {
    if (disposed) {
      return;
    }
    timer = setTimeout(() => {
      if (disposed) {
        return;
      }
      if (abortController.signal.aborted) {
        return;
      }
      if (params.shouldAbort()) {
        abortController.abort();
        return;
      }
      scheduleAbortCheck();
    }, pollMs);
  };

  scheduleAbortCheck();

  try {
    const result = await params.run(abortSignal);
    if (params.shouldAbort()) {
      abortController.abort();
      return { completed: false };
    }
    return { completed: true, result };
  } catch (error) {
    if (abortSignal.aborted && params.shouldAbort()) {
      return { completed: false };
    }
    throw error;
  } finally {
    disposed = true;
    if (timer) {
      clearTimeout(timer);
    }
  }
}
