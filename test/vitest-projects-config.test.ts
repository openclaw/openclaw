import { describe, expect, it } from "vitest";
import baseConfig, { rootVitestProjects } from "../vitest.config.ts";

describe("projects vitest config", () => {
  it("defines the native root project list for all non-live Vitest lanes", () => {
    expect(baseConfig.test?.projects).toEqual([...rootVitestProjects]);
  });
});
