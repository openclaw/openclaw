import { resolveSafeNodeCompileCacheDirectory } from "../../node-compile-cache.mjs";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// The launcher publishes this same fact before importing built runtime chunks.
// Node's cache cannot be reset during this instance's lifetime; neither can its owner fact.
const COMPILE_CACHE_BASE_KEY = Symbol.for("openclaw.nodeCompileCacheBase");

function compileCacheOwner() {
  return resolveGlobalSingleton<{ baseDirectory?: string }>(COMPILE_CACHE_BASE_KEY, () => ({}));
}

export function resolveNodeCompileCacheEnv(env = process.env): NodeJS.ProcessEnv {
  if (env.NODE_DISABLE_COMPILE_CACHE !== undefined) {
    return env;
  }
  // Getter and ALREADY_ENABLED directories are Node-owned leaves, not child cache bases.
  const directory = env.NODE_COMPILE_CACHE ?? compileCacheOwner().baseDirectory;
  if (directory && !resolveSafeNodeCompileCacheDirectory(directory)) {
    const disabled: NodeJS.ProcessEnv = { ...env, NODE_DISABLE_COMPILE_CACHE: "1" };
    delete disabled.NODE_COMPILE_CACHE;
    return disabled;
  }
  if (env.NODE_COMPILE_CACHE !== undefined) {
    return env;
  }
  return directory ? { ...env, NODE_COMPILE_CACHE: directory } : env;
}
