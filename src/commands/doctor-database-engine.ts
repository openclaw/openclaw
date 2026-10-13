import { note } from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import {
  listDatabaseEngineStores,
  selectDatabaseEngine,
} from "../infra/database-engine/registry.js";

export function collectDatabaseEngineHealthFindings(cfg: OpenClawConfig): HealthFinding[] {
  if (cfg.database?.engine !== "postgres") {
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
  const lines = listDatabaseEngineStores().map(
    (store) => `${store.label}: ${selectDatabaseEngine(store, cfg)}`,
  );
  for (const finding of collectDatabaseEngineHealthFindings(cfg)) {
    lines.push("", finding.message, finding.fixHint ?? "");
  }
  note(lines.join("\n"), "Database engines");
}
