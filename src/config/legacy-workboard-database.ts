import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readBackupEngine } from "../infra/database-engine/physical-store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveStateDir } from "./state-dir.js";

const log = createSubsystemLogger("config");

/** Preserve the Workboard-only meaning shipped by openclaw@2026.11.1. */
export function normalizeLegacyWorkboardDatabaseConfig(
  raw: unknown,
  env: NodeJS.ProcessEnv,
): unknown {
  if (!isRecord(raw) || !isRecord(raw.database)) {
    return raw;
  }
  const database = raw.database;
  if (database.engine !== "postgres" || database.families !== undefined) {
    return raw;
  }
  const stateDir = resolveStateDir(env);
  const statePath = path.join(stateDir, "state/openclaw.sqlite");
  const workboardPath = path.join(stateDir, "plugins/workboard/workboard.sqlite");
  if (!fs.existsSync(statePath) || !fs.existsSync(workboardPath)) {
    return raw;
  }
  // Version stamps cannot disambiguate the release branch from main. Only the
  // released physical layout qualifies; real PostgreSQL state keeps its default.
  if (
    readBackupEngine(statePath).engine !== "sqlite" ||
    readBackupEngine(workboardPath).engine !== "postgres"
  ) {
    return raw;
  }
  log.warn(
    "Preserving the 2026.11.1 Workboard-only PostgreSQL setting: Workboard remains on PostgreSQL; shared state and other families remain on SQLite. Save database.engine=sqlite and database.families.workboard.engine=postgres to record this explicitly.",
  );
  return {
    ...raw,
    database: { ...database, engine: "sqlite", families: { workboard: { engine: "postgres" } } },
  };
}
