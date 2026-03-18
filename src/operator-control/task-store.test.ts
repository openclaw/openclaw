import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { invalidateRegistryCache } from "./agent-registry.js";
import { resolveOperatorReferenceSourcePath } from "./reference-paths.js";
import {
  acceptOperatorExternalReceipt,
  applyOperatorExternalReceipt,
  getOperatorTask,
  getOperatorTaskStatusSummary,
  listOperatorTasks,
  listRecoverableDeadLetters,
  patchOperatorTask,
  processPendingReceipts,
  resubmitDeadLetteredTask,
  submitOperatorTask,
} from "./task-store.js";

async function seedOperatorRegistryFixture(): Promise<void> {
  const sourcePath = resolveOperatorReferenceSourcePath("agents.yaml");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(
    sourcePath,
    [
      "operator_runtime:",
      "  transports:",
      "    delegated_http:",
      "      global_default_alias: angela",
      "agents:",
      "  - id: angela",
      "    name: Angela",
      "    specialty: Marketing",
      "    triggers: [marketing]",
      "  - id: bobby-digital",
      "    name: Bobby Digital",
      "    specialty: Engineering",
      "    triggers: [backend, engineering]",
      "teams:",
      "  - id: marketing",
      "    name: Marketing",
      "    lead: angela",
      "    route_via_lead: true",
      "    members: [angela]",
      "    dispatch_transport: delegated-http",
      "    dispatch_default_alias: angela",
      "  - id: engineering",
      "    name: Engineering",
      "    lead: bobby-digital",
      "    route_via_lead: true",
      "    members: [bobby-digital]",
      "    dispatch_transport: delegated-http",
      "    dispatch_default_alias: bobby-digital",
      "",
    ].join("\n"),
    "utf8",
  );
  invalidateRegistryCache({ sourcePath: sourcePath });
}

