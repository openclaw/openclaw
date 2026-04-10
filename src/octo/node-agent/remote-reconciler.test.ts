// Octopus Orchestrator — RemoteReconciler tests (M4-06)

import { describe, it, expect } from "vitest";
import { PendingLog, type PendingTransition } from "./pending-log.ts";
import { RemoteReconciler } from "./remote-reconciler.ts";
import type { ReplayTransport } from "./remote-reconciler.ts";
import type { ReconciliationReport } from "./session-reconciler.ts";

// ======================================================================
// Helpers
// ======================================================================

function makeTransition(overrides: Partial<PendingTransition> = {}): PendingTransition {
  return {
    id: overrides.id ?? "tx-1",
    arm_id: overrides.arm_id ?? "arm-a",
    event_type: overrides.event_type ?? "arm.state_changed",
    payload: overrides.payload ?? { state: "active" },
    ts: overrides.ts ?? 1000,
  };
}

function emptyReport(): ReconciliationReport {
  return {
    outcomes: [],
    recovered_count: 0,
    orphan_count: 0,
    missing_count: 0,
    other_anomaly_count: 0,
    total_live_sessions: 0,
    total_persisted_arms: 0,
  };
}

interface MockPendingLogOptions {
  entries?: PendingTransition[];
}

function makeMockPendingLog(opts: MockPendingLogOptions = {}): PendingLog {
  const entries = opts.entries ?? [];
  return {
    path: "/tmp/test-pending.jsonl",
    async append() {
      throw new Error("not implemented in mock");
    },
    async replay(handler: (t: PendingTransition) => void | Promise<void>): Promise<number> {
      for (const entry of entries) {
        await handler(entry);
      }
      return entries.length;
    },
    async ack(_transitionId: string) {},
    async clear() {},
  } as unknown as PendingLog;
}

function makeMockReconciler(report: ReconciliationReport = emptyReport()) {
  return {
    reconcile: async (): Promise<ReconciliationReport> => report,
  };
}

function makeMockTransport(
  behavior: "succeed" | "fail" | "fail-on-id" = "succeed",
  failId?: string,
): ReplayTransport & { calls: Array<{ method: string; data: unknown }> } {
  const calls: Array<{ method: string; data: unknown }> = [];
  return {
    calls,
    async send(method: string, data: unknown): Promise<unknown> {
      calls.push({ method, data });
      if (behavior === "fail") {
        throw new Error("transport unavailable");
      }
      if (behavior === "fail-on-id" && failId !== undefined) {
        const d = data as Record<string, unknown>;
        if (d["id"] === failId) {
          throw new Error(`send failed for ${failId}`);
        }
      }
      return { ok: true };
    },
  };
}

// ======================================================================
// Tests
// ======================================================================

describe("RemoteReconciler", () => {
  it("replays 3 pending entries and returns reconciliation report", async () => {
    const entries = [
      makeTransition({ id: "tx-1", arm_id: "arm-a" }),
      makeTransition({ id: "tx-2", arm_id: "arm-b" }),
      makeTransition({ id: "tx-3", arm_id: "arm-c" }),
    ];
    const report: ReconciliationReport = {
      ...emptyReport(),
      recovered_count: 1,
      total_live_sessions: 2,
      total_persisted_arms: 3,
    };
    const transport = makeMockTransport("succeed");
    const reconciler = new RemoteReconciler(
      makeMockPendingLog({ entries }),
      makeMockReconciler(report) as never,
      transport,
    );

    const result = await reconciler.reconcileOnReconnect();

    expect(result.replayed).toBe(3);
    expect(result.replayErrors).toHaveLength(0);
    expect(result.reconciled.recovered_count).toBe(1);
    expect(result.reconciled.total_live_sessions).toBe(2);
    expect(transport.calls).toHaveLength(3);
    expect(transport.calls[0]?.method).toBe("replay_transition");
  });

  it("returns 0 replayed for an empty pending log", async () => {
    const transport = makeMockTransport("succeed");
    const reconciler = new RemoteReconciler(
      makeMockPendingLog({ entries: [] }),
      makeMockReconciler() as never,
      transport,
    );

    const result = await reconciler.reconcileOnReconnect();

    expect(result.replayed).toBe(0);
    expect(result.replayErrors).toHaveLength(0);
    expect(result.reconciled.recovered_count).toBe(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("collects transport errors without aborting replay", async () => {
    const entries = [
      makeTransition({ id: "tx-1" }),
      makeTransition({ id: "tx-2" }),
      makeTransition({ id: "tx-3" }),
    ];
    const transport = makeMockTransport("fail");
    const reconciler = new RemoteReconciler(
      makeMockPendingLog({ entries }),
      makeMockReconciler() as never,
      transport,
    );

    const result = await reconciler.reconcileOnReconnect();

    expect(result.replayed).toBe(0);
    expect(result.replayErrors).toHaveLength(3);
    expect(result.replayErrors[0]?.transitionId).toBe("tx-1");
    expect(result.replayErrors[0]?.error).toBe("transport unavailable");
    // Reconciliation still runs despite replay failures
    expect(result.reconciled).toBeDefined();
  });

  it("handles partial transport failures (some succeed, some fail)", async () => {
    const entries = [
      makeTransition({ id: "tx-ok-1" }),
      makeTransition({ id: "tx-fail" }),
      makeTransition({ id: "tx-ok-2" }),
    ];
    const transport = makeMockTransport("fail-on-id", "tx-fail");
    const reconciler = new RemoteReconciler(
      makeMockPendingLog({ entries }),
      makeMockReconciler() as never,
      transport,
    );

    const result = await reconciler.reconcileOnReconnect();

    expect(result.replayed).toBe(2);
    expect(result.replayErrors).toHaveLength(1);
    expect(result.replayErrors[0]?.transitionId).toBe("tx-fail");
    expect(transport.calls).toHaveLength(3);
  });

  it("sends correct payload shape to transport", async () => {
    const entry = makeTransition({
      id: "tx-99",
      arm_id: "arm-z",
      event_type: "arm.failed",
      payload: { reason: "oom" },
      ts: 5555,
    });
    const transport = makeMockTransport("succeed");
    const reconciler = new RemoteReconciler(
      makeMockPendingLog({ entries: [entry] }),
      makeMockReconciler() as never,
      transport,
    );

    await reconciler.reconcileOnReconnect();

    const sent = transport.calls[0]?.data as Record<string, unknown>;
    expect(sent["id"]).toBe("tx-99");
    expect(sent["arm_id"]).toBe("arm-z");
    expect(sent["event_type"]).toBe("arm.failed");
    expect(sent["payload"]).toEqual({ reason: "oom" });
    expect(sent["ts"]).toBe(5555);
  });
});
