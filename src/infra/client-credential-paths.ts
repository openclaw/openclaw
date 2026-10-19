import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";

/** Local inventory must resolve this family without loading its credential writer. */
export function resolveClientCredentialStorePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "client", "credentials.sqlite");
}
