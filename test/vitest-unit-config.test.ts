import { afterEach, describe, expect, it } from "vitest";
import { buildVitestRunPlans } from "../scripts/test-projects.test-support.mts";
import { createPatternFileHelper } from "./helpers/pattern-file.js";
import {
  createUnitVitestConfig,
  createUnitVitestConfigWithOptions,
} from "./vitest/vitest.unit.config.ts";

const patterns = createPatternFileHelper("openclaw-vitest-unit-config-");
afterEach(() => patterns.cleanup());

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
      const plan = plans[0]!;
      expect(plan.includePatterns).toEqual(targets);
      expect(plan.forwardedArgs).toEqual(["--coverage", ...targets]);
      const options = { argv: ["node", "vitest", "run", ...plan.forwardedArgs] };
      const env = excludeAll
        ? {
            OPENCLAW_VITEST_EXTRA_EXCLUDE_FILE: patterns.writePatternFile("exclude.json", targets),
          }
        : {};
      const cliConfig = createUnitVitestConfigWithOptions(env, options).test!;
      const routedConfig = createUnitVitestConfigWithOptions(
        {
          ...env,
          OPENCLAW_VITEST_INCLUDE_FILE: patterns.writePatternFile(
            "include.json",
            plan.includePatterns,
          ),
        },
        options,
      ).test!;
      expect(routedConfig).toEqual(cliConfig);
      expect(routedConfig.include).toEqual(targets);
      expect(routedConfig.passWithNoTests).toBe(excludeAll ? true : undefined);
    },
  );

  it("skips default coverage source discovery when coverage is disabled", () => {
    expect(createUnitVitestConfig({}).test!.coverage?.include).toBeUndefined();
  });

  it("scopes default coverage to source files owned by the unit lane", () => {
    const coverageInclude = createUnitVitestConfigWithOptions(
      {},
      {
        argv: ["node", "vitest", "run", "--coverage"],
      },
    ).test!.coverage?.include;
    expect(coverageInclude).toContain("packages/memory-host-sdk/src/host/batch-runner.ts");
    expect(coverageInclude).toContain("src/media-generation/runtime-shared.ts");
    expect(coverageInclude).toContain("src/web-search/runtime.ts");
    expect(coverageInclude).not.toContain("packages/markdown-core/src/render.ts");
    expect(coverageInclude).not.toContain("src/security/audit-workspace-skills.ts");
  });

  it("keeps bundled unit include files out of the resolved exclude list", () => {
    const includePatterns = [
      "src/infra/matrix-plugin-helper.test.ts",
      "src/plugin-sdk/facade-runtime.test.ts",
      "src/plugins/loader.test.ts",
    ];
    const testConfig = createUnitVitestConfigWithOptions({}, { includePatterns }).test!;
    expect(testConfig.include).toEqual(includePatterns);
    for (const pattern of [
      "src/infra/**",
      "src/plugin-sdk/**",
      "src/plugins/**",
      ...includePatterns,
    ]) {
      expect(testConfig.exclude).not.toContain(pattern);
    }
  });
});
