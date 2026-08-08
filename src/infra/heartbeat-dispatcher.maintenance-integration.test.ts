// End-to-end coverage for the maintenance window at the heartbeat
// dispatcher layer.
//
// `shouldDeferWake` is the single decision point for every wake source
// (scheduler tick, manual, exec event, cron, etc). The maintenance-window
// guard sits above the flood guard but below the manual intent exemption.
//
// This file exercises the full contract:
//   1. Non-allowed agent + non-manual intent => defer with reason
//      "maintenance-window" and retryAtMs = nextAllowedAtMs.
//   2. Allowed agent + any intent => never defer on maintenance grounds.
//   3. Manual intent pierces the window even when the agent is non-allowed
//      (this is the operator escape hatch).
//   4. Maintenance guard runs *before* the flood guard so a non-allowed
//      agent's repeated attempts don't trip the flood-warning log path.
//   5. retryAtMs falls back to now+60s when nextAllowedAtMs is undefined
//      (defensive guard).
import { describe, expect, it } from "vitest";
import { shouldDeferWake, type MaintenanceWindowContext } from "./heartbeat-cooldown.js";

const NOW = Date.UTC(2026, 0, 15, 3, 30, 0); // 03:30 UTC, inside a 02:00-04:00 window
const NEXT_ALLOWED = Date.UTC(2026, 0, 15, 4, 0, 0); // window exit

const blocked: MaintenanceWindowContext = {
  isAllowed: false,
  nextAllowedAtMs: NEXT_ALLOWED,
  windowEndsAtMs: NEXT_ALLOWED,
};

const allowed: MaintenanceWindowContext = {
  isAllowed: true,
  nextAllowedAtMs: NEXT_ALLOWED,
  windowEndsAtMs: NEXT_ALLOWED,
};

const baseInput = {
  reason: "test",
  now: NOW,
  nextDueMs: NOW - 1_000, // would normally be due
};

describe("shouldDeferWake + maintenance window", () => {
  it("defer a non-allowed agent on a scheduled wake with reason=maintenance-window", () => {
    const d = shouldDeferWake({
      ...baseInput,
      intent: "scheduled",
      maintenanceWindow: blocked,
    });
    expect(d.defer).toBe(true);
    if (d.defer) {
      expect(d.reason).toBe("maintenance-window");
      expect(d.retryAtMs).toBe(NEXT_ALLOWED);
    }
  });

  it("defer a non-allowed agent on an event wake (cron handoff, exec event, etc)", () => {
    const d = shouldDeferWake({
      ...baseInput,
      intent: "event",
      maintenanceWindow: blocked,
    });
    expect(d.defer).toBe(true);
    if (d.defer) {
      expect(d.reason).toBe("maintenance-window");
    }
  });

  it("defer a non-allowed agent on a task-completion follow-up wake", () => {
    const d = shouldDeferWake({
      ...baseInput,
      intent: "task",
      maintenanceWindow: blocked,
    });
    expect(d.defer).toBe(true);
    if (d.defer) {
      expect(d.reason).toBe("maintenance-window");
    }
  });

  it("defer a non-allowed agent on an immediate wake (e.g. cron --wake now)", () => {
    const d = shouldDeferWake({
      ...baseInput,
      intent: "immediate",
      maintenanceWindow: blocked,
    });
    expect(d.defer).toBe(true);
    if (d.defer) {
      expect(d.reason).toBe("maintenance-window");
    }
  });

  it("allow a manual wake to pierce the maintenance window (operator escape hatch)", () => {
    const d = shouldDeferWake({
      ...baseInput,
      intent: "manual",
      maintenanceWindow: blocked,
    });
    expect(d.defer).toBe(false);
  });

  it("never defer on maintenance grounds when the agent is allowed", () => {
    const d = shouldDeferWake({
      ...baseInput,
      intent: "event",
      maintenanceWindow: allowed,
    });
    expect(d.defer).toBe(false);
  });

  it("maintenance guard runs before the flood guard (no flood-warning log when window is active)", () => {
    // Without the maintenance guard taking priority, the flood guard would
    // trip on these recent run starts and the dispatcher would log a warning.
    // The maintenance guard suppresses the deferral reason to
    // "maintenance-window" so the operator sees a single stable signal.
    const recent = [NOW - 1_000, NOW - 2_000, NOW - 3_000, NOW - 4_000, NOW - 5_000, NOW - 6_000];
    const d = shouldDeferWake({
      ...baseInput,
      intent: "event",
      maintenanceWindow: blocked,
      recentRunStarts: recent,
    });
    expect(d.defer).toBe(true);
    if (d.defer) {
      expect(d.reason).toBe("maintenance-window");
    }
  });

  it("falls back to now+60s when nextAllowedAtMs is undefined", () => {
    const d = shouldDeferWake({
      ...baseInput,
      intent: "scheduled",
      maintenanceWindow: { isAllowed: false },
    });
    expect(d.defer).toBe(true);
    if (d.defer) {
      expect(d.reason).toBe("maintenance-window");
      expect(d.retryAtMs).toBe(NOW + 60_000);
    }
  });

  it("respects cron service's allowManualRun=mode:force semantic by also piercing manual", () => {
    // Even with a very small retryAtMs, manual must be exempt. This is the
    // property that the upstream cron service relies on when an operator
    // runs `cron run --mode force` for a non-roster agent.
    const d = shouldDeferWake({
      ...baseInput,
      intent: "manual",
      maintenanceWindow: { isAllowed: false, nextAllowedAtMs: NOW + 30 * 60_000 },
    });
    expect(d.defer).toBe(false);
  });

  it("when maintenanceWindow is not provided, falls through to the regular defer matrix", () => {
    // Without a maintenance context, a not-due scheduled wake is deferred
    // for the normal `not-due` reason. This is the regression-guard for the
    // scenario where the dispatcher is wired up but the maintenance field
    // is not threaded through.
    const d = shouldDeferWake({
      ...baseInput,
      intent: "scheduled",
      nextDueMs: NOW + 60_000, // not due yet
    });
    expect(d.defer).toBe(true);
    if (d.defer) {
      expect(d.reason).toBe("not-due");
    }
  });

  it("maintenance-window defer is distinct from not-due: different retryAtMs and reason", () => {
    const due = NOW - 1_000;
    const dueNotAllowed = shouldDeferWake({
      ...baseInput,
      intent: "scheduled",
      nextDueMs: due,
      maintenanceWindow: blocked,
    });
    const notDue = shouldDeferWake({
      ...baseInput,
      intent: "scheduled",
      nextDueMs: NOW + 60_000, // not yet due
    });
    if (dueNotAllowed.defer && notDue.defer) {
      expect(dueNotAllowed.reason).toBe("maintenance-window");
      expect(notDue.reason).toBe("not-due");
      expect(dueNotAllowed.retryAtMs).toBe(NEXT_ALLOWED);
      expect(notDue.retryAtMs).toBe(NOW + 60_000);
    } else {
      throw new Error("expected both to defer");
    }
  });
});
