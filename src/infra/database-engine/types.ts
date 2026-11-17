export type DatabaseEngineInput =
  | Readonly<{
      connection: string;
      schemaPrefix: string;
      /** Host-owned credential source; child exec must not inherit its value. */
      connectionEnvKey?: string;
    }>
  | undefined;
export type DatabaseEngineId = "sqlite" | "postgres";

/** Engine identity transported by snapshot workers without importing native openers. */
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
