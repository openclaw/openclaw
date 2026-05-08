import path from "node:path";
import {
  resolveOpenClawStateSqliteDir,
  resolveOpenClawStateSqlitePath,
} from "../state/openclaw-state-db.paths.js";
import { resolveTaskStateDir } from "./task-registry.paths.js";

export function resolveTaskFlowRegistryDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveOpenClawStateSqliteDir(env);
}

export function resolveTaskFlowRegistrySqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveOpenClawStateSqlitePath(env);
}

export function resolveLegacyTaskFlowRegistrySqlitePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveTaskStateDir(env), "flows", "registry.sqlite");
}
