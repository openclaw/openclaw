import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

function resolveDebugProxyRootDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "debug-proxy");
}

export function resolveDebugProxyDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveOpenClawStateSqlitePath(env);
}

export function resolveDebugProxyBlobDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDebugProxyRootDir(env), "blobs");
}

export function resolveDebugProxyCertDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDebugProxyRootDir(env), "certs");
}
