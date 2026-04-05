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

  it("keeps the heavy root projects on fork workers only where explicitly required", () => {
    expect(createGatewayVitestConfig().test.pool).toBe("forks");
    expect(createAgentsVitestConfig().test.pool).toBe("forks");
    expect(createCommandsVitestConfig().test.pool).toBe("forks");
    expect(createContractsVitestConfig().test.pool).toBe("threads");
  });

  it("keeps the contracts lane on the shared non-isolated runner", () => {
    const config = createContractsVitestConfig();
    expect(config.test.isolate).toBe(false);
    expect(config.test.runner).toBe("./test/non-isolated-runner.ts");
  });

  it("keeps the root ui lane aligned with the shared non-isolated jsdom setup", () => {
    const config = createUiVitestConfig();
    expect(config.test.environment).toBe("jsdom");
    expect(config.test.isolate).toBe(false);
    expect(config.test.runner).toBe("./test/non-isolated-runner.ts");
    expect(config.test.setupFiles).not.toContain("test/setup-openclaw-runtime.ts");
    expect(config.test.setupFiles).toContain("ui/src/test-helpers/lit-warnings.setup.ts");
    expect(config.test.deps?.optimizer?.web?.enabled).toBe(true);
  });

  it("keeps the unit lane on the shared non-isolated runner", () => {
    const config = createUnitVitestConfig();
    expect(config.test.isolate).toBe(false);
    expect(config.test.runner).toBe("./test/non-isolated-runner.ts");
  });

  it("keeps the bundled lane on the shared non-isolated runner", () => {
    expect(bundledConfig.test?.pool).toBe("threads");
    expect(bundledConfig.test?.isolate).toBe(false);
    expect(bundledConfig.test?.runner).toBe("./test/non-isolated-runner.ts");
  });
});
