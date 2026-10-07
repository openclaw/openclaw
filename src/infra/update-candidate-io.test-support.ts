import { setImmediate } from "node:timers";
import { expect, vi } from "vitest";
import { z } from "zod";
import * as commands from "../process/exec.js";

export function observeUpdateCandidateIoProgress() {
  let started = 0;
  let observed = { id: 0, bytes: -1 };
  const run = commands.runUtf8CommandWithTimeout;
  vi.spyOn(commands, "runUtf8CommandWithTimeout").mockImplementation(async (...args) => {
    const [argv, options] = args;
    if (
      !argv.includes("--eval") ||
      typeof options === "number" ||
      typeof options.input !== "string" ||
      !z.object({ directory: z.string() }).safeParse(JSON.parse(options.input)).success
    ) {
      return run(...args);
    }
    const id = ++started;
    const result = await run(...args);
    if (result.code === 0) {
      const measurement = z.object({ bytes: z.number() }).parse(JSON.parse(result.stdout));
      // Publish after the watchdog consumes the real probe result and renews its deadline.
      setImmediate(() => {
        if (id > observed.id) {
          observed = { id, bytes: measurement.bytes };
        }
      });
    }
    return result;
  });
  return async (expectedBytes: number) => {
    // Older lock metadata can already exceed a small payload's byte threshold.
    const next = started + 1;
    await vi.waitFor(
      () => {
        expect(observed.id).toBeGreaterThanOrEqual(next);
        expect(observed.bytes).toBeGreaterThanOrEqual(expectedBytes);
      },
      { timeout: 5_000, interval: 10 },
    );
  };
}
