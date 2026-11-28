import {
  isRecord as isPlainRecord,
  omitUndefinedFields,
} from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";
import { updateRecoverySchema } from "./update-recovery.js";
import { UpdateFailureFactSchema } from "./update-run-schema.js";

type RestartSentinelStats = z.infer<typeof restartSentinelStatsSchema>;
type RestartSentinelContinuation = z.infer<typeof restartSentinelContinuationSchema>;

export type RestartSentinelPayload = SchemaContract<
  Omit<z.input<typeof restartSentinelPayloadSchema>, "stats" | "continuation">
> & {
  continuation?: RestartSentinelContinuation | null;
  stats?: RestartSentinelStats | null;
};

// Optional properties are absent from the canonical payload, including when an
// input explicitly supplies undefined. Keep nested diagnostic records untouched.
const restartSentinelLogSchema = z
  .object({
    stdoutTail: z.string().nullish(),
    stderrTail: z.string().nullish(),
    exitCode: z.number().int().nullish(),
  })
  .transform(omitUndefinedFields);
const restartSentinelStepSchema = z
  .object({
    name: z.string(),
    command: z.string(),
    failureFacts: UpdateFailureFactSchema.array().max(5).optional().catch(undefined),
    cwd: z.string().nullish(),
    durationMs: z.number().finite().nullish(),
    log: restartSentinelLogSchema.nullish(),
    advisory: z.boolean().optional(),
  })
  .transform(omitUndefinedFields);
const restartSentinelStepsSchema = z.custom<unknown[]>(Array.isArray).transform((steps, ctx) =>
  steps.map((step) => {
    const parsed = restartSentinelStepSchema.safeParse(step);
    if (parsed.success) {
      return parsed.data;
    }
    ctx.addIssue({ code: "custom", message: "Invalid restart sentinel step" });
    return z.NEVER;
  }),
);
const restartSentinelStatsSchema = z
  .object({
    // Unsupported recovery metadata must not suppress the restart notice.
    recovery: updateRecoverySchema.optional().catch(undefined),
    mode: z.string().optional(),
    root: z.string().optional(),
    target: z.string().optional(),
    requiresRestart: z.boolean().optional(),
    handoffId: z.string().optional(),
    runId: z.string().optional(),
    before: z.custom<Record<string, unknown>>(isPlainRecord).nullish(),
    after: z.custom<Record<string, unknown>>(isPlainRecord).nullish(),
    steps: restartSentinelStepsSchema.optional(),
    reason: z.string().nullish(),
    durationMs: z.number().finite().nullish(),
  })
  .transform(omitUndefinedFields);

const restartSentinelContinuationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("systemEvent"), text: z.string() }),
  z.object({ kind: z.literal("agentTurn"), message: z.string() }),
]);
export const restartSentinelPayloadSchema = z
  .object({
    kind: z.enum(["config-apply", "config-auto-recovery", "config-patch", "update", "restart"]),
    status: z.enum(["ok", "error", "skipped"]),
    ts: z.number().int(),
    sessionKey: z.string().optional(),
    deliveryContext: z
      .object({
        channel: z.string().optional(),
        to: z.string().optional(),
        accountId: z.string().optional(),
      })
      .transform(omitUndefinedFields)
      .transform((value) => (Object.keys(value).length > 0 ? value : undefined))
      .optional(),
    threadId: z.string().optional(),
    message: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    continuation: restartSentinelContinuationSchema
      .nullish()
      .transform((value) => value ?? undefined),
    doctorHint: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    stats: restartSentinelStatsSchema.nullish().transform((value) => value ?? undefined),
  })
  // SQL NULL is canonical absence for optional top-level columns. Keep legacy
  // nulls and empty routes consistent between writes and typed-column reads.
  .transform(omitUndefinedFields);

export function parseRestartSentinelPayload(value: unknown): RestartSentinelPayload | null {
  const parsed = restartSentinelPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function buildRestartSentinelRow(
  payload: RestartSentinelPayload,
  revision: number,
  sentinelKey: string,
) {
  return {
    sentinel_key: sentinelKey,
    version: 1,
    kind: payload.kind,
    status: payload.status,
    ts: payload.ts,
    session_key: payload.sessionKey ?? null,
    thread_id: payload.threadId ?? null,
    delivery_channel: payload.deliveryContext?.channel ?? null,
    delivery_to: payload.deliveryContext?.to ?? null,
    delivery_account_id: payload.deliveryContext?.accountId ?? null,
    message: payload.message ?? null,
    continuation_json: payload.continuation ? JSON.stringify(payload.continuation) : null,
    doctor_hint: payload.doctorHint ?? null,
    stats_json: payload.stats ? JSON.stringify(payload.stats) : null,
    // Debug shadow only. Reads reconstruct exclusively from typed columns above.
    payload_json: JSON.stringify(payload),
    updated_at_ms: revision,
  };
}
