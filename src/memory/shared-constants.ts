import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

/** Reserved agent ID for the shared memory store. */
export const SHARED_AGENT_ID = "_shared";

/** Convention directory for shared memory files. */
export function getSharedMemoryConventionDir(): string {
  return path.join(resolveStateDir(), "shared-memory");
}

/** Shared store SQLite path. */
export function getSharedStorePath(): string {
  return path.join(resolveStateDir(), "memory", `${SHARED_AGENT_ID}.sqlite`);
}
