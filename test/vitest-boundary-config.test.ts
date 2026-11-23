// Vitest boundary config tests validate boundary test configuration.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "vitest/node";
import { normalizeConfigPath, normalizeConfigPaths } from "./helpers/vitest-config-paths.js";
import { createBoundaryVitestConfig } from "./vitest/vitest.boundary.config.ts";

async function requireTestConfig(config: ReturnType<typeof createBoundaryVitestConfig>) {
  return (await resolveConfig({ config: false }, config)).test;
}

describe("boundary vitest config", () => {
  it("keeps boundary suites on the non-isolated runner with shared test bootstrap", async () => {
    const config = createBoundaryVitestConfig({});
    const testConfig = await requireTestConfig(config);

    expect(testConfig.isolate).toBe(false);
    expect(normalizeConfigPath(testConfig.runner)).toBe("test/non-isolated-runner.ts");
    expect(testConfig.include?.filter((file) => !existsSync(file))).toEqual([]);
    expect(normalizeConfigPaths(testConfig.setupFiles)).toEqual(["test/setup.ts"]);
  });

  it("narrows boundary includes to matching CLI file filters", async () => {
    const config = createBoundaryVitestConfig({}, [
      "node",
      "vitest",
      "run",
      "src/infra/openclaw-root.test.ts",
    ]);
    const testConfig = await requireTestConfig(config);

    expect(testConfig.include).toEqual(["src/infra/openclaw-root.test.ts"]);
    expect(testConfig.passWithNoTests).toBeUndefined();
  });

  it("lets unrelated root Vitest projects skip when CLI filters match no boundary files", async () => {
    const config = createBoundaryVitestConfig({}, [
      "node",
      "vitest",
      "run",
      "src/config/channel-configured.test.ts",
    ]);
    const testConfig = await requireTestConfig(config);

    expect(testConfig.include).toEqual([]);
    expect(testConfig.passWithNoTests).toBe(true);
  });
});
