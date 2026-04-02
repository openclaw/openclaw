import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TASK_ROOT = path.resolve(import.meta.dirname);
const SRC_ROOT = path.resolve(TASK_ROOT, "..");

const ALLOWED_IMPORTERS = new Set([
  "tasks/task-flow-owner-access.ts",
  "tasks/task-flow-registry.audit.ts",
  "tasks/task-flow-registry.maintenance.ts",
  "tasks/task-flow-runtime-internal.ts",
]);

async function listSourceFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(fullPath)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

describe("task flow registry import boundary", () => {
  it("keeps direct task-flow-registry imports behind approved task-flow access seams", async () => {
    const importers: string[] = [];
    for (const file of await listSourceFiles(SRC_ROOT)) {
      const relative = path.relative(SRC_ROOT, file).replaceAll(path.sep, "/");
      const source = await fs.readFile(file, "utf8");
      if (source.includes("task-flow-registry.js")) {
        importers.push(relative);
      }
    }
    expect(importers.toSorted()).toEqual([...ALLOWED_IMPORTERS].toSorted());
  });
});
