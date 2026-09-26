import { z } from "zod";
import {
  UPDATE_RUN_DRIVER_LIMIT,
  UPDATE_RUN_PHASES,
  UPDATE_RUN_STATUSES,
  UPDATE_RUN_STEP_STATUSES,
  UPDATE_RUN_TRIGGERS,
} from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import {
  UpdateDoctorConfigChangeSchema,
  UpdateDoctorConfigWriteRefusalSchema,
} from "./update-doctor-config-schema.js";
import { updateRecoveryCaptureStateSchema } from "./update-recovery-receipt-schema.js";
import { updateRecoverySchema } from "./update-recovery.js";
import { UpdateRunDriverSchema as driver } from "./update-run-driver-schema.js";
import { UPDATE_RUN_TEXT_LIMIT, UPDATE_RUN_DIAGNOSTIC_LIMIT } from "./update-run-limits.js";
import { UpdateSnapshotCapacitySchema } from "./update-snapshot-capacity-schema.js";

export const UPDATE_ADMISSION_PROTOCOL = 1;

const admissionText = z.string().min(1);
const admissionIdentifier = (maxBytes: number) =>
  admissionText.refine((value) => Buffer.byteLength(value) <= maxBytes);
const admissionReasonCode = admissionIdentifier(80);
const admissionVersion = admissionIdentifier(128);

const UpdateAdmissionCheckSchema = z.object({
  name: admissionIdentifier(128),
  status: z.enum(["ok", "warn", "refuse"]),
  detail: admissionText.optional(),
});

const UpdateAdmissionVerdictSchema = z
  .object({
    protocol: z.literal(UPDATE_ADMISSION_PROTOCOL),
    verdict: z.enum(["admit", "refuse"]),
    reasons: z
      .array(
        z.object({
          code: admissionReasonCode,
          message: admissionText,
          nextAction: admissionText.optional(),
        }),
      )
      .max(UPDATE_RUN_DIAGNOSTIC_LIMIT),
    warnings: z.array(z.object({ code: admissionText, message: admissionText })),
    facts: z.object({
      candidateVersion: admissionVersion,
      installedVersion: admissionVersion.nullable(),
      nodeEngines: z.string().optional(),
      checks: z.array(UpdateAdmissionCheckSchema).max(UPDATE_RUN_DIAGNOSTIC_LIMIT),
    }),
  })
  .refine(
    (value) =>
      new Set(value.facts.checks.map((check) => check.name)).size === value.facts.checks.length,
  )
  .refine((value) =>
    value.verdict === "refuse"
      ? value.reasons.length > 0
      : value.reasons.length === 0 &&
        value.facts.checks.every((check) => check.status !== "refuse"),
  )
  .refine((value) => {
    const checks = value.facts.checks.map((check) => ({
      ...check,
      ...(check.detail !== undefined ? { detail: "" } : {}),
    }));
    const identity = {
      admission: {
        owner: "candidate",
        protocol: value.protocol,
        candidateVersion: value.facts.candidateVersion,
        checks,
      },
      candidateAdmission: {
        ...value,
        reasons: value.reasons.map((reason) => ({
          ...reason,
          message: "",
          ...(reason.nextAction !== undefined ? { nextAction: "" } : {}),
        })),
        warnings: [],
        facts: { ...value.facts, checks },
      },
    };
    // Leave room in origin's 16 KiB for eight maximally escaped driver
    // identities and the remaining origin field names, even after all prose shrinks.
    return Buffer.byteLength(JSON.stringify(identity)) <= 2 * UPDATE_RUN_TEXT_LIMIT;
  });

export type UpdateAdmissionVerdict = z.infer<typeof UpdateAdmissionVerdictSchema>;

export function parseUpdateAdmissionVerdict(value: unknown): UpdateAdmissionVerdict | null {
  const parsed = UpdateAdmissionVerdictSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const verdict = parsed.data;
  return {
    ...verdict,
    // Warnings cannot invalidate a decision or spend authoritative receipt capacity.
    warnings: verdict.warnings
      .filter((warning) => admissionReasonCode.safeParse(warning.code).success)
      .slice(0, UPDATE_RUN_DIAGNOSTIC_LIMIT),
  };
}

const destinationPath = z.string().max(240);
export const UpdateDestinationFailureSchema = z.strictObject({
  ownership: z.enum(["foreign", "unknown"]),
  cause: z.enum([
    "package-mismatch",
    "launcher-mismatch",
    "permission",
    "probe-failure",
    "unreadable-layout",
  ]),
  destinationKind: z.enum(["npm-global", "unknown"]),
  prefix: destinationPath.nullable(),
  packageRoot: destinationPath.nullable(),
  runningRoot: destinationPath,
  runningPrefix: destinationPath.nullable(),
  launcher: destinationPath.nullable(),
  launcherTarget: destinationPath.nullable(),
});

export const UpdateFailureFactSchema = z.object({
  check: z.string().max(128),
  code: z.string().max(80),
  message: z.string().max(200).optional(),
  affectedKey: z.string().max(128).optional(),
  pluginId: z.string().max(80).optional(),
  errorName: z.string().max(80).nullable().optional(),
  location: z.string().max(160).nullable().optional(),
  destination: UpdateDestinationFailureSchema.optional(),
});

const UpdateRollbackOutcomeSchema = z.object({
  status: z.enum(["not-needed", "not-attempted", "succeeded", "failed"]),
  reason: z.string().max(512),
});

export type UpdateRollbackOutcome = z.infer<typeof UpdateRollbackOutcomeSchema>;

