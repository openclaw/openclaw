import { describe, expect, it } from "vitest";
import config from "../../tsdown.config.ts";

describe("tsdown core dist entries", () => {
  it("emits the task-registry control runtime on a stable dist path", () => {
    const build = Array.isArray(config) ? config[0] : config;
    const entry = build.entry as Record<string, string>;

    expect(entry).toMatchObject({
      "task-registry-control.runtime": "src/tasks/task-registry-control.runtime.ts",
    });
  });
});
