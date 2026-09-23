import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { recordAuditEventInDatabase } from "./audit-event-store.js";
import { recordExecutionDecisionFactInDatabase } from "./execution-decision-facts.js";
import { receipt } from "./execution-decision-facts.test-support.js";
import { ExecutionDecisionCursorError } from "./execution-decision-receipts.js";
import { createExecutionIdentityAdmissionToken } from "./execution-identity-admission.js";
import { inspectExecutionIdentityRun } from "./execution-identity-context.js";
import {
  prepareExecutionIdentityContextAtAdmission,
  recordDeniedApprovalForRun,
} from "./execution-identity.test-support.js";
import { bindExecutionOwnerLifecycleMetadata } from "./execution-owner-lifecycle-binding-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const now = 200;
const stages = [
  { prefix: "a", owner: "operator_approvals" },
  { prefix: "m", owner: "audit_events" },
  { prefix: "g", owner: "tool-policy" },
  { prefix: "c", owner: "cron_run_receipts" },
  { prefix: "t", owner: "task_runs" },
  { prefix: "f", owner: "flow_runs" },
] as const;
type Stage = (typeof stages)[number]["prefix"];
let options: { env: { OPENCLAW_STATE_DIR: string } };
let db: DatabaseSync;

function inspect(decisionCursor: string, executionId = "execution-local") {
  return inspectExecutionIdentityRun(
    { executionId, decisionCursor, decisionLimit: 1 },
    { ...options, now },
  );
}

beforeAll(async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("decision-cursors-") } };
  const database = openOpenClawStateDatabase(options);
  db = database.db;
  for (const scope of ["local", "foreign", "sibling"]) {
    const context = prepareExecutionIdentityContextAtAdmission(
      {
        runId: scope === "sibling" ? "run-local" : `run-${scope}`,
        agentId: "main",
        ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
        runtime: { kind: "embedded" },
      },
      {
        ...options,
        contextId: `context-${scope}`,
        executionId: `execution-${scope}`,
        runtimeInstanceId: `runtime-${scope}`,
        now: 50,
      },
    );
    const token = createExecutionIdentityAdmissionToken(context.runId, {
      contextId: context.contextId,
      executionId: context.executionId,
      now: context.createdAt,
    });
    for (const index of [1, 2]) {
      const id = `${scope}-${index}`;
      await recordDeniedApprovalForRun(context.runId, options, `approval-${id}`, context);
      expect(
        recordAuditEventInDatabase(
          {
            sourceId: `message-${id}`,
            sourceSequence: 1,
            occurredAt: now,
            kind: "message",
            action: "message.outbound.finished",
            status: "succeeded",
            outcome: "sent",
            actorType: "agent",
            actorId: "main",
            agentId: "main",
            runId: context.runId,
            executionIdentityToken: token,
            direction: "outbound",
            channel: "qa-channel",
            conversationKind: "direct",
            resultCount: 1,
          },
          { ...options, database },
        ),
      ).toBeDefined();
      expect(
        recordExecutionDecisionFactInDatabase(
          {
            ...receipt(`generic-${id}`, now),
            contextId: context.contextId,
            executionId: context.executionId,
            runId: context.runId,
          },
          { ...options, database, now },
        ),
      ).toBe("inserted");
      db.prepare(`INSERT INTO cron_run_receipts (
        receipt_id, store_key, job_id, config_revision, agent_id, request_run_id,
        status, owner_pid, started_at_ms, finished_at_ms
      ) VALUES (?, 'default', ?, 'revision-1', 'main', ?, 'ok', 1, ?, ?)`).run(
        `cron-${id}`,
        `job-${id}`,
        context.runId,
        now,
        now,
      );
      db.prepare(`INSERT INTO task_runs (
        task_id, runtime, owner_key, scope_kind, task, status, delivery_status,
        notify_policy, created_at
      ) VALUES (?, 'cron', 'fixture-owner', 'system', 'fixture task', 'succeeded',
        'not_applicable', 'silent', ?)`).run(`task-${id}`, now);
      db.prepare(`INSERT INTO flow_runs (
        flow_id, owner_key, status, notify_policy, goal, created_at, updated_at
      ) VALUES (?, 'fixture-owner', 'succeeded', 'silent', 'fixture goal', ?, ?)`).run(
        `flow-${id}`,
        now,
        now,
      );
      for (const ownerKind of ["cron", "task", "flow"] as const) {
        expect(
          bindExecutionOwnerLifecycleMetadata({
            db,
            ownerKind,
            ownerId: `${ownerKind}-${id}`,
            binding: context,
          }),
        ).toBe("bound");
      }
    }
  }
});

