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
  it("keeps boundary suites isolated with shared test bootstrap", () => {
    const config = createBoundaryVitestConfig({});

    expect(config.test?.isolate).toBe(true);
    expect(config.test?.runner).toBeUndefined();
    expect(config.test?.include).toEqual(boundaryTestFiles);
    expect(config.test?.setupFiles).toEqual(["test/setup.ts"]);
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
