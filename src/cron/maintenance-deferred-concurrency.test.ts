// Concurrency coverage for the deferred queue.
//
// The deferred queue is a process-global (module-level) state. The cron
// service is a single instance per gateway, so true cross-process
// concurrency is not a concern. But within a single process, multiple
// async paths can call recordMaintenanceDeferral in the same tick (e.g.
// a scheduler tick that runs in parallel with a manual-run preflight).
// These tests exercise that intra-process concurrency contract:
//
//   1. Parallel recordMaintenanceDeferral for distinct jobs => all entries
//      land; order is preserved (FIFO).
//   2. Parallel recordMaintenanceDeferral for the same job => the entry is
//      deduped; firstDeferredAtMs and lastDeferredAtMs reflect the
//      first/last write respectively.
//   3. Parallel record + shift => the FIFO invariant holds under
//      concurrent shifters.
//   4. Parallel record + clear => the queue ends up empty; no leaks.
//   5. waitForMaintenanceDeferralsToDrain resolves with drained=true
//      when the last concurrent recorder finishes.
//
// We use p-limit (already in the project) to cap parallelism so the test
// stays fast and deterministic.
import pLimit from "p-limit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beginMaintenancePhase,
  clearMaintenanceDeferrals,
  getMaintenanceDeferralCount,
  listMaintenanceDeferrals,
  recordMaintenanceDeferral,
  resetMaintenanceDeferrals,
  shiftMaintenanceDeferral,
  waitForMaintenanceDeferralsToDrain,
} from "./maintenance-deferred.js";

const AT_BASE = Date.UTC(2026, 0, 15, 3, 0, 0);

beforeEach(() => {
  resetMaintenanceDeferrals();
});
afterEach(() => {
  resetMaintenanceDeferrals();
});

describe("deferred queue intra-process concurrency", () => {
  it("parallel record for distinct jobs preserves FIFO order and counts", async () => {
    beginMaintenancePhase(AT_BASE);
    const limit = pLimit(8);
    const promises: Array<Promise<void>> = [];
    for (let i = 0; i < 50; i++) {
      const jobId = `job-${String(i).padStart(2, "0")}`;
      const nowMs = AT_BASE + i * 10;
      promises.push(limit(() => recordMaintenanceDeferral({ jobId, agentId: "main", nowMs })));
    }
    await Promise.all(promises);
    expect(getMaintenanceDeferralCount()).toBe(50);
    const entries = listMaintenanceDeferrals();
    expect(entries[0]?.jobId).toBe("job-00");
    expect(entries[49]?.jobId).toBe("job-49");
  });

  it("parallel record for the same job dedupes; first/last timestamps reflect the writes", async () => {
    beginMaintenancePhase(AT_BASE);
    const limit = pLimit(8);
    const promises: Array<Promise<void>> = [];
    for (let i = 0; i < 30; i++) {
      const nowMs = AT_BASE + i * 5;
      promises.push(
        limit(() => recordMaintenanceDeferral({ jobId: "job-A", agentId: "main", nowMs })),
      );
    }
    await Promise.all(promises);
    expect(getMaintenanceDeferralCount()).toBe(1);
    const entry = listMaintenanceDeferrals()[0];
    expect(entry?.firstDeferredAtMs).toBe(AT_BASE);
    expect(entry?.lastDeferredAtMs).toBe(AT_BASE + 29 * 5);
  });

  it("parallel record + FIFO shift yields each entry exactly once", async () => {
    beginMaintenancePhase(AT_BASE);
    const recordLimit = pLimit(8);
    const N = 30;
    // First record all entries; then shift them. Simpler than racing
    // shifters with recorders and still exercises the FIFO contract.
    const tasks: Array<Promise<void>> = [];
    for (let i = 0; i < N; i++) {
      const jobId = `job-${String(i).padStart(2, "0")}`;
      const nowMs = AT_BASE + i;
      tasks.push(recordLimit(() => recordMaintenanceDeferral({ jobId, agentId: "main", nowMs })));
    }
    await Promise.all(tasks);
    expect(getMaintenanceDeferralCount()).toBe(N);
    // Shift in parallel; with FIFO order, the popped sequence is
    // monotonic by jobId across all shifters.
    const shiftLimit = pLimit(4);
    const shifted: string[] = [];
    await Promise.all(
      Array.from({ length: 4 }, () =>
        shiftLimit(() => {
          while (true) {
            const entry = shiftMaintenanceDeferral();
            if (!entry) {
              return;
            }
            shifted.push(entry.jobId);
          }
        }),
      ),
    );
    expect(shifted).toHaveLength(N);
    const sorted = [...shifted].toSorted();
    expect(shifted).toEqual(sorted);
  });

  it("parallel record + clear leaves the queue empty", async () => {
    beginMaintenancePhase(AT_BASE);
    const limit = pLimit(8);
    const tasks: Array<Promise<void>> = [];
    for (let i = 0; i < 20; i++) {
      const jobId = `job-${String(i).padStart(2, "0")}`;
      tasks.push(
        limit(() => recordMaintenanceDeferral({ jobId, agentId: "main", nowMs: AT_BASE + i })),
      );
    }
    tasks.push(limit(() => clearMaintenanceDeferrals()));
    await Promise.all(tasks);
    expect(getMaintenanceDeferralCount()).toBe(0);
  });

  it("waitForMaintenanceDeferralsToDrain resolves with drained=true when the queue empties", async () => {
    beginMaintenancePhase(AT_BASE);
    // Record synchronously, then drain asynchronously while the waiter is
    // already parked. The waiter must observe the drain via the emptyWaiters
    // notification, not just the fast path.
    for (let i = 0; i < 15; i++) {
      recordMaintenanceDeferral({
        jobId: `job-${String(i).padStart(2, "0")}`,
        agentId: "main",
        nowMs: AT_BASE + i,
      });
    }
    const drainPromise = waitForMaintenanceDeferralsToDrain(1_000);
    // Concurrent path simulating the scheduler's phase-exit drainer.
    setTimeout(() => clearMaintenanceDeferrals(), 10);
    const result = await drainPromise;
    expect(result.drained).toBe(true);
    expect(result.pending).toBe(0);
  });

  it("waitForMaintenanceDeferralsToDrain resolves with drained=false when the timeout elapses", async () => {
    beginMaintenancePhase(AT_BASE);
    recordMaintenanceDeferral({ jobId: "stuck-job", agentId: "main", nowMs: AT_BASE });
    // Queue is not drained within the timeout; the waiter should surface
    // the truth (drained=false, pending=1) rather than hang.
    const result = await waitForMaintenanceDeferralsToDrain(20);
    expect(result.drained).toBe(false);
    expect(result.pending).toBe(1);
  });
});
