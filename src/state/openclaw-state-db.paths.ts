import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export function resolveOpenClawStateSqliteDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "state");
}

export function resolveOpenClawStateSqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveOpenClawStateSqliteDir(env), "openclaw.sqlite");
}
