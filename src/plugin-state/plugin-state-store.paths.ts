import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
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

export function resolveLegacyPluginStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "plugin-state");
}

export function resolveLegacyPluginStateSqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveLegacyPluginStateDir(env), "state.sqlite");
}
