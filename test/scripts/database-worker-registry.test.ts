import { describe, expect, it } from "vitest";
import {
  databaseWorkerCoreTestFiles,
  isDatabaseWorkerCoreTestFile,
} from "../vitest/vitest.database-worker-core-paths.mjs";

describe("database-worker test routing registry", () => {
  it("contains no duplicate file routes", () => {
    expect(new Set(databaseWorkerCoreTestFiles).size).toBe(databaseWorkerCoreTestFiles.length);
  });

  it("keeps wizard recovery on the forked database-worker route exactly once", () => {
    const file = "src/wizard/setup.inference-recovery.integration.test.ts";
    expect(databaseWorkerCoreTestFiles.filter((entry) => entry === file)).toEqual([file]);
    expect(isDatabaseWorkerCoreTestFile(file)).toBe(true);
  });
});
