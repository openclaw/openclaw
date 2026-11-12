import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CanaryResult } from "./update-candidate-canary-commands.js";
import {
  UpdateDoctorConfigChangeSchema,
  UpdateDoctorConfigWriteRefusalSchema,
} from "./update-doctor-config-schema.js";
import { UpdateDoctorLintFindingSchema } from "./update-doctor-lint-schema.js";
import type { UpdateRunStep } from "./update-run-record.js";
import { UpdateFailureFactSchema, UpdateRunStepSchema } from "./update-run-schema.js";
import { UpdateSnapshotCapacitySchema } from "./update-snapshot-capacity-schema.js";
import type { UpdateStepResult } from "./update-step-result.js";

/** Package marker: the candidate can rehearse itself for an installed updater. */
export const UPDATE_REHEARSAL_PROTOCOL = 1;
/** Private stderr contract between a rehearsing candidate and its updater. */
export const UPDATE_REHEARSAL_EVENT_PREFIX = "openclaw-update-rehearsal-event: ";
/** The candidate proves its orchestrating process is alive; checks keep their own budgets. */
export const UPDATE_REHEARSAL_HEARTBEAT_MS = 15_000;

const requestSchema = z.object({
  protocol: z.literal(UPDATE_REHEARSAL_PROTOCOL),
  /** The exact source the installed updater resolved; the candidate never re-derives it. */
  config: z.custom<OpenClawConfig>(isRecord),
  sourceBundledPlugins: z
    .object({ packageRoot: z.string().min(1), directory: z.string().min(1).optional() })
    .optional(),
  timeoutMs: z.number().finite().positive().optional(),
  fullIntegrityCheck: z.boolean().optional(),
  gatewayStartupRuntime: z.string().min(1).optional(),
});
export type UpdateRehearsalRequest = z.infer<typeof requestSchema>;

const stepResultSchema = z.object({
  name: z.string().min(1),
  command: z.string(),
  cwd: z.string(),
  durationMs: z.number().finite().nonnegative(),
  exitCode: z.number().int().nullable(),
  stdoutTail: z.string().nullable().optional(),
  stderrTail: z.string().nullable().optional(),
  signal: z
    .custom<NodeJS.Signals>((value) => typeof value === "string")
    .nullable()
    .optional(),
  killed: z.boolean().optional(),
  outputLimitExceeded: z.boolean().optional(),
  termination: z.enum(["exit", "timeout", "no-output-timeout", "signal"]).optional(),
  advisory: z
    .object({
      kind: z.enum([
        "package-post-install-doctor",
        "candidate-runtime-unavailable",
        "recoverable-maintenance",
      ]),
      message: z.string(),
    })
    .optional(),
  warnings: z.array(z.string()).optional(),
  diagnostics: z.array(z.string()).optional(),
  recoverySteps: z
    .array(
      z.union([
        z.object({
          kind: z.enum(["preserve-context", "select-runtime", "continue-update"]),
          command: z.string(),
        }),
        z.object({
          kind: z.enum(["select-runtime", "preserve-context", "continue-update", "deployment"]),
          instruction: z.string(),
        }),
      ]),
    )
    .optional(),
  failureFacts: z.array(UpdateFailureFactSchema).optional(),
  doctorLintFindings: z.array(UpdateDoctorLintFindingSchema).optional(),
  deferredInspectionCheckIds: z.array(z.string()).nullable().optional(),
  configChanges: z.array(UpdateDoctorConfigChangeSchema).optional(),
  configWriteRefusal: UpdateDoctorConfigWriteRefusalSchema.optional(),
  snapshotCapacity: UpdateSnapshotCapacitySchema.optional(),
}) satisfies z.ZodType<UpdateStepResult>;

const receiptSeq = z.number().int().positive();
const processId = z.number().int().positive();
const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heartbeat") }),
  // Receipts: the candidate waits for the updater's answer before it continues.
  z.object({ type: z.literal("progress"), seq: receiptSeq, step: UpdateRunStepSchema }),
  z.object({ type: z.literal("step"), seq: receiptSeq, step: stepResultSchema }),
  // Custody: the updater stops any check the candidate leaves running.
  z.object({ type: z.literal("process"), pid: processId }),
  z.object({ type: z.literal("process-closed"), pid: processId }),
]);
export type UpdateRehearsalEvent =
  | { type: "heartbeat" }
  | { type: "progress"; seq: number; step: UpdateRunStep }
  | { type: "step"; seq: number; step: UpdateStepResult }
  | { type: "process"; pid: number }
  | { type: "process-closed"; pid: number };

const receiptAnswerSchema = z.object({ seq: receiptSeq, ok: z.boolean() });
/** The updater's answer to one receipt, written to the candidate's stdin. */
export type UpdateRehearsalReceiptAnswer = z.infer<typeof receiptAnswerSchema>;

const resultFields = {
  phase: z.enum([
    "doctor",
    "lint",
    "config",
    "plugins",
    "runtime",
    "snapshot",
    "startup",
    "readiness",
  ]),
  durationMs: z.number().finite().nonnegative(),
  logTail: z.array(z.string()),
  steps: z.array(stepResultSchema),
  candidateSchemaVersions: z
    .object({ state: z.number().int().nonnegative(), agent: z.number().int().nonnegative() })
    .optional(),
  gatewayRestartCompletion: z.boolean().optional(),
  doctorConfigWrites: z.boolean().optional(),
  doctorConfigChanges: z.array(UpdateDoctorConfigChangeSchema).optional(),
};
const resultSchema = z.object({
  protocol: z.literal(UPDATE_REHEARSAL_PROTOCOL),
  result: z.discriminatedUnion("status", [
    z.object({ ...resultFields, status: z.literal("ok") }),
    z.object({
      ...resultFields,
      status: z.literal("error"),
      reason: z.enum([
        "doctor-failed",
        "candidate-checks-timeout",
        "candidate-snapshot-failed",
        "runtime-verification-failed",
      ]),
    }),
  ]) satisfies z.ZodType<CanaryResult>,
});

/** A request carries data only; it grants no update or service authority. */
export function parseUpdateRehearsalRequest(value: unknown): UpdateRehearsalRequest | null {
  const parsed = requestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Lines without the prefix are ordinary diagnostics; malformed events are ignored. */
export function parseUpdateRehearsalEventLine(line: string): UpdateRehearsalEvent | null {
  if (!line.startsWith(UPDATE_REHEARSAL_EVENT_PREFIX)) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(line.slice(UPDATE_REHEARSAL_EVENT_PREFIX.length));
  } catch {
    return null;
  }
  const parsed = eventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function formatUpdateRehearsalEventLine(event: UpdateRehearsalEvent): string {
  return `${UPDATE_REHEARSAL_EVENT_PREFIX}${JSON.stringify(event)}\n`;
}

export function formatUpdateRehearsalReceiptAnswer(answer: UpdateRehearsalReceiptAnswer): string {
  return `${JSON.stringify(answer)}\n`;
}

export function parseUpdateRehearsalReceiptAnswer(
  line: string,
): UpdateRehearsalReceiptAnswer | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = receiptAnswerSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Unknown fields are dropped; an unknown phase, reason, or step shape is not a result. */
export function parseUpdateRehearsalResult(value: unknown): CanaryResult | null {
  const parsed = resultSchema.safeParse(value);
  return parsed.success ? parsed.data.result : null;
}
