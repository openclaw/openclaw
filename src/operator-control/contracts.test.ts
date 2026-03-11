import { describe, expect, it } from "vitest";
import {
  angelaTaskEnvelopeSchema,
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
      transport: "2tony-http",
      runtime: "acpx",
      durable: true,
    });
    expect(envelope.context_refs).toEqual([]);
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
    const angelaReceipt = operatorExternalReceiptSchema.parse({
      schema: "AngelaTaskReceiptV1",
      task_id: "task-1",
      run_id: "run-1",
      state: "completed",
      attempt: 0,
      created_at: 1,
      updated_at: 2,
      result_status: "SUCCESS",
    });

    expect(angelaReceipt.schema).toBe("AngelaTaskReceiptV1");
  });

  it("accepts Angela task envelopes", () => {
    const envelope = angelaTaskEnvelopeSchema.parse({
      schema: "AngelaTaskEnvelopeV1",
      task_id: "task-1",
      run_id: "run-1",
      objective: "Draft investor narrative",
      capability: "marketing",
      requester: { id: "tonya", kind: "operator" },
      acceptance_criteria: ["brief completed"],
      execution: {
        transport: "angela-http",
        runtime: "acpx",
        durable: true,
      },
    });

    expect(envelope.receipt_schema).toBe("AngelaTaskReceiptV1");
    expect(envelope.schema).toBe("AngelaTaskEnvelopeV1");
  });
});
