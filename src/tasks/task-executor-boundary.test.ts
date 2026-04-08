import { describe, expect, it } from "vitest";
import {
  listTaskBoundarySourceFiles,
  readTaskBoundarySource,
  toTaskBoundaryRelativePath,
} from "./import-boundary.test-helpers.js";

const RAW_TASK_MUTATORS = [
  "createTaskRecord",
  "markTaskRunningByRunId",
  "markTaskTerminalByRunId",
  "markTaskTerminalById",
  "setTaskRunDeliveryStatusByRunId",
] as const;

const ALLOWED_CALLERS = new Set([
  "tasks/task-executor.ts",
  "tasks/task-registry.ts",
  "tasks/task-registry.maintenance.ts",
]);

describe("task executor boundary", () => {
  it("keeps raw task lifecycle mutators behind task internals", async () => {
    const offenders: string[] = [];
    for (const file of await listTaskBoundarySourceFiles()) {
      const relative = toTaskBoundaryRelativePath(file);
      if (ALLOWED_CALLERS.has(relative)) {
        continue;
      }
      const source = await readTaskBoundarySource(file);
      for (const symbol of RAW_TASK_MUTATORS) {
        if (source.includes(`${symbol}(`)) {
          offenders.push(`${relative}:${symbol}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
