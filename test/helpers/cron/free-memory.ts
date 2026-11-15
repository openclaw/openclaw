// Free-memory readings for cron tests: automation admission sizes run slots from them.
import os from "node:os";
import { vi } from "vitest";

/** Stands in for the host's free memory, with no container limit; run slots read both. */
export function stubFreeMemory(bytes: number) {
  vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
  vi.spyOn(process, "availableMemory").mockReturnValue(bytes);
  vi.spyOn(os, "freemem").mockReturnValue(bytes);
}
