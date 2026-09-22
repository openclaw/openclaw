import { setImmediate } from "node:timers";
import { expect, vi } from "vitest";
import { z } from "zod";
import * as commands from "../process/exec.js";

export function observeUpdateCandidateIoProgress() {
  let observedBytes = -1;
  const run = commands.runUtf8CommandWithTimeout;
  vi.spyOn(commands, "runUtf8CommandWithTimeout").mockImplementation(async (...args) => {
    const result = await run(...args);
    if (result.code === 0) {
      const measurement = z.object({ bytes: z.number() }).parse(JSON.parse(result.stdout));
      // Publish after the watchdog consumes the real probe result and renews its deadline.
      setImmediate(() => {
        observedBytes = Math.max(observedBytes, measurement.bytes);
      });
    }
    return result;
  });
  return async (expectedBytes: number) => {
    await vi.waitFor(() => expect(observedBytes).toBeGreaterThanOrEqual(expectedBytes), {
      timeout: 5_000,
      interval: 10,
    });
  };
}
