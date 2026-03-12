import { z } from "zod";
import { SecretInputSchema } from "./zod-schema.core.js";
import { sensitive } from "./zod-schema.sensitive.js";

const SCHEMA_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const PersistencePostgresSchema = z
  .object({
    url: SecretInputSchema.optional().register(sensitive),
    schema: z
      .string()
      .regex(SCHEMA_NAME_RE, "persistence.postgres.schema must match /^[A-Za-z_][A-Za-z0-9_]*$/")
      .optional(),
    maxConnections: z.number().int().positive().max(64).optional(),
    encryptionKey: SecretInputSchema.optional().register(sensitive),
    exportCompatibility: z.boolean().optional(),
  })
  .strict()
  .optional();

export const PersistenceConfigSchema = z
  .object({
    backend: z.union([z.literal("filesystem"), z.literal("postgres")]).optional(),
    postgres: PersistencePostgresSchema,
  })
  .strict()
  .optional();
