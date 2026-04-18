import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const srcRoot = path.join(repoRoot, "src");
const forbiddenOllamaFacadeFiles = [
  "src/plugin-sdk/ollama.ts",
  "src/plugin-sdk/ollama-runtime.ts",
] as const;
const importSpecifierPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function collectSourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "plugin-sdk") {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(entryPath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

function toRepoRelative(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

describe("core extension facade boundary", () => {
  it("does not expose Ollama plugin facades from core plugin-sdk", () => {
    expect(
      forbiddenOllamaFacadeFiles.filter((file) => fs.existsSync(path.join(repoRoot, file))),
    ).toEqual([]);
  });

  it("does not import Ollama plugin facades from core code", () => {
    const violations: string[] = [];
    for (const filePath of collectSourceFiles(srcRoot)) {
      const source = fs.readFileSync(filePath, "utf8");
      for (const match of source.matchAll(importSpecifierPattern)) {
        const specifier = match[1] ?? match[2];
        if (specifier?.includes("plugin-sdk/ollama")) {
          violations.push(`${toRepoRelative(filePath)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
