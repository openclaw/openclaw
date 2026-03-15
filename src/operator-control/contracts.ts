import { z } from "zod";

export const OPERATOR_TASK_SCHEMA_VERSION = "TaskEnvelopeV1" as const;
export const RUN_RECEIPT_SCHEMA_VERSION = "RunReceiptV1" as const;
export const OUTCOME_RECORD_SCHEMA_VERSION = "OutcomeRecordV1" as const;
export const VALIDATION_REPORT_SCHEMA_VERSION = "ValidationReportV1" as const;
export const ANGELA_TASK_ENVELOPE_SCHEMA_VERSION = "AngelaTaskEnvelopeV1" as const;
export const LEGACY_DELEGATED_EXECUTION_TRANSPORT = "angela-http" as const;
export const CANONICAL_DELEGATED_EXECUTION_TRANSPORT = "delegated-http" as const;

export const OPERATOR_TASK_TIERS = ["LITE", "STANDARD", "HEAVY"] as const;
export const OPERATOR_TASK_STATES = [
  "accepted",
  "queued",
  "started",
  "retrying",
  "blocked",
  "completed",
  "dead-letter",
] as const;
export const OPERATOR_REPLY_TARGET_KINDS = ["session", "task", "webhook"] as const;
export const OPERATOR_CONTEXT_REF_KINDS = ["file", "memory", "session", "url", "artifact"] as const;
export const OPERATOR_REQUESTER_KINDS = ["operator", "agent", "system"] as const;
export const OPERATOR_EXECUTION_TRANSPORTS = [
  "2tony-http",
  "deb-http",
  CANONICAL_DELEGATED_EXECUTION_TRANSPORT,
  LEGACY_DELEGATED_EXECUTION_TRANSPORT,
  "sessions_send",
  "inline",
  "manual",
] as const;
export const OPERATOR_EXECUTION_RUNTIMES = ["acpx", "subagent", "inline"] as const;
export const OPERATOR_OUTCOMES = ["success", "partial", "fail", "blocked"] as const;
export const OPERATOR_VERIFICATION_RESULTS = ["passed", "failed", "waived", "pending"] as const;
export const OPERATOR_EXTERNAL_RECEIPT_STATES = [
  "queued",
  "started",
  "retrying",
  "blocked",
  "completed",
  "dead-letter",
] as const;
export const OPERATOR_EXTERNAL_RECEIPT_SCHEMAS = [
  "2TonyTaskReceiptV1",
  "AngelaTaskReceiptV1",
] as const;

export function canonicalizeOperatorExecutionTransport(
  transport: (typeof OPERATOR_EXECUTION_TRANSPORTS)[number],
):
  | Exclude<
      (typeof OPERATOR_EXECUTION_TRANSPORTS)[number],
      typeof LEGACY_DELEGATED_EXECUTION_TRANSPORT
    >
  | typeof CANONICAL_DELEGATED_EXECUTION_TRANSPORT {
  return transport === LEGACY_DELEGATED_EXECUTION_TRANSPORT
    ? CANONICAL_DELEGATED_EXECUTION_TRANSPORT
    : transport;
}

export function isDelegatedExecutionTransport(
  transport: string | null | undefined,
): transport is
  | typeof CANONICAL_DELEGATED_EXECUTION_TRANSPORT
  | typeof LEGACY_DELEGATED_EXECUTION_TRANSPORT {
  return (
    transport === CANONICAL_DELEGATED_EXECUTION_TRANSPORT ||
    transport === LEGACY_DELEGATED_EXECUTION_TRANSPORT
  );
}

export const operatorContextRefSchema = z.object({
  kind: z.enum(OPERATOR_CONTEXT_REF_KINDS),
  value: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
});

export const operatorReplyTargetSchema = z.object({
  kind: z.enum(OPERATOR_REPLY_TARGET_KINDS),
  value: z.string().trim().min(1),
});

