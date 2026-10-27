import { z } from "zod";

export const witnessIdentifierSchema = z.string().max(256);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const headerInteger = z.number().int().min(-2147483648).max(2147483647);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const registryRowSchema = z
  .object({ store: digest, locator: digest, schemaVersion: headerInteger, sha256: digest })
  .strict();
const tableSchema = z
  .object({
    name: witnessIdentifierSchema,
    columns: z.array(witnessIdentifierSchema).min(1).max(256),
    rowCount: count,
    sha256: digest,
    migrationSha256: digest,
    registryRows: z.array(registryRowSchema).max(4096).optional(),
  })
  .strict();
export const witnessSchema = z
  .object({
    version: z.literal(1),
    role: z.enum(["agent", "global", "sqlite"]),
    schemaVersion: headerInteger,
    applicationId: headerInteger,
    agentId: witnessIdentifierSchema.min(1).nullable(),
    schemaSha256: digest,
    migrationSchemaSha256: digest,
    registryMigrationBinding: digest.nullable(),
    tables: z.array(tableSchema).max(512),
    gaps: z.object({ missingWindows: count, emptyWindows: count }).strict(),
  })
  .strict();

export type OpenClawMigrationWitness = z.infer<typeof witnessSchema>;