afterAll(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

const removeAnchor: Record<Stage, () => void> = {
  a: () => {
    db.prepare("DELETE FROM operator_approvals WHERE approval_id = ?").run("approval-local-1");
  },
  m: () => {
    db.prepare(
      "DELETE FROM audit_events WHERE sequence = (SELECT MIN(sequence) FROM audit_events)",
    ).run();
  },
  g: () => {
    db.prepare("DELETE FROM execution_decision_facts WHERE receipt_id = ?").run("generic-local-1");
  },
  c: () => {
    db.prepare("DELETE FROM cron_run_receipts WHERE receipt_id = ?").run("cron-local-1");
  },
  t: () => {
    db.prepare("DELETE FROM task_runs WHERE task_id = ?").run("task-local-1");
  },
  f: () => {
    db.prepare("DELETE FROM flow_runs WHERE flow_id = ?").run("flow-local-1");
  },
};

describe("inspection decision cursor rejection matrix", () => {
  it.each(stages)(
    "rejects malformed and unretained $prefix anchors through inspection",
    async ({ prefix, owner }) => {
      const first = await inspect(`${prefix}:0:0`);
      expect(first.decisions).toHaveLength(1);
      expect(first.decisions[0]?.source.owner).toBe(owner);
      const cursor = first.nextDecisionCursor;
      expect(cursor).toMatch(new RegExp(`^${prefix}:${now}:[1-9]\\d*$`));
      if (!cursor) {
        throw new Error("Expected an owner cursor with another row at the same timestamp");
      }
      const second = await inspect(cursor);
      expect(second.decisions).toHaveLength(1);
      expect(second.decisions[0]?.source.owner).toBe(owner);
      expect(second.decisions[0]?.receiptId).not.toBe(first.decisions[0]?.receiptId);

      for (const suffix of [
        "-1:1",
        "1:-1",
        "1.5:1",
        "1:1.5",
        "01:1",
        "1:01",
        "9007199254740992:1",
        "1:9007199254740992",
        "1",
        "1:1:extra",
      ]) {
        await expect(inspect(`${prefix}:${suffix}`)).rejects.toThrow(
          "invalid execution decision cursor",
        );
      }
      const rowId = cursor.split(":")[2];
      for (const invalid of [
        `${prefix}:${now + 1}:${rowId}`,
        `${prefix}:${now}:9007199254740991`,
      ]) {
        await expect(inspect(invalid)).rejects.toThrow(
          "decision cursor is no longer retained; restart inspection without --cursor",
        );
      }
      await expect(inspect(cursor, "execution-foreign")).rejects.toBeInstanceOf(
        ExecutionDecisionCursorError,
      );
      await expect(inspect(cursor, "execution-foreign")).rejects.toThrow(
        "decision cursor is no longer retained; restart inspection without --cursor",
      );
      if (prefix === "a") {
        // Approvals page the run correlation and expose a mismatched execution
        // only as unknown evidence; the other owners scope their cursor itself.
        const sibling = await inspect(cursor, "execution-sibling");
        expect(sibling.decisions).toHaveLength(1);
        expect(sibling.decisions[0]).toMatchObject({
          contextId: "context-sibling",
          executionId: "execution-sibling",
          runId: "run-local",
          decision: {
            outcome: "unknown",
            reasonCode: "operator_approval_execution_link_mismatch",
          },
          enforcement: { coverageState: "unknown", grantRefs: [] },
          missingEvidence: ["decision.execution_link"],
        });
      } else {
        await expect(inspect(cursor, "execution-sibling")).rejects.toThrow(
          "decision cursor is no longer retained; restart inspection without --cursor",
        );
      }
      removeAnchor[prefix]();
      await expect(inspect(cursor)).rejects.toThrow(
        "decision cursor is no longer retained; restart inspection without --cursor",
      );
      expect((await inspect(`${prefix}:0:0`)).decisions[0]?.receiptId).toBe(
        second.decisions[0]?.receiptId,
      );
    },
  );
});
