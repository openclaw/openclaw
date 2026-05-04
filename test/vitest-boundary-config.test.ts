import { describe, expect, it } from "vitest";
import { normalizeConfigPath, normalizeConfigPaths } from "./helpers/vitest-config-paths.js";
import {
  createBoundaryVitestConfig,
  loadBoundaryIncludePatternsFromEnv,
} from "./vitest/vitest.boundary.config.ts";
import { boundaryTestFiles } from "./vitest/vitest.unit-paths.mjs";

describe("loadBoundaryIncludePatternsFromEnv", () => {
  it("returns null when no include file is configured", () => {
    expect(loadBoundaryIncludePatternsFromEnv({})).toBeNull();
  });
});

describe("boundary vitest config", () => {
  it("keeps boundary suites on the non-isolated runner with shared test bootstrap", () => {
    const config = createBoundaryVitestConfig({});

    expect(config.test?.isolate).toBe(false);
    expect(normalizeConfigPath(config.test?.runner)).toBe("test/non-isolated-runner.ts");
    expect(config.test?.include).toEqual(boundaryTestFiles);
    expect(normalizeConfigPaths(config.test?.setupFiles)).toEqual(["test/setup.ts"]);
  });

  it("narrows boundary includes to matching CLI file filters", () => {
    const config = createBoundaryVitestConfig({}, [
      "node",
      "vitest",
      "run",
      "src/infra/openclaw-root.test.ts",
    ]);

    expect(config.test?.include).toEqual(["src/infra/openclaw-root.test.ts"]);
    expect(config.test?.passWithNoTests).toBe(true);
  });
});
