import type { DatabaseStoreDiagnostic } from "./diagnostics.js";
import { listDatabaseEngineStores, selectDatabaseEngine } from "./registry.js";

type Config = Parameters<typeof selectDatabaseEngine>[1];

/** Configured choices only: this report does not claim a store has been opened. */
export function describeDatabaseEngineSelection(
  config: Config,
  stores?: readonly Pick<DatabaseStoreDiagnostic, "family" | "configured">[],
) {
  const defaultEngine = config.database?.engine ?? "sqlite";
  return listDatabaseEngineStores().map((store) => {
    const { id } = store;
    const local = id === "quarantine" || id === "managed-update" || id === "package-activation";
    const configured = stores?.find((entry) => entry.family === id)?.configured;
    return {
      id,
      label: store.label,
      default: configured?.default ?? defaultEngine,
      override: configured
        ? configured.override
        : local
          ? null
          : (config.database?.families?.[id]?.engine ?? null),
      fixedLocal: local,
      effective: configured?.effective ?? selectDatabaseEngine(store, config),
    };
  });
}

export function formatDatabaseEngineSelection(
  config: Config,
  stores?: readonly Pick<DatabaseStoreDiagnostic, "family" | "configured">[],
): string {
  const families = describeDatabaseEngineSelection(config, stores);
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
