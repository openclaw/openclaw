export type DatabaseEngineInput =
  | Readonly<{
      connection: string;
      schemaPrefix: string;
      /** Host-owned credential source; child exec must not inherit its value. */
      connectionEnvKey?: string;
      /** Existing sealed stores only; the connection never admits writes or migration. */
      readOnly?: true;
      /** Opt-in: rollback captures keep their rows on the server instead of a SQLite image. */
      serverRecoveryCaptures?: true;
      /** database.postgres.ownership installation: Gateway state ownership is held in PostgreSQL. */
      ownership?: "installation";
    }>
  | undefined;
export type DatabaseEngineId = "sqlite" | "postgres";
export type BackupEngine =
  | { engine: "sqlite" }
  | { engine: "postgres"; storeId: string; namespace: string };
export type DatabaseEngineFamily =
  | "state"
  | "agent"
  | "workboard"
  | "logbook"
  | "team-reports"
  | "quarantine"
  | "managed-update"
  | "package-activation";

export type DatabaseEngineSelection = Readonly<{
  effectiveEngines: Readonly<Record<DatabaseEngineFamily, DatabaseEngineId>>;
  postgres?: Exclude<DatabaseEngineInput, undefined>;
}>;
