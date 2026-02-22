import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCAN_ROOTS = ["src", "extensions"] as const;
const SKIP_DIRS = new Set([".git", "dist", "node_modules"]);

function collectTypeScriptFiles(rootDir: string): string[] {
  const out: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          stack.push(fullPath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (
        !entry.name.endsWith(".ts") ||
        entry.name.endsWith(".test.ts") ||
        entry.name.endsWith(".d.ts")
      ) {
        continue;
      }
      out.push(fullPath);
    }
  }
  return out;
}

function findWeakRandomPatternMatches(repoRoot: string): string[] {
  const matches: string[] = [];
  for (const scanRoot of SCAN_ROOTS) {
    const root = path.join(repoRoot, scanRoot);
    if (!fs.existsSync(root)) {
      continue;
    }
    const files = collectTypeScriptFiles(root);
    for (const filePath of files) {
      const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
      for (let idx = 0; idx < lines.length; idx += 1) {
        const line = lines[idx] ?? "";
        if (!line.includes("Date.now") || !line.includes("Math.random")) {
          continue;
        }
        matches.push(`${path.relative(repoRoot, filePath)}:${idx + 1}`);
      }
    }
  }
  return matches;
}

describe("weak random pattern guardrail", () => {
  it("rejects Date.now + Math.random token/id patterns in runtime code", () => {
    const repoRoot = path.resolve(process.cwd());
    const matches = findWeakRandomPatternMatches(repoRoot);
    expect(matches).toEqual([]);
  });
});
