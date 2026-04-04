import { describe, expect, it } from "vitest";
import { createAgentsVitestConfig } from "../vitest.agents.config.ts";
import { createCommandsVitestConfig } from "../vitest.commands.config.ts";
import baseConfig, { rootVitestProjects } from "../vitest.config.ts";
import { createGatewayVitestConfig } from "../vitest.gateway.config.ts";
import { createUiVitestConfig } from "../vitest.ui.config.ts";
import { createUnitVitestConfig } from "../vitest.unit.config.ts";

describe("projects vitest config", () => {
  it("defines the native root project list for all non-live Vitest lanes", () => {
    expect(baseConfig.test?.projects).toEqual([...rootVitestProjects]);
  });

  it("keeps hard thread exceptions on forks", () => {
    expect(createGatewayVitestConfig().test.pool).toBe("forks");
    expect(createAgentsVitestConfig().test.pool).toBe("forks");
    expect(createCommandsVitestConfig().test.pool).toBe("forks");
  });

  it("keeps the root ui lane aligned with the jsdom ui project setup", () => {
    const config = createUiVitestConfig();
    expect(config.test.environment).toBe("jsdom");
    expect(config.test.isolate).toBe(true);
    expect(config.test.runner).toBeUndefined();
    expect(config.test.setupFiles).not.toContain("test/setup-openclaw-runtime.ts");
    expect(config.test.setupFiles).toContain("ui/src/test-helpers/lit-warnings.setup.ts");
    expect(config.test.deps?.optimizer?.web?.enabled).toBe(true);
  });

  it("uses the standard runner when unit file isolation is enabled", () => {
    const config = createUnitVitestConfig({
      OPENCLAW_TEST_ISOLATE: "1",
    });
    expect(config.test.isolate).toBe(true);
    expect(config.test.runner).toBeUndefined();
  });
});
