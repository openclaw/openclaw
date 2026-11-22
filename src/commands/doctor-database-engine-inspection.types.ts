import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DatabaseStoreDiagnostic } from "../infra/database-engine/diagnostics.js";
import type { BackupEngine } from "../infra/database-engine/physical-store.js";
import type { DatabaseEngineFamily, DatabaseEngineId } from "../infra/database-engine/types.js";

export type DoctorDatabaseEngineInspectionInput = {
  config: OpenClawConfig;
  stateDir: string;
  env: NodeJS.ProcessEnv;
};
export type ObservedDatabaseEngines = Partial<Record<DatabaseEngineFamily, DatabaseEngineId[]>>;
export type DoctorDatabaseEngineInspection = {
  observed: ObservedDatabaseEngines;
  stateRoots: { path: string; physical: BackupEngine }[];
  discoveryFailed: boolean;
  stores?: DatabaseStoreDiagnostic[];
};
