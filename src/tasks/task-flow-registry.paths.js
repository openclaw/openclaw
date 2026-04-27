import path from "node:path";
import { resolveTaskStateDir } from "./task-registry.paths.js";
export function resolveTaskFlowRegistryDir(env = process.env) {
    return path.join(resolveTaskStateDir(env), "flows");
}
export function resolveTaskFlowRegistrySqlitePath(env = process.env) {
    return path.join(resolveTaskFlowRegistryDir(env), "registry.sqlite");
}
