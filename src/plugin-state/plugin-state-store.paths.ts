import {
  resolveOpenClawStateSqliteDir,
  resolveOpenClawStateSqlitePath,
} from "../state/openclaw-state-db.paths.js";

export function resolvePluginStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveOpenClawStateSqliteDir(env);
}

export function resolvePluginStateSqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveOpenClawStateSqlitePath(env);
}
