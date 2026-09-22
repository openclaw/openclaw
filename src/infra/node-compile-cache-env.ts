import * as module from "node:module";
import path from "node:path";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// The launcher publishes this same fact before importing built runtime chunks.
// Node's cache cannot be reset during this instance's lifetime; neither can its owner fact.
const COMPILE_CACHE_BASE_KEY = Symbol.for("openclaw.nodeCompileCacheBase");

function compileCacheOwner() {
  return resolveGlobalSingleton<{ baseDirectory?: string }>(COMPILE_CACHE_BASE_KEY, () => ({}));
}

/** Enable through OpenClaw, retaining only the input to a successful first enable. */
export function enableOwnedNodeCompileCache(directory: string): void {
  const baseDirectory = path.resolve(directory);
  const result = module.enableCompileCache(directory);
  const enabled = module.constants?.compileCacheStatus?.ENABLED;
  if (enabled !== undefined && result?.status === enabled) {
    compileCacheOwner().baseDirectory ??= baseDirectory;
  }
}

export function resolveNodeCompileCacheEnv(env = process.env): NodeJS.ProcessEnv {
  if (env.NODE_COMPILE_CACHE !== undefined || env.NODE_DISABLE_COMPILE_CACHE !== undefined) {
    return env;
  }
  // Getter and ALREADY_ENABLED directories are Node-owned leaves, not child cache bases.
  const directory = compileCacheOwner().baseDirectory;
  return directory ? { ...env, NODE_COMPILE_CACHE: directory } : env;
}
