import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionIdentityContextV1 } from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { activityRunInspectorSearch } from "../../ui/src/pages/activity/run-inspector-model.js";
import { presentExecutionDecisionReceiptsInDatabase } from "../audit/execution-decision-receipts.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  forceDenyOperatorApproval,
  insertOperatorApproval,
  resolveOperatorApproval,
} from "./operator-approval-store.js";
import {
  pageOperatorApprovalReceiptsForRunInDatabase,
  summarizeOperatorApprovalReceiptsForRunInDatabase,
} from "./operator-approval-store.receipts.js";

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function approval(id: string): Parameters<typeof insertOperatorApproval>[0]["approval"] {
  return {
    id,
    kind: "exec" as const,
    presentation: {
      kind: "exec" as const,
      commandText: "secret command --token private-value",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    requester: {
      deviceId: "requester-device-secret",
      clientId: "requester-client-secret",
      deviceTokenAuth: true,
    },
    reviewerDeviceIds: ["reviewer-device-secret"],
    source: {
      agentId: "main",
      sessionKey: "session-secret",
      sessionId: "session-id-secret",
      runId: context.runId,
      toolCallId: "tool-call-secret",
      toolName: "exec",
    },
    runtimeEpoch: "runtime-secret",
    createdAtMs: 1_000,
    expiresAtMs: 11_000,
    executionIdentityToken: {
      ...context,
      tokenVersion: 1,
      createdAt: 1_000,
    },
  };
}

const context = {
  contextId: "context-receipts",
  executionId: "execution-receipts",
  runId: "run-receipts",
  createdAt: 500,
};

const identityContext: ExecutionIdentityContextV1 = {
  schemaVersion: 1,
  ...context,
  trustDomain: { kind: "gateway-cell", domainRef: "domain-ref", state: "present" },
  invoker: { state: "absent" },
  ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
  agentPrincipal: { kind: "agent", domainRef: "domain-ref", principalRef: "main" },
  agentDefinition: { definitionRef: "main", state: "present" },
  runtimeInstance: { runtimeRef: "runtime-ref", kind: "embedded", state: "present" },
  applicableGrants: [],
  assurance: [],
  coverageState: "unattributed",
  missingEvidence: [],
};

function receiptFixture() {
  const database = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-approval-receipts-") } };
  const db = openOpenClawStateDatabase(database).db;
  const insert = (id: string) =>
    insertOperatorApproval({ approval: approval(id), databaseOptions: database });
  const resolve = (
    id: string,
    decision: Parameters<typeof resolveOperatorApproval>[0]["decision"],
    params: Partial<Parameters<typeof resolveOperatorApproval>[0]> = {},
  ) =>
    resolveOperatorApproval({
      resolver: { kind: "device", id: "reviewer-device-secret" },
      nowMs: 2_000,
      ...params,
      id,
      decision,
      databaseOptions: database,
    });
  const deny = (
    id: string,
    status: Parameters<typeof forceDenyOperatorApproval>[0]["status"],
    reason: Parameters<typeof forceDenyOperatorApproval>[0]["reason"],
    params: Partial<Parameters<typeof forceDenyOperatorApproval>[0]> = {},
  ) =>
    forceDenyOperatorApproval({
      resolver: { kind: "system", id: null },
      nowMs: 2_000,
      ...params,
      id,
      status,
      reason,
      databaseOptions: database,
    });
  const page = (
    params: Partial<Parameters<typeof pageOperatorApprovalReceiptsForRunInDatabase>[1]> = {},
  ) =>
    pageOperatorApprovalReceiptsForRunInDatabase(db, {
      context,
      limit: 20,
      nowMs: 3_000,
      ...params,
    });
  const summary = () =>
    summarizeOperatorApprovalReceiptsForRunInDatabase(db, { context, nowMs: 3_000 });
  const displays = (decisionLimit = 20) =>
    presentExecutionDecisionReceiptsInDatabase(db, {
      schema: {
        cronRunReceipts: tableExists(db, "cron_run_receipts"),
        executionOwnerLifecycleBindings: tableExists(db, "execution_owner_lifecycle_bindings"),
      },
      context: identityContext,
      decisionCursor: "a:0:0",
      decisionLimit,
      now: 3_000,
    }).decisionDisplays;
  return { db, insert, resolve, deny, page, summary, displays };
}

describe("operator approval decision receipts", () => {
  it("requests approval again when the outer approval scope closed", async () => {
    const { insert, deny, page } = receiptFixture();
    await insert("cancelled-scope");
    await deny("cancelled-scope", "cancelled", "run-aborted", {
      resolver: { kind: "system", id: "approval-scope-closed" },
    });
    const receipt = page({ limit: 1 }).entries[0]?.receipt;
    expect(receipt?.remediation).toEqual([
      expect.objectContaining({ code: "request_approval_again" }),
    ]);
  });

  it("projects every terminal state from the authoritative first answer", async () => {
    const { db, insert, resolve, deny, page, summary, displays } = receiptFixture();
    for (const id of [
      "allowed",
      "denied",
      "expired",
      "cancelled",
      "no-route",
      "storage-corrupt",
      "payload-corrupt",
    ]) {
      await insert(id);
    }
    await resolve("allowed", "allow-once");
    await resolve("denied", "deny", { nowMs: 2_001 });
    await deny("expired", "expired", "timeout", { nowMs: 2_002 });
    await deny("cancelled", "cancelled", "run-aborted", { nowMs: 2_003 });
    await deny("no-route", "denied", "no-route", {
      resolver: { kind: "system", id: "no-approval-route" },
      nowMs: 2_004,
    });
    await deny("storage-corrupt", "denied", "storage-corrupt", {
      resolver: { kind: "system", id: "storage-error" },
      nowMs: 2_005,
    });
    await resolve("payload-corrupt", "deny", {
      resolver: { kind: "channel", id: "channel-reviewer-secret" },
      nowMs: 2_006,
    });
    db.prepare("UPDATE operator_approvals SET presentation_json = ? WHERE approval_id = ?").run(
      "{",
      "payload-corrupt",
    );

    const entries = page().entries;
    const receipts = entries.map((entry) => entry.receipt);
    expect(entries.map((entry) => entry.selectorId)).toEqual(
      Array.from({ length: 7 }, (_, index) => `approval-decision:${index + 1}`),
    );
    expect(summary()).toEqual({
      count: 7,
      coverageState: "unknown",
      missingEvidence: ["operator_approval.valid"],
    });
    expect(
      receipts.map((receipt) => [
        receipt.decision.outcome,
        receipt.decision.reasonCode,
        receipt.enforcement.coverageState,
      ]),
    ).toEqual([
      ["allowed", "operator_approval_allowed_once", "enforced"],
      ["denied", "operator_approval_denied_by_reviewer", "enforced"],
      ["denied", "operator_approval_expired", "enforced"],
      ["denied", "operator_approval_cancelled_run_aborted", "enforced"],
      ["denied", "operator_approval_denied_no_route", "enforced"],
      ["denied", "operator_approval_denied_storage_corrupt", "enforced"],
      ["unknown", "operator_approval_record_corrupt", "unknown"],
    ]);
    expect(receipts[4]?.enforcement.policyRefs).toContain(
      "operator-approval:delivery-route-required",
    );
    expect(receipts[4]?.remediation).toEqual([
      expect.objectContaining({ code: "restore_approval_route" }),
    ]);

    const encoded = JSON.stringify(receipts);
    for (const secret of [
      "secret command",
      "private-value",
      "requester-device-secret",
      "requester-client-secret",
      "reviewer-device-secret",
      "channel-reviewer-secret",
      "session-secret",
      "session-id-secret",
      "tool-call-secret",
      "runtime-secret",
    ]) {
      expect(encoded).not.toContain(secret);
    }

    const decisionDisplays = displays();
    expect(decisionDisplays?.[0]).toMatchObject({
      action: {
        family: "exec",
        operation: "approval",
        summary: "A exec approval allowed the requested action.",
      },
      provenance: { state: "verified", producer: "operator-approval" },
      remediation: [],
    });
    expect(JSON.stringify(decisionDisplays)).not.toContain("secret command");
  });

  it("keeps a denied first answer after a conflicting allow retry", async () => {
    const { insert, resolve, page } = receiptFixture();
    await insert("first-answer");
    expect(
      await resolve("first-answer", "deny", {
        resolver: { kind: "device", id: "first" },
      }),
    ).toMatchObject({ outcome: "resolved" });
    expect(
      await resolve("first-answer", "allow-once", {
        resolver: { kind: "device", id: "second" },
        nowMs: 2_001,
      }),
    ).toMatchObject({ outcome: "already-resolved", retry: "conflict" });
    expect(page({ limit: 10, nowMs: 2_001 }).entries[0]?.receipt).toMatchObject({
      decision: { outcome: "denied", reasonCode: "operator_approval_denied_by_reviewer" },
      enforcement: {
        coverageState: "enforced",
        contextFieldsUsed: ["contextId", "executionId", "runId"],
      },
      source: { owner: "operator_approvals" },
    });
  });

  it("keeps high-cardinality summary work bounded and conservative", async () => {
    const { insert, resolve, summary } = receiptFixture();
    for (let index = 0; index < 130; index += 1) {
      const id = `bounded-${String(index).padStart(3, "0")}`;
      await insert(id);
      await resolve(id, "deny", { nowMs: 2_000 + index });
    }

    expect(summary()).toEqual({
      count: 129,
      coverageState: "unknown",
      missingEvidence: ["operator_approval.summary_bounded"],
    });
  });

  it("pages portable approval cursors after maximum reuse and bounds oversized presentations", async () => {
    const { db, insert, resolve, page, displays } = receiptFixture();
    for (const id of ["page-a", "page-b", "page-c"]) {
      await insert(id);
      await resolve(id, "deny", {
        resolver: { kind: "device", id: "reviewer" },
      });
    }
    db.exec("UPDATE operator_approvals SET rowid = 100 WHERE approval_id = 'page-a'");
    db.exec("DELETE FROM operator_approvals WHERE approval_id = 'page-c'");
    await insert("page-c");
    await resolve("page-c", "deny", {
      resolver: { kind: "device", id: "reviewer" },
    });
    expect(
      db.prepare("SELECT cursor_id FROM operator_approvals WHERE approval_id = 'page-c'").get(),
    ).toEqual({ cursor_id: 3 });
    db.prepare("UPDATE operator_approvals SET presentation_json = ? WHERE approval_id = ?").run(
      JSON.stringify({ kind: "exec", commandText: "x".repeat(70_000) }),
      "page-b",
    );

    const first = page({ limit: 1 });
    expect(first.entries[0]?.receipt.receiptId).toContain("approval:");
    expect(first.nextCursor).toEqual({ occurredAt: 2_000, rowId: 1 });
    const firstDisplay = displays(1)[0];
    expect(firstDisplay?.selectorId).toBe(`approval-decision:${first.nextCursor?.rowId}`);
    expect(first.entries[0]?.selectorId).toBe(firstDisplay?.selectorId);
    expect(firstDisplay?.selectorId).not.toBe(first.entries[0]?.receipt.receiptId);
    const receiptSearch = activityRunInspectorSearch(
      { kind: "run", id: context.runId },
      { id: firstDisplay?.selectorId ?? "" },
    );
    expect(new URLSearchParams(receiptSearch.slice(1)).get("receipt")).toBe(
      firstDisplay?.selectorId,
    );
    expect(receiptSearch).not.toContain(
      encodeURIComponent(first.entries[0]?.receipt.receiptId ?? ""),
    );
    const next = page({ after: first.nextCursor, limit: 2 });
    expect(next.entries.map((entry) => entry.receipt)).toEqual([
      expect.objectContaining({
        decision: { outcome: "unknown", reasonCode: "operator_approval_payload_bounded" },
        missingEvidence: ["operator_approval.payload_bounded"],
      }),
      expect.objectContaining({
        decision: { outcome: "denied", reasonCode: "operator_approval_denied_by_reviewer" },
      }),
    ]);
  });

  it("reports missing, malformed, and mismatched execution bindings as unknown", async () => {
    for (const [bindingState, reasonCode] of [
      ["missing", "operator_approval_execution_link_missing"],
      ["malformed", "operator_approval_execution_link_malformed"],
      ["mismatch", "operator_approval_execution_link_mismatch"],
    ] as const) {
      const { db, insert, resolve, page } = receiptFixture();
      await insert(`binding-${bindingState}`);
      if (bindingState === "missing") {
        db.prepare("DELETE FROM operator_approval_execution_identities").run();
      } else if (bindingState === "malformed") {
        db.exec("PRAGMA ignore_check_constraints = ON");
        db.prepare(
          "UPDATE operator_approval_execution_identities SET source_context_id = ''",
        ).run();
      } else {
        db.prepare(
          "UPDATE operator_approval_execution_identities SET source_context_id = 'context-other'",
        ).run();
      }
      await resolve(`binding-${bindingState}`, "deny", {
        resolver: { kind: "device", id: "reviewer" },
        nowMs: 3_000,
      });

      const receipts = page({ limit: 10, nowMs: 4_000 }).entries.map((entry) => entry.receipt);
      expect(receipts).toEqual([
        expect.objectContaining({
          decision: { outcome: "unknown", reasonCode },
          enforcement: expect.objectContaining({ coverageState: "unknown", grantRefs: [] }),
          missingEvidence: ["decision.execution_link"],
        }),
      ]);
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
    }
  });
});
