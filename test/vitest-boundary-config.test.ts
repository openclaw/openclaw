import { describe, expect, it } from "vitest";
import {
  createBoundaryVitestConfig,
  loadBoundaryIncludePatternsFromEnv,
} from "../vitest.boundary.config.ts";
import { boundaryTestFiles } from "../vitest.unit-paths.mjs";

describe("loadBoundaryIncludePatternsFromEnv", () => {
  it("returns null when no include file is configured", () => {
    expect(loadBoundaryIncludePatternsFromEnv({})).toBeNull();
  });
});

describe("boundary vitest config", () => {
  it("keeps boundary suites on the shared runner with shared test bootstrap", () => {
    const config = createBoundaryVitestConfig({});

    expect(config.test?.isolate).toBe(false);
    expect(config.test?.runner).toBe("./test/non-isolated-runner.ts");
    expect(config.test?.include).toEqual(boundaryTestFiles);
    expect(config.test?.setupFiles).toEqual(["test/setup.ts"]);
  });
});
