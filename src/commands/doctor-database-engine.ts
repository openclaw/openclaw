import { note } from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import {
  listDatabaseEngineStores,
  resolveDatabaseFamilyEngines,
  selectDatabaseEngine,
} from "../infra/database-engine/registry.js";

export function collectDatabaseEngineHealthFindings(cfg: OpenClawConfig): HealthFinding[] {
  if (!Object.values(resolveDatabaseFamilyEngines(cfg)).includes("postgres")) {
    return [];
  }
  return [
    {
      checkId: "core/doctor/database-engine",
      severity: "warning",
      source: "doctor",
      path: "database.engine",
      message:
        "The PostgreSQL database engine is experimental. Stores without a registered PostgreSQL schema remain on SQLite.",
      fixHint:
        "Review the store engine selections and https://docs.openclaw.ai/reference/database-engines before using this configuration.",
    },
  ];
}

export function noteDatabaseEngines(cfg: OpenClawConfig): void {
  const defaultEngine = cfg.database?.engine ?? "sqlite";
  const lines = listDatabaseEngineStores().map((store) => {
    const { id } = store;
    const local = id === "quarantine" || id === "managed-update" || id === "package-activation";
    const override = local ? "fixed local" : (cfg.database?.families?.[id]?.engine ?? "inherit");
    return `${store.label}: default=${defaultEngine}, override=${override}, effective=${selectDatabaseEngine(store, cfg)} (configured)`;
  });
  for (const finding of collectDatabaseEngineHealthFindings(cfg)) {
    lines.push("", finding.message, finding.fixHint ?? "");
  }
  note(lines.join("\n"), "Database engines");
}
