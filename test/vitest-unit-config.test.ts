// Vitest unit config tests validate unit test project configuration.
import { afterEach, describe, expect, it } from "vitest";
import { buildVitestRunPlans } from "../scripts/test-projects.test-support.mts";
import { createPatternFileHelper } from "./helpers/pattern-file.js";
import {
  createUnitVitestConfig,
  createUnitVitestConfigWithOptions,
} from "./vitest/vitest.unit.config.ts";

const patternFiles = createPatternFileHelper("openclaw-vitest-unit-config-");

function requireTestConfig<T extends { test?: unknown }>(config: T): NonNullable<T["test"]> {
  if (!config.test) {
    throw new Error("expected unit vitest test config");
  }
  return config.test as NonNullable<T["test"]>;
}

afterEach(() => {
  patternFiles.cleanup();
});

describe("unit vitest config", () => {
  it.each([false, true])(
    "keeps routed unit configuration equivalent to CLI discovery with all files excluded=%s",
    (excludeAll) => {
      const targets = [
        "src/node-host/node-worker-bundle-installer.test.ts",
        "src/media-generation/runtime-shared.test.ts",
      ];
      const plans = buildVitestRunPlans([...targets, "--", "--coverage"]);
      expect(plans).toHaveLength(1);
      const plan = plans[0];
      if (!plan) {
        throw new Error("expected a default unit plan");
      }
      expect(plan.includePatterns).toEqual(targets);
      expect(plan.forwardedArgs).toEqual(["--coverage", ...targets]);
      const options = { argv: ["node", "vitest", "run", ...plan.forwardedArgs] };
      const env = excludeAll
        ? {
            OPENCLAW_VITEST_EXTRA_EXCLUDE_FILE: patternFiles.writePatternFile(
              "exclude.json",
              targets,
            ),
          }
        : {};
      const cliConfig = requireTestConfig(createUnitVitestConfigWithOptions(env, options));
      const routedConfig = requireTestConfig(
        createUnitVitestConfigWithOptions(
          {
            ...env,
            OPENCLAW_VITEST_INCLUDE_FILE: patternFiles.writePatternFile(
              "include.json",
              plan.includePatterns,
            ),
          },
          options,
        ),
      );
      expect(routedConfig).toEqual(cliConfig);
      expect(routedConfig.include).toEqual(targets);
      expect(routedConfig.passWithNoTests).toBe(excludeAll ? true : undefined);
    },
  );

  it("skips default coverage source discovery when coverage is disabled", () => {
    const unitConfig = createUnitVitestConfig({});
    const testConfig = requireTestConfig(unitConfig);

    expect(testConfig.coverage?.include).toBeUndefined();
  });

  it("scopes default coverage to source files owned by the unit lane", () => {
    const unitConfig = createUnitVitestConfigWithOptions(
      {},
      {
        argv: ["node", "vitest", "run", "--coverage"],
      },
    );
    const testConfig = requireTestConfig(unitConfig);
    const coverageInclude = testConfig.coverage?.include;
    expect(coverageInclude).toContain("packages/memory-host-sdk/src/host/batch-runner.ts");
    expect(coverageInclude).toContain("src/media-generation/runtime-shared.ts");
    expect(coverageInclude).toContain("src/web-search/runtime.ts");
    expect(coverageInclude).not.toContain("packages/markdown-core/src/render.ts");
    expect(coverageInclude).not.toContain("src/security/audit-workspace-skills.ts");
  });

  it("keeps bundled unit include files out of the resolved exclude list", () => {
    const unitConfig = createUnitVitestConfigWithOptions(
      {},
      {
        includePatterns: [
          "src/infra/matrix-plugin-helper.test.ts",
          "src/plugin-sdk/facade-runtime.test.ts",
          "src/plugins/loader.test.ts",
        ],
      },
    );
    const testConfig = requireTestConfig(unitConfig);

    expect(testConfig.include).toEqual([
      "src/infra/matrix-plugin-helper.test.ts",
      "src/plugin-sdk/facade-runtime.test.ts",
      "src/plugins/loader.test.ts",
    ]);
    expect(testConfig.exclude).not.toContain("src/infra/**");
    expect(testConfig.exclude).not.toContain("src/plugin-sdk/**");
    expect(testConfig.exclude).not.toContain("src/plugins/**");
    expect(testConfig.exclude).not.toContain("src/infra/matrix-plugin-helper.test.ts");
    expect(testConfig.exclude).not.toContain("src/plugin-sdk/facade-runtime.test.ts");
    expect(testConfig.exclude).not.toContain("src/plugins/loader.test.ts");
  });
});
