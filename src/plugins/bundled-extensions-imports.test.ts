import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const extensionsRoot = path.join(repoRoot, "extensions");
const forbiddenImportTarget = "src/infra/outbound/send-deps";
const importSpecifierPattern =
  /\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === ".build"
      ) {
        continue;
      }
      files.push(...walk(full));
      continue;
    }
    if (entry.isFile() && full.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function listExtensionSourceFiles(): string[] {
  return fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .flatMap((entry) => {
      const srcRoot = path.join(extensionsRoot, entry.name, "src");
      if (!fs.existsSync(srcRoot) || !fs.statSync(srcRoot).isDirectory()) {
        return [];
      }
      return walk(srcRoot);
    });
}

function hasForbiddenImport(source: string): boolean {
  for (const match of source.matchAll(importSpecifierPattern)) {
    const specifier = (match[1] ?? match[2] ?? "").replaceAll("\\", "/");
    if (specifier.includes(forbiddenImportTarget)) {
      return true;
    }
  }
  return false;
}

describe("bundled extensions imports", () => {
  it("does not reach into src/infra outbound send-deps from extension sources", () => {
    const offenders = listExtensionSourceFiles()
      .filter((file) => hasForbiddenImport(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(repoRoot, file));

    expect(offenders).toEqual([]);
  });
});
