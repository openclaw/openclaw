import type { DatabaseEngineSelection } from "./types.js";

export function createSqliteFamilyEngines(
  overrides: Partial<DatabaseEngineSelection["effectiveEngines"]> = {},
): DatabaseEngineSelection["effectiveEngines"] {
  return {
    state: "sqlite",
    agent: "sqlite",
    workboard: "sqlite",
    logbook: "sqlite",
    "team-reports": "sqlite",
    quarantine: "sqlite",
    "managed-update": "sqlite",
    "package-activation": "sqlite",
    ...overrides,
  };
}
