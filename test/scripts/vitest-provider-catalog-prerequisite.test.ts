import { expect, it } from "vitest";
import { resolveVitestPretestBuildMode } from "../../scripts/lib/vitest-build-prerequisites.mts";
import { resolveVitestRuntimeCliSelections } from "../../scripts/lib/vitest-runtime-selection.mts";
import { buildVitestRunPlans } from "../../scripts/test-projects.test-support.mts";

const integrationFile = "src/agents/tool-surface-plan.provider-catalog.integration.test.ts";
const unitFile = "src/agents/tool-surface-plan.test.ts";

it.each([
  {
    file: integrationFile,
    config: "test/vitest/vitest.agents-core.config.ts",
    build: "runtime",
  },
  { file: unitFile, config: "test/vitest/vitest.unit-fast.config.ts", build: undefined },
])("prepares only the selected provider runtime consumer: $file", ({ file, config, build }) => {
  const plans = buildVitestRunPlans([file]);
  expect(plans).toMatchObject([{ config, includePatterns: [file] }]);
  expect(
    resolveVitestPretestBuildMode(
      plans.map((plan) => ({ configs: [plan.config], includePatterns: plan.includePatterns })),
    ),
  ).toBe(build);
});

it.each(["test/vitest/vitest.agents-core.config.ts", "test/vitest/vitest.agents.config.ts"])(
  "honors direct provider-runtime selection and exclusion in %s",
  (config) => {
    const selected = resolveVitestRuntimeCliSelections(config, ["run", integrationFile], {});
    expect(resolveVitestPretestBuildMode(selected)).toBe("runtime");
    const excluded = resolveVitestRuntimeCliSelections(
      config,
      [
        "run",
        integrationFile,
        "--exclude",
        "tool-surface-plan.provider-catalog.integration.test.ts",
      ],
      {},
    );
    expect(resolveVitestPretestBuildMode(excluded)).toBeUndefined();
  },
);
