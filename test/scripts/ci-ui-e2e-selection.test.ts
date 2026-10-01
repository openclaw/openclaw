import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import {
  createUiTestShardGroups,
  hasSharedUiE2eInput,
  resolveUiE2ePrTestSelection,
} from "../../scripts/lib/ci-node-test-plan.mts";
import { resolvePolicyTestTargets } from "../../scripts/lib/ci-policy-test-watch.mts";
import { readUiE2eFileTimings } from "../../scripts/lib/ci-test-timings.mts";
import { UI_E2E_SMOKE_TEST_FILES } from "../../scripts/lib/ci-ui-e2e-owner-inventory.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { uiE2eRealGatewayTestFiles } from "../vitest/vitest.ui-paths.mjs";
import {
  CI_MANIFEST_FIXTURE_TARGETS,
  runCiManifestFixture,
} from "./ci-workflow-manifest.test-support.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const cron = "ui/src/e2e/cron-descriptions.e2e.test.ts";
const appearance = "ui/src/e2e/appearance-control-layout.e2e.test.ts";
const unknown = "ui/src/e2e/new-unmapped-flow.e2e.test.ts";

function fixture() {
  const cwd = temporary.make("ui-e2e-selection-");
  const files: Record<string, string> = {
    [cron]: 'import "../test-helpers/cron-fixture.ts";',
    [appearance]: "export {};",
    [unknown]: "export {};",
    "ui/src/test-helpers/cron-fixture.ts": "export {};",
    "ui/src/pages/cron/route.ts": 'export const route = () => import("../../lib/cron/view.ts");',
    "ui/src/lib/cron/view.ts": 'import "./labels.ts";',
    "ui/src/lib/cron/labels.ts": "export const label = 'Run';",
    "ui/src/pages/appearance/route.ts": "export const route = {};",
    ...Object.fromEntries(UI_E2E_SMOKE_TEST_FILES.map((file) => [file, "export {};\n"])),
  };
  for (const [file, source] of Object.entries(files)) {
    const destination = path.join(cwd, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, source);
  }
  return cwd;
}

describe("Control UI PR owner selection", () => {
  it("does not turn a neighboring unit-test edit into a browser source-owner change", () => {
    expect(resolvePolicyTestTargets(["ui/src/pages/cron/cron-page.test.ts"])).not.toContain(cron);
    expect(resolvePolicyTestTargets(["ui/src/pages/cron/cron-page.ts"])).toContain(cron);
  });
  it("follows a dynamically loaded route dependency while retaining smoke and unknown tests", () => {
    const selected = resolveUiE2ePrTestSelection(["ui/src/lib/cron/labels.ts"], { cwd: fixture() });
    expect(selected.mode).toBe("owners");
    expect(selected.files).toContain(cron);
    expect(selected.files).not.toContain(appearance);
    expect(selected.files).toContain(unknown);
    for (const smoke of UI_E2E_SMOKE_TEST_FILES) {
      expect(selected.files).toContain(smoke);
    }
    expect(selected.reasons[cron]).toContain(
      "route/component dependency: ui/src/pages/cron/route.ts",
    );
  });

  it.each([
    [cron, "edited test"],
    ["ui/src/test-helpers/cron-fixture.ts", "test or fixture import dependency"],
    ["ui/src/pages/cron/new-view.ts", "explicit source-owner watch"],
  ])("retains direct tests, imported fixtures and new owner modules: %s", (changed, reason) => {
    const selected = resolveUiE2ePrTestSelection([changed], { cwd: fixture() });
    expect(selected.files).toContain(cron);
    expect(selected.reasons[cron]).toContain(reason);
  });

  it.each([
    null,
    [],
    ["ui/src/app/bootstrap.ts"],
    ["ui/src/styles/base.css"],
    ["ui/public/themes/paper.css"],
    ["scripts/lib/vitest-worker-bootstrap.mts"],
    ["scripts/lib/control-ui-i18n-catalog.ts"],
    ["tsdown.config.ts"],
    ["ui/src/test-helpers/control-ui-e2e.ts"],
    ["ui/src/e2e/control-ui-e2e-suite.test-support.ts"],
    ["ui/vite.config.ts"],
    ["pnpm-lock.yaml"],
    ["ui/src/unmapped-runtime.ts"],
  ])("keeps full coverage for missing, shared, or unresolved ownership: %j", (changed) => {
    const selected = resolveUiE2ePrTestSelection(changed, { cwd: fixture() });
    expect(selected.mode).toBe("full");
    expect(selected.files).toContain(cron);
    expect(selected.files).toContain(appearance);
    expect(selected.files).toContain(unknown);
  });

  it("restores the complete inventory when forced and keeps the fixed smoke within one shard", () => {
    const cwd = fixture();
    const selected = resolveUiE2ePrTestSelection([cron], { cwd, forceFull: true });
    expect(selected.mode).toBe("full");
    expect(selected.files).toContain(appearance);
    const timings = readUiE2eFileTimings();
    expect(
      UI_E2E_SMOKE_TEST_FILES.reduce((sum, file) => sum + timings.fileSeconds[file]!, 0),
    ).toBeLessThan(60);
    expect(hasSharedUiE2eInput(["ui/src/e2e/cron-descriptions.e2e.test.ts"])).toBe(false);
  });

  it("retains formerly release-only and real-Gateway files in full periodic groups", () => {
    const selection = resolveUiE2ePrTestSelection(null);
    expect(selection.files).toContain("ui/src/e2e/native-embed-settings.e2e.test.ts");
    expect(selection.files).toContain("ui/src/e2e/board-fixture.e2e.test.ts");
    const groups = createUiTestShardGroups({
      includeReleaseOnlyTests: false,
      includePrExemptRuntimeTests: false,
      includeReleaseOnlyE2eTests: true,
      uiE2eFiles: selection.files,
    });
    expect(groups.e2e.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
      [...new Set([...selection.files, ...uiE2eRealGatewayTestFiles])].toSorted(),
    );
  });
});

