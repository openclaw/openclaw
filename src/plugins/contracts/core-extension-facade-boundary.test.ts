import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expectNoReaddirSyncDuring } from "../../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, toRepoRelativePath } from "../../test-utils/repo-files.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const forbiddenOllamaFacadeFiles = [
  "src/plugin-sdk/ollama.ts",
  "src/plugin-sdk/ollama-runtime.ts",
] as const;
const importSpecifierPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function collectSourceFiles(): string[] {
  const files = listGitTrackedFiles({ repoRoot, pathspecs: "src" });
  expect(files, "boundary scans require a Git checkout").not.toBeNull();
  return (files ?? [])
    .filter((line) => line.length > 0 && line.endsWith(".ts") && !line.includes("/plugin-sdk/"))
    .map((line) => path.join(repoRoot, ...line.split("/")))
    .filter((filePath) => fs.existsSync(filePath))
    .toSorted();
}

describe("core extension facade boundary", () => {
  it("lists core facade boundary sources from git without walking src", () => {
    expectNoReaddirSyncDuring(() => {
      const files = collectSourceFiles();

      expect(files.length).toBeGreaterThan(0);
      expect(files.filter((file) => file.includes("/plugin-sdk/"))).toEqual([]);
    });
  });

  it("does not expose Ollama plugin facades from core plugin-sdk", () => {
    expect(
      forbiddenOllamaFacadeFiles.filter((file) => fs.existsSync(path.join(repoRoot, file))),
    ).toStrictEqual([]);
  });

  it("does not import Ollama plugin facades from core code", () => {
    const violations = collectSourceFiles().flatMap((filePath) =>
      [...fs.readFileSync(filePath, "utf8").matchAll(importSpecifierPattern)].flatMap((match) => {
        const specifier = match[1] ?? match[2];
        return specifier?.includes("plugin-sdk/ollama")
          ? [`${toRepoRelativePath(repoRoot, filePath)} -> ${specifier}`]
          : [];
      }),
    );
    expect(violations).toStrictEqual([]);
  });
});
