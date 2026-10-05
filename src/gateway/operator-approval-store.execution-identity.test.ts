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
import { insertOperatorApprovalInDatabase as insertOperatorApprovalNative } from "./operator-approval-store.kernel.js";

type NewOperatorApproval = Parameters<typeof insertOperatorApproval>[0]["approval"];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function databaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.realpathSync(tempDirs.make("openclaw-approval-id-"));
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function approval(
  id: string,
  token?: NewOperatorApproval["executionIdentityToken"],
): NewOperatorApproval {
  return {
    id,
    kind: "exec",
    presentation: {
      kind: "exec",
      commandText: `echo ${id}`,
      commandPreview: `echo ${id}`,
      warningText: null,
      host: "gateway",
      nodeId: null,
      agentId: "main",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    requester: { deviceId: "request-device", clientId: "request-client", deviceTokenAuth: true },
    reviewerDeviceIds: ["reviewer"],
    source: {
      agentId: "main",
      sessionKey: "agent:main:child",
      sessionId: "session-1",
      runId: "run-1",
      toolCallId: "tool-call-1",
      toolName: "exec",
    },
    audienceSessionKeys: ["agent:main:child"],
    runtimeEpoch: "runtime-a",
    createdAtMs: 1_000,
    expiresAtMs: 10_000,
    ...(token ? { executionIdentityToken: token } : {}),
  };
}

const token = (runId = "run-1"): NonNullable<NewOperatorApproval["executionIdentityToken"]> => ({
  tokenVersion: 1,
  createdAt: 1,
  runId,
  contextId: "context-1",
  executionId: "execution-1",
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

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
        approval: approval("atomic", token()),
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
    const options = databaseOptions();
    for (const id of ["missing-child", "corrupt-child", "deleted-audit"]) {
      expect(
        await insertOperatorApproval({ approval: approval(id, token()), databaseOptions: options }),
      ).toMatchObject({ outcome: "inserted" });
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
      expect(
        await resolveOperatorApproval({
          id,
          decision: "allow-once",
          resolver: { kind: "device", id: "reviewer" },
          expectedKind: "exec",
          runtimeEpoch: "runtime-a",
          nowMs: 2_000,
          databaseOptions: options,
        }),
      ).toMatchObject({ outcome: "resolved" });
      expect(
        await consumeOperatorApprovalAllowOnce({
          id,
          consumerId: "consumer",
          expectedKind: "exec",
          runtimeEpoch: "runtime-a",
          nowMs: 3_000,
          databaseOptions: options,
        }),
      ).toMatchObject({ outcome: "consumed" });
      expect(
        await getOperatorApprovalDetailed({ id, nowMs: 3_000, databaseOptions: options }),
      ).toMatchObject({
        outcome: "found",
        record: { decision: "allow-once", consumedBy: "consumer" },
      });
    }
  });
});
