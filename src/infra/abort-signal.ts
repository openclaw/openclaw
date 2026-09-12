export function createAbortError(message: string, options?: ErrorOptions): Error {
  const error = new Error(message, options);
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = "name" in error ? String(error.name) : "";
  if (name === "AbortError") {
    return true;
  }
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return message === "This operation was aborted";
}

export function racePromiseWithAbortSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) {
    return promise;
  }
  const abortError = () => createAbortError("Operation aborted", { cause: signal.reason });
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
  return Promise.race([promise, aborted]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}

/** Resolves when the signal aborts, or immediately when no wait is needed. */
export async function waitForAbortSignal(signal?: AbortSignal): Promise<void> {
  if (!signal || signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
