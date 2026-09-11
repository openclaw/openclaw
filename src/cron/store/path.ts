import path from "node:path";
/** Cron partition path resolution without loading the store writer. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expandHomePrefix } from "../../infra/home-dir.js";
import { resolveConfigDir } from "../../utils.js";
import { readCronStoreStatePath } from "./config-state.js";

function resolveDefaultCronDir(env: NodeJS.ProcessEnv): string {
  return path.join(resolveConfigDir(env), "cron");
}

function resolveDefaultCronStorePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveDefaultCronDir(env), "jobs.json");
}

/** Resolves the cron jobs store path, expanding home-relative user input. */
export function resolveCronJobsStorePath(storePath?: string, env: NodeJS.ProcessEnv = process.env) {
  const selected = storePath?.trim() || readCronStoreStatePath(env);
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
): string {
  const store = isRecord(cfg.cron) ? cfg.cron.store : undefined;
  return resolveCronJobsStorePath(typeof store === "string" ? store : undefined, env);
}
