import { describe, expect, it } from "vitest";
import {
  listTaskBoundarySourceFiles,
  readTaskBoundarySource,
  toTaskBoundaryRelativePath,
} from "./import-boundary.test-helpers.js";

const ALLOWED_IMPORTERS = new Set([
  "tasks/task-flow-owner-access.ts",
  "tasks/task-flow-registry.audit.ts",
  "tasks/task-flow-registry.maintenance.ts",
  "tasks/task-flow-runtime-internal.ts",
]);

describe("task flow registry import boundary", () => {
  it("keeps direct task-flow-registry imports behind approved task-flow access seams", async () => {
    const importers: string[] = [];
    for (const file of await listTaskBoundarySourceFiles()) {
      const relative = toTaskBoundaryRelativePath(file);
      const source = await readTaskBoundarySource(file);
      if (source.includes("task-flow-registry.js")) {
        importers.push(relative);
      }
    }
    expect(importers.toSorted()).toEqual([...ALLOWED_IMPORTERS].toSorted());
  });
});
