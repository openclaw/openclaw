// Proxy capture path helpers resolve certificate artifacts.
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

// Debug proxy CA files live under OpenClaw state. Capture data lives in the
// shared global state database.
function resolveDebugProxyRootDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "debug-proxy");
}

export function resolveDebugProxyCertDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDebugProxyRootDir(env), "certs");
}
