/**
 * Replaces global setTimeout with a near-instant version so that tests
 * involving polling / retry / exponential-backoff run quickly.
 *
 * Returns a restore function that puts the original timers back.
 */
export function useFastShortTimeouts(): () => void {
  const origSetTimeout = globalThis.setTimeout;

  // Replace setTimeout with a version that clamps the delay to 0-1 ms
  // so any "wait 500 ms then retry" paths resolve almost immediately.
  (globalThis as unknown as Record<string, unknown>).setTimeout = ((
    fn: (...args: unknown[]) => void,
    _ms?: number,
    ...args: unknown[]
  ) => {
    return origSetTimeout(fn, 0, ...args);
  }) as typeof globalThis.setTimeout;

  // Preserve toString / name so code that inspects the function still works
  Object.defineProperty(globalThis.setTimeout, "name", { value: "setTimeout" });

  return () => {
    globalThis.setTimeout = origSetTimeout;
  };
}
