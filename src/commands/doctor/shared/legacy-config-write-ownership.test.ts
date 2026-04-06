import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(fullPath, acc);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      continue;
    }
    acc.push(fullPath);
  }
  return acc;
}

describe("legacy config write ownership", () => {
  it("keeps legacy config repair flags and migration modules under doctor", () => {
    const files = collectSourceFiles(SRC_ROOT);
    const violations: string[] = [];

    for (const file of files) {
      const rel = path.relative(REPO_ROOT, file).replaceAll(path.sep, "/");
      const source = fs.readFileSync(file, "utf8");
      const isDoctorFile = rel.startsWith("src/commands/doctor/");

      if (!isDoctorFile && /migrateLegacyConfig\s*:\s*true/.test(source)) {
        violations.push(`${rel}: migrateLegacyConfig:true outside doctor`);
      }

      if (
        !isDoctorFile &&
        /legacy-config-migrate(?:\.js)?|legacy-config-migrations(?:\.[\w-]+)?(?:\.js)?/.test(source)
      ) {
        violations.push(`${rel}: doctor legacy migration module referenced outside doctor`);
      }
    }

    expect(violations).toEqual([]);
  });
});
