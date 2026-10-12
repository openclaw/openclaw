import { z } from "zod";
import { projectConfigFieldMetadata } from "./schema.field-metadata.js";
import { SecretInputSchema } from "./zod-schema.secret-input.js";
import { configUiMetadata, sensitive } from "./zod-schema.sensitive.js";

export const DatabaseConfigSchema = z
  .strictObject({
    engine: z.enum(["sqlite", "postgres"]).optional().register(configUiMetadata, {
      label: "Database Engine (Experimental)",
      help: "Store engine (default: sqlite). Experimental postgres selects every store with a registered PostgreSQL schema; other stores stay on SQLite. Existing SQLite data cannot be ported yet.",
    }),
    postgres: z
      .strictObject({
        connection: SecretInputSchema.optional().register(sensitive).register(configUiMetadata, {
          label: "PostgreSQL Connection (Experimental)",
          help: "Experimental PostgreSQL connection DSN, required when database.engine is postgres. Prefer a SecretRef; the host resolves it before handing it to database workers. Connection failures never fall back to SQLite.",
        }),
        schemaPrefix: z
          .string()
          .regex(/^[a-z_][a-z0-9_]{0,26}$/)
          .optional()
          .register(configUiMetadata, {
            label: "PostgreSQL Schema Prefix (Experimental)",
            help: "Prefix for new experimental PostgreSQL store schemas (default: openclaw). Use 1–27 lowercase letters, digits, or underscores, starting with a letter or underscore. Existing anchors retain their schema.",
          }),
      })
      .optional()
      .register(configUiMetadata, {
        label: "PostgreSQL (Experimental)",
        help: "Experimental PostgreSQL connection and schema naming. Back up each PostgreSQL store schema together with its SQLite anchor.",
      }),
  })
  .optional()
  .register(configUiMetadata, {
    label: "Database (Experimental)",
    help: "Database engine selection. SQLite is the supported default; experimental PostgreSQL currently supports workboard. Doctor reports each store's engine and warns about stores that remain on SQLite.",
  });

export const { labels: DATABASE_FIELD_LABELS, help: DATABASE_FIELD_HELP } =
  projectConfigFieldMetadata(DatabaseConfigSchema, "database");
