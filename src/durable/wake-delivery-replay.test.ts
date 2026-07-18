import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadPendingSessionDeliveries } from "../infra/session-delivery-queue.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { openDurableRuntimeSqliteStore } from "./sqlite-store.js";
import type { DurableRuntimeStore, DurableWakeDeliveryAttemptStatus } from "./types.js";
import { replayDurableWakeDeliveryAttempts } from "./wake-delivery-replay.js";
import { createDurableWakeSessionDeliveryHook } from "./wake-internal-delivery.js";
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

  it("dedupes repeated replay scans after a terminal unknown outcome", async () => {
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
            status: "unknown",
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

  it("reclaims a persisted pending attempt after a crash before delivery side effects", async () => {
    const { dbPath, store } = tempStore();
    try {
      const wake = createPendingWake(store, "crash-before-side-effect", 100);
      const first = await replayDurableWakeDeliveryAttempts({
        store,
        replayPassId: "pass:before-crash",
        now: 200,
      });
      const [scheduledAttempt] = first.attempts;
      expect(scheduledAttempt).toMatchObject({
        wakeId: wake.wakeId,
        status: "pending",
      });
      store.close();

      const reopened = openDurableRuntimeSqliteStore({ path: dbPath });
      try {
        let hookCalls = 0;
        const result = await replayDurableWakeDeliveryAttempts({
          store: reopened,
          replayPassId: "pass:after-crash",
          now: 300,
          deliveryHook: ({ attempt }) => {
            hookCalls += 1;
            expect(attempt.deliveryAttemptId).toBe(scheduledAttempt?.deliveryAttemptId);
            expect(attempt.status).toBe("attempted");
            expect(attempt.evidence).toMatchObject({
              kind: "wake_delivery_attempt_claimed",
              previousStatus: "pending",
            });
            return {
              status: "delivered",
              evidence: {
                kind: "delivered_after_pending_reclaim",
                deliveryAttemptId: attempt.deliveryAttemptId,
              },
            };
          },
        });

        expect(result).toMatchObject({
          scanned: 1,
          recorded: 0,
          deduped: 0,
          delivered: 1,
        });
        expect(hookCalls).toBe(1);
        expect(reopened.listWakeDeliveryAttempts({ wakeId: wake.wakeId })).toEqual([
          expect.objectContaining({
            deliveryAttemptId: scheduledAttempt?.deliveryAttemptId,
            status: "delivered",
            attemptedAt: 300,
            deliveredAt: 300,
            evidence: expect.objectContaining({ kind: "delivered_after_pending_reclaim" }),
          }),
        ]);
        expect(reopened.getDurableWake(wake.wakeId)).toMatchObject({
          status: "delivered",
          attemptCount: 2,
          lastAttemptAt: 300,
        });
      } finally {
        reopened.close();
      }
    } finally {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("reclaims a persisted attempted attempt after a crash past the side-effect boundary", async () => {
    const { dbPath, store } = tempStore();
    try {
      const wake = createPendingWake(store, "crash-after-side-effect", 100);
      const first = await replayDurableWakeDeliveryAttempts({
        store,
        replayPassId: "pass:side-effect",
        now: 200,
        deliveryHook: () => ({
          status: "attempted",
          evidence: {
            kind: "delivery_side_effect_started",
          },
        }),
      });
      const [attempted] = first.attempts;
      expect(attempted).toMatchObject({
        wakeId: wake.wakeId,
        status: "attempted",
        attemptedAt: 200,
        deliveryClaimedBy: "pass:side-effect",
        deliveryClaimExpiresAt: 30200,
      });
      store.close();

      const reopened = openDurableRuntimeSqliteStore({ path: dbPath });
      try {
        let hookCalls = 0;
        const leased = await replayDurableWakeDeliveryAttempts({
          store: reopened,
          replayPassId: "pass:too-early",
          now: 300,
          deliveryHook: () => {
            hookCalls += 1;
            return { status: "delivered" };
          },
        });
        expect(leased).toMatchObject({
          scanned: 1,
          recorded: 0,
          delivered: 0,
          pending: 1,
        });
        expect(hookCalls).toBe(0);

        const result = await replayDurableWakeDeliveryAttempts({
          store: reopened,
          replayPassId: "pass:confirm-side-effect",
          now: 30_201,
          deliveryHook: ({ attempt }) => {
            hookCalls += 1;
            expect(attempt.deliveryAttemptId).toBe(attempted?.deliveryAttemptId);
            expect(attempt.status).toBe("attempted");
            expect(attempt.deliveryClaimedBy).toBe("pass:confirm-side-effect");
            return {
              status: "delivered",
              evidence: {
                kind: "delivery_side_effect_confirmed",
                deliveryAttemptId: attempt.deliveryAttemptId,
              },
            };
          },
        });

        expect(result).toMatchObject({
          scanned: 1,
          recorded: 0,
          deduped: 0,
          delivered: 1,
        });
        expect(hookCalls).toBe(1);
        const [deliveredAttempt] = reopened.listWakeDeliveryAttempts({ wakeId: wake.wakeId });
        expect(deliveredAttempt).toEqual(
          expect.objectContaining({
            deliveryAttemptId: attempted?.deliveryAttemptId,
            status: "delivered",
            attemptedAt: 30_201,
            deliveredAt: 30_201,
            evidence: expect.objectContaining({ kind: "delivery_side_effect_confirmed" }),
          }),
        );
        expect(deliveredAttempt).not.toHaveProperty("deliveryClaimedBy");
        expect(deliveredAttempt).not.toHaveProperty("deliveryClaimExpiresAt");
        expect(reopened.getDurableWake(wake.wakeId)).toMatchObject({
          status: "delivered",
          attemptCount: 2,
          lastAttemptAt: 30_201,
        });
      } finally {
        reopened.close();
      }
    } finally {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("repairs a terminal attempt with a pending wake after the old split-write crash boundary", async () => {
    const { dbPath, store } = tempStore();
    try {
      const wake = createPendingWake(store, "terminal-split-repair", 100);
      const first = await replayDurableWakeDeliveryAttempts({
        store,
        replayPassId: "pass:schedule-split",
        now: 200,
      });
      const [scheduledAttempt] = first.attempts;
      expect(scheduledAttempt).toMatchObject({
        status: "pending",
      });
      expect(
        store.claimWakeDeliveryAttempt({
          deliveryAttemptId: scheduledAttempt!.deliveryAttemptId,
          replayPassId: "pass:old-split",
          claimTtlMs: 30_000,
          now: 300,
        }),
      ).toMatchObject({ status: "attempted" });
      expect(
        store.updateWakeDeliveryAttempt({
          deliveryAttemptId: scheduledAttempt!.deliveryAttemptId,
          status: "delivered",
          expectedClaimedBy: "pass:old-split",
          evidence: { kind: "old_split_terminal_attempt" },
          attemptedAt: 300,
          deliveredAt: 300,
          metadata: {
            deliveryContract: "durable_wake_delivery_replay_v1",
            replayPassId: "pass:old-split",
          },
          now: 300,
        }),
      ).toMatchObject({ status: "delivered" });
      expect(store.getDurableWake(wake.wakeId)).toMatchObject({
        status: "pending",
        attemptCount: 1,
      });
      store.close();

      const reopened = openDurableRuntimeSqliteStore({ path: dbPath });
      try {
        let hookCalls = 0;
        const result = await replayDurableWakeDeliveryAttempts({
          store: reopened,
          replayPassId: "pass:repair-split",
          now: 400,
          deliveryHook: () => {
            hookCalls += 1;
            return { status: "failed" };
          },
        });

        expect(result).toMatchObject({
          scanned: 1,
          recorded: 0,
          deduped: 1,
          delivered: 0,
        });
        expect(hookCalls).toBe(0);
        expect(result.attempts).toEqual([
          expect.objectContaining({
            deliveryAttemptId: scheduledAttempt?.deliveryAttemptId,
            status: "delivered",
            deliveredAt: 300,
            evidence: expect.objectContaining({ kind: "old_split_terminal_attempt" }),
          }),
        ]);
        expect(reopened.getDurableWake(wake.wakeId)).toMatchObject({
          status: "delivered",
          attemptCount: 2,
          lastAttemptAt: 300,
        });
      } finally {
        reopened.close();
      }
    } finally {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("keeps a slow in-flight delivery hook claim through ttl-expired competing replay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { store, cleanup } = tempStore();
    try {
      const wake = createPendingWake(store, "slow-hook-claim", 100);
      const hookCalls: string[] = [];
      let releaseFirstHook!: () => void;
      let markFirstHookStarted!: () => void;
      const firstHookStarted = new Promise<void>((resolve) => {
        markFirstHookStarted = resolve;
      });
      const firstHookRelease = new Promise<void>((resolve) => {
        releaseFirstHook = resolve;
      });

      const firstReplay = replayDurableWakeDeliveryAttempts({
        store,
        replayPassId: "pass:slow-first",
        claimTtlMs: 10,
        deliveryHook: async () => {
          hookCalls.push("first");
          markFirstHookStarted();
          await firstHookRelease;
          return {
            status: "delivered",
            evidence: { kind: "slow_first_delivered" },
          };
        },
      });
      await firstHookStarted;

      await vi.advanceTimersByTimeAsync(11);

      const competingReplay = await replayDurableWakeDeliveryAttempts({
        store,
        replayPassId: "pass:competing-second",
        claimTtlMs: 10,
        deliveryHook: () => {
          hookCalls.push("second");
          return {
            status: "failed",
            error: "competing hook should not run",
          };
        },
      });

      expect(competingReplay).toMatchObject({
        scanned: 1,
        recorded: 0,
        delivered: 0,
        failed: 0,
        pending: 1,
      });
      expect(hookCalls).toEqual(["first"]);
      expect(store.listWakeDeliveryAttempts({ wakeId: wake.wakeId })).toEqual([
        expect.objectContaining({
          status: "attempted",
          deliveryClaimedBy: "pass:slow-first",
          deliveryClaimExpiresAt: 1_020,
        }),
      ]);

      releaseFirstHook();
      const firstResult = await firstReplay;

      expect(firstResult).toMatchObject({
        scanned: 1,
        recorded: 1,
        delivered: 1,
      });
      expect(hookCalls).toEqual(["first"]);
      expect(store.listWakeDeliveryAttempts({ wakeId: wake.wakeId })).toEqual([
        expect.objectContaining({
          status: "delivered",
          replayPassId: "pass:slow-first",
          deliveredAt: 1_011,
          evidence: expect.objectContaining({ kind: "slow_first_delivered" }),
        }),
      ]);
      expect(store.listWakeDeliveryAttempts({ wakeId: wake.wakeId })[0]).not.toHaveProperty(
        "deliveryClaimedBy",
      );
      expect(store.getDurableWake(wake.wakeId)).toMatchObject({
        status: "delivered",
        attemptCount: 1,
        lastAttemptAt: 1_011,
      });
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("enqueues a resolved wake into the internal session delivery queue exactly once", async () => {
    await withTempDir({ prefix: "openclaw-durable-wake-internal-delivery-" }, async (stateDir) => {
      const { store, cleanup } = tempStore();
      try {
        const wake = createPendingWake(store, "internal-queue", 100);
        const hook = createDurableWakeSessionDeliveryHook({ stateDir });

        const first = await replayDurableWakeDeliveryAttempts({
          store,
          replayPassId: "pass:internal:first",
          now: 200,
          deliveryHook: hook,
        });
        const second = await replayDurableWakeDeliveryAttempts({
          store,
          replayPassId: "pass:internal:second",
          now: 300,
          deliveryHook: hook,
        });
        const pending = await loadPendingSessionDeliveries(stateDir);

        expect(first).toMatchObject({
          scanned: 1,
          recorded: 1,
          delivered: 1,
        });
        expect(second).toMatchObject({
          scanned: 0,
          recorded: 0,
          deduped: 0,
        });
        expect(pending).toEqual([
          expect.objectContaining({
            kind: "systemEvent",
            sessionKey: "agent:session:internal-queue",
            idempotencyKey: expect.stringContaining(
              `durable-wake-session-delivery:v1:${wake.wakeId}:`,
            ),
            text: expect.stringContaining(`wakeId=${wake.wakeId}`),
          }),
        ]);
        const queuedKeys = collectKeys(pending[0]);
        expect(queuedKeys).not.toContain("resume");
        expect(queuedKeys).not.toContain("abandon");
        expect(queuedKeys).not.toContain("createNew");
        expect(queuedKeys).not.toContain("maxRetries");
        expect(store.listWakeDeliveryAttempts({ wakeId: wake.wakeId })).toEqual([
          expect.objectContaining({
            status: "delivered",
            evidence: expect.objectContaining({
              kind: "wake_internal_session_delivery_enqueued",
              internalDelivery: "session_delivery_queue",
              noExternalSend: true,
              sessionKey: "agent:session:internal-queue",
            }),
            deliveredAt: 200,
          }),
        ]);
      } finally {
        cleanup();
      }
    });
  });

  it("persists delivered, failed, and unknown attempt evidence", async () => {
    const { store, cleanup } = tempStore();
    try {
      createPendingWake(store, "delivered", 100);
      createPendingWake(store, "failed", 101);
      createPendingWake(store, "unknown", 102);
      const statuses = new Map<
        string,
        Exclude<DurableWakeDeliveryAttemptStatus, "pending" | "superseded">
      >([
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

  it("keeps missing or ambiguous targets inspectable without internal queue delivery", async () => {
    await withTempDir({ prefix: "openclaw-durable-wake-ambiguous-delivery-" }, async (stateDir) => {
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
          deliveryHook: createDurableWakeSessionDeliveryHook({ stateDir }),
        });

        expect(await loadPendingSessionDeliveries(stateDir)).toEqual([]);
        expect(store.listWakeDeliveryAttempts({ wakeId: wake.wakeId })).toEqual([
          expect.objectContaining({
            routeKind: "operator",
            routeRef: "operator",
            status: "unknown",
            evidence: expect.objectContaining({
              kind: "wake_internal_session_delivery_not_enqueued",
              reason: "no_resolved_agent_session_target",
            }),
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
