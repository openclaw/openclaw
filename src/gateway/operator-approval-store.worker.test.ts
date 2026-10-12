import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import * as boot from "./operator-approval-store.boot.js";
import * as store from "./operator-approval-store.js";
import * as native from "./operator-approval-store.kernel.worker.js";
import { operatorApprovalPublication } from "./operator-approval-store.publication.js";
import { getOperatorApprovalResolutionKey } from "./operator-approval-store.rows.js";
import * as nativeTransitions from "./operator-approval-store.transitions.worker.js";
import type { OperatorApprovalRow } from "./operator-approval-store.types.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

function options() {
  return {
    env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("operator-approval-worker-") },
  };
}

function approval(id: string): Parameters<typeof store.insertOperatorApproval>[0]["approval"] {
  return {
    id,
    kind: "exec",
    runtimeEpoch: "synthetic-epoch",
    createdAtMs: 1000,
    expiresAtMs: 10_000,
    source: { agentId: "main", sessionKey: "agent:main:synthetic" },
    reviewerDeviceIds: ["reviewer"],
    audienceSessionKeys: ["agent:main:synthetic"],
    presentation: {
      kind: "exec",
      commandText: "printf 'héllo  world'",
      commandPreview: "printf 'héllo  world'",
      warningText: null,
      host: "gateway",
      nodeId: null,
      agentId: "main",
      allowedDecisions: ["allow-once", "deny"],
    },
  };
}

it("preserves serialized records, first-answer wins, consumption and history through the worker", async () => {
  const databaseOptions = options();
  const originalOptions = options();
  const input = approval("golden");
  const sameBytes = (actual: unknown, expected: unknown) =>
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  sameBytes(
    await store.insertOperatorApproval({ approval: input, databaseOptions }),
    native.insertOperatorApprovalInDatabase({ approval: input, databaseOptions: originalOptions }),
  );
  sameBytes(
    await store.listPendingOperatorApprovals({ nowMs: 2000, databaseOptions }),
    native.listPendingOperatorApprovalsInDatabase({
      nowMs: 2000,
      databaseOptions: originalOptions,
    }),
  );
  const verdict = {
    id: input.id,
    decision: "allow-once" as const,
    resolver: { kind: "device" as const, id: "reviewer" },
    nowMs: 3000,
  };
  sameBytes(
    await store.resolveOperatorApproval({ ...verdict, databaseOptions }),
    nativeTransitions.resolveOperatorApprovalInDatabase({
      ...verdict,
      databaseOptions: originalOptions,
    }),
  );
  sameBytes(
    await store.resolveOperatorApproval({ ...verdict, decision: "deny", databaseOptions }),
    nativeTransitions.resolveOperatorApprovalInDatabase({
      ...verdict,
      decision: "deny",
      databaseOptions: originalOptions,
    }),
  );
  const consume = { id: input.id, consumerId: "synthetic-consumer", nowMs: 4000 };
  sameBytes(
    await store.consumeOperatorApprovalAllowOnce({ ...consume, databaseOptions }),
    nativeTransitions.consumeOperatorApprovalAllowOnceInDatabase({
      ...consume,
      databaseOptions: originalOptions,
    }),
  );
  sameBytes(
    await store.listTerminalOperatorApprovals({ nowMs: 5000, databaseOptions }),
    native.listTerminalOperatorApprovalsInDatabase(
      { nowMs: 5000 },
      openOpenClawStateDatabase(originalOptions).db,
    ),
  );
});

