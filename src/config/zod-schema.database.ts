import { z } from "zod";
import { getMixedPostgresAgentError } from "../infra/database-engine/registry.js";
import { projectConfigFieldMetadata } from "./schema.field-metadata.js";
import { SecretInputSchema } from "./zod-schema.secret-input.js";
import { configUiMetadata, sensitive } from "./zod-schema.sensitive.js";

const DatabaseFamilyEngineSchema = z.enum(["sqlite", "postgres"]).register(configUiMetadata, {
  label: "Family Database Engine (Experimental)",
  help: "Override database.engine for this family. Changing an engine requires a port and a restart; it does not migrate existing data. Port, backup/restore, and update refuse mixed-engine installations until family-scoped support is available.",
});

const DatabaseFamilySchema = z.strictObject({ engine: DatabaseFamilyEngineSchema }).optional();

export const DatabaseConfigSchema = z
  .strictObject({
    engine: z.enum(["sqlite", "postgres"]).optional().register(configUiMetadata, {
      label: "Database Engine (Experimental)",
      help: "Default store engine (default: sqlite). Experimental postgres selects supported families unless database.families overrides them; unsupported families stay on SQLite. Changing an engine does not migrate existing data.",
    }),
    families: z
      .strictObject({
        state: DatabaseFamilySchema,
        agent: z
          .strictObject({
            engine: DatabaseFamilyEngineSchema.clone().register(configUiMetadata, {
              label: "Agent Database Engine (Experimental)",
              help: "Agent databases support sqlite in mixed-engine installations. PostgreSQL agents require PostgreSQL for every configurable family until mixed-pair conformance is available.",
            }),
          })
          .optional(),
        workboard: DatabaseFamilySchema,
        logbook: DatabaseFamilySchema,
        "team-reports": DatabaseFamilySchema,
      })
      .optional()
      .register(configUiMetadata, {
        label: "Family Database Engines (Experimental)",
        help: "Optional engine overrides for state, agent, workboard, logbook, and team-reports. Each override requires engine. PostgreSQL agents require PostgreSQL for every configurable family; local safety journals are not configurable. All PostgreSQL families share database.postgres.",
      }),
    postgres: z
      .strictObject({
        connection: SecretInputSchema.refine(
          (value) => typeof value === "string" || value.source !== "store",
          "PostgreSQL bootstrap connection cannot use a store-backed SecretRef; use an env, file or exec SecretRef.",
        )
          .optional()
          .register(sensitive)
          .register(configUiMetadata, {
            label: "PostgreSQL Connection (Experimental)",
            help: "Shared experimental PostgreSQL connection DSN, required when any effective family engine is postgres. Use an env/file/exec SecretRef; store-backed refs cannot bootstrap the database. The host resolves it once before handing it to database workers. Connection failures never fall back to SQLite.",
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
  .superRefine((database, ctx) => {
    const message = getMixedPostgresAgentError({ database });
    if (message) {
      ctx.addIssue({ code: "custom", path: ["families", "agent", "engine"], message });
    }
  })
  .optional()
  .register(configUiMetadata, {
    label: "Database (Experimental)",
    help: "Database engine selection. SQLite is the supported default; experimental PostgreSQL applies to supported store families. Doctor reports each store's engine and warns about stores that remain on SQLite.",
  });

export const { labels: DATABASE_FIELD_LABELS, help: DATABASE_FIELD_HELP } =
  projectConfigFieldMetadata(DatabaseConfigSchema, "database");
