import path from "node:path";
import { z } from "zod";

export const STATE_RECOVERY_PREPARATION_CHILD_ARG = "--openclaw-state-recovery-preparation-child";

const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0") && path.resolve(value) === value);

export const stateRecoveryPreparationRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("prepare-state"),
      baselinePath: absolutePath,
      candidatePath: absolutePath,
      targetPath: absolutePath,
    })
    .strict()
    .superRefine((value, context) => {
      if (new Set([value.baselinePath, value.candidatePath, value.targetPath]).size !== 3) {
        context.addIssue({
          code: "custom",
          message: "Recovery generation paths must be distinct.",
        });
      }
    }),
  z.object({ operation: z.literal("sanitize-state"), targetPath: absolutePath }).strict(),
  z
    .object({
      operation: z.literal("compare-agent"),
      baselinePath: absolutePath,
      candidatePath: absolutePath,
      agentId: z.string().min(1),
      supportedVersion: z.number().int().positive(),
    })
    .strict(),
]);
export type StateRecoveryPreparationRequest = z.infer<typeof stateRecoveryPreparationRequestSchema>;

const fileIdentitySchema = z
  .object({
    dev: z.string().regex(/^\d+$/u),
    ino: z.string().regex(/^\d+$/u),
    size: z.string().regex(/^\d+$/u),
    mtimeNs: z.string().regex(/^\d+$/u),
    birthtimeNs: z.string().regex(/^\d+$/u),
  })
  .strict();

export const stateRecoveryPreparationResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), identity: fileIdentitySchema.optional() }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.string().min(1).max(8192),
      code: z.string().min(1).max(128).optional(),
    })
    .strict(),
]);
