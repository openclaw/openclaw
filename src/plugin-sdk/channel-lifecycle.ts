type CloseAwareServer = {
  once: (event: "close", listener: () => void) => unknown;
};

/**
 * Return a promise that resolves when the signal is aborted.
 *
 * If no signal is provided, the promise stays pending forever.
 */
export function waitUntilAbort(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Keep a channel/provider task pending until the HTTP server closes.
 *
 * When an abort signal is provided, `onAbort` is invoked once and should
 * trigger server shutdown. The returned promise resolves only after `close`.
 */
export async function keepHttpServerTaskAlive(params: {
  server: CloseAwareServer;
  abortSignal?: AbortSignal;
  onAbort?: () => void | Promise<void>;
}): Promise<void> {
  const { server, abortSignal, onAbort } = params;
  let abortTask: Promise<void> = Promise.resolve();
  let abortTriggered = false;

  const triggerAbort = () => {
    if (abortTriggered) {
      return;
    }
    abortTriggered = true;
    abortTask = Promise.resolve(onAbort?.()).then(() => undefined);
  };

  const onAbortSignal = () => {
    triggerAbort();
  };

  if (abortSignal) {
    if (abortSignal.aborted) {
      triggerAbort();
    } else {
      abortSignal.addEventListener("abort", onAbortSignal, { once: true });
    }
  }

  await new Promise<void>((resolve) => {
    server.once("close", () => resolve());
  });

  if (abortSignal) {
    abortSignal.removeEventListener("abort", onAbortSignal);
  }
  await abortTask;
}
