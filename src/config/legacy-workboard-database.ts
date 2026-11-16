import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readBackupEngine } from "../infra/database-engine/physical-store.js";
import { runSqliteReadOnlyWorkerSync } from "../infra/sqlite-readonly-worker.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveConfigEnvVars } from "./env-substitution.js";
import { applyMergePatch } from "./merge-patch.js";
import { resolveStateDir } from "./state-dir.js";
import type { ConfigFileSnapshot } from "./types.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const log = createSubsystemLogger("config");

/** Pin engine siblings before include reconstruction; connection references stay included. */
export function projectLegacyWorkboardWrite(
  snapshot: Pick<ConfigFileSnapshot, "authoredConfig" | "sourceConfig" | "parsed">,
  next: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): unknown {
  const authored = snapshot.authoredConfig ?? snapshot.sourceConfig;
  if (normalizeLegacyWorkboardDatabaseConfig(authored, env) === authored) {
    return snapshot.parsed;
  }
  const { engine, families } = next.database ?? {};
  return applyMergePatch(snapshot.parsed, { database: { engine, families } });
}

/** Preserve the Workboard-only meaning shipped by openclaw@2026.11.1. */
export function normalizeLegacyWorkboardDatabaseConfig(
  raw: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): OpenClawConfig;
export function normalizeLegacyWorkboardDatabaseConfig(
  raw: unknown,
  env: NodeJS.ProcessEnv,
): unknown;
export function normalizeLegacyWorkboardDatabaseConfig(
  raw: unknown,
  env: NodeJS.ProcessEnv,
): unknown {
  if (!isRecord(raw) || !isRecord(raw.database)) {
    return raw;
  }
  const database = raw.database;
  if (
    resolveConfigEnvVars(database.engine, env) !== "postgres" ||
    database.families !== undefined
  ) {
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
    !runSqliteReadOnlyWorkerSync(statePath, undefined, "state-sqlite-populated") ||
    readBackupEngine(workboardPath).engine !== "postgres"
  ) {
    return raw;
  }
  log.warn(
    "Preserving the 2026.11.1 Workboard-only PostgreSQL setting: Workboard remains on PostgreSQL; shared state and other families remain on SQLite. The next config write records this explicitly.",
  );
  return {
    ...raw,
    database: { ...database, engine: "sqlite", families: { workboard: { engine: "postgres" } } },
  };
}
