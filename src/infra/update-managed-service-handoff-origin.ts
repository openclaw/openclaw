import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import type { ForegroundUpdateOrigin } from "./update-restart-sentinel-payload.js";

export function hasForegroundUpdatePaths(
  origin: ForegroundUpdateOrigin,
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    resolvePathViaExistingAncestorSync(resolveOpenClawStateSqlitePath(env)) ===
      origin.stateDatabasePath &&
    resolvePathViaExistingAncestorSync(resolveConfigPath(env, resolveStateDir(env))) ===
      origin.configPath
  );
}
