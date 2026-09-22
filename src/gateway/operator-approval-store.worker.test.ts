import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import * as store from "./operator-approval-store.js";
import * as native from "./operator-approval-store.kernel.js";
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

it("runs pending scans and expiry without opening a SQLite statement on the requesting thread", async () => {
  const databaseOptions = options();
  await store.insertOperatorApproval({ approval: approval("off-thread"), databaseOptions });
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(() => {
    throw new Error("SQLite statement reached the requesting thread");
  });
  const pending = await store.listPendingOperatorApprovals({ nowMs: 2000, databaseOptions });
  expect(pending.map((record) => record.id)).toEqual(["off-thread"]);
  expect(
    (await store.expireDueOperatorApprovals({ nowMs: 10_000, databaseOptions })).affected,
  ).toBe(1);
  expect(prepare).not.toHaveBeenCalled();
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
