export function rejectOnNextAbort(signal: AbortSignal, fallbackMessage: string): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(signal.reason instanceof Error ? signal.reason : new Error(fallbackMessage)),
      { once: true },
    );
  });
}
