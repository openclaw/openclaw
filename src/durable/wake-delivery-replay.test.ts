import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDurableRuntimeSqliteStore } from "./sqlite-store.js";
import type { DurableRuntimeStore, DurableWakeDeliveryAttemptStatus } from "./types.js";
import { replayDurableWakeDeliveryAttempts } from "./wake-delivery-replay.js";
import { recordDurableWakeObligation } from "./wake-producers.js";

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-wake-delivery-"));
  const dbPath = path.join(dir, "openclaw.sqlite");
  const store = openDurableRuntimeSqliteStore({ path: dbPath });
  return {
    dbPath,
    store,
    cleanup: () => {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function createPendingWake(store: DurableRuntimeStore, suffix: string, now = 100) {
  return recordDurableWakeObligation({
    store,
    reason: "child_terminal",
    dedupeKey: `wake:test:delivery:${suffix}`,
    sourceRunId: `run_child_${suffix}`,
    factsRef: `facts:${suffix}`,
    facts: {
      sourceRunId: `run_child_${suffix}`,
      reportRoute: {
        kind: "channel_route",
        ref: `discord:thread:${suffix}`,
        ownerKind: "agent_session",
        ownerRef: `agent:session:${suffix}`,
        reportRouteRef: `discord:thread:${suffix}`,
      },
    },
    evidence: {
      kind: "test_delivery_obligation",
      suffix,
    },
    now,
  });
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") {
    return keys;
  }
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    collectKeys(child, keys);
  }
  return keys;
}

