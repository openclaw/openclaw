import { describe, expect, it } from "vitest";
import { createAgentsVitestConfig } from "../vitest.agents.config.ts";
import bundledConfig from "../vitest.bundled.config.ts";
import { createCommandsVitestConfig } from "../vitest.commands.config.ts";
import baseConfig, { rootVitestProjects } from "../vitest.config.ts";
import { createContractsVitestConfig } from "../vitest.contracts.config.ts";
import { createGatewayVitestConfig } from "../vitest.gateway.config.ts";
import { createUiVitestConfig } from "../vitest.ui.config.ts";
import { createUnitVitestConfig } from "../vitest.unit.config.ts";

describe("projects vitest config", () => {
  it("defines the native root project list for all non-live Vitest lanes", () => {
    expect(baseConfig.test?.projects).toEqual([...rootVitestProjects]);
  });

  it("keeps every root project on fork workers", () => {
    expect(createGatewayVitestConfig().test.pool).toBe("forks");
    expect(createAgentsVitestConfig().test.pool).toBe("forks");
    expect(createCommandsVitestConfig().test.pool).toBe("forks");
    expect(createContractsVitestConfig().test.pool).toBe("forks");
  });

  it("keeps the contracts lane isolated by default", () => {
    const config = createContractsVitestConfig();
    expect(config.test.isolate).toBe(true);
    expect(config.test.runner).toBeUndefined();
  });

  it("keeps the root ui lane aligned with the isolated jsdom setup", () => {
    const config = createUiVitestConfig();
    expect(config.test.environment).toBe("jsdom");
    expect(config.test.isolate).toBe(true);
    expect(config.test.runner).toBeUndefined();
    expect(config.test.setupFiles).not.toContain("test/setup-openclaw-runtime.ts");
    expect(config.test.setupFiles).toContain("ui/src/test-helpers/lit-warnings.setup.ts");
    expect(config.test.deps?.optimizer?.web?.enabled).toBe(true);
  });

  it("keeps the unit lane isolated by default", () => {
    const config = createUnitVitestConfig();
    expect(config.test.isolate).toBe(true);
    expect(config.test.runner).toBeUndefined();
  });

  it("keeps the bundled lane isolated on fork workers", () => {
    expect(bundledConfig.test?.pool).toBe("forks");
    expect(bundledConfig.test?.isolate).toBe(true);
    expect(bundledConfig.test?.runner).toBeUndefined();
  });
});
