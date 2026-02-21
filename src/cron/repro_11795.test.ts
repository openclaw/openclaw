import { describe, expect, it } from "vitest";
import { createJob, nextWakeAtMs } from "./service/jobs.js";
import { update } from "./service/ops.js";
import { createCronServiceState, type CronServiceDeps } from "./service/state.js";

describe("reproduction of bug 11795", () => {
  it("registers nextWakeAtMs for 'at' schedule type during update via ops", async () => {
    const now = 1738987700000;
    const at = "2026-02-08T09:28:00Z";
    
    const deps: CronServiceDeps = {
      nowMs: () => now,
      log: { 
        info: () => {}, 
        warn: () => {}, 
        error: () => {}, 
        debug: () => {} 
      },
      cronEnabled: true,
      storePath: "/tmp/cron.json",
      enqueueSystemEvent: () => {},
      requestHeartbeatNow: () => {},
      runIsolatedAgentJob: async () => ({ status: "ok" }),
    };

    const state = createCronServiceState(deps);
    state.store = {
      jobs: [],
    };

    // 1. Create with recurring cron
    const job = createJob(state, {
      name: "test-update",
      schedule: { kind: "cron", expr: "0 5 * * *" },
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "hello" },
    });
    state.store!.jobs.push(job);

    // 2. Update to 'at' schedule via ops (in the past)
    const pastAt = new Date(now - 60000).toISOString();
    await update(state, job.id, {
      schedule: { kind: "at", at: pastAt },
    });

    const wakeAt = nextWakeAtMs(state);
    expect(wakeAt).toBeUndefined(); // Should be undefined because it's in the past and due immediately

    // 3. Update to 'at' schedule (in the future)
    const futureAt = new Date(now + 60000).toISOString();
    const futureAtMs = Date.parse(futureAt);
    await update(state, job.id, {
      schedule: { kind: "at", at: futureAt },
    });

    const wakeAtFuture = nextWakeAtMs(state);
    expect(wakeAtFuture).toBe(futureAtMs);
  });
});
