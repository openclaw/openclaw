import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RUNTIME_ROOTS = ["src", "extensions"];
const SKIP_PATTERNS = [
  /\.test\.tsx?$/,
  /\.test-helpers\.tsx?$/,
  /\.test-utils\.tsx?$/,
  /\.e2e\.tsx?$/,
  /\.d\.ts$/,
  /[\\/](?:__tests__|tests)[\\/]/,
  /[\\/][^\\/]*test-helpers(?:\.[^\\/]+)?\.ts$/,
];

function shouldSkip(relativePath: string): boolean {
  return SKIP_PATTERNS.some((pattern) => pattern.test(relativePath));
}

function hasDynamicTmpdirTemplateJoin(source: string): boolean {
  const needle = "path.join(os.tmpdir(),";
  let cursor = source.indexOf(needle);
  while (cursor !== -1) {
    const window = source.slice(cursor, Math.min(source.length, cursor + 240));
    const closeIdx = window.indexOf(")");
    const expr = closeIdx === -1 ? window : window.slice(0, closeIdx + 1);
    if (expr.includes("`") && expr.includes("${")) {
      return true;
    }
    cursor = source.indexOf(needle, cursor + needle.length);
  }
  return false;
}

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listTsFiles(fullPath)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (fullPath.endsWith(".ts") || fullPath.endsWith(".tsx")) {
      out.push(fullPath);
    }
  }
  return out;
}

describe("temp path guard", () => {
  it("skips test helper filename variants", () => {
    expect(shouldSkip("src/commands/test-helpers.ts")).toBe(true);
    expect(shouldSkip("src/commands/sessions.test-helpers.ts")).toBe(true);
    expect(shouldSkip("src\\commands\\sessions.test-helpers.ts")).toBe(true);
  });

  it("blocks dynamic template path.join(os.tmpdir(), ...) in runtime source files", async () => {
    const repoRoot = process.cwd();
    const offenders: string[] = [];

    for (const root of RUNTIME_ROOTS) {
      const absRoot = path.join(repoRoot, root);
      const files = await listTsFiles(absRoot);
      for (const file of files) {
        const relativePath = path.relative(repoRoot, file);
        if (shouldSkip(relativePath)) {
          continue;
        }
        const source = await fs.readFile(file, "utf-8");
        if (hasDynamicTmpdirTemplateJoin(source)) {
          offenders.push(relativePath);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
