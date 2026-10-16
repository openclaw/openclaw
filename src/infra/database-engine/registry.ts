import type { DatabaseEngineFamily, DatabaseEngineId } from "./types.js";
export type { DatabaseEngineId } from "./types.js";

// Keep schema validation independent of the complete, schema-inferred application config.
type DatabaseEngineConfig = {
  database?: {
    engine?: DatabaseEngineId;
    families?: Partial<
      Record<
        Exclude<DatabaseEngineFamily, "quarantine" | "managed-update" | "package-activation">,
        { engine: DatabaseEngineId }
      >
    >;
  };
};

export type DatabaseEngineStore = {
  id: DatabaseEngineFamily;
  label: string;
  postgres?: boolean;
};

// Store families, including local safety journals, without loading plugin code.
const stores: readonly DatabaseEngineStore[] = [
  { id: "state", label: "Shared state", postgres: true },
  { id: "agent", label: "Agent data", postgres: true },
  { id: "workboard", label: "Workboard", postgres: true },
  { id: "logbook", label: "Logbook", postgres: true },
  { id: "team-reports", label: "Team Reports", postgres: true },
  { id: "quarantine", label: "Database quarantine" },
  { id: "managed-update", label: "Managed update handoffs" },
  { id: "package-activation", label: "Package activation journal" },
];

export function listDatabaseEngineStores(): readonly DatabaseEngineStore[] {
  return stores;
}

export function selectDatabaseEngine(
  store: Pick<DatabaseEngineStore, "id" | "postgres">,
  config: DatabaseEngineConfig,
): DatabaseEngineId {
  const override =
    store.id === "quarantine" || store.id === "managed-update" || store.id === "package-activation"
      ? undefined
      : config.database?.families?.[store.id]?.engine;
  if (override === "postgres" && !store.postgres) {
    throw new Error(`database.families.${store.id}.engine does not support postgres.`);
  }
  return (
    override ?? (config.database?.engine === "postgres" && store.postgres ? "postgres" : "sqlite")
  );
}

export function getMixedPostgresAgentError(config: DatabaseEngineConfig): string | undefined {
  if (
    (config.database?.families?.agent?.engine ?? config.database?.engine) === "postgres" &&
    stores.some((store) => store.postgres && selectDatabaseEngine(store, config) !== "postgres")
  ) {
    return "DATABASE_AGENT_MIXED_POSTGRES_UNSUPPORTED: Agent PostgreSQL with mixed engines requires the mixed-pair conformance in PR3; select SQLite for agents or use PostgreSQL for every configurable family.";
  }
  return undefined;
}

export function resolveDatabaseFamilyEngines(
  config: DatabaseEngineConfig,
): Record<DatabaseEngineFamily, DatabaseEngineId> {
  const agentError = getMixedPostgresAgentError(config);
  if (agentError) {
    throw new Error(agentError);
  }
  const effectiveEngines: Record<DatabaseEngineFamily, DatabaseEngineId> = {
    state: "sqlite",
    agent: "sqlite",
    workboard: "sqlite",
    logbook: "sqlite",
    "team-reports": "sqlite",
    quarantine: "sqlite",
    "managed-update": "sqlite",
    "package-activation": "sqlite",
  };
  for (const store of stores) {
    effectiveEngines[store.id] = selectDatabaseEngine(store, config);
  }
  return effectiveEngines;
}

/** Fixed-local stores do not turn the existing PostgreSQL default into a mixed installation. */
export function assertHomogeneousDatabaseEngines(
  config: DatabaseEngineConfig,
  operation: "port" | "backup" | "restore" | "update",
): void {
  const engines = new Set(
    stores.filter((store) => store.postgres).map((store) => selectDatabaseEngine(store, config)),
  );
  if (engines.size > 1) {
    throw new Error(
      `${operation} for mixed-engine installs is not supported yet; use a single engine for PostgreSQL-capable families, or wait for family-scoped port, backup, and update support. Changing an engine does not migrate existing data.`,
    );
  }
}
