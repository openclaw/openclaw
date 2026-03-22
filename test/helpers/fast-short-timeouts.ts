import { setTimeout as nativeSetTimeout } from "node:timers";
import { vi } from "vitest";

export function useFastShortTimeouts(maxDelayMs = 2000): () => void {
  const spy = vi.spyOn(global, "setTimeout").mockImplementation(((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => {
    const delay = typeof timeout === "number" ? timeout : 0;
    if (delay > 0 && delay <= maxDelayMs) {
      return nativeSetTimeout(handler, 0, ...args);
    }
    return nativeSetTimeout(handler, delay, ...args);
  }) as typeof setTimeout);
  return () => spy.mockRestore();
}
