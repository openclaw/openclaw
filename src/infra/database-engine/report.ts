import { listDatabaseEngineStores, selectDatabaseEngine } from "./registry.js";

type Config = Parameters<typeof selectDatabaseEngine>[1];

/** Configured choices only: this report does not claim a store has been opened. */
export function describeDatabaseEngineSelection(config: Config) {
  const defaultEngine = config.database?.engine ?? "sqlite";
  return listDatabaseEngineStores().map((store) => {
    const { id } = store;
    const local = id === "quarantine" || id === "managed-update" || id === "package-activation";
    return {
      id,
      label: store.label,
      default: defaultEngine,
      override: local ? null : (config.database?.families?.[id]?.engine ?? null),
      fixedLocal: local,
      effective: selectDatabaseEngine(store, config),
    };
  });
}

export function formatDatabaseEngineSelection(config: Config): string {
  const families = describeDatabaseEngineSelection(config);
  const choices = families
    .map(
      (family) =>
        `${family.id}: default=${family.default}, override=${family.fixedLocal ? "fixed local" : (family.override ?? "inherit")}, effective=${family.effective}`,
    )
    .join("; ");
  return families.some((family) => family.effective === "postgres")
    ? `${choices}; PostgreSQL is experimental`
    : choices;
}
