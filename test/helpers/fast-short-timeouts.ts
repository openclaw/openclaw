import { vi } from "vitest";

export function useFastShortTimeouts(maxDelayMs = 2000): () => void {
  const realSetTimeout = setTimeout;
  const spy = vi.spyOn(global, "setTimeout").mockImplementation(((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => {
    const delay = typeof timeout === "number" ? timeout : 0;
    if (delay > 0 && delay <= maxDelayMs) {
      return realSetTimeout(handler, 0, ...args);
    }
    return realSetTimeout(handler, delay, ...args);
  }) as typeof setTimeout);
  return () => spy.mockRestore();
}
