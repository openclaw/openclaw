import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { resolveShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import {
  CI_MANIFEST_FIXTURE_TARGETS as targets,
  runCiManifestFixture,
} from "./ci-workflow-manifest.test-support.js";

function runUi(eventName: "schedule" | "pull_request", runNode = true) {
  const result = runCiManifestFixture({
    bundledPlanner: true,
    eventName,
    runNode,
    changedPaths: eventName === "schedule" ? null : ["src/owner.ts"],
    selectedTestTargets: ["src/owner.test.ts"],
    uiE2eSelectorSource: `export const resolveUiE2ePrTestSelection = (_paths, { forceFull }) => ({
      mode: forceFull ? "full" : "owners",
      files: forceFull ? ${JSON.stringify(targets.mocked)} : [], reasons: {},
    });`,
    scopeEnv: {
      OPENCLAW_CI_FULL: String(eventName === "pull_request"),
      OPENCLAW_CI_RUN_UI_TESTS: String(eventName === "schedule"),
      OPENCLAW_CI_VALIDATION_TIER: eventName === "schedule" ? "main" : "full",
    },
  });
  expect(result.status, result.output).toBe(0);
  const outputs = result.outputs;
  const output = (name: string) => expectDefined(outputs[name], name);
  const files = (encoded: string) =>
    encoded
      ? resolveShardPlans({ OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: encoded }).flatMap((entry) => {
          if (entry.kind !== "group" || !entry.plan.includePatterns) {
            throw new Error("UI fixture groups require an explicit file inventory");
          }
          return entry.plan.includePatterns;
        })
      : [];
  const real = JSON.parse(output("ui_real_gateway_matrix")).include;
  return {
    unit: files(output("ui_test_groups_gzip_base64")),
    e2e: files(output("ui_e2e_test_groups_gzip_base64")),
    real: real.flatMap((row: { test_groups_gzip_base64: string }) =>
      files(row.test_groups_gzip_base64),
    ),
    enabled: [outputs.run_ui_tests, outputs.run_ui_e2e, outputs.run_ui_real_gateway],
  };
}

it.each([true, false])("ci:full selects all UI tests with runNode=%s", (runNode) => {
  expect(runUi("pull_request", runNode)).toEqual({
    unit: targets.ui,
    e2e: [...targets.mocked, ...targets.real],
    real: targets.real,
    enabled: ["true", "true", "true"],
  });
});

it("ci:full matches scheduled main UI coverage", () => {
  expect(runUi("pull_request")).toEqual(runUi("schedule"));
});
