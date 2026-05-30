import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const LEGACY_MODEL_CATALOG_BRIDGES = new Map([
  [path.join(REPO_ROOT, "src/agents/provider-id.ts"), "@openclaw/model-catalog-core/provider-id"],
  [
    path.join(REPO_ROOT, "src/model-catalog/refs.ts"),
    "@openclaw/model-catalog-core/model-catalog-refs",
  ],
  [
    path.join(REPO_ROOT, "src/model-catalog/normalize.ts"),
    "@openclaw/model-catalog-core/model-catalog-normalize",
  ],
  [
    path.join(REPO_ROOT, "src/model-catalog/types.ts"),
    "@openclaw/model-catalog-core/model-catalog-types",
  ],
  [
    path.join(REPO_ROOT, "src/config/model-refs.ts"),
    "@openclaw/model-catalog-core/configured-model-refs",
  ],
  [
    path.join(REPO_ROOT, "src/shared/provider-model-id-normalization.ts"),
    "@openclaw/model-catalog-core/provider-model-id-normalization",
  ],
  [
    path.join(REPO_ROOT, "src/plugin-sdk/provider-model-id-normalize.ts"),
    "@openclaw/model-catalog-core/provider-model-id-normalize",
  ],
]);

function listSourceFiles(): string[] {
  return (
    listGitTrackedFiles({
      repoRoot: REPO_ROOT,
      pathspecs: ["src", "extensions", "packages", "test"],
    }) ?? []
  )
    .filter((file) => /\.(?:[cm]?ts|tsx|mts|cts)$/u.test(file))
    .filter((file) => fs.existsSync(path.join(REPO_ROOT, file)));
}

function resolveRelativeJsImport(sourceFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }
  return path.normalize(path.join(path.dirname(sourceFile), specifier.replace(/\.js$/u, ".ts")));
}

describe("model catalog core imports", () => {
  it("uses package subpaths instead of legacy internal bridge modules", () => {
    const bridgePaths = [...LEGACY_MODEL_CATALOG_BRIDGES.keys()];
    for (const bridgePath of bridgePaths) {
      expect(fs.existsSync(bridgePath), path.relative(REPO_ROOT, bridgePath)).toBe(false);
    }

    const offenders: string[] = [];
    for (const relativeFile of listSourceFiles()) {
      const filePath = path.join(REPO_ROOT, relativeFile);
      const source = fs.readFileSync(filePath, "utf8");
      for (const match of source.matchAll(/["'](\.{1,2}\/[^"']+?\.js)["']/gu)) {
        const resolved = resolveRelativeJsImport(filePath, match[1] ?? "");
        const replacement = resolved ? LEGACY_MODEL_CATALOG_BRIDGES.get(resolved) : undefined;
        if (replacement) {
          offenders.push(`${relativeFile} imports ${match[1]} instead of ${replacement}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
