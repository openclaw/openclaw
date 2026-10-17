import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  consumeOperatorApprovalAllowOnce,
  getOperatorApprovalDetailed,
  insertOperatorApproval,
  resolveOperatorApproval,
} from "./operator-approval-store.js";
import { insertOperatorApprovalInDatabase as insertOperatorApprovalNative } from "./operator-approval-store.kernel.worker.js";
import {
  getOperatorApprovalDetailed as getOlderOperatorApproval,
  resolveOperatorApproval as resolveOlderOperatorApproval,
} from "./operator-approval-store.older-reader.test-support.js";

type NewOperatorApproval = Parameters<typeof insertOperatorApproval>[0]["approval"];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function databaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.realpathSync(tempDirs.make("openclaw-approval-id-"));
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function approval(id: string): NewOperatorApproval {
  return {
    id,
    kind: "exec",
    presentation: {
      kind: "exec",
      commandText: `echo ${id}`,
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    source: { runId: "run-1" },
    runtimeEpoch: "runtime-a",
    createdAtMs: 1_000,
    expiresAtMs: 10_000,
    executionIdentityToken: {
      tokenVersion: 1,
      createdAt: 1,
      runId: "run-1",
      contextId: "context-1",
      executionId: "execution-1",
    },
  };
}

async function closeDatabase() {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
}
afterEach(closeDatabase);

function expectFound(result: unknown, record: object) {
  expect(result).toMatchObject({ outcome: "found", record });
}

function identityFixture() {
  const options = databaseOptions();
  const owner = {
    expectedKind: "exec",
    runtimeEpoch: "runtime-a",
    databaseOptions: options,
  } as const;
  return {
    options,
    insert: (id: string) =>
      insertOperatorApproval({ approval: approval(id), databaseOptions: options }),
    resolve: (id: string) =>
      resolveOperatorApproval({
        id,
        decision: "allow-once",
        resolver: { kind: "device", id: "reviewer" },
        nowMs: 2_000,
        ...owner,
      }),
    consume: (id: string, consumerId = "consumer") =>
      consumeOperatorApprovalAllowOnce({
        id,
        consumerId,
        nowMs: 3_000,
        ...owner,
      }),
    get: (id: string) =>
      getOperatorApprovalDetailed({ id, nowMs: 3_000, databaseOptions: options }),
  };
}

describe("operator approval execution identity", () => {
  it("rolls back the parent when the child insert is forced to fail", () => {
    const options = databaseOptions();
    const db = openOpenClawStateDatabase(options).db;
    db.exec(`
      CREATE TABLE operator_approval_execution_identities (
        approval_id TEXT PRIMARY KEY REFERENCES operator_approvals(approval_id) ON DELETE CASCADE,
        source_context_id TEXT NOT NULL,
        source_execution_id TEXT NOT NULL
      ) STRICT;
      CREATE TRIGGER force_execution_identity_failure
      BEFORE INSERT ON operator_approval_execution_identities
      BEGIN
        SELECT RAISE(ABORT, 'forced child failure');
      END;
    `);

    // The injected trigger is deliberately noncanonical; worker admission rejects it.
    // Exercise the same native transaction directly to prove parent/child atomicity.
    expect(() =>
      insertOperatorApprovalNative({
        approval: approval("atomic"),
        databaseOptions: options,
      }),
    ).toThrow("forced child failure");
    expect(
      db.prepare("SELECT approval_id FROM operator_approvals WHERE approval_id = ?").get("atomic"),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT approval_id FROM operator_approval_execution_identities").get(),
    ).toBeUndefined();
  });

  it("keeps parent decision and consume semantics independent of child/audit rows", async () => {
    const { options, insert, resolve, consume, get } = identityFixture();
    for (const id of ["missing-child", "corrupt-child", "deleted-audit"]) {
      expect(await insert(id)).toMatchObject({ outcome: "inserted" });
    }
    const db = openOpenClawStateDatabase(options).db;
    db.prepare("DELETE FROM operator_approval_execution_identities WHERE approval_id = ?").run(
      "missing-child",
    );
    db.prepare(
      "UPDATE operator_approval_execution_identities SET source_context_id = ?, source_execution_id = ? WHERE approval_id = ?",
    ).run("missing-context", "missing-execution", "corrupt-child");
    db.exec(`
      CREATE TABLE execution_identity_contexts (
        context_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL
      ) STRICT;
      INSERT INTO execution_identity_contexts VALUES ('context-1', 'execution-1');
      DELETE FROM execution_identity_contexts WHERE context_id = 'context-1';
    `);

    for (const id of ["missing-child", "corrupt-child", "deleted-audit"]) {
      expect(await resolve(id)).toMatchObject({ outcome: "resolved" });
      expect(await consume(id)).toMatchObject({ outcome: "consumed" });
      expectFound(await get(id), { decision: "allow-once", consumedBy: "consumer" });
    }
  });
  it("preserves companion identity through an older approval reader write and candidate reopen", async () => {
    const { options, insert, consume, get } = identityFixture();
    await insert("older-reader");
    const candidate = openOpenClawStateDatabase(options);
    const version = candidate.db.prepare("PRAGMA user_version").get();
    const binding = candidate.db
      .prepare("SELECT * FROM operator_approval_execution_identities")
      .all();
    expect(binding).toEqual([
      {
        approval_id: "older-reader",
        source_context_id: "context-1",
        source_execution_id: "execution-1",
      },
    ]);
    await closeDatabase();

    // The pinned reader predates companion identities. Its original decoder and
    // decision transition reopen through the current shared database owner.
    const olderInput = { id: "older-reader", nowMs: 2_000, databaseOptions: options };
    expectFound(getOlderOperatorApproval(olderInput), { status: "pending", decision: null });
    const older = openOpenClawStateDatabase(options);
    expect(
      resolveOlderOperatorApproval({
        ...olderInput,
        decision: "allow-once",
        resolver: { kind: "device", id: "older-reviewer" },
        expectedKind: "exec",
        runtimeEpoch: "runtime-a",
      }),
    ).toMatchObject({ outcome: "resolved", record: { decision: "allow-once" } });
    expectFound(getOlderOperatorApproval(olderInput), {
      status: "allowed",
      decision: "allow-once",
    });
    expect(older.db.prepare("PRAGMA user_version").get()).toEqual(version);
    await closeDatabase();

    expectFound(await get("older-reader"), {
      decision: "allow-once",
      resolver: { id: "older-reviewer" },
    });
    expect(await consume("older-reader", "candidate-consumer")).toMatchObject({
      outcome: "consumed",
    });
    expectFound(await get("older-reader"), { consumedBy: "candidate-consumer" });
    const reopened = openOpenClawStateDatabase(options).db;
    expect(reopened.prepare("SELECT * FROM operator_approval_execution_identities").all()).toEqual(
      binding,
    );
    expect(reopened.prepare("PRAGMA user_version").get()).toEqual(version);
    expect(reopened.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    expect(reopened.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
