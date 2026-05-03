import { describe, expect, it } from "vitest";
import { createProjectShardVitestConfig } from "./vitest/vitest.project-shard-config.ts";
import { nonIsolatedRunnerPath } from "./vitest/vitest.shared.config.ts";

describe("project shard vitest config", () => {
  it("lets child projects own their runner", () => {
    const config = createProjectShardVitestConfig([
      "test/vitest/vitest.boundary.config.ts",
      "test/vitest/vitest.tooling.config.ts",
    ]);

    expect(config.test?.projects).toEqual([
      "test/vitest/vitest.boundary.config.ts",
      "test/vitest/vitest.tooling.config.ts",
    ]);
    expect(config.test?.runner).toBeUndefined();
    expect(nonIsolatedRunnerPath).toContain("test/non-isolated-runner.ts");
  });
});
