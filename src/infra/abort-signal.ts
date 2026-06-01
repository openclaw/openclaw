/** Resolve once the signal aborts, or immediately when no live signal exists. */
export async function waitForAbortSignal(signal?: AbortSignal): Promise<void> {
  if (!signal || signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    // Use a one-shot listener but still remove it in the callback for custom signal shims.
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
