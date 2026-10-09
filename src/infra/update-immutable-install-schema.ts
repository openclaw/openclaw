import path from "node:path";
import { z } from "zod";
import { ImmutableRecoveryRuntimeReferenceSchema } from "./package-update-activation-immutable-recovery-schema.js";
import { packageActivationIdentitySchema } from "./package-update-activation-schema.js";
import { ImmutableProtectionSnapshotSchema } from "./update-immutable-protection-schema.js";

const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.resolve(value) === value && !value.includes("\0"));
const generation = z.strictObject({
  sha: z.string().regex(/^[a-f0-9]{40}$/u),
  path: absolutePath,
  identity: packageActivationIdentitySchema,
  buildDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const ImmutableInstallDescriptorSchema = z
  .strictObject({
    version: z.union([z.literal(1), z.literal(2)]),
    activationEnabled: z.literal(true).optional(),
    kind: z.literal("immutable"),
    root: absolutePath,
    rootIdentity: packageActivationIdentitySchema,
    releasesIdentity: packageActivationIdentitySchema,
    current: generation.extend({ pointerIdentity: packageActivationIdentitySchema }),
    service: z.strictObject({
      unit: z.string().min(1).max(256),
      scope: z.literal("system"),
      account: z.string().min(1).max(256),
      stateDir: absolutePath,
      configPath: absolutePath,
      profile: z.string().min(1).max(256).nullable(),
    }),
    runtime: z.strictObject({
      path: absolutePath,
      identity: z.string().min(1).max(256),
    }),
    source: z.literal("https://github.com/openclaw/openclaw.git"),
  })
  .refine((value) => (value.version === 2) === (value.activationEnabled === true), {
    message: "Immutable activation requires an explicitly enabled version-2 adoption.",
  });

export const ImmutablePreparedGenerationSchema = generation.extend({
  preparedAtMs: z.number().int().nonnegative(),
  schemaVersions: z.record(z.string().min(1).max(256), z.number().int().nonnegative()).optional(),
});

const ImmutableActivationPhaseSchema = z.enum([
  "prepared",
  "draining",
  "stopping",
  "stopped",
  "publishing",
  "starting",
  "verifying",
  "rollback-stopping",
  "rollback-publishing",
  "rollback-starting",
  "rolled-back",
  "recovery-required",
]);
const authority = z.strictObject({
  databasePath: absolutePath,
  databaseIdentity: packageActivationIdentitySchema,
  parentIdentity: packageActivationIdentitySchema,
  installKey: absolutePath,
  owner: z.string().min(1).max(4096),
});
const ImmutableActivationOperationSchema = z.strictObject({
  version: z.literal(1),
  operationId: z.uuid(),
  authority,
  phase: ImmutableActivationPhaseSchema,
  previous: generation.extend({ pointerIdentity: packageActivationIdentitySchema }),
  candidate: ImmutablePreparedGenerationSchema,
  serviceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  protection: ImmutableProtectionSnapshotSchema,
  recovery: ImmutableRecoveryRuntimeReferenceSchema,
  startedAtMs: z.number().int().nonnegative(),
  candidateStartedAtMs: z.number().int().nonnegative().optional(),
  servingStartedAtMs: z.number().int().nonnegative().optional(),
  stoppedService: z
    .strictObject({
      controlGroup: z.string().min(1).max(4096),
      pid: z.number().int().positive(),
      processStartTicks: z.string().min(1).max(128),
    })
    .optional(),
  pointerIntent: z
    .strictObject({
      fromIdentity: packageActivationIdentitySchema,
      targetSha: z.string().regex(/^[a-f0-9]{40}$/u),
      temporaryIdentity: packageActivationIdentitySchema,
    })
    .optional(),
  failure: z.string().max(2048).optional(),
});
const activationState = z.strictObject({
  operation: ImmutableActivationOperationSchema.optional(),
  previous: generation.optional(),
  lastResult: z
    .strictObject({
      operationId: z.uuid(),
      outcome: z.enum(["succeeded", "rolled-back"]),
      selectedSha: z.string().regex(/^[a-f0-9]{40}$/u),
      verifiedAtMs: z.number().int().nonnegative(),
      gateway: z
        .strictObject({
          pid: z.number().int().positive(),
          bootId: z.string().min(1).max(256),
          version: z.string().min(1).max(256),
          buildId: z.string().min(1).max(256),
        })
        .optional(),
    })
    .optional(),
});

export const ImmutableInstallRecordSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  descriptor: ImmutableInstallDescriptorSchema,
  prepared: ImmutablePreparedGenerationSchema.nullable(),
  activation: activationState.optional(),
});

export type ImmutableInstallDescriptor = z.infer<typeof ImmutableInstallDescriptorSchema>;
export type ImmutablePreparedGeneration = z.infer<typeof ImmutablePreparedGenerationSchema>;
export type ImmutableInstallRecord = z.infer<typeof ImmutableInstallRecordSchema>;

export type ImmutableActivationOperation = z.infer<typeof ImmutableActivationOperationSchema>;
export type ImmutableActivationPhase = z.infer<typeof ImmutableActivationPhaseSchema>;