it("publishes exact native postimages only after the outer commit and retention tombstones", () => {
  const databaseOptions = options();
  const facts = new Map<string, OperatorApprovalRow>();
  const snapshots: string[][] = [];
  const releaseFacts = operatorApprovalPublication.subscribeFacts((change) => {
    if (change.kind !== "committed") {
      return;
    }
    for (const [key, fact] of change.receipt.facts) {
      if (fact.kind === "postimage") {
        facts.set(key, fact.value);
      }
      if (fact.kind === "absent") {
        facts.delete(key);
      }
    }
  });
  const releaseObserver = operatorApprovalPublication.subscribe(() => {
    snapshots.push([...facts.values()].map((row) => `${row.approval_id}:${row.status}`));
  });
  try {
    runOpenClawStateWriteTransaction(() => {
      native.insertOperatorApprovalInDatabase({ approval: approval("first"), databaseOptions });
      expect(() =>
        runOpenClawStateWriteTransaction(() => {
          nativeTransitions.forceDenyOperatorApprovalInDatabase({
            id: "first",
            status: "cancelled",
            reason: "run-aborted",
            resolver: { kind: "runtime", id: null },
            nowMs: 2000,
            databaseOptions,
          });
          throw new Error("rollback nested verdict");
        }, databaseOptions),
      ).toThrow("rollback nested verdict");
      native.insertOperatorApprovalInDatabase({ approval: approval("second"), databaseOptions });
      expect(facts.size).toBe(0);
    }, databaseOptions);
    expect(snapshots).toEqual([
      ["first:pending", "second:pending"],
      ["first:pending", "second:pending"],
    ]);
    native.getOperatorApprovalDetailedInDatabase({ id: "first", nowMs: 10_000, databaseOptions });
    expect(facts.get("first")?.status).toBe("expired");
    boot.closeOrphanedOperatorApprovals({
      runtimeEpoch: "next-runtime",
      nowMs: 10_000,
      databaseOptions,
    });
    expect(facts.get("second")?.status).toBe("cancelled");
    expect(
      boot.pruneTerminalOperatorApprovals({
        nowMs: 10_001,
        retentionMs: 0,
        databaseOptions,
      }),
    ).toBe(2);
    expect(facts.size).toBe(0);
  } finally {
    releaseFacts();
    releaseObserver();
  }
});

it.each(["worker", "native-compatibility"] as const)(
  "runs %s approval operations without host SQLite through close",
  async (family) => {
    const databaseOptions = options();
    await store.insertOperatorApproval({ approval: approval("off-thread"), databaseOptions });
    const guard = { family, assertCurrent() {} };
    requireNodeSqlite();
    const counters = observeMainThreadSql();
    try {
      counters.calibrate();
      expect(
        await store.resolveOperatorApproval({
          id: "off-thread",
          decision: "allow-once",
          resolver: { kind: "device", id: "reviewer" },
          nowMs: 2000,
          databaseOptions,
          guard,
        }),
      ).toMatchObject({ outcome: "resolved" });
      expect(
        await store.consumeOperatorApprovalAllowOnce({
          id: "off-thread",
          consumerId: "synthetic-consumer",
          nowMs: 2001,
          databaseOptions,
          guard,
        }),
      ).toMatchObject({ outcome: "consumed" });
      await store.insertOperatorApproval({ approval: approval("expiry"), databaseOptions, guard });
      const pending = await store.listPendingOperatorApprovals({
        nowMs: 2002,
        databaseOptions,
        guard,
      });
      expect(pending.map((record) => record.id)).toEqual(["expiry"]);
      expect(
        (await store.expireDueOperatorApprovals({ nowMs: 10_000, databaseOptions, guard }))
          .affected,
      ).toBe(1);
      expect(
        await store.getOperatorApprovalDetailed({
          id: "expiry",
          nowMs: 10_001,
          databaseOptions,
          guard,
        }),
      ).toMatchObject({ outcome: "found", record: { status: "expired" } });
      expect(
        await store.listTerminalOperatorApprovals({ nowMs: 10_002, databaseOptions, guard }),
      ).toMatchObject({
        records: [
          { id: "expiry", status: "expired" },
          { id: "off-thread", status: "allowed" },
        ],
      });
      await closeOpenClawStateDatabaseAsync();
      counters.expectIdle();
    } finally {
      counters.restore();
    }
  },
);

it("keeps legacy callback reads between earlier and later worker mutations", async () => {
  const databaseOptions = options();
  const inserted = store.insertOperatorApproval({ approval: approval("ordered"), databaseOptions });
  const guardedRead = store.getOperatorApprovalDetailed({
    id: "ordered",
    nowMs: 2000,
    databaseOptions,
    guard: { family: "native-compatibility", assertCurrent() {} },
  });
  const resolved = store.resolveOperatorApproval({
    id: "ordered",
    decision: "allow-once",
    resolver: { kind: "device", id: "reviewer" },
    nowMs: 3000,
    databaseOptions,
  });
  const [insertResult, readResult, resolveResult] = await Promise.all([
    inserted,
    guardedRead,
    resolved,
  ]);
  expect(insertResult.outcome).toBe("inserted");
  expect(readResult).toMatchObject({
    outcome: "found",
    record: { status: "pending", decision: null },
  });
  expect(resolveResult).toMatchObject({
    outcome: "resolved",
    record: { status: "allowed", decision: "allow-once" },
  });
});

