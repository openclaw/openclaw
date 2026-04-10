import path from "node:path";
import { resolveTaskStateDir } from "./task-registry.paths.js";

export function resolveTaskFlowRegistryDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveTaskStateDir(env), "flows");
}

export function resolveTaskFlowRegistrySqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveTaskFlowRegistryDir(env), "registry.sqlite");
}
