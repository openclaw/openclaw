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
  return (
    /module is not defined|ReferenceError.*\bmodule\b/.test(msg) ||
    /require is not defined|ReferenceError.*\brequire\b/.test(msg)
  );
}

/** True if the error indicates require() of an ESM module (so we should try import). */
function isRequireOfEsmError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /require\(\) of ES Module is not supported|Cannot use import statement/.test(msg);
}

/**
 * Load a hook handler module from a file path.
 * For .js and .cjs we try require() first so CJS hooks never hit "require is not defined" when
 * Node parses them as ESM. For .mjs we use import() only. On ESM-style errors we fall back to the other loader.
 */
export async function loadHookModule(filePath: string): Promise<Record<string, unknown>> {
  const resolved = path.resolve(filePath);
  const ext = path.extname(resolved).toLowerCase();
  const tryRequireFirst = ext === ".cjs" || ext === ".js";

  if (tryRequireFirst) {
    try {
      return require(resolved) as Record<string, unknown>;
    } catch (err) {
      if (isRequireOfEsmError(err)) {
        const url = pathToFileURL(resolved).href;
        return (await import(`${url}?t=${Date.now()}`)) as Record<string, unknown>;
      }
      throw err;
    }
  }

  const url = pathToFileURL(resolved).href;
  const cacheBustedUrl = `${url}?t=${Date.now()}`;
  try {
    return (await import(cacheBustedUrl)) as Record<string, unknown>;
  } catch (err) {
    if (isCjsInEsmError(err)) {
      return require(resolved) as Record<string, unknown>;
    }
    throw err;
  }
}

/**
 * Get the handler function from a loaded module.
 * - CJS module.exports = fn: mod is the function.
 * - ESM export default fn: mod.default is the function.
 * - Object with .handle (e.g. Foundry-style): wrap so (event) => obj.handle(event.context ?? {}).
 */
export function getHandlerFromModule(mod: Record<string, unknown>, exportName: string): unknown {
  if (exportName === "default" && typeof mod === "function") {
    return mod;
  }
  const value = mod[exportName];
  if (typeof value === "function") {
    return value;
  }
  // Accept default export that is an object with .handle (Foundry-style); wrap for internal (event) => handler.handle(event.context)
  if (
    exportName === "default" &&
    value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).handle === "function"
  ) {
    const obj = value as { handle: (ctx: unknown) => void | Promise<void> };
    return (event: { context?: Record<string, unknown> }) =>
      Promise.resolve(obj.handle(event.context ?? {}));
  }
  return value;
}
