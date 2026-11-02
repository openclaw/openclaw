import { z } from "zod";
import { projectConfigFieldMetadata } from "./schema.field-metadata.js";
import { SecretInputSchema } from "./zod-schema.secret-input.js";
import { configUiMetadata, sensitive } from "./zod-schema.sensitive.js";

const DatabaseFamilyEngineSchema = z.enum(["sqlite", "postgres"]).register(configUiMetadata, {
  label: "Family Database Engine",
  help: "Override database.engine for this family. Changing an engine requires database port --family and a restart; editing config does not migrate existing data. Mixed-engine backup/restore preserves each store's engine, and updates require candidate family support.",
});

const DatabaseFamilySchema = z.strictObject({ engine: DatabaseFamilyEngineSchema }).optional();

export const DatabaseConfigSchema = z
  .strictObject({
    engine: z.enum(["sqlite", "postgres"]).optional().register(configUiMetadata, {
      label: "Database Engine",
      help: "Default store engine (default: sqlite). PostgreSQL supports state, agent, workboard, logbook, and team-reports unless database.families overrides them; safety stores stay local SQLite. Changing an engine does not migrate existing data.",
    }),
    families: z
      .strictObject({
        state: DatabaseFamilySchema,
        agent: DatabaseFamilySchema,
        workboard: DatabaseFamilySchema,
        logbook: DatabaseFamilySchema,
        "team-reports": DatabaseFamilySchema,
      })
      .optional()
      .register(configUiMetadata, {
        label: "Family Database Engines",
        help: "Optional engine overrides for state, agent, workboard, logbook, and team-reports. Each override requires engine. State and agent families may use different engines; local safety journals are not configurable. All PostgreSQL families share database.postgres.",
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
            label: "PostgreSQL Connection",
            help: "Shared PostgreSQL DSN, required when any effective family engine is postgres. Env/file SecretRefs are qualified; TLS and exec-backed DSNs remain experimental pending live qualification. Store-backed refs cannot bootstrap the database. The host resolves it once for database workers. Connection failures never fall back to SQLite.",
          }),
        schemaPrefix: z
          .string()
          .regex(/^[a-z_][a-z0-9_]{0,26}$/)
          .optional()
          .register(configUiMetadata, {
            label: "PostgreSQL Schema Prefix",
            help: "Prefix for new PostgreSQL store schemas (default: openclaw). Use 1–27 lowercase letters, digits, or underscores, starting with a letter or underscore. Existing anchors retain their schema.",
          }),
      })
      .optional()
      .register(configUiMetadata, {
        label: "PostgreSQL",
        help: "PostgreSQL connection and schema naming. PostgreSQL 16–18 are qualified; other admitted majors remain experimental pending conformance. Back up each store schema together with its local SQLite anchor. See the PostgreSQL operator guide for deployment qualification limits.",
      }),
  })
  .optional()
  .register(configUiMetadata, {
    label: "Database",
    help: "Database engine selection. SQLite is the default; PostgreSQL is a supported alternative for the five configurable families. Doctor reports configured and observed engines and warns about mismatches, missing capabilities, or unavailable stores. See the PostgreSQL operator guide for platform and upgrade qualification limits.",
  });

export const { labels: DATABASE_FIELD_LABELS, help: DATABASE_FIELD_HELP } =
  projectConfigFieldMetadata(DatabaseConfigSchema, "database");
