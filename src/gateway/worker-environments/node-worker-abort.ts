export function raceNodeWorkerOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  messages: { aborted: string; failed?: string } = {
    aborted: "node worker operation aborted",
    failed: "node worker operation failed",
  },
): Promise<T> {
  const abortError = () =>
    signal.reason instanceof Error ? signal.reason : new Error(messages.aborted);
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(messages.failed ?? String(error)));
      },
    );
  });
}
