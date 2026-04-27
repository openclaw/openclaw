import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
export function resolveDebugProxyRootDir(env = process.env) {
    return path.join(resolveStateDir(env), "debug-proxy");
}
export function resolveDebugProxyDbPath(env = process.env) {
    return path.join(resolveDebugProxyRootDir(env), "capture.sqlite");
}
export function resolveDebugProxyBlobDir(env = process.env) {
    return path.join(resolveDebugProxyRootDir(env), "blobs");
}
export function resolveDebugProxyCertDir(env = process.env) {
    return path.join(resolveDebugProxyRootDir(env), "certs");
}
