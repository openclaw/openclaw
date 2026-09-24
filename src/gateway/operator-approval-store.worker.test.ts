import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import * as store from "./operator-approval-store.js";
import * as native from "./operator-approval-store.kernel.js";
import { getOperatorApprovalResolutionKey } from "./operator-approval-store.rows.js";
import * as nativeTransitions from "./operator-approval-store.transitions.js";

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

it("runs lookup, pending scans, expiry and history without host SQLite calls through close", async () => {
  const databaseOptions = options();
  await store.insertOperatorApproval({ approval: approval("off-thread"), databaseOptions });
  requireNodeSqlite();
  const counters = observeMainThreadSql();
  try {
    counters.calibrate();
    const pending = await store.listPendingOperatorApprovals({ nowMs: 2000, databaseOptions });
    expect(pending.map((record) => record.id)).toEqual(["off-thread"]);
    expect(
      (await store.expireDueOperatorApprovals({ nowMs: 10_000, databaseOptions })).affected,
    ).toBe(1);
    expect(
      await store.getOperatorApprovalDetailed({ id: "off-thread", nowMs: 10_001, databaseOptions }),
    ).toMatchObject({ outcome: "found", record: { status: "expired" } });
    expect(
      await store.listTerminalOperatorApprovals({ nowMs: 10_002, databaseOptions }),
    ).toMatchObject({ records: [{ id: "off-thread", status: "expired" }] });
    await closeOpenClawStateDatabaseAsync();
    counters.expectIdle();
  } finally {
    counters.restore();
  }
});

it("keeps native reads between earlier and later worker mutations", async () => {
  const databaseOptions = options();
  const inserted = store.insertOperatorApproval({ approval: approval("ordered"), databaseOptions });
  const nativeRead = store.getOperatorApprovalDetailed({
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
    nativeRead,
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

it("leaves the default approval clock to the worker when dispatching a public read", async () => {
  const databaseOptions = options();
  const input = approval("worker-clock");
  await store.insertOperatorApproval({ approval: input, databaseOptions });
  // Only the requesting thread sees this pre-expiry clock; the real worker must
  // expire the historical fixture using its own transaction-time clock.
  using _ = vi.spyOn(Date, "now").mockReturnValue(input.createdAtMs);

  expect(await store.getOperatorApprovalDetailed({ id: input.id, databaseOptions })).toMatchObject({
    outcome: "found",
    record: { status: "expired", terminalReason: "timeout" },
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
    const onCommitted = vi.fn();
    let refuse = true;
    let current = true;
    if (family === "worker") {
      const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
      vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (admit) =>
          createAdmission((request, grant) => {
            if (request.stage === "commit" && refuse) {
              current = false;
            }
            return admit(request, grant);
          }),
      );
    }
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
          if (family === "native-compatibility" && refuse) {
            const observed = native.getOperatorApprovalDetailedInDatabase({
              id: "receipt-rollback",
              nowMs: 2000,
              databaseOptions,
            });
            current = observed.outcome !== "found" || observed.record.decision !== "allow-once";
          }
          if (!current) {
            throw new Error("synthetic commit refusal");
          }
        },
      },
    };
    await expect(store.resolveOperatorApproval(input)).rejects.toThrow("synthetic commit refusal");
    expect(onCommitted).not.toHaveBeenCalled();
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