const text = z.string().max(UPDATE_RUN_TEXT_LIMIT);
const admissionCheck = z.object({
  name: text,
  status: UpdateAdmissionCheckSchema.shape.status,
  detail: text.optional(),
});
const admissionChecks = z.array(admissionCheck).max(UPDATE_RUN_DIAGNOSTIC_LIMIT);
const admission = z.object({
  owner: z.enum(["candidate", "installed"]),
  protocol: UpdateAdmissionVerdictSchema.shape.protocol.optional(),
  candidateVersion: text.optional(),
  checks: admissionChecks.optional(),
  fallbackReason: text.optional(),
});
// The ledger bounds diagnostic text independently of the command's wire verdict.
const candidateAdmission = z.object({
  protocol: UpdateAdmissionVerdictSchema.shape.protocol,
  verdict: UpdateAdmissionVerdictSchema.shape.verdict,
  reasons: z
    .array(z.object({ code: text, message: text, nextAction: text.optional() }))
    .max(UPDATE_RUN_DIAGNOSTIC_LIMIT),
  warnings: z.array(z.object({ code: text, message: text })).max(UPDATE_RUN_DIAGNOSTIC_LIMIT),
  facts: z.object({
    candidateVersion: text,
    installedVersion: text.nullable(),
    nodeEngines: text.optional(),
    checks: admissionChecks,
  }),
});
const timestamp = z.number().int().nonnegative();
const version = z.object({
  version: text.nullable().optional(),
  sha: text.nullable().optional(),
  buildId: text.nullable().optional(),
});

const UpdateRunStepSchema = z.object({
  step: text,
  status: z.enum(UPDATE_RUN_STEP_STATUSES),
  startedAtMs: timestamp.optional(),
  endedAtMs: timestamp.optional(),
  exitCode: z.number().int().nullable().optional(),
  detail: text.optional(),
  failureFacts: z.array(UpdateFailureFactSchema).max(5).optional(),
  configChange: z
    .discriminatedUnion("kind", [
      UpdateDoctorConfigChangeSchema.options[0].extend({ key: text }),
      UpdateDoctorConfigChangeSchema.options[1].extend({ message: text }),
    ])
    .optional(),
  configWriteRefusal: UpdateDoctorConfigWriteRefusalSchema.extend({
    reason: text,
    message: text,
    keys: z.array(text).max(UPDATE_RUN_DIAGNOSTIC_LIMIT),
  }).optional(),
  snapshotCapacity: UpdateSnapshotCapacitySchema.extend({
    candidates: z
      .array(
        UpdateSnapshotCapacitySchema.shape.candidates.element.extend({
          directory: text,
          allocationError: text.optional(),
        }),
      )
      .max(3),
    selection: UpdateSnapshotCapacitySchema.shape.selection
      .unwrap()
      .extend({ directory: text })
      .nullable(),
  }).optional(),
});

export const UpdateRunRecordSchema = z.object({
  runId: z.uuid(),
  createdAtMs: timestamp,
  updatedAtMs: timestamp,
  trigger: z.enum(UPDATE_RUN_TRIGGERS),
  phase: z.enum(UPDATE_RUN_PHASES),
  status: z.enum(UPDATE_RUN_STATUSES),
  reason: text.nullable(),
  admission: admission.optional(),
  origin: z.object({
    admission: admission.optional(),
    candidateAdmission: candidateAdmission.optional(),
    updateRecoveryCapture: updateRecoveryCaptureStateSchema.optional(),
    driver: driver.optional(),
    previousDrivers: z
      .array(driver)
      .max(UPDATE_RUN_DRIVER_LIMIT - 1)
      .optional(),
    requester: z
      .object({
        channel: text.optional(),
        accountId: text.optional(),
        senderId: text.optional(),
        authorizationSource: text.optional(),
      })
      .optional(),
    sessionKey: text.optional(),
    deliveryContext: z
      .object({
        channel: text.optional(),
        to: text.optional(),
        accountId: text.optional(),
        threadId: text.optional(),
      })
      .optional(),
    campaignId: text.optional(),
    doctorHint: text.optional(),
    nextAction: text.optional(),
  }),
  target: z.object({
    channel: text.optional(),
    tag: text.optional(),
    kind: z.enum(["package", "git"]).optional(),
    version: text.optional(),
    sha: text.optional(),
    installationMethod: z
      .enum(["git-checkout", "npm-global", "pnpm-global", "bun-global", "managed-service"])
      .nullable()
      .optional(),
  }),
  before: version,
  after: version,
  steps: z.array(UpdateRunStepSchema).max(128),
  verification: z.object({
    rollbackOutcome: UpdateRollbackOutcomeSchema.nullable().optional(),
    recovery: updateRecoverySchema.nullable().optional(),
    booted: z.boolean().optional(),
    runningVersion: text.optional(),
    runningBuildId: text.optional(),
    serviceRunning: z.boolean().optional(),
    pid: timestamp.optional(),
    port: z.number().int().min(1).max(65535).optional(),
    versionMatch: z.boolean().optional(),
    pluginErrors: z.array(text).max(32).optional(),
    channelsReady: z.boolean().optional(),
    readyz: z.boolean().optional(),
    settled: z.boolean().optional(),
    noticeDelivered: z.boolean().optional(),
    doctorHint: text.optional(),
  }),
  repair: z
    .array(
      z.object({
        attempt: z.number().int().positive(),
        status: z.enum(["succeeded", "failed", "skipped"]),
        startedAtMs: timestamp,
        endedAtMs: timestamp.optional(),
        summary: text.optional(),
        reason: text.optional(),
      }),
    )
    .max(16),
  confirmedAtMs: timestamp.nullable(),
  finishedAtMs: timestamp.nullable(),
  downtimeMs: timestamp.nullable(),
});
