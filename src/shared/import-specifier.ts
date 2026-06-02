import path from "node:path";
import { pathToFileURL } from "node:url";

/** Converts Windows absolute filesystem paths to file URLs for Node ESM import(). */
export function toSafeImportPath(specifier: string): string {
  if (process.platform !== "win32") {
    return specifier;
  }
  if (specifier.startsWith("file://")) {
    return specifier;
  }
  if (path.win32.isAbsolute(specifier)) {
    return pathToFileURL(specifier, { windows: true }).href;
  }
  return specifier;
}
