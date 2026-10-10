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

const buildIdentity = z.strictObject({
  account: z
    .string()
    .regex(/^[a-z_][a-z0-9_-]{0,31}$/u)
    .refine((value) => value !== "root"),
  uid: z.number().int().positive().max(2147483647),
  gid: z.number().int().positive().max(2147483647),
  toolchainPath: absolutePath,
  resources: z.strictObject({
    memoryMaxBytes: z.number().int().positive().safe(),
    tasksMax: z.number().int().positive().max(65536),
    buildFreeBytes: z.number().int().positive().safe(),
    runtimeFreeBytes: z.number().int().positive().safe(),
  }),
});

const releaseRetention = z.strictObject({
  version: z.literal(1),
  mode: z.literal("inspect"),
  keepVerifiedGenerations: z.literal(3),
  pins: z.array(z.strictObject({ sha: generation.shape.sha, identity: generation.shape.identity })),
});

export const ImmutableRetainedGenerationSchema = generation.extend({
  publishedRevision: z.number().int().nonnegative(),
  verifiedRevision: z.number().int().nonnegative().nullable(),
});

export const ImmutableInstallDescriptorSchema = z
  .strictObject({
    version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    activationEnabled: z.literal(true).optional(),
    releaseRetention: releaseRetention.optional(),
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
    build: buildIdentity.optional(),
  })
  .refine((value) => (value.version !== 1) === (value.activationEnabled === true), {
    message: "Immutable activation requires an explicitly enabled version-2 or version-3 adoption.",
  })
  .refine((value) => !value.releaseRetention || value.version === 3, {
    message: "Immutable release retention requires an explicitly adopted version-3 bridge.",
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
  releases: z.array(ImmutableRetainedGenerationSchema).optional(),
});

export type ImmutableInstallDescriptor = z.infer<typeof ImmutableInstallDescriptorSchema>;
export type ImmutablePreparedGeneration = z.infer<typeof ImmutablePreparedGenerationSchema>;
export type ImmutableInstallRecord = z.infer<typeof ImmutableInstallRecordSchema>;

export type ImmutableActivationOperation = z.infer<typeof ImmutableActivationOperationSchema>;
export type ImmutableActivationPhase = z.infer<typeof ImmutableActivationPhaseSchema>;
