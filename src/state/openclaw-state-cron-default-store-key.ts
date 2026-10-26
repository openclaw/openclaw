import path from "node:path";
import { resolveConfigDir } from "../infra/config-dir.js";

/** Derive the default identity from original selectors; this value is never a path to open. */
export function resolvePathDerivedCronDefaultStoreKey(env: NodeJS.ProcessEnv): string {
  return path.resolve(resolveConfigDir(env), "cron", "jobs.json");
}
