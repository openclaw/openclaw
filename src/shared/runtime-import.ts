/**
 * Runtime import helpers for lazy modules that may be loaded from file URLs or platform paths.
 * Windows paths need normalization before Node's ESM loader can import them safely.
 */
import { toSafeImportPath } from "./import-specifier.js";

/**
 * Imports a lazy runtime module through the normalized runtime specifier.
 */
export async function importRuntimeModule<T>(
  baseUrl: string,
  parts: readonly string[],
): Promise<T> {
  const joined = parts.join("");
  const safeJoined = toSafeImportPath(joined);
  // Absolute Windows paths and UNC shares become standalone file URLs.
  const specifier =
    safeJoined !== joined ? safeJoined : new URL(joined, toSafeImportPath(baseUrl)).href;
  return (await import(specifier)) as T;
}