export const operatorExecutionPreferenceSchema = z
  .object({
    // Default new operator work to the delegated first-class-agent boundary.
    transport: z
      .enum(OPERATOR_EXECUTION_TRANSPORTS)
      .default(CANONICAL_DELEGATED_EXECUTION_TRANSPORT),
    runtime: z.enum(OPERATOR_EXECUTION_RUNTIMES).default("acpx"),
    durable: z.boolean().default(true),
  })
  .default({
    transport: CANONICAL_DELEGATED_EXECUTION_TRANSPORT,
    runtime: "acpx",
    durable: true,
  });

export const taskEnvelopeSchema = z.object({
  schema: z.literal(OPERATOR_TASK_SCHEMA_VERSION).default(OPERATOR_TASK_SCHEMA_VERSION),
  task_id: z.string().trim().min(1),
  parent_task_id: z.string().trim().min(1).nullable().optional(),
  idempotency_key: z.string().trim().min(1),
  requester: z.object({
    id: z.string().trim().min(1),
    kind: z.enum(OPERATOR_REQUESTER_KINDS).default("operator"),
  }),
  target: z
    .object({
      capability: z.string().trim().optional().default(""),
      role: z.string().trim().min(1).nullable().optional(),
      team_id: z.string().trim().min(1).nullable().optional(),
      alias: z.string().trim().min(1).nullable().optional(),
    })
    .superRefine((target, ctx) => {
      if (!target.capability && !target.role) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "target capability or role is required",
          path: ["capability"],
        });
      }
    }),
  objective: z.string().trim().min(1),
  tier: z.enum(OPERATOR_TASK_TIERS).default("STANDARD"),
  inputs: z.record(z.string(), z.unknown()).default({}),
  context_refs: z.array(operatorContextRefSchema).default([]),
  acceptance_criteria: z.array(z.string().trim().min(1)).min(1),
  timeout_s: z.number().int().positive().max(86_400),
  reply_to: operatorReplyTargetSchema.nullable().optional(),
  execution: operatorExecutionPreferenceSchema,
});

export const angelaTaskEnvelopeSchema = z.object({
  schema: z
    .literal(ANGELA_TASK_ENVELOPE_SCHEMA_VERSION)
    .default(ANGELA_TASK_ENVELOPE_SCHEMA_VERSION),
  task_id: z.string().trim().min(1),
  run_id: z.string().trim().min(1),
  callback_url: z.string().url().nullable().optional(),
  receipt_schema: z.literal("AngelaTaskReceiptV1").default("AngelaTaskReceiptV1"),
  objective: z.string().trim().min(1),
  capability: z.string().trim().min(1),
  team_id: z.string().trim().min(1).nullable().optional(),
  team_lead: z.string().trim().min(1).nullable().optional(),
  alias: z.string().trim().min(1).nullable().optional(),
  requester: taskEnvelopeSchema.shape.requester,
  acceptance_criteria: z.array(z.string().trim().min(1)).min(1),
  context_refs: z.array(operatorContextRefSchema).default([]),
  inputs: z.record(z.string(), z.unknown()).default({}),
  reply_to: operatorReplyTargetSchema.nullable().optional(),
  execution: operatorExecutionPreferenceSchema,
});

export const runReceiptSchema = z.object({
  schema: z.literal(RUN_RECEIPT_SCHEMA_VERSION).default(RUN_RECEIPT_SCHEMA_VERSION),
  task_id: z.string().trim().min(1),
  run_id: z.string().trim().min(1),
  state: z.enum(OPERATOR_TASK_STATES),
  owner: z.string().trim().min(1).nullable().optional(),
  attempt: z.number().int().min(0),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  queue_latency_ms: z.number().int().min(0).nullable().optional(),
  execution: operatorExecutionPreferenceSchema.optional(),
  artifacts: z.array(z.string().trim().min(1)).default([]),
  failure_code: z.string().trim().min(1).nullable().optional(),
});

export const validationCheckSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  passed: z.boolean(),
  evidence_ref: z.string().trim().min(1).nullable().optional(),
});

