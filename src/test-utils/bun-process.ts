import path from "node:path";

// Keep this builtin-only: native test bootstrap imports it before registering a source loader.
export function resolveTestBunSourceArgs(repoRoot: string): string[] {
  return ["--tsconfig-override", path.join(repoRoot, "tsconfig.json")];
}
