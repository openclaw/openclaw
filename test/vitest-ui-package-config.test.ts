import { describe, expect, it } from "vitest";
import uiConfig from "../ui/vitest.config.ts";
import uiNodeConfig from "../ui/vitest.node.config.ts";

describe("ui package vitest config", () => {
  it("keeps the standalone ui package on forks with isolation enabled", () => {
    expect(uiConfig.test?.pool).toBe("forks");
    expect(uiConfig.test?.isolate).toBe(true);
    expect(uiConfig.test?.projects).toHaveLength(3);

    for (const project of uiConfig.test?.projects ?? []) {
      expect(project.test?.pool).toBe("forks");
      expect(project.test?.isolate).toBe(true);
      expect(project.test?.runner).toBeUndefined();
    }
  });

  it("keeps the standalone ui node config on forks with isolation enabled", () => {
    expect(uiNodeConfig.test?.pool).toBe("forks");
    expect(uiNodeConfig.test?.isolate).toBe(true);
    expect(uiNodeConfig.test?.runner).toBeUndefined();
  });
});
