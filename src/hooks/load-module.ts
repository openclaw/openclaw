/**
 * Shared hook module loader: ESM first, CJS fallback.
 * Used by internal hooks loader and plugin hooks so both support CJS hooks
 * (e.g. "module is not defined in ES module scope" from Foundry/installed packs).
 */

import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/** True if the error indicates the module is CJS but was loaded as ESM. */
export function isCjsInEsmError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /module is not defined|ReferenceError.*\bmodule\b/.test(msg);
}

/**
 * Load a hook handler module from a file path. Tries ESM import first;
 * if that fails with "module is not defined" (CJS in ESM context), falls back to require().
 */
export async function loadHookModule(filePath: string): Promise<Record<string, unknown>> {
  const url = pathToFileURL(path.resolve(filePath)).href;
  const cacheBustedUrl = `${url}?t=${Date.now()}`;
  try {
    return (await import(cacheBustedUrl)) as Record<string, unknown>;
  } catch (err) {
    if (isCjsInEsmError(err)) {
      return require(filePath) as Record<string, unknown>;
    }
    throw err;
  }
}

/**
 * Get the handler function from a loaded module. Handles CJS module.exports = fn.
 */
export function getHandlerFromModule(mod: Record<string, unknown>, exportName: string): unknown {
  if (exportName === "default" && typeof mod === "function") {
    return mod;
  }
  return mod[exportName];
}