it("revalidates live authority after dispatch and rolls back refused decisions", async () => {
  const databaseOptions = options();
  await store.insertOperatorApproval({ approval: approval("guarded"), databaseOptions });
  let current = true;
  const resolve = store.resolveOperatorApproval({
    id: "guarded",
    decision: "allow-once",
    resolver: { kind: "device", id: "reviewer" },
    nowMs: 2000,
    databaseOptions,
    assertCurrent() {
      if (!current) {
        throw new Error("synthetic authority revoked");
      }
    },
  });
  current = false;
  await expect(resolve).rejects.toThrow("synthetic authority revoked");
  expect(
    await store.getOperatorApprovalDetailed({ id: "guarded", nowMs: 2000, databaseOptions }),
  ).toMatchObject({ outcome: "found", record: { status: "pending", decision: null } });
});

it.each(["worker", "native-compatibility"] as const)(
  "publishes %s receipts only for a committed winning verdict",
  async (family) => {
    const databaseOptions = options();
    await store.insertOperatorApproval({ approval: approval("receipt-rollback"), databaseOptions });
    const published: OperatorApprovalRow[] = [];
    const unknown = vi.fn();
    const releaseFacts = operatorApprovalPublication.subscribeFacts((change) => {
      if (change.kind === "unknown") {
        unknown();
      }
      if (change.kind === "committed") {
        const fact = change.receipt.facts.get("receipt-rollback");
        if (fact?.kind === "postimage") {
          published.push(fact.value);
        }
      }
    });
    const onCommitted = vi.fn(() => {
      expect(published.at(-1)).toMatchObject({ status: "allowed", decision: "allow-once" });
    });
    try {
      let refuse = true;
      let current = true;
      probe.admission(workerAdmission, (request, grant, admit) => {
        if (request.stage === "commit" && refuse) {
          current = false;
        }
        return admit(request, grant);
      });
      const input = {
        id: "receipt-rollback",
        decision: "allow-once" as const,
        resolver: { kind: "runtime" as const, id: null },
        nowMs: 2000,
        databaseOptions,
        onCommitted,
        guard: {
          family,
          assertCurrent: () => {
            if (!current) {
              throw new Error("synthetic commit refusal");
            }
          },
        },
      };
      await expect(store.resolveOperatorApproval(input)).rejects.toThrow(
        "synthetic commit refusal",
      );
      expect(onCommitted).not.toHaveBeenCalled();
      expect(published).toEqual([]);
      expect(unknown).not.toHaveBeenCalled();
      refuse = false;
      current = true;
      expect(
        await store.getOperatorApprovalDetailed({ id: input.id, nowMs: 2000, databaseOptions }),
      ).toMatchObject({ outcome: "found", record: { status: "pending" } });
      const winner = await store.resolveOperatorApproval(input);
      expect(winner.outcome).toBe("resolved");
      assert(winner.outcome === "resolved", "Expected committed resolution");
      expect(onCommitted).toHaveBeenCalledExactlyOnceWith(
        getOperatorApprovalResolutionKey(winner.record),
      );
      expect(await store.resolveOperatorApproval(input)).toMatchObject({
        outcome: "already-resolved",
      });
      expect(onCommitted).toHaveBeenCalledTimes(1);
    } finally {
      releaseFacts();
    }
  },
);

it("queues a brief approval burst through shared input admission", async () => {
  const databaseOptions = options();
  await store.insertOperatorApproval({ approval: approval("burst"), databaseOptions });
  const outcomes = await Promise.allSettled(
    Array.from({ length: 129 }, (_, index) =>
      store.getOperatorApprovalDetailed({
        id: "burst",
        nowMs: 2000,
        databaseOptions,
        ...(index % 2 === 0
          ? { guard: { family: "native-compatibility" as const, assertCurrent() {} } }
          : {}),
      }),
    ),
  );
  expect(outcomes).toHaveLength(129);
  for (const outcome of outcomes) {
    expect(outcome).toMatchObject({
      status: "fulfilled",
      value: { outcome: "found", record: { status: "pending", decision: null } },
    });
  }
});
