import { toSafeImportPath } from "./import-specifier.js";

/** Runtime-facing alias for import specifier normalization helpers. */
export { toSafeImportPath as toSafeRuntimeImportPath } from "./import-specifier.js";

/** Resolves a runtime import part against a base URL/path after platform-safe normalization. */
export function resolveRuntimeImportSpecifier(baseUrl: string, parts: readonly string[]): string {
  const joined = parts.join("");
  const safeJoined = toSafeImportPath(joined);
  // Absolute Windows paths and UNC shares become standalone file URLs instead
  // of being resolved relative to the caller's module URL.
  if (safeJoined !== joined) {
    return safeJoined;
  }
  return new URL(joined, toSafeImportPath(baseUrl)).href;
}

/** Imports a lazy runtime module through the normalized runtime specifier. */
export async function importRuntimeModule<T>(
  baseUrl: string,
  parts: readonly string[],
  importModule: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<T> {
  return (await importModule(resolveRuntimeImportSpecifier(baseUrl, parts))) as T;
}
