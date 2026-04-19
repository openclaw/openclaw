import path from "node:path";
import { resolveTaskStateDir } from "../tasks/task-registry.paths.js";

export function resolveMinionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveTaskStateDir(env), "minions");
}

export function resolveMinionsSqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveMinionsDir(env), "queue.sqlite");
}

export const MINIONS_DIR_MODE = 0o700;
export const MINIONS_FILE_MODE = 0o600;
export const MINIONS_SIDECAR_SUFFIXES = ["", "-shm", "-wal"] as const;
