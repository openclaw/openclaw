import path from "node:path";
import { resolveTaskStateDir } from "./task-registry.paths.js";

export function resolveDurableJobRegistryDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveTaskStateDir(env), "jobs");
}

export function resolveDurableJobRegistrySqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDurableJobRegistryDir(env), "registry.sqlite");
}
