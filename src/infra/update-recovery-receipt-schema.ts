import path from "node:path";
import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const updateRecoveryWarningSchema = z.strictObject({
  kind: z.literal("undeclared-migration-resources"),
  pluginId: z.string().min(1),
  message: z.string().min(1),
});

const updateRecoveryConfigWriteSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !value.includes("\0") && path.resolve(value) === value),
  beforeHash: sha256.nullable(),
  afterHash: sha256.nullable(),
  contiguous: z.boolean(),
});

const updateRecoveryRetirementSchema = z.strictObject({
  directory: z.string().min(1).max(4096),
  installRoot: z.string().min(1).max(4096),
  stateDir: z.string().min(1).max(4096),
  configPath: z.string().min(1).max(4096),
  identity: z.strictObject({ dev: z.number(), ino: z.number(), birthtimeMs: z.number() }),
  outcome: z.enum(["committed", "restored"]),
  // Present only after every retained generation has passed terminal verification.
  generations: z
    .array(
      z.strictObject({
        kind: z.enum(["candidate", "prepared"]),
        manifestSha256: sha256,
        identity: z.strictObject({ dev: z.number(), ino: z.number(), birthtimeMs: z.number() }),
      }),
    )
    .max(2)
    .optional(),
});

const updateRecoveryForwardResolutionSchema = z.strictObject({
  kind: z.literal("forward-resolved"),
  binding: z.strictObject({
    runId: z.string().min(1),
    failedAtMs: z.number().int().nonnegative(),
    manifestSha256: sha256,
    candidateSha256: sha256.nullable(),
    preparedSha256: sha256.nullable(),
    incompleteGenerations: z
      .strictObject({
        candidate: sha256.optional(),
        prepared: sha256.optional(),
      })
      .optional(),
    installRoot: z.string().min(1),
    stateDir: z.string().min(1),
    configPath: z.string().min(1),
  }),
  repair: z.strictObject({
    root: z.string().min(1),
    packageSha256: sha256,
    node: z.string().min(1),
    nodeVersion: z.string().min(1),
    build: z.string().min(1),
    artifact: z.strictObject({
      rootIdentity: z.string().min(1),
      module: z.string().min(1),
      entry: z.string().min(1),
      inventorySha256: sha256,
      executableIdentity: z.string().min(1),
      executableSha256: sha256,
    }),
  }),
  completedAtMs: z.number().int().nonnegative(),
});

export const updateRecoveryCaptureStateSchema = z.strictObject({
  manifestSha256: sha256,
  configWrites: z.array(updateRecoveryConfigWriteSchema).max(512),
  warnings: z.array(updateRecoveryWarningSchema).optional(),
  status: z.enum(["pending", "restore-failed"]),
  error: z.string().max(4096).optional(),
  doctorCompleted: z.boolean().optional(),
  restored: z.literal(true).optional(),
  retirement: updateRecoveryRetirementSchema.optional(),
  forwardResolution: updateRecoveryForwardResolutionSchema.optional(),
});
