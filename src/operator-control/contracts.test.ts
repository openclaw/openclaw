import { describe, expect, it } from "vitest";
import {
  delegatedLeadTaskEnvelopeSchema,
  operatorExternalReceiptSchema,
  outcomeRecordSchema,
  runReceiptSchema,
  taskEnvelopeSchema,
  validationReportSchema,
} from "./contracts.js";

describe("operator-control contracts", () => {
  it("applies defaults to task envelopes", () => {
    const envelope = taskEnvelopeSchema.parse({
      task_id: "task-1",
      idempotency_key: "idem-1",
      requester: { id: "tonya" },
      target: { capability: "backend" },
      objective: "Fix the regression",
      acceptance_criteria: ["tests pass"],
      timeout_s: 600,
    });

    expect(envelope.schema).toBe("TaskEnvelopeV1");
    expect(envelope.tier).toBe("STANDARD");
    expect(envelope.execution).toEqual({
      transport: "delegated-http",
      runtime: "acpx",
      durable: true,
    });
    expect(envelope.context_refs).toEqual([]);
  });

  it("accepts the legacy angela-http transport alias for delegated execution", () => {
    const envelope = taskEnvelopeSchema.parse({
      task_id: "task-legacy-delegated-1",
      idempotency_key: "idem-legacy-delegated-1",
      requester: { id: "tonya" },
      target: { capability: "marketing" },
      objective: "Use the old delegated transport token",
      acceptance_criteria: ["legacy alias remains valid"],
      timeout_s: 600,
      execution: {
        transport: "angela-http",
        runtime: "acpx",
        durable: true,
      },
    });

    expect(envelope.execution.transport).toBe("angela-http");
  });

  it("accepts versioned receipt, outcome, and validation payloads", () => {
    const receipt = runReceiptSchema.parse({
      task_id: "task-1",
      run_id: "run-1",
      state: "queued",
      attempt: 0,
      created_at: 1,
      updated_at: 2,
    });
    const validation = validationReportSchema.parse({
      validation_id: "val-1",
      target_id: "task-1",
      validator: "northstar",
      result: "passed",
      created_at: 3,
      checks: [{ id: "c1", label: "healthz", passed: true }],
    });
    const outcome = outcomeRecordSchema.parse({
      task_id: "task-1",
      run_id: "run-1",
      outcome: "success",
      verification_status: "passed",
      rework_needed: false,
      recorded_at: 4,
    });

    expect(receipt.schema).toBe("RunReceiptV1");
    expect(validation.schema).toBe("ValidationReportV1");
    expect(outcome.schema).toBe("OutcomeRecordV1");
  });

  it("accepts external receipts from multiple worker schemas", () => {
    const delegatedReceipt = operatorExternalReceiptSchema.parse({
      schema: "DelegatedLeadReceiptV1",
      task_id: "task-1",
      run_id: "run-1",
      delegated_run_id: "delegated-run-1",
      upstream_run_id: "run-1",
      state: "completed",
      attempt: 0,
      created_at: 1,
      updated_at: 2,
      result_status: "SUCCESS",
    });

    expect(delegatedReceipt.schema).toBe("DelegatedLeadReceiptV1");
    expect(delegatedReceipt.delegated_run_id).toBe("delegated-run-1");
    expect(delegatedReceipt.upstream_run_id).toBe("run-1");
  });

  it("accepts delegated lead task envelopes and keeps Angela aliases readable", () => {
    const envelope = delegatedLeadTaskEnvelopeSchema.parse({
      schema: "AngelaTaskEnvelopeV1",
      task_id: "task-1",
      run_id: "run-1",
      objective: "Draft investor narrative",
      capability: "marketing",
      requester: { id: "tonya", kind: "operator" },
      acceptance_criteria: ["brief completed"],
      execution: {
        transport: "delegated-http",
        runtime: "acpx",
        durable: true,
      },
    });

    expect(envelope.receipt_schema).toBe("DelegatedLeadReceiptV1");
    expect(envelope.schema).toBe("AngelaTaskEnvelopeV1");
  });
});