export const validationReportSchema = z.object({
  schema: z.literal(VALIDATION_REPORT_SCHEMA_VERSION).default(VALIDATION_REPORT_SCHEMA_VERSION),
  validation_id: z.string().trim().min(1),
  target_id: z.string().trim().min(1),
  validator: z.string().trim().min(1),
  result: z.enum(OPERATOR_VERIFICATION_RESULTS),
  checks: z.array(validationCheckSchema).min(1),
  created_at: z.number().int().nonnegative(),
});

export const outcomeRecordSchema = z.object({
  schema: z.literal(OUTCOME_RECORD_SCHEMA_VERSION).default(OUTCOME_RECORD_SCHEMA_VERSION),
  task_id: z.string().trim().min(1),
  run_id: z.string().trim().min(1),
  outcome: z.enum(OPERATOR_OUTCOMES),
  verification_status: z.enum(OPERATOR_VERIFICATION_RESULTS),
  rework_needed: z.boolean(),
  rework_reason: z.string().trim().min(1).nullable().optional(),
  context_gap_detected: z.boolean().default(false),
  infrastructure_failure: z.boolean().default(false),
  evidence_ref: z.string().trim().min(1).nullable().optional(),
  recorded_at: z.number().int().nonnegative(),
});

export const operatorTaskPatchSchema = z.object({
  state: z.enum(OPERATOR_TASK_STATES),
  owner: z.string().trim().min(1).nullable().optional(),
  attempt: z.number().int().min(0).optional(),
  queue_latency_ms: z.number().int().min(0).nullable().optional(),
  artifacts: z.array(z.string().trim().min(1)).optional(),
  failure_code: z.string().trim().min(1).nullable().optional(),
  note: z.string().trim().min(1).nullable().optional(),
  validation: validationReportSchema.optional(),
  outcome: outcomeRecordSchema.optional(),
});

const operatorExternalReceiptBaseSchema = z.object({
  task_id: z.string().trim().min(1),
  run_id: z.string().trim().min(1),
  delegated_run_id: z.string().trim().min(1).nullable().optional(),
  upstream_run_id: z.string().trim().min(1).nullable().optional(),
  state: z.enum(OPERATOR_EXTERNAL_RECEIPT_STATES),
  owner: z.string().trim().min(1).nullable().optional(),
  attempt: z.number().int().min(0).default(0),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  queue_latency_ms: z.number().int().min(0).nullable().optional(),
  summary: z.string().trim().min(1).nullable().optional(),
  artifacts: z.array(z.string().trim().min(1)).default([]),
  failure_code: z.string().trim().min(1).nullable().optional(),
  result_status: z.enum(["SUCCESS", "FAILED", "RETRY"]).nullable().optional(),
  output: z.record(z.string(), z.unknown()).default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const operatorExternalReceiptSchema = z.discriminatedUnion("schema", [
  operatorExternalReceiptBaseSchema.extend({
    schema: z.literal("2TonyTaskReceiptV1").default("2TonyTaskReceiptV1"),
  }),
  operatorExternalReceiptBaseSchema.extend({
    schema: z.literal("AngelaTaskReceiptV1"),
  }),
]);

export type OperatorTaskTier = (typeof OPERATOR_TASK_TIERS)[number];
export type OperatorTaskState = (typeof OPERATOR_TASK_STATES)[number];
export type OperatorTaskEnvelope = z.infer<typeof taskEnvelopeSchema>;
export type AngelaTaskEnvelope = z.infer<typeof angelaTaskEnvelopeSchema>;
export type OperatorRunReceipt = z.infer<typeof runReceiptSchema>;
export type OperatorOutcomeRecord = z.infer<typeof outcomeRecordSchema>;
export type OperatorValidationReport = z.infer<typeof validationReportSchema>;
export type OperatorTaskPatch = z.infer<typeof operatorTaskPatchSchema>;
export type OperatorExternalReceipt = z.infer<typeof operatorExternalReceiptSchema>;