it.each([
  { event: "pull_request", kill: "", full: false },
  { event: "pull_request", kill: "true", full: true },
  { event: "pull_request", kill: "1", full: true },
  { event: "schedule", kill: "", full: true },
  { event: "workflow_dispatch", kill: "", full: true },
] as const)(
  "manifest publishes exact selection and reasons: $event / $kill",
  ({ event, kill, full }) => {
    const summary = path.join(temporary.make("ui-selection-summary-"), "summary.md");
    const selection = [CI_MANIFEST_FIXTURE_TARGETS.mocked[0]!];
    const expected = full ? CI_MANIFEST_FIXTURE_TARGETS.mocked : selection;
    const result = runCiManifestFixture({
      bundledPlanner: true,
      historicalCompatibility: false,
      eventName: event,
      releaseGate: event === "workflow_dispatch",
      changedPaths: ["ui/src/pages/cron/cron-page.ts"],
      selectedTestTargets: [...CI_MANIFEST_FIXTURE_TARGETS.mocked],
      changedPlannerSource:
        "export const hasUiE2eAffectingChange = (_paths, {family}) => family === 'control-ui'; export const createChangedNodeTestShards = () => [];",
      uiE2eSelectorSource: `
      export const resolveUiE2ePrTestSelection = (_paths, {forceFull}) => {
        const files = forceFull ? ${JSON.stringify(CI_MANIFEST_FIXTURE_TARGETS.mocked)} : ${JSON.stringify(selection)};
        return {mode: forceFull ? 'full' : 'owners', files, reasons: Object.fromEntries(files.map(file => [file, ['fixture owner']]))};
      };`,
      scopeEnv: {
        OPENCLAW_CI_RUN_UI_TESTS: "true",
        OPENCLAW_CI_UI_E2E_FULL: kill,
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    expect(result.status, result.output).toBe(0);
    const files = resolveShardPlans({
      OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: result.outputs.ui_e2e_test_groups_gzip_base64!,
    })
      .flatMap((entry) => (entry.kind === "group" ? (entry.plan.includePatterns ?? []) : []))
      .filter((file) => !CI_MANIFEST_FIXTURE_TARGETS.real.includes(file));
    expect(files).toEqual(expected);
    const published = readFileSync(summary, "utf8");
    expect(published).toContain(`Mode: ${full ? "full" : "owners"}`);
    expect(published).toContain("fixture owner");
    expect(published).toContain(`Selected files: ${expected.length}`);
  },
);
