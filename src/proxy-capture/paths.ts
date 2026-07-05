<<<<<<< HEAD
// Proxy capture path helpers resolve certificate artifacts.
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

// Debug proxy CA files live under OpenClaw state. Capture data lives in the
// shared global state database.
=======
// Proxy capture path helpers resolve capture directories and database paths.
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

// Debug proxy capture artifacts live under OpenClaw state so DB, blobs, and CA
// files are grouped and easy to purge.
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
function resolveDebugProxyRootDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "debug-proxy");
}

<<<<<<< HEAD
/** @deprecated Capture storage now lives in the shared state database. */
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
export function resolveDebugProxyDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDebugProxyRootDir(env), "capture.sqlite");
}

<<<<<<< HEAD
/** @deprecated Capture payloads now live in the shared state database. */
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
export function resolveDebugProxyBlobDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDebugProxyRootDir(env), "blobs");
}

export function resolveDebugProxyCertDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDebugProxyRootDir(env), "certs");
}
