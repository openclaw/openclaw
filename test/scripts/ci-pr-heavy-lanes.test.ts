import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { resolveShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import {
  CI_MANIFEST_FIXTURE_TARGETS,
  runCiManifestFixture,
} from "./ci-workflow-manifest.test-support.js";
import {
  evaluateWorkflowExpression,
  readCiWorkflow,
  runWorkflowShellScript,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

function manifest(options: Omit<Parameters<typeof runCiManifestFixture>[0], "bundledPlanner">) {
  const result = runCiManifestFixture({ bundledPlanner: true, ...options });
  expect(result.status, result.output).toBe(0);
  return result;
}
function rows(outputs: Record<string, string>, key: string) {
  return JSON.parse(expectDefined(outputs[key], key)).include as Array<{
    check_name: string;
    task?: string;
    group?: string;
  }>;
}
const checks = (outputs: Record<string, string>) =>
  ["check_matrix", "check_additional_matrix"].flatMap((key) => rows(outputs, key));
const heavyLanes = [
  ["checks-ui-e2e-real-gateway", "run_ui_real_gateway"],
  ["checks-windows", "run_checks_windows"],
  ["macos-node", "run_macos_node"],
  ["macos-swift", "run_macos_swift"],
  ["ios-build", "run_ios_build"],
  ["android-screenshots", "run_android_screenshots"],
  ["published-driver-update", "run_published_driver_update"],
] as const;

it.each(["openclaw/openclaw", "contributor/openclaw"])(
  "keeps TypeScript cycle and Kysely checks in the existing PR guard for %s",
  (headRepository) => {
    for (const [changedPath, cycles, kysely] of [
      ["src/skills/runtime/refresh.ts", true, true],
      ["extensions/telegram/src/runtime.ts", true, true],
      ["packages/media-core/src/runtime.mts", true, true],
      ["ui/src/runtime.tsx", true, false],
      ["src/shared/runtime.js", false, false],
    ] as const) {
      const result = manifest({
        checkFamilyScope: true,
        runnerProfile: "hybrid",
        eventName: "pull_request",
        changedPaths: [changedPath],
        scopeEnv: { OPENCLAW_CI_HEAD_REPOSITORY: headRepository },
      });
      expect(result.outputs.run_pr_madge_import_cycles).toBe(String(cycles));
      expect(result.outputs.run_pr_kysely_guardrails).toBe(String(kysely));
      const selected = checks(result.outputs);
      expect(selected.filter((row) => (row.task ?? row.group) === "guards")).toHaveLength(1);
      expect(selected.some((row) => row.group === "runtime-topology-architecture")).toBe(false);
      expect(selected.some((row) => /import-cycle|kysely/u.test(row.check_name))).toBe(false);
    }
  },
);

it("does not budget a disabled PR screenshot request", () => {
  const results = ["false", "true"].map((hint) => {
    const result = manifest({
      runnerProfile: "hybrid",
      eventName: "pull_request",
      changedPaths: ["apps/android/app/src/main/java/ai/openclaw/app/MainActivity.kt"],
      scopeEnv: { OPENCLAW_CI_RUN_ANDROID_SCREENSHOTS: hint },
    });
    expect(result.outputs.run_android_screenshots).toBe("false");
    return result.outputs;
  });
  const disabledHint = expectDefined(results[0], "disabled screenshot hint");
  const enabledHint = expectDefined(results[1], "enabled screenshot hint");
  for (const key of ["hybrid_hosted_base_rows", "hybrid_hosted_total_rows"]) {
    expect(expectDefined(enabledHint[key], key)).toBe(expectDefined(disabledHint[key], key));
  }
});

it.each([
  { eventName: "pull_request", headRepository: "openclaw/openclaw", deferred: true },
  { eventName: "pull_request", headRepository: "contributor/openclaw", deferred: true },
  { eventName: "push", deferred: false },
  { eventName: "schedule", deferred: false },
  { eventName: "workflow_dispatch", deferred: false },
  { eventName: "workflow_dispatch", releaseGate: true, deferred: false },
] as const)("selects heavy lanes for $eventName $headRepository $releaseGate", (scenario) => {
  const { eventName, deferred } = scenario;
  const releaseGate = "releaseGate" in scenario && scenario.releaseGate;
  const revision = "a".repeat(40);
  const result = manifest({
    historicalCompatibility: false,
    iosCapabilities: true,
    macosNodeParts: true,
    protocolCoverage: true,
    openClawKitTests: true,
    eventName,
    releaseGate,
    changedPaths: ["src/infra/update-runner.ts", "apps/ios/Sources/Main.swift"],
    selectedTestTargets: Object.values(CI_MANIFEST_FIXTURE_TARGETS).flat(),
    scopeEnv: {
      OPENCLAW_CI_HEAD_REPOSITORY:
        "headRepository" in scenario
          ? expectDefined(scenario.headRepository, "PR head repository")
          : "openclaw/openclaw",
      OPENCLAW_CI_WORKFLOW_REVISION: revision,
      OPENCLAW_CI_VALIDATION_TIER: eventName === "schedule" ? "main" : "full",
      OPENCLAW_CI_RUN_ANDROID_SCREENSHOTS: "true",
      OPENCLAW_CI_RUN_UI_TESTS: "true",
    },
  });
  expect(result.outputs.run_pr_madge_import_cycles).toBe(String(deferred));
  expect(result.outputs.run_pr_kysely_guardrails).toBe(String(deferred));
  for (const [, flag] of heavyLanes) {
    expect(result.outputs[flag], flag).toBe(String(!deferred));
  }
  for (const flag of ["run_protocol_event_coverage", "run_ui_e2e", "run_android_job"]) {
    expect(result.outputs[flag], flag).toBe("true");
  }
  const selectedChecks = checks(result.outputs);
  expect(selectedChecks.some((row) => (row.task ?? row.group) === "dependencies")).toBe(!deferred);
  expect(selectedChecks.some((row) => row.group === "runtime-topology-architecture")).toBe(
    !deferred,
  );
  if (deferred) {
    for (const key of ["checks_windows_matrix", "macos_node_matrix", "ui_real_gateway_matrix"]) {
      expect(rows(result.outputs, key)).toEqual([]);
    }
    const plans = resolveShardPlans({
      OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: expectDefined(
        result.outputs.ui_e2e_test_groups_gzip_base64,
        "UI E2E groups",
      ),
    });
    const selected = plans.flatMap((entry) =>
      entry.kind === "group" ? (entry.plan.includePatterns ?? []) : [entry.target],
    );
    for (const file of CI_MANIFEST_FIXTURE_TARGETS.real) {
      expect(selected).not.toContain(file);
      expect(result.summary).not.toContain(file);
    }
    expect(selected).toEqual(expect.arrayContaining(CI_MANIFEST_FIXTURE_TARGETS.mocked));
  }

  const gate = readCiWorkflow().jobs["ci-gate"].steps.find(
    (step: WorkflowStep) => step.name === "Verify selected CI lanes",
  );
  const movedJobs = new Set<string>(heavyLanes.map(([job]) => job));
  const jobResults = gate.env.JOB_RESULTS.replace(/\$\{\{[\s\S]*?\}\}/gu, (expression: string) => {
    const job = expression.match(/^\$\{\{\s*needs\.([\w-]+)\.result\s*\}\}$/u)?.[1];
    if (job) {
      return deferred && movedJobs.has(job) ? "skipped" : "success";
    }
    return String(
      evaluateWorkflowExpression(expression, {
        eventName,
        releaseGate,
        repository: "openclaw/openclaw",
        sha: revision,
        runAttempt: 1,
        preflightOutputs: result.outputs,
      }) ?? "",
    );
  });
  if (deferred) {
    for (const job of movedJobs) {
      expect(jobResults).toContain(`${job}=skipped|false`);
    }
  }
  const checked = runWorkflowShellScript(gate.run, { env: { JOB_RESULTS: jobResults } });
  expect(checked.status, `${checked.stdout}${checked.stderr}`).toBe(0);
});
