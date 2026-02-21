export function waitForever() {
  // Keep event loop alive via an unref'ed interval plus a pending promise.
  const interval = setInterval(() => {}, 1_000_000);
  interval.unref();
  return new Promise<void>(() => {
    /* never resolve */
  });
}
