import { z } from "zod";
import { projectConfigFieldMetadata } from "./schema.field-metadata.js";
import { SecretInputSchema } from "./zod-schema.secret-input.js";
import { configUiMetadata, sensitive } from "./zod-schema.sensitive.js";

export const DatabaseConfigSchema = z
  .strictObject({
    engine: z.enum(["sqlite", "postgres"]).optional().register(configUiMetadata, {
      label: "Database Engine",
      help: "Store engine. Defaults to sqlite (supported). postgres is experimental and currently applies only to workboard; existing SQLite data cannot be ported yet.",
    }),
    postgres: z
      .strictObject({
        connection: SecretInputSchema.optional().register(sensitive).register(configUiMetadata, {
          label: "PostgreSQL Connection",
          help: "PostgreSQL connection DSN, required when database.engine is postgres. Prefer a SecretRef; the host resolves it before opening the workboard worker. Connection failures never fall back to SQLite.",
        }),
        schemaPrefix: z
          .string()
          .regex(/^[a-z_][a-z0-9_]{0,26}$/)
          .optional()
          .register(configUiMetadata, {
            label: "PostgreSQL Schema Prefix",
            help: "Prefix for new workboard PostgreSQL schemas (default: openclaw). Use 1–27 lowercase letters, digits, or underscores, starting with a letter or underscore. Existing anchors retain their schema.",
          }),
      })
      .optional()
      .register(configUiMetadata, {
        label: "PostgreSQL",
        help: "Experimental workboard PostgreSQL connection and schema naming. Back up both the PostgreSQL schema and its SQLite anchor.",
      }),
  })
  .optional()
  .register(configUiMetadata, {
    label: "Database",
    help: "Database engine selection. SQLite is the supported default; the experimental PostgreSQL pilot currently covers workboard only.",
  });

export const { labels: DATABASE_FIELD_LABELS, help: DATABASE_FIELD_HELP } =
  projectConfigFieldMetadata(DatabaseConfigSchema, "database");