describe("durable wake delivery replay", () => {
  it("records a delivery attempt ledger entry for a pending wake obligation", async () => {
    const { store, cleanup } = tempStore();
    try {
      const wake = createPendingWake(store, "pending", 100);

      const result = await replayDurableWakeDeliveryAttempts({
        store,
        replayPassId: "pass:pending",
        now: 200,
      });

      expect(result).toMatchObject({
        scanned: 1,
        recorded: 1,
        deduped: 0,
        pending: 1,
      });
      expect(store.listWakeDeliveryAttempts({ wakeId: wake.wakeId })).toEqual([
        expect.objectContaining({
          wakeId: wake.wakeId,
          dedupeKey: expect.stringContaining(`wake-delivery:v1:${wake.wakeId}:channel_route`),
          replayPassId: "pass:pending",
          routeKind: "channel_route",
          routeRef: "discord:thread:pending",
          status: "pending",
          evidence: expect.objectContaining({
            kind: "wake_delivery_scheduled",
            wakeId: wake.wakeId,
          }),
          scheduledAt: 200,
        }),
      ]);
      expect(store.getDurableWake(wake.wakeId)).toMatchObject({
        attemptCount: 1,
        lastAttemptAt: 200,
      });
    } finally {
      cleanup();
    }
  });

  it("dedupes repeated replay scans and does not call the hook twice", async () => {
    const { store, cleanup } = tempStore();
    try {
      createPendingWake(store, "dedupe", 100);
      let hookCalls = 0;
      const first = await replayDurableWakeDeliveryAttempts({
        store,
        replayPassId: "pass:first",
        now: 200,
        deliveryHook: () => {
          hookCalls += 1;
          return {
            status: "attempted",
            evidence: { kind: "in_memory_test_hook" },
          };
        },
      });
      const second = await replayDurableWakeDeliveryAttempts({
        store,
        replayPassId: "pass:second",
        now: 300,
        deliveryHook: () => {
          hookCalls += 1;
          return {
            status: "attempted",
          };
        },
      });

      expect(first).toMatchObject({ recorded: 1, deduped: 0 });
      expect(second).toMatchObject({ recorded: 0, deduped: 1 });
      expect(hookCalls).toBe(1);
      expect(store.listWakeDeliveryAttempts()).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("persists delivered, failed, and unknown attempt evidence", async () => {
    const { store, cleanup } = tempStore();
    try {
      createPendingWake(store, "delivered", 100);
      createPendingWake(store, "failed", 101);
      createPendingWake(store, "unknown", 102);
      const statuses = new Map<string, DurableWakeDeliveryAttemptStatus>([
        ["discord:thread:delivered", "delivered"],
        ["discord:thread:failed", "failed"],
        ["discord:thread:unknown", "unknown"],
      ]);

      await replayDurableWakeDeliveryAttempts({
        store,
        replayPassId: "pass:outcomes",
        now: 300,
        deliveryHook: ({ attempt }) => {
          const status = statuses.get(attempt.routeRef ?? "");
          if (!status) {
            throw new Error(`missing status for ${attempt.routeRef}`);
          }
          return {
            status,
            evidence: {
              kind: `test_${status}`,
              routeRef: attempt.routeRef,
            },
            ...(status === "failed" ? { error: "test delivery failed" } : {}),
          };
        },
      });

      expect(store.listWakeDeliveryAttempts({ status: "delivered" })).toEqual([
        expect.objectContaining({
          status: "delivered",
          evidence: expect.objectContaining({ kind: "test_delivered" }),
          attemptedAt: 300,
          deliveredAt: 300,
        }),
      ]);
      expect(store.listWakeDeliveryAttempts({ status: "failed" })).toEqual([
        expect.objectContaining({
          status: "failed",
          error: "test delivery failed",
          evidence: expect.objectContaining({ kind: "test_failed" }),
          attemptedAt: 300,
          failedAt: 300,
        }),
      ]);
      expect(store.listWakeDeliveryAttempts({ status: "unknown" })).toEqual([
        expect.objectContaining({
          status: "unknown",
          evidence: expect.objectContaining({ kind: "test_unknown" }),
          attemptedAt: 300,
          unknownAt: 300,
        }),
      ]);
    } finally {
      cleanup();
    }
  });

  it("keeps missing or ambiguous targets inspectable through an operator attempt", async () => {
    const { store, cleanup } = tempStore();
    try {
      const wake = recordDurableWakeObligation({
        store,
        reason: "delivery_unknown",
        dedupeKey: "wake:test:ambiguous-delivery-target",
        facts: {
          explicitWorkOwners: [
            {
              kind: "agent_session",
              ref: "agent:owner:a",
              ownerKind: "agent_session",
              ownerRef: "agent:owner:a",
            },
            {
              kind: "agent_session",
              ref: "agent:owner:b",
              ownerKind: "agent_session",
              ownerRef: "agent:owner:b",
            },
          ],
        },
        evidence: { kind: "ambiguous_delivery_target" },
        now: 100,
      });

      await replayDurableWakeDeliveryAttempts({
        store,
        replayPassId: "pass:operator",
        now: 200,
      });

      expect(store.listWakeDeliveryAttempts({ wakeId: wake.wakeId })).toEqual([
        expect.objectContaining({
          routeKind: "operator",
          routeRef: "operator",
          status: "pending",
        }),
      ]);
      expect(store.listUnresolvedObligations()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "pending_wake",
            wakeId: wake.wakeId,
            status: "pending",
          }),
        ]),
      );
    } finally {
      cleanup();
    }
  });

  it("replays existing persisted pending obligations after reopening the store", async () => {
    const { dbPath, store } = tempStore();
    try {
      const wake = createPendingWake(store, "restart", 100);
      store.close();
      const reopened = openDurableRuntimeSqliteStore({ path: dbPath });
      try {
        const result = await replayDurableWakeDeliveryAttempts({
          store: reopened,
          replayPassId: "pass:restart",
          now: 500,
        });

        expect(result).toMatchObject({
          scanned: 1,
          recorded: 1,
        });
        expect(reopened.listWakeDeliveryAttempts({ wakeId: wake.wakeId })).toEqual([
          expect.objectContaining({
            replayPassId: "pass:restart",
            status: "pending",
            scheduledAt: 500,
          }),
        ]);
      } finally {
        reopened.close();
      }
    } finally {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("does not add autonomous retry, resume, abandon, or create-new policy fields", async () => {
    const { store, cleanup } = tempStore();
    try {
      createPendingWake(store, "no-policy", 100);
      const result = await replayDurableWakeDeliveryAttempts({
        store,
        replayPassId: "pass:no-policy",
        now: 200,
      });

      const keys = collectKeys(result);
      expect(keys).not.toContain("retry");
      expect(keys).not.toContain("resume");
      expect(keys).not.toContain("abandon");
      expect(keys).not.toContain("createNew");
      expect(result.attempts[0]).toMatchObject({
        status: "pending",
        metadata: {
          deliveryContract: "durable_wake_delivery_replay_v1",
          replayPassId: "pass:no-policy",
        },
      });
    } finally {
      cleanup();
    }
  });
});
