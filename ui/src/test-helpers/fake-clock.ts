import { onTestFinished, vi } from "vitest";

export function useFakeClock() {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
}
