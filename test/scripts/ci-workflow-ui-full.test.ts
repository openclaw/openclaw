import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { resolveShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import {
  CI_MANIFEST_FIXTURE_TARGETS as targets,
  runCiManifestFixture,
} from "./ci-workflow-manifest.test-support.js";

const uiE2eSelectorSource = `
export const resolveUiE2ePrTestSelection = (_paths, { forceFull }) => ({
  mode: forceFull ? "full" : "owners",
  files: forceFull ? ${JSON.stringify(targets.mocked)} : [${JSON.stringify(targets.mocked[0])}],
  reasons: {},
});`;

function uiCoverage(outputs: Record<string, string>) {
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
    unitRows: JSON.parse(output("ui_test_matrix")).include,
    e2eRows: JSON.parse(output("ui_e2e_matrix")).include,
    realRows: real.map((row: { shard: number; shard_count: number; run_desktop: boolean }) => ({
      shard: row.shard,
      shard_count: row.shard_count,
      run_desktop: row.run_desktop,
    })),
    enabled: [outputs.run_ui_tests, outputs.run_ui_e2e, outputs.run_ui_real_gateway],
  };
}

function runUi(options: Omit<Parameters<typeof runCiManifestFixture>[0], "bundledPlanner">) {
  const result = runCiManifestFixture({ bundledPlanner: true, uiE2eSelectorSource, ...options });
  expect(result.status, result.output).toBe(0);
  return uiCoverage(result.outputs);
}

describe("ci:full UI coverage", () => {
  it.each([
    { full: false, uiOwner: false, runNode: true },
    { full: false, uiOwner: true, runNode: true },
    { full: true, uiOwner: false, runNode: true },
    { full: true, uiOwner: true, runNode: true },
    { full: true, uiOwner: false, runNode: false },
  ])("selects UI inventories for %j", ({ full, uiOwner, runNode }) => {
    const coverage = runUi({
      eventName: "pull_request",
      runNode,
      changedPaths: [uiOwner ? "ui/src/owner.ts" : "src/owner.ts"],
      selectedTestTargets: [
        "src/owner.test.ts",
        expectDefined(targets.ui[0], "unit fixture"),
        expectDefined(targets.mocked[0], "E2E fixture"),
      ],
      changedPlannerSource: `
        export const hasUiE2eAffectingChange = () => ${uiOwner};
        export const createChangedNodeTestShards = () => [];
      `,
      scopeEnv: {
        OPENCLAW_CI_FULL: String(full),
        OPENCLAW_CI_RUN_UI_TESTS: String(uiOwner),
      },
    });
    expect(coverage.unit).toEqual(full || uiOwner ? targets.ui : [targets.ui[0]]);
    expect(coverage.e2e).toEqual(full ? [...targets.mocked, ...targets.real] : [targets.mocked[0]]);
    expect(coverage.real).toEqual(full ? targets.real : []);
    expect(coverage.unitRows).toHaveLength(full || uiOwner ? 3 : 1);
    expect(coverage.e2eRows).toHaveLength(full ? 9 : uiOwner ? 2 : 1);
    expect(coverage.realRows).toHaveLength(full ? 2 : 0);
    expect(coverage.enabled).toEqual(["true", "true", String(full)]);
  });

  it("matches scheduled main UI matrices and inventories", () => {
    const run = (eventName: "schedule" | "pull_request") =>
      runUi({
        eventName,
        changedPaths: eventName === "schedule" ? null : ["src/owner.ts"],
        selectedTestTargets: ["src/owner.test.ts"],
        scopeEnv: {
          OPENCLAW_CI_FULL: String(eventName === "pull_request"),
          OPENCLAW_CI_RUN_UI_TESTS: String(eventName === "schedule"),
          OPENCLAW_CI_VALIDATION_TIER: eventName === "schedule" ? "main" : "full",
        },
      });
    expect(run("pull_request")).toEqual(run("schedule"));
  });
});
