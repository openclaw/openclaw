import { describe, expect, it } from "vitest";
import projectsConfig from "../vitest.projects.config.ts";

describe("projects vitest config", () => {
  it("defines named unit and boundary projects", () => {
    expect(projectsConfig.test?.projects).toHaveLength(2);
    expect(projectsConfig.test?.projects?.map((project) => project.test?.name)).toEqual([
      "unit",
      "boundary",
    ]);
  });
});
