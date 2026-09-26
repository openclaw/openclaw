import path from "node:path";
import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const updateRecoveryWarningSchema = z
  .object({
    kind: z.literal("undeclared-migration-resources"),
    pluginId: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

const updateRecoveryConfigWriteSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes("\0") && path.resolve(value) === value),
    beforeHash: sha256.nullable(),
    afterHash: sha256.nullable(),
    contiguous: z.boolean(),
  })
  .strict();

const updateRecoveryRetirementSchema = z
  .object({
    directory: z.string().min(1).max(4096),
    installRoot: z.string().min(1).max(4096),
    stateDir: z.string().min(1).max(4096),
    configPath: z.string().min(1).max(4096),
    identity: z.object({ dev: z.number(), ino: z.number(), birthtimeMs: z.number() }).strict(),
    outcome: z.enum(["committed", "restored"]),
    inventoryVersion: z.literal(1).optional(),
    // Present only after every retained generation has passed terminal verification.
    generations: z
      .array(
        z
          .object({
            kind: z.enum(["candidate", "prepared"]),
            manifestSha256: sha256,
            sourceAttestation: z
              .object({ path: z.string().min(1), sha256 })
              .strict()
              .optional(),
            identity: z
              .object({ dev: z.number(), ino: z.number(), birthtimeMs: z.number() })
              .strict(),
          })
          .strict(),
      )
      .max(2)
      .optional(),
  })
  .strict();

const updateRecoveryForwardResolutionSchema = z
  .object({
    kind: z.literal("forward-resolved"),
    binding: z
      .object({
        runId: z.string().min(1),
        failedAtMs: z.number().int().nonnegative(),
        manifestSha256: sha256,
        candidateSha256: sha256.nullable(),
        preparedSha256: sha256.nullable(),
        incompleteGenerations: z
          .object({
            candidate: sha256.optional(),
            prepared: sha256.optional(),
          })
          .strict()
          .optional(),
        installRoot: z.string().min(1),
        stateDir: z.string().min(1),
        configPath: z.string().min(1),
      })
      .strict(),
    repair: z
      .object({
        root: z.string().min(1),
        packageSha256: sha256,
        node: z.string().min(1),
        nodeVersion: z.string().min(1),
        build: z.string().min(1),
        artifact: z
          .object({
            rootIdentity: z.string().min(1),
            module: z.string().min(1),
            entry: z.string().min(1),
            inventorySha256: sha256,
            executableIdentity: z.string().min(1),
            executableSha256: sha256,
          })
          .strict(),
      })
      .strict(),
    completedAtMs: z.number().int().nonnegative(),
  })
  .strict();

export const updateRecoveryCaptureStateSchema = z
  .object({
    manifestSha256: sha256,
    configWrites: z.array(updateRecoveryConfigWriteSchema).max(512),
    warnings: z.array(updateRecoveryWarningSchema).optional(),
    status: z.enum(["pending", "restore-failed"]),
    error: z.string().max(4096).optional(),
    doctorCompleted: z.boolean().optional(),
    restored: z.literal(true).optional(),
    // Sealed by the original C/T producer before reverse publication; never
    // reconstructed from whatever files happen to remain at terminal cleanup.
    generation: z
      .object({
        operationId: z.string().min(1),
        candidateSha256: sha256,
        preparedSha256: sha256,
        sourceAttestation: z.object({ path: z.string().min(1), sha256 }).strict(),
      })
      .strict()
      .optional(),
    retirement: updateRecoveryRetirementSchema.optional(),
    forwardResolution: updateRecoveryForwardResolutionSchema.optional(),
  })
  .strict();
