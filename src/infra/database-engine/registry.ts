import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DatabaseEngineId } from "./types.js";
export type { DatabaseEngineId } from "./types.js";

export type DatabaseEngineStore = {
  id: string;
  label: string;
  postgres?: boolean;
};

// Store families, including local safety journals, without loading plugin code.
const stores: readonly DatabaseEngineStore[] = [
  { id: "state", label: "Shared state" },
  { id: "agent", label: "Agent data" },
  { id: "workboard", label: "Workboard", postgres: true },
  { id: "logbook", label: "Logbook" },
  { id: "quarantine", label: "Database quarantine" },
  { id: "managed-update", label: "Managed update handoffs" },
  { id: "package-activation", label: "Package activation journal" },
];

export function listDatabaseEngineStores(): readonly DatabaseEngineStore[] {
  return stores;
}

export function selectDatabaseEngine(
  store: Pick<DatabaseEngineStore, "postgres">,
  config: Pick<OpenClawConfig, "database">,
): DatabaseEngineId {
  return config.database?.engine === "postgres" && store.postgres ? "postgres" : "sqlite";
}
