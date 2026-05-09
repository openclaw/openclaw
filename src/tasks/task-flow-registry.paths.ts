import {
  resolveOpenClawStateSqliteDir,
  resolveOpenClawStateSqlitePath,
} from "../state/openclaw-state-db.paths.js";

export function resolveTaskFlowRegistryDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveOpenClawStateSqliteDir(env);
}

export function resolveTaskFlowRegistrySqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveOpenClawStateSqlitePath(env);
}
