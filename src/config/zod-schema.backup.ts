import { z } from "zod";
import { SecretInputSchema } from "./zod-schema.core.js";
import { sensitive } from "./zod-schema.sensitive.js";

const BackupRetentionSchema = z
  .object({
    keepDaily: z.number().int().nonnegative().optional(),
    keepWeekly: z.number().int().nonnegative().optional(),
    keepMonthly: z.number().int().nonnegative().optional(),
    maxSnapshots: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

const BackupEncryptionSchema = z
  .object({
    key: SecretInputSchema.optional().register(sensitive),
  })
  .strict()
  .optional();

export const BackupSchema = z
  .object({
    target: z.string().min(1).optional(),
    retention: BackupRetentionSchema,
    encryption: BackupEncryptionSchema,
  })
  .strict()
  .optional();
