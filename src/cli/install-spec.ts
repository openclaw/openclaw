import path from "node:path";

export function looksLikeLocalInstallSpec(spec: string, knownSuffixes: readonly string[]): boolean {
  return (
    spec.startsWith(".") ||
    spec.startsWith("~") ||
    path.isAbsolute(spec) ||
    knownSuffixes.some((suffix) => spec.endsWith(suffix))
  );
}
