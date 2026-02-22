import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listRuntimeSourceFiles } from "../test-utils/repo-scan.js";

const SCAN_ROOTS = ["src", "extensions"] as const;

async function findWeakRandomPatternMatches(repoRoot: string): Promise<string[]> {
  const matches: string[] = [];
  const files = await listRuntimeSourceFiles(repoRoot, {
    roots: SCAN_ROOTS,
    extensions: [".ts"],
  });
  for (const filePath of files) {
    const lines = (await fs.readFile(filePath, "utf8")).split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx] ?? "";
      if (!line.includes("Date.now") || !line.includes("Math.random")) {
        continue;
      }
      matches.push(`${path.relative(repoRoot, filePath)}:${idx + 1}`);
    }
  }
  return matches;
}

describe("weak random pattern guardrail", () => {
  it("rejects Date.now + Math.random token/id patterns in runtime code", async () => {
    const repoRoot = path.resolve(process.cwd());
    const matches = await findWeakRandomPatternMatches(repoRoot);
    expect(matches).toEqual([]);
  });
});
