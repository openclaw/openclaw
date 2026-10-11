import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expandHomePrefix } from "../../infra/home-dir.js";
import { resolveConfigDir } from "../../utils.js";
import { readCronStoreStatePath, readCronStoreStatePathInDatabase } from "./config-state.js";

function resolveDefaultCronDir(env: NodeJS.ProcessEnv): string {
  return path.join(resolveConfigDir(env), "cron");
}

function resolveDefaultCronStorePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveDefaultCronDir(env), "jobs.json");
}

/** Resolves the cron jobs store path, expanding home-relative user input. */
export function resolveCronJobsStorePath(
  storePath?: string,
  env: NodeJS.ProcessEnv = process.env,
  stateEnv: NodeJS.ProcessEnv = env,
) {
  const selected = storePath?.trim() || readCronStoreStatePath(stateEnv);
  return resolveSelectedCronJobsStorePath(selected, env);
}

/** Resolve the selected partition on the caller's admitted database connection. */
export function resolveCronJobsStorePathInDatabase(
  db: DatabaseSync,
  storePath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveSelectedCronJobsStorePath(
    storePath?.trim() || readCronStoreStatePathInDatabase(db),
    env,
  );
}

/** Expand an already-selected partition without reading machine state. */
export function resolveSelectedCronJobsStorePath(
  selected: string | undefined,
  env: NodeJS.ProcessEnv,
) {
  if (selected) {
    const raw = selected.trim();
    if (raw.startsWith("~")) {
      return path.resolve(expandHomePrefix(raw, { env }));
    }
    return path.resolve(raw);
  }
  return resolveDefaultCronStorePath(env);
}

/** Resolves the active cron partition from runtime config and environment. */
export function resolveCronJobsStorePathFromConfig(
  cfg: { cron?: unknown },
  env: NodeJS.ProcessEnv = process.env,
  stateEnv: NodeJS.ProcessEnv = env,
): string {
  const store = asOptionalRecord(cfg.cron)?.store;
  return resolveCronJobsStorePath(typeof store === "string" ? store : undefined, env, stateEnv);
}
