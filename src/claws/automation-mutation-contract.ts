import { Value } from "typebox/value";
import { z } from "zod";
import { CronDateTimestampMsSchema } from "../../packages/gateway-protocol/src/schema/cron-shared.js";
import { CRON_JOB_SCRATCH_MAX_BYTES } from "../cron/scratch-contract.js";
import { clawAutomationInstallIntentSchema } from "./automation-install-intent.js";
import { clawMonitorCleanupBindingSchema } from "./monitor-cleanup-contract.js";
import {
  clawRemovalLeaseSchema,
  clawRemovalSourceIdentitySchema,
} from "./removal-journal-contract.js";
import { parseClawOpenClawProfile } from "./schema.js";
import { MAX_CLAW_MANIFEST_BYTES } from "./source-limits.js";

const text = z.string().min(1).max(4096);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const sourceDigest = z.string().regex(/^[a-f0-9]{64}$/u);
const configRevision = z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/u);
const heartbeat = z.unknown().transform((value, ctx) => {
  const parsed = parseClawOpenClawProfile({ schemaVersion: 1, agent: { heartbeat: value } });
  if (!parsed.ok || !parsed.profile.agent.heartbeat) {
    ctx.addIssue({ code: "custom", message: "Invalid portable heartbeat declaration." });
    return z.NEVER;
  }
  return parsed.profile.agent.heartbeat;
});
const source = z
  .object({
    heartbeat,
    scratch: z
      .string()
      .refine((value) => Buffer.byteLength(value) <= CRON_JOB_SCRATCH_MAX_BYTES)
      .optional(),
  })
  .strict();

export const clawAutomationMutationRequestSchema = z
  .object({
    agentId: text,
    binding: clawMonitorCleanupBindingSchema,
    expectedStateDigest: digest,
    mutation: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("import"),
          source,
          expectedSettingsRevision: configRevision,
          install: clawAutomationInstallIntentSchema.optional(),
        })
        .strict(),
      z
        .object({ kind: z.literal("update"), source, expectedSettingsRevision: configRevision })
        .strict(),
      z.object({ kind: z.literal("release") }).strict(),
      z
        .object({
          kind: z.literal("remove"),
          jobId: text,
          expectedInstallDigest: digest,
          deletion: z
            .object({
              databasePath: text,
              sourceIdentity: clawRemovalSourceIdentitySchema,
              agentId: text,
              operationId: text,
              lease: clawRemovalLeaseSchema,
            })
            .strict(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("rollback"),
          previous: z
            .object({
              source,
              configRevision,
              expectedRuntimeDigest: digest,
              nextRunAtMs: z
                .custom<number>((value) => Value.Check(CronDateTimestampMsSchema, value))
                .optional(),
              heartbeat,
              sourceScratchDigest: sourceDigest.optional(),
              sourceAgentDigest: digest.optional(),
            })
            .strict(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("completeTasks"),
          jobId: text,
          sourceScratchDigest: sourceDigest,
        })
        .strict(),
    ]),
  })
  .strict()
  .refine(
    (request) => Buffer.byteLength(JSON.stringify(request)) <= MAX_CLAW_MANIFEST_BYTES,
    "Automation mutation exceeds the Claw manifest byte limit.",
  );

export const clawAutomationMutationResultSchema = z
  .object({ stateDigest: digest, installDigest: digest.optional() })
  .strict();

export type ClawAutomationMutationRequest = z.infer<typeof clawAutomationMutationRequestSchema>;
type ClawAutomationMutationResult = z.infer<typeof clawAutomationMutationResultSchema>;
export type ClawAutomationMutationGateway = (
  request: Omit<ClawAutomationMutationRequest, "binding">,
) => Promise<ClawAutomationMutationResult>;
