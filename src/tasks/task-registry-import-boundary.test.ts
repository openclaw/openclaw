import { describe, expect, it } from "vitest";
import {
  listTaskBoundarySourceFiles,
  readTaskBoundarySource,
  toTaskBoundaryRelativePath,
} from "./import-boundary.test-helpers.js";

const ALLOWED_IMPORTERS = new Set([
  "tasks/runtime-internal.ts",
  "tasks/task-owner-access.ts",
  "tasks/task-status-access.ts",
]);

describe("task registry import boundary", () => {
  it("keeps direct task-registry imports behind the approved task access seams", async () => {
    const importers: string[] = [];
    for (const file of await listTaskBoundarySourceFiles()) {
      const relative = toTaskBoundaryRelativePath(file);
      const source = await readTaskBoundarySource(file);
      if (source.includes("task-registry.js")) {
        importers.push(relative);
      }
    }
    expect(importers.toSorted()).toEqual([...ALLOWED_IMPORTERS].toSorted());
  });
});
