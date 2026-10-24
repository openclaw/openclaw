import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import {
  resolveDatabasePath,
  resolveOpenClawStateDirForDatabasePath,
  resolveOpenClawStateSqlitePath,
} from "../state/openclaw-state-db.paths.js";

/** Local inventory must resolve this family without loading its credential writer. */
export function resolveClientCredentialStorePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "client", "credentials.sqlite");
}

/** Only the canonical shared file owns the native client's local companion. */
export function resolveStateClientCredentialEnvironment(options: {
  path: string;
  env: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv | undefined {
  const pathname = resolveDatabasePath({ path: options.path });
  const env = {
    ...options.env,
    OPENCLAW_STATE_DIR: resolveOpenClawStateDirForDatabasePath(pathname),
  };
  return pathname === resolveOpenClawStateSqlitePath(env) ? env : undefined;
}
