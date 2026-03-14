import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const extensionsRoot = path.join(repoRoot, "extensions");
const forbiddenImport = "../../../src/infra/outbound/send-deps.js";

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".build") {
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

describe("bundled extensions imports", () => {
  it("does not reach into src/infra outbound send-deps from extension sources", () => {
    const offenders = walk(extensionsRoot)
      .filter((file) => fs.readFileSync(file, "utf8").includes(forbiddenImport))
      .map((file) => path.relative(repoRoot, file));

    expect(offenders).toEqual([]);
  });
});
