import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, it } from "vitest";
import { resolveShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import { resolveUiE2ePrTestSelection } from "../../scripts/lib/ci-node-test-plan.mts";
import { resolvePolicyTestTargets } from "../../scripts/lib/ci-policy-test-watch.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  CI_MANIFEST_FIXTURE_TARGETS,
  runCiManifestFixture,
} from "./ci-workflow-manifest.test-support.js";

const temporary = useAutoCleanupTempDirTracker(afterAll);
const cron = "ui/src/e2e/cron-descriptions.e2e.test.ts";
const appearance = "ui/src/e2e/appearance-control-layout.e2e.test.ts";
const unknown = "ui/src/e2e/new-unmapped-flow.e2e.test.ts";
const staleBuild = "ui/src/e2e/control-ui-stale-build-reload.e2e.test.ts";
const smoke = "ui/src/e2e/control-ui-route-readiness.e2e.test.ts";
const route = "ui/src/pages/cron/route.ts";
const { mocked, real } = CI_MANIFEST_FIXTURE_TARGETS;

function runManifest(options: Omit<Parameters<typeof runCiManifestFixture>[0], "bundledPlanner">) {
  return runCiManifestFixture({
    bundledPlanner: true,
    historicalCompatibility: false,
    changedPlannerSource:
      "export const hasUiE2eAffectingChange = (_paths, {family}) => family === 'control-ui'; export const createChangedNodeTestShards = () => [];",
    ...options,
    scopeEnv: { OPENCLAW_CI_RUN_UI_TESTS: "true", ...options.scopeEnv },
  });
}
function selectedFiles(result: ReturnType<typeof runCiManifestFixture>) {
  expect(result.status, result.output).toBe(0);
  return resolveShardPlans({
    OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: result.outputs.ui_e2e_test_groups_gzip_base64!,
  }).flatMap((entry) => (entry.kind === "group" ? (entry.plan.includePatterns ?? []) : []));
}

const cwd = temporary.make("ui-e2e-selection-");
const fixtureFiles: Record<string, string> = {
  [cron]: "export {};",
  [appearance]: "export {};",
  [unknown]: "export {};",
  [route]: 'export const route = () => import("../../lib/cron/view.ts");',
  "ui/src/lib/cron/view.ts": 'import "./labels.ts";',
  "ui/src/lib/cron/labels.ts": "export const label = 'Run';",
  [smoke]: "export {};",
};
for (const [file, source] of Object.entries(fixtureFiles)) {
  const destination = path.join(cwd, file);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, source);
}
const select = (changed: Parameters<typeof resolveUiE2ePrTestSelection>[0], forceFull = false) =>
  resolveUiE2ePrTestSelection(changed, { cwd, forceFull });

it("does not turn a neighboring unit-test edit into a browser source-owner change", () => {
  expect(resolvePolicyTestTargets(["ui/src/pages/cron/cron-page.test.ts"])).not.toContain(cron);
});
const fullInventory = expect.arrayContaining([cron, appearance, unknown]);
it.each([
  [null, false, "full", fullInventory],
  [["ui/src/app/bootstrap.ts"], false, "full", fullInventory],
  [[cron], true, "full", fullInventory],
  [["ui/src/unmapped-runtime.ts"], false, "owners", [smoke]],
  [["ui/src/lib/cron/labels.ts"], false, "owners", [smoke]],
] as const)("selects %j / force=%s as %s", (changed, forceFull, mode, files) => {
  const selected = select(changed, forceFull);
  expect({ ...selected, files: selected.files.toSorted() }).toMatchObject({ mode, files });
});

it.each([
  { event: "pull_request", edited: false, selected: false },
  { event: "pull_request", edited: true, selected: true },
  { event: "schedule", edited: false, selected: false },
  { event: "workflow_dispatch", edited: false, selected: true },
] as const)("stale-build: $event / $edited", ({ event, edited, selected }) => {
  const result = runManifest({
    eventName: event,
    changedPaths: edited ? [staleBuild] : ["ui/src/app/stale-chunk-reload.ts"],
    selectedTestTargets: [staleBuild, cron],
    targetFiles: [staleBuild, cron],
    uiTestGroupsSource: `export { createUiTestShardGroups } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/ci-node-test-plan.mts")).href)};`,
    uiE2eSelectorSource: `
        export const resolveUiE2ePrTestSelection = () => ({
          mode: 'owners', files: ${JSON.stringify([staleBuild, cron])},
          reasons: {${JSON.stringify(staleBuild)}: ['fixture stale-build owner'], ${JSON.stringify(cron)}: ['fixture source owner']},
        });`,
    scopeEnv: {
      OPENCLAW_CI_WORKFLOW_REVISION: "a".repeat(40),
      ...(event === "schedule" ? { OPENCLAW_CI_VALIDATION_TIER: "main" } : {}),
    },
  });
  const files = selectedFiles(result);
  expect(files).toContain(cron);
  expect(files.includes(staleBuild)).toBe(selected);
  expect(result.summary).toContain(`Selected files: ${selected ? 2 : 1}`);
  expect(result.summary.includes("fixture stale-build owner")).toBe(selected);
});

it.each([
  { event: "pull_request", kill: "", full: false, count: 0 },
  { event: "pull_request", kill: "", full: false, count: 30 },
  { event: "pull_request", kill: "", full: false, count: 31 },
  { event: "pull_request", kill: "", full: false, count: 241 },
  { event: "pull_request", kill: "true", full: true, count: 1 },
  { event: "schedule", kill: "", full: true, count: 1 },
  { event: "workflow_dispatch", kill: "", full: true, count: 1 },
] as const)("publishes selection: $event / $kill / $count", ({ event, kill, full, count }) => {
  const selection = Array.from(
    { length: count },
    (_, index) => `ui/src/e2e/fixture-${index + 1}.e2e.test.ts`,
  );
  const expected = full ? mocked : selection;
  const result = runManifest({
    eventName: event,
    releaseGate: event === "workflow_dispatch",
    changedPaths: [route],
    selectedTestTargets: [...mocked],
    uiE2eSelectorSource: `
      export const resolveUiE2ePrTestSelection = (_paths, {forceFull}) => {
        const files = forceFull ? ${JSON.stringify(mocked)} : ${JSON.stringify(selection)};
        return {mode: forceFull ? 'full' : 'owners', files, reasons: Object.fromEntries(files.map(file => [file, ['fixture owner']]))};
      };`,
    scopeEnv: { OPENCLAW_CI_UI_E2E_FULL: kill },
  });
  const files = selectedFiles(result).filter((file) => !real.includes(file));
  expect(files).toEqual(expected);
  const rows = JSON.parse(result.outputs.ui_e2e_matrix!) as { include: { task: string }[] };
  expect(rows.include.filter((row) => row.task === "control-ui")).toHaveLength(
    full ? 6 : Math.min(6, Math.ceil(count / 30)),
  );
  expect(result.summary).toContain(`Mode: ${full ? "full" : "owners"}`);
  if (expected.length > 0) {
    expect(result.summary).toContain("fixture owner");
  }
  expect(result.summary).toContain(`Selected files: ${expected.length}`);
});
