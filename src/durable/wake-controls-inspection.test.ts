import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDurableRuntimeSqliteStore } from "./sqlite-store.js";
import type { DurableRuntimeStore } from "./types.js";
import { replayDurableWakeDeliveryAttempts } from "./wake-delivery-replay.js";
import { recordDurableWakeObligation } from "./wake-producers.js";

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-wake-controls-"));
  const store = openDurableRuntimeSqliteStore({
    path: path.join(dir, "openclaw.sqlite"),
  });
  return {
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
    dedupeKey: `wake:test:controls:${suffix}`,
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
      kind: "test_control_obligation",
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

describe("durable wake controls and inspection", () => {
  it("acknowledges wake obligations idempotently and keeps terminal controls immutable", () => {
    const { store, cleanup } = tempStore();
    try {
      const wake = createPendingWake(store, "ack", 100);

      const acked = store.acknowledgeDurableWake({
        wakeId: wake.wakeId,
        actorKind: "parent",
        actorRef: "agent:parent:session",
        reason: "parent saw child terminal result",
        decisionRef: "message:ack:1",
        idempotencyKey: "ack:wake:1",
        evidence: { seenResultRef: "result:child" },
        now: 200,
      });
      const duplicateAck = store.acknowledgeDurableWake({
        wakeId: wake.wakeId,
        actorKind: "parent",
        actorRef: "agent:parent:session",
        reason: "parent saw child terminal result",
        decisionRef: "message:ack:1",
        idempotencyKey: "ack:wake:1",
        evidence: { seenResultRef: "result:child" },
        now: 300,
      });

      expect(acked).toMatchObject({
        wakeId: wake.wakeId,
        status: "acked",
        ackedAt: 200,
        updatedAt: 200,
        metadata: {
          durableWakeControl: {
            kind: "acknowledged",
            actorKind: "parent",
            actorRef: "agent:parent:session",
            idempotencyKey: "ack:wake:1",
            evidence: { seenResultRef: "result:child" },
          },
        },
      });
      expect(duplicateAck).toEqual(acked);
      expect(
        store.supersedeDurableWake({
          wakeId: wake.wakeId,
          actorKind: "operator",
          actorRef: "operator:test",
          reason: "should not rewrite acked wake",
        }),
      ).toBeUndefined();
      expect(
        store.updateDurableWake({
          wakeId: wake.wakeId,
          status: "superseded",
          now: 400,
        }),
      ).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("supersedes stale obligations while preserving reason and evidence metadata", () => {
    const { store, cleanup } = tempStore();
    try {
      const wake = createPendingWake(store, "supersede", 100);

      const superseded = store.supersedeDurableWake({
        wakeId: wake.wakeId,
        actorKind: "operator",
        actorRef: "operator:test",
        reason: "duplicate newer wake exists",
        supersededByRef: "wake:newer",
        decisionRef: "decision:supersede:1",
        evidence: { duplicateOf: "wake:newer", inspectedAt: 190 },
        now: 200,
      });

      expect(superseded).toMatchObject({
        status: "superseded",
        failedReason: "duplicate newer wake exists",
        metadata: {
          producer: "durable_wake_producer",
          evidence: {
            kind: "test_control_obligation",
            suffix: "supersede",
          },
          supersededByRef: "wake:newer",
          durableWakeControl: {
            kind: "superseded",
            actorKind: "operator",
            actorRef: "operator:test",
            reason: "duplicate newer wake exists",
            evidence: { duplicateOf: "wake:newer", inspectedAt: 190 },
          },
        },
      });
      expect(
        store.supersedeDurableWake({
          wakeId: wake.wakeId,
          actorKind: "operator",
          actorRef: "operator:test",
          reason: "duplicate newer wake exists",
        }),
      ).toEqual(superseded);
    } finally {
      cleanup();
    }
  });

  it("marks inspected and decision-required obligations without resolving them", () => {
    const { store, cleanup } = tempStore();
    try {
      const wake = createPendingWake(store, "decision", 100);

      const marked = store.markDurableWakeDecisionRequired({
        wakeId: wake.wakeId,
        decisionKind: "requires_operator_decision",
        actorKind: "external",
        actorRef: "gateway:durable-inspection",
        reason: "target evidence needs operator routing choice",
        evidence: { routeCandidates: ["operator", "discord:thread:decision"] },
        now: 200,
      });

      expect(marked).toMatchObject({
        status: "pending",
        metadata: {
          durableWakeControl: {
            kind: "requires_operator_decision",
            actorKind: "external",
            actorRef: "gateway:durable-inspection",
          },
        },
      });
      expect(store.listPendingWakeObligations()).toEqual([
        expect.objectContaining({ wakeId: wake.wakeId, status: "pending" }),
      ]);
    } finally {
      cleanup();
    }
  });

  it("rejects invalid delivery-attempt transitions and supersedes only nonterminal attempts", () => {
    const { store, cleanup } = tempStore();
    try {
      const wake = createPendingWake(store, "attempt-transition", 100);
      const attempt = store.recordWakeDeliveryAttempt({
        wakeId: wake.wakeId,
        dedupeKey: "wake-delivery:test:attempt-transition",
        status: "pending",
        now: 200,
      });

      expect(
        store.updateWakeDeliveryAttempt({
          deliveryAttemptId: attempt.deliveryAttemptId,
          status: "delivered",
          attemptedAt: 210,
          deliveredAt: 210,
          now: 210,
        }),
      ).toMatchObject({ status: "delivered", deliveredAt: 210 });
      expect(
        store.updateWakeDeliveryAttempt({
          deliveryAttemptId: attempt.deliveryAttemptId,
          status: "pending",
          now: 220,
        }),
      ).toBeUndefined();
      expect(
        store.supersedeWakeDeliveryAttempt({
          wakeId: wake.wakeId,
          deliveryAttemptId: attempt.deliveryAttemptId,
          actorKind: "operator",
          actorRef: "operator:test",
          reason: "terminal attempts are immutable",
          now: 230,
        }),
      ).toBeUndefined();

      const staleAttempt = store.recordWakeDeliveryAttempt({
        wakeId: wake.wakeId,
        dedupeKey: "wake-delivery:test:stale-attempt",
        status: "unknown",
        unknownAt: 240,
        now: 240,
      });
      expect(
        store.supersedeWakeDeliveryAttempt({
          wakeId: wake.wakeId,
          deliveryAttemptId: staleAttempt.deliveryAttemptId,
          actorKind: "operator",
          actorRef: "operator:test",
          reason: "newer route chosen externally",
          supersededByRef: "wake-delivery:test:newer-attempt",
          now: 250,
        }),
      ).toMatchObject({
        status: "superseded",
        error: "newer route chosen externally",
        evidence: {
          kind: "wake_delivery_attempt_superseded",
          supersededByRef: "wake-delivery:test:newer-attempt",
        },
      });
    } finally {
      cleanup();
    }
  });

  it("returns pending obligations, delivery attempts, uncertainty facts, and target diagnostics", async () => {
    const { store, cleanup } = tempStore();
    try {
      const wake = recordDurableWakeObligation({
        store,
        reason: "delivery_unknown",
        dedupeKey: "wake:test:inspection:ambiguous",
        sourceRunId: "run_ambiguous",
        factsRef: "facts:ambiguous",
        facts: {
          sourceRunId: "run_ambiguous",
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
        evidence: { kind: "ambiguous_delivery_fact" },
        now: 100,
      });
      const uncertainty = store.recordSideEffectUncertaintyFact({
        kind: "delivery_unknown",
        sourceRunId: "run_ambiguous",
        factsRef: "facts:delivery-unknown",
        dedupeKey: "uncertain:test:inspection",
        facts: { externalDeliveryId: "redacted" },
        now: 110,
      });

      await replayDurableWakeDeliveryAttempts({
        store,
        replayPassId: "pass:inspection",
        now: 200,
      });

      expect(store.listPendingWakeObligations()).toEqual([
        expect.objectContaining({ wakeId: wake.wakeId, status: "pending" }),
      ]);
      expect(store.listUnresolvedUncertaintyFacts()).toEqual([
        expect.objectContaining({ factId: uncertainty.factId, status: "open" }),
      ]);
      expect(store.getDurableWakeInspection(wake.wakeId)).toMatchObject({
        wake: {
          wakeId: wake.wakeId,
          targetResolutionStatus: "ambiguous",
          targetResolutionReason: "explicit_work_owner_ambiguous",
        },
        targetResolution: {
          status: "ambiguous",
          reason: "explicit_work_owner_ambiguous",
          targetKind: "operator",
          ownerKind: "operator",
          factsRef: "facts:ambiguous",
          sourceRunId: "run_ambiguous",
          evidence: { kind: "ambiguous_delivery_fact" },
        },
        deliveryAttempts: [
          expect.objectContaining({
            wakeId: wake.wakeId,
            routeKind: "operator",
            routeRef: "operator",
          }),
        ],
        unresolvedUncertaintyFacts: [
          expect.objectContaining({
            factId: uncertainty.factId,
            kind: "delivery_unknown",
          }),
        ],
        sourceRefs: {
          factsRef: "facts:ambiguous",
          sourceRunId: "run_ambiguous",
          dedupeKey: "wake:test:inspection:ambiguous",
        },
      });
    } finally {
      cleanup();
    }
  });

  it("does not create retry, resume, abandon, or create-new actions from controls", () => {
    const { store, cleanup } = tempStore();
    try {
      const wake = createPendingWake(store, "no-policy", 100);

      const marked = store.markDurableWakeDecisionRequired({
        wakeId: wake.wakeId,
        decisionKind: "inspected",
        actorKind: "operator",
        actorRef: "operator:test",
        reason: "inspection only",
        now: 200,
      });
      const keys = collectKeys(marked);

      expect(keys).not.toContain("retry");
      expect(keys).not.toContain("resume");
      expect(keys).not.toContain("abandon");
      expect(keys).not.toContain("createNew");
      expect(marked).toMatchObject({
        status: "pending",
        metadata: {
          durableWakeControl: {
            kind: "inspected",
          },
        },
      });
    } finally {
      cleanup();
    }
  });

  it("does not replay obligations after ack or supersede controls", async () => {
    const { store, cleanup } = tempStore();
    try {
      const acked = createPendingWake(store, "replay-acked", 100);
      const superseded = createPendingWake(store, "replay-superseded", 101);
      store.acknowledgeDurableWake({
        wakeId: acked.wakeId,
        actorKind: "parent",
        actorRef: "agent:parent",
        now: 200,
      });
      store.supersedeDurableWake({
        wakeId: superseded.wakeId,
        actorKind: "operator",
        actorRef: "operator:test",
        reason: "duplicate",
        now: 201,
      });

      const result = await replayDurableWakeDeliveryAttempts({
        store,
        replayPassId: "pass:controlled",
        now: 300,
      });

      expect(result).toMatchObject({
        scanned: 0,
        recorded: 0,
        deduped: 0,
      });
      expect(store.listWakeDeliveryAttempts()).toEqual([]);
      expect(store.listUnresolvedObligations()).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ wakeId: acked.wakeId }),
          expect.objectContaining({ wakeId: superseded.wakeId }),
        ]),
      );
    } finally {
      cleanup();
    }
  });
});
