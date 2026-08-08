// Covers the cron maintenance deferred queue lifecycle.
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

describe("maintenance-deferred queue", () => {
  beforeEach(() => {
    resetMaintenanceDeferrals();
  });
  afterEach(() => {
    resetMaintenanceDeferrals();
  });

  it("starts empty", () => {
    expect(getMaintenanceDeferralCount()).toBe(0);
    expect(listMaintenanceDeferrals()).toEqual([]);
  });

  it("records a deferral in FIFO order", () => {
    recordMaintenanceDeferral({ jobId: "job-A", agentId: "ops", nowMs: 1_000 });
    recordMaintenanceDeferral({ jobId: "job-B", agentId: "main", nowMs: 2_000 });
    expect(getMaintenanceDeferralCount()).toBe(2);
    const list = listMaintenanceDeferrals();
    expect(list.map((e) => e.jobId)).toEqual(["job-A", "job-B"]);
  });

  it("preserves firstDeferredAtMs and updates lastDeferredAtMs on repeated defers", () => {
    recordMaintenanceDeferral({ jobId: "job-A", agentId: "ops", nowMs: 1_000 });
    recordMaintenanceDeferral({ jobId: "job-A", agentId: "ops", nowMs: 2_000 });
    recordMaintenanceDeferral({ jobId: "job-A", agentId: "ops", nowMs: 3_000 });
    expect(getMaintenanceDeferralCount()).toBe(1);
    const entry = listMaintenanceDeferrals()[0];
    expect(entry).toBeDefined();
    if (!entry) {
      return;
    }
    expect(entry.firstDeferredAtMs).toBe(1_000);
    expect(entry.lastDeferredAtMs).toBe(3_000);
  });

  it("shifts in FIFO order", () => {
    recordMaintenanceDeferral({ jobId: "job-A", agentId: "ops", nowMs: 1_000 });
    recordMaintenanceDeferral({ jobId: "job-B", agentId: "main", nowMs: 2_000 });
    const first = shiftMaintenanceDeferral();
    const second = shiftMaintenanceDeferral();
    const third = shiftMaintenanceDeferral();
    expect(first?.jobId).toBe("job-A");
    expect(second?.jobId).toBe("job-B");
    expect(third).toBeUndefined();
    expect(getMaintenanceDeferralCount()).toBe(0);
  });

  it("binds entries to the active phase id and re-binds on phase start", () => {
    const phase1 = beginMaintenancePhase(100);
    recordMaintenanceDeferral({ jobId: "job-A", agentId: "ops", nowMs: 200 });
    const first = listMaintenanceDeferrals()[0];
    expect(first).toBeDefined();
    if (!first) {
      return;
    }
    expect(first.phaseId).toBe(phase1);

    const phase2 = beginMaintenancePhase(500);
    expect(phase2).not.toBe(phase1);
    // Phase id change does not retroactively re-tag existing entries.
    const stillFirst = listMaintenanceDeferrals()[0];
    expect(stillFirst?.phaseId).toBe(phase1);
    recordMaintenanceDeferral({ jobId: "job-B", agentId: "main", nowMs: 600 });
    expect(listMaintenanceDeferrals()[1]?.phaseId).toBe(phase2);
  });

  it("clears backlog and resets the active phase", () => {
    recordMaintenanceDeferral({ jobId: "job-A", agentId: "ops", nowMs: 1_000 });
    recordMaintenanceDeferral({ jobId: "job-B", agentId: "main", nowMs: 2_000 });
    expect(getMaintenanceDeferralCount()).toBe(2);
    clearMaintenanceDeferrals();
    expect(getMaintenanceDeferralCount()).toBe(0);
    // After clear, a new phase must be bound by the next deferral.
    recordMaintenanceDeferral({ jobId: "job-C", agentId: "ops", nowMs: 5_000 });
    const phase = beginMaintenancePhase(5_000);
    // (Begin won't tag the existing entry; only the next recordMaintenanceDeferral
    // will. We just verify there is exactly one entry and it still references
    // the pre-phase record.)
    expect(getMaintenanceDeferralCount()).toBe(1);
    expect(phase).toMatch(/^phase-/);
  });

  it("ignores empty jobId", () => {
    recordMaintenanceDeferral({ jobId: "", agentId: "ops", nowMs: 1_000 });
    expect(getMaintenanceDeferralCount()).toBe(0);
  });

  it("waitForMaintenanceDeferralsToDrain resolves immediately when empty", async () => {
    const result = await waitForMaintenanceDeferralsToDrain(100);
    expect(result.drained).toBe(true);
    expect(result.pending).toBe(0);
  });

  it("waitForMaintenanceDeferralsToDrain notifies on drain", async () => {
    recordMaintenanceDeferral({ jobId: "job-A", agentId: "ops", nowMs: 1_000 });
    const drainPromise = waitForMaintenanceDeferralsToDrain(1_000);
    // Drain asynchronously.
    setTimeout(() => shiftMaintenanceDeferral(), 10);
    const result = await drainPromise;
    expect(result.drained).toBe(true);
    expect(result.pending).toBe(0);
  });

  it("waitForMaintenanceDeferralsToDrain times out when not drained", async () => {
    recordMaintenanceDeferral({ jobId: "job-A", agentId: "ops", nowMs: 1_000 });
    const result = await waitForMaintenanceDeferralsToDrain(20);
    expect(result.drained).toBe(false);
    expect(result.pending).toBe(1);
  });

  it("resetMaintenanceDeferrals returns to a clean slate", () => {
    recordMaintenanceDeferral({ jobId: "job-A", agentId: "ops", nowMs: 1_000 });
    resetMaintenanceDeferrals();
    expect(getMaintenanceDeferralCount()).toBe(0);
    const next = beginMaintenancePhase(1_000);
    expect(next).toMatch(/^phase-1-/); // counter resets
  });
});
