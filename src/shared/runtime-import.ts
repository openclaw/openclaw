import path from "node:path";
import { toSafeImportPath } from "./import-specifier.js";

export function resolveRuntimeImportSpecifier(baseUrl: string, parts: readonly string[]): string {
  const safeBaseUrl = toSafeImportPath(baseUrl);
  const joined = parts.join("");
  if (process.platform === "win32" && path.win32.isAbsolute(joined)) {
    return toSafeImportPath(joined);
  }
  return new URL(joined, safeBaseUrl).href;
}

export async function importRuntimeModule<T>(
  baseUrl: string,
  parts: readonly string[],
  importModule: (specifier: string) => Promise<T> = async (specifier: string) =>
    (await import(specifier)) as T,
): Promise<T> {
  const specifier = resolveRuntimeImportSpecifier(baseUrl, parts);
  return await importModule(specifier);
}
