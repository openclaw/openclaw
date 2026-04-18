import { vi } from "vitest";

export function useFrozenTime(at: string | number | Date): void {
  vi.useFakeTimers();
  vi.setSystemTime(at);
}

export function useRealTime(): void {
  vi.useRealTimers();
}
