import { expect, it } from "vitest";
import { resolveVitestPretestBuildMode } from "../../scripts/lib/vitest-build-prerequisites.mts";
import { resolveVitestRuntimeCliSelections } from "../../scripts/lib/vitest-runtime-selection.mts";
import { buildVitestRunPlans } from "../../scripts/test-projects.test-support.mts";

const integrationFile = "src/agents/tool-surface-plan.provider-catalog.integration.test.ts";
const unitFile = "src/agents/tool-surface-plan.test.ts";
const catalogBootstrapFile = "ui/src/e2e/chat-flow.catalog-bootstrap.e2e.test.ts";

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

it.each([
  {
    config: "test/vitest/vitest.agents-core.config.ts",
    file: integrationFile,
    exclude: "tool-surface-plan.provider-catalog.integration.test.ts",
  },
  {
    config: "test/vitest/vitest.agents.config.ts",
    file: integrationFile,
    exclude: "tool-surface-plan.provider-catalog.integration.test.ts",
  },
  {
    config: "test/vitest/vitest.ui-e2e.config.ts",
    file: catalogBootstrapFile,
    exclude: catalogBootstrapFile,
  },
])(
  "honors direct provider-runtime selection and exclusion in $config",
  ({ config, file, exclude }) => {
    const selected = resolveVitestRuntimeCliSelections(config, ["run", file], {});
    expect(resolveVitestPretestBuildMode(selected)).toBe("runtime");
    const excluded = resolveVitestRuntimeCliSelections(
      config,
      ["run", file, "--exclude", exclude],
      {},
    );
    expect(resolveVitestPretestBuildMode(excluded)).toBeUndefined();
  },
);