describe("operator task store", () => {
  it("stores tasks idempotently and tracks lifecycle transitions", async () => {
    await withStateDirEnv("operator-task-store-", async () => {
      const first = submitOperatorTask({
        task_id: "task-1",
        idempotency_key: "idem-1",
        requester: { id: "tonya", kind: "operator" },
        target: { capability: "backend", alias: "raekwon" },
        objective: "Fix API timeout",
        tier: "STANDARD",
        acceptance_criteria: ["typecheck passes"],
        timeout_s: 900,
      });
      const second = submitOperatorTask({
        task_id: "task-1",
        idempotency_key: "idem-1",
        requester: { id: "tonya", kind: "operator" },
        target: { capability: "backend", alias: "raekwon" },
        objective: "Fix API timeout",
        tier: "STANDARD",
        acceptance_criteria: ["typecheck passes"],
        timeout_s: 900,
      });

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.task.receipt.run_id).toBe(first.task.receipt.run_id);

      const queued = patchOperatorTask("task-1", {
        state: "queued",
        owner: "2tony",
        note: "queued for execution",
      });
      const started = patchOperatorTask("task-1", {
        state: "started",
        owner: "2tony",
      });
      const completed = patchOperatorTask("task-1", {
        state: "completed",
        owner: "2tony",
        validation: {
          validation_id: "val-1",
          target_id: "task-1",
          validator: "northstar",
          result: "passed",
          created_at: Date.now(),
          checks: [{ id: "c1", label: "smoke", passed: true }],
        },
        outcome: {
          task_id: "task-1",
          run_id: first.task.receipt.run_id,
          outcome: "success",
          verification_status: "passed",
          rework_needed: false,
          recorded_at: Date.now(),
        },
      });

      expect(queued?.receipt.state).toBe("queued");
      expect(started?.receipt.state).toBe("started");
      expect(completed?.receipt.state).toBe("completed");
      expect(completed?.validation?.result).toBe("passed");
      expect(completed?.outcome?.outcome).toBe("success");
      expect(completed?.events).toHaveLength(4);

      const fetched = getOperatorTask("task-1");
      expect(fetched?.receipt.state).toBe("completed");

      const listed = listOperatorTasks({ state: "completed", limit: 10 });
      expect(listed.tasks).toHaveLength(1);
      expect(listed.summary.completed).toBe(1);

      const status = getOperatorTaskStatusSummary();
      expect(status.primaryOperator).toBe("tonya");
      expect(status.tasks.completed).toBe(1);
    });
  });

  it("rejects invalid task transitions", async () => {
    await withStateDirEnv("operator-task-store-invalid-", async () => {
      submitOperatorTask({
        task_id: "task-2",
        idempotency_key: "idem-2",
        requester: { id: "tonya", kind: "operator" },
        target: { capability: "infra" },
        objective: "Roll out fix",
        tier: "HEAVY",
        acceptance_criteria: ["pods healthy"],
        timeout_s: 1200,
      });

      expect(() =>
        patchOperatorTask("task-2", {
          state: "completed",
        }),
      ).not.toThrow();
      expect(() =>
        patchOperatorTask("task-2", {
          state: "queued",
        }),
      ).toThrow("Invalid task transition: completed -> queued");
    });
  });

  it("applies external worker receipts onto operator tasks", async () => {
    await withStateDirEnv("operator-task-store-receipts-", async () => {
      const created = submitOperatorTask({
        task_id: "task-3",
        idempotency_key: "idem-3",
        requester: { id: "tonya", kind: "operator" },
        target: { capability: "backend" },
        objective: "Bind external receipt",
        tier: "STANDARD",
        acceptance_criteria: ["task completed from receipt"],
        timeout_s: 1200,
      });

      patchOperatorTask("task-3", {
        state: "queued",
        owner: "2tony",
      });

      const completed = applyOperatorExternalReceipt("task-3", {
        schema: "2TonyTaskReceiptV1",
        task_id: "task-3",
        run_id: created.task.receipt.run_id,
        state: "completed",
        owner: "2tony",
        attempt: 0,
        created_at: Date.now() - 1000,
        updated_at: Date.now(),
        summary: "worker finished successfully",
        result_status: "SUCCESS",
        artifacts: ["artifact://report"],
        output: {
          receipt: true,
        },
        metadata: {
          evidence_ref: "task://task-3",
        },
      });

      expect(completed?.receipt.state).toBe("completed");
      expect(completed?.outcome?.outcome).toBe("success");
      expect(completed?.outcome?.verification_status).toBe("pending");
      expect(completed?.receipt.artifacts).toEqual(["artifact://report"]);
    });
  });

  it("applies delegated lead receipts onto marketing tasks", async () => {
    await withStateDirEnv("operator-task-store-angela-receipts-", async () => {
      await seedOperatorRegistryFixture();
      const created = submitOperatorTask({
        task_id: "task-4",
        idempotency_key: "idem-4",
        requester: { id: "tonya", kind: "operator" },
        target: { capability: "marketing", team_id: "marketing" },
        objective: "Bind Angela receipt",
        tier: "STANDARD",
        acceptance_criteria: ["marketing task completed from receipt"],
        timeout_s: 1200,
      });

      patchOperatorTask("task-4", {
        state: "queued",
        owner: "angela",
      });

      const completed = applyOperatorExternalReceipt("task-4", {
        schema: "DelegatedLeadReceiptV1",
        task_id: "task-4",
        run_id: created.task.receipt.run_id,
        state: "completed",
        attempt: 0,
        created_at: Date.now() - 1000,
        updated_at: Date.now(),
        summary: "angela delivered investor narrative",
        result_status: "SUCCESS",
        artifacts: ["artifact://deck-v1"],
        output: {
          campaign: "series-a-prep",
        },
      });

      expect(completed?.receipt.state).toBe("completed");
      expect(completed?.receipt.owner).toBe("angela");
      expect(completed?.outcome?.outcome).toBe("success");
      expect(completed?.receipt.artifacts).toEqual(["artifact://deck-v1"]);
    });
  });

  it("falls back to delegated receipt metadata when owner is omitted", async () => {
    await withStateDirEnv("operator-task-store-angela-target-agent-fallback-", async () => {
      await seedOperatorRegistryFixture();
      const created = submitOperatorTask({
        task_id: "task-5",
        idempotency_key: "idem-5",
        requester: { id: "tonya", kind: "operator" },
        target: { capability: "backend", team_id: "engineering", alias: "bobby-digital" },
        objective: "Bind Bobby receipt without owner",
        tier: "STANDARD",
        acceptance_criteria: ["engineering task completed from receipt"],
        timeout_s: 1200,
      });

      patchOperatorTask("task-5", {
        state: "queued",
        owner: null,
      });

      const completed = applyOperatorExternalReceipt("task-5", {
        schema: "DelegatedLeadReceiptV1",
        task_id: "task-5",
        run_id: created.task.receipt.run_id,
        state: "completed",
        attempt: 0,
        created_at: Date.now() - 1000,
        updated_at: Date.now(),
        summary: "bobby-digital routed the work",
        result_status: "SUCCESS",
        artifacts: [],
        output: {
          receipt: true,
        },
        metadata: {
          resolved_internal_owner: "bobby-digital",
        },
      });

      expect(completed?.receipt.state).toBe("completed");
      expect(completed?.receipt.owner).toBe("bobby-digital");
      expect(completed?.outcome?.outcome).toBe("success");
    });
  });

  it("lists and resubmits recoverable dead-letter tasks until retries are exhausted", async () => {
    await withStateDirEnv("operator-task-store-dead-letter-recovery-", async () => {
      submitOperatorTask({
        task_id: "task-dead-letter-1",
        idempotency_key: "idem-dead-letter-1",
        requester: { id: "tonya", kind: "operator" },
        target: { capability: "backend" },
        objective: "Retry dead-lettered work",
        tier: "STANDARD",
        acceptance_criteria: ["task can be resubmitted"],
        timeout_s: 1200,
        maxRetries: 3,
      });

      patchOperatorTask("task-dead-letter-1", {
        state: "queued",
        owner: "2tony",
      });
      patchOperatorTask("task-dead-letter-1", {
        state: "dead-letter",
        owner: "2tony",
        attempt: 1,
        failure_code: "tool-timeout",
      });

      expect(listRecoverableDeadLetters().map((task) => task.envelope.task_id)).toEqual([
        "task-dead-letter-1",
      ]);

      const resubmitted = resubmitDeadLetteredTask("task-dead-letter-1");
      expect(resubmitted?.receipt.state).toBe("queued");
      expect(resubmitted?.receipt.attempt).toBe(2);
      expect(resubmitted?.outcome).toBeNull();

      patchOperatorTask("task-dead-letter-1", {
        state: "dead-letter",
        owner: "2tony",
        attempt: 3,
        failure_code: "tool-timeout",
      });

      expect(listRecoverableDeadLetters()).toEqual([]);
      expect(() => resubmitDeadLetteredTask("task-dead-letter-1")).toThrow(
        "task task-dead-letter-1 exhausted retries (3/3)",
      );
      expect(getOperatorTask("task-dead-letter-1")?.receipt.state).toBe("dead-letter");
    });
  });

  it("queues out-of-order receipts and replays them once the task state catches up", async () => {
    await withStateDirEnv("operator-task-store-pending-receipts-", async () => {
      await seedOperatorRegistryFixture();
      const created = submitOperatorTask({
        task_id: "task-pending-receipt-1",
        idempotency_key: "idem-pending-receipt-1",
        requester: { id: "tonya", kind: "operator" },
        target: { capability: "marketing" },
        objective: "Queue an out-of-order receipt",
        tier: "STANDARD",
        acceptance_criteria: ["receipt is replayed later"],
        timeout_s: 1200,
      });

      const queued = acceptOperatorExternalReceipt("task-pending-receipt-1", {
        schema: "DelegatedLeadReceiptV1",
        task_id: "task-pending-receipt-1",
        run_id: created.task.receipt.run_id,
        state: "started",
        attempt: 0,
        created_at: Date.now() - 1000,
        updated_at: Date.now(),
        summary: "delegate started work",
      });

      expect(queued).toMatchObject({
        queued: true,
        reason: "Invalid task transition: accepted -> started",
      });
      expect(getOperatorTask("task-pending-receipt-1")?.receipt.state).toBe("accepted");

      patchOperatorTask("task-pending-receipt-1", {
        state: "queued",
        owner: "angela",
      });

      expect(processPendingReceipts()).toMatchObject({
        processed: 1,
        applied: 1,
        requeued: 0,
        remaining: 0,
      });
      expect(getOperatorTask("task-pending-receipt-1")?.receipt.state).toBe("started");
    });
  });
});
