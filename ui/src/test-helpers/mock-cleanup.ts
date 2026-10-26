import { vi } from "vitest";

export function restoreMocksAndGlobals(): void {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}
