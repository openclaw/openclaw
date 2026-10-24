import { describe, expect, it, vi } from "vitest";
import { waitForScheduledTaskRunningEvidence } from "./schtasks-runtime.js";

// The evidence wait spawns real schtasks queries; only Windows can run them.
const itWindows = process.platform === "win32" ? it : it.skip;

describe("scheduled task fallback evidence clock domain", () => {
  itWindows(
    "ends the evidence wait at its monotonic deadline when the wall clock rewinds",
    { timeout: 30_000 },
    async () => {
      // Everything runs on real time: the real Task Scheduler queries via
      // schtasks.exe, the 250ms polls, and the 15s fallback budget. Only the
      // wall clock reading is rewound mid-wait, like an NTP correction.
      const startedAt = Date.now();
      const wallClock = vi.spyOn(Date, "now");
      // A task name that never reports RUNNING keeps the real probe loop
      // waiting for the whole budget; no task state is created or mutated.
      const env = { OPENCLAW_WINDOWS_TASK_NAME: "OpenClawMonotonicProofNeverRunning" } as never;
      setTimeout(() => {
        wallClock.mockReturnValue(startedAt - 10 * 60_000);
      }, 1_000);
      const t0 = performance.now();
      const evidence = await waitForScheduledTaskRunningEvidence(env);
      const elapsedMs = performance.now() - t0;
      wallClock.mockRestore();
      expect(evidence).toBe(false);
      expect(elapsedMs).toBeGreaterThan(13_000);
      expect(elapsedMs).toBeLessThan(19_000);
    },
  );
});
