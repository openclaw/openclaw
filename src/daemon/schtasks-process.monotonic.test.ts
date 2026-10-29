import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForProcessExitForTest } from "./schtasks-process.js";

// The exit-wait budget is consumed by real process probes (tasklist on
// Windows) and sleep polls on the monotonic clock; the deadline must live
// there too, or a wall-clock step keeps probing past the configured bound.
describe("scheduled task process exit wait clock domain", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "ends the exit wait at its monotonic deadline when the wall clock rewinds",
    { timeout: 20_000 },
    async () => {
      // Spawn a real child that stays alive for the whole test.
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
        stdio: "ignore",
      });
      await once(child, "spawn");
      const startedAt = Date.now();
      const wallClock = vi.spyOn(Date, "now").mockReturnValue(startedAt - 10 * 60_000);
      const t0 = performance.now();
      const exited = await waitForProcessExitForTest(child.pid!, 1_500);
      const elapsedMs = performance.now() - t0;
      wallClock.mockRestore();
      child.kill();
      await once(child, "exit").catch(() => undefined);
      // The child stayed alive, so the wait must report false after the
      // monotonic budget, not hang on the rewound wall clock.
      expect(exited).toBe(false);
      expect(elapsedMs).toBeGreaterThan(1_400);
      expect(elapsedMs).toBeLessThan(4_000);
    },
  );
});
