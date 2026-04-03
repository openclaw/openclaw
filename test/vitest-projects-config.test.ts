import { describe, expect, it } from "vitest";
import baseConfig from "../vitest.config.ts";

describe("projects vitest config", () => {
  it("defines unit and boundary project config files at the root", () => {
    expect(baseConfig.test?.projects).toEqual([
      "vitest.unit.config.ts",
      "vitest.boundary.config.ts",
    ]);
  });
});
