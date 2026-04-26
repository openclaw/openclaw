import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Node's ESM `import()` treats some Windows absolute paths (notably `C:\...`) as
 * having a `c:` URL scheme. jiti's native import path must use `file:` URLs for
 * those paths instead (see #72040).
 */
export function normalizeJitiFileSpecifier(
  specifier: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32" || specifier.length === 0) {
    return specifier;
  }
  if (
    specifier.startsWith("file:") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("data:")
  ) {
    return specifier;
  }
  if (path.isAbsolute(specifier) && shouldCoerceWin32FileUrl(specifier)) {
    return pathToFileURL(specifier).href;
  }
  return specifier;
}

function shouldCoerceWin32FileUrl(filePath: string): boolean {
  if (filePath.startsWith("\\\\")) {
    return true;
  }
  return /^[A-Za-z]:/u.test(filePath);
}
