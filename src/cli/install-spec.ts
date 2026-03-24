import path from "node:path";

/**
 * Returns true when `spec` looks like a local path rather than a registry package name.
 * Handles relative paths (`./`, `../`), home-relative paths (`~/`), absolute paths,
 * and any spec ending with one of `knownSuffixes` (e.g. `.tgz`, `.tar.gz`).
 */
export function looksLikeLocalInstallSpec(spec: string, knownSuffixes: readonly string[]): boolean {
  return (
    spec.startsWith(".") ||
    spec.startsWith("~") ||
    path.isAbsolute(spec) ||
    knownSuffixes.some((suffix) => spec.endsWith(suffix))
  );
}
