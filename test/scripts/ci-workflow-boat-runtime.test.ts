import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { runCiManifestFixture } from "./ci-workflow-manifest.test-support.js";
import {
  evaluateWorkflowExpression,
  readCiWorkflow,
  requiredWorkflowStep,
  runWorkflowShellScript,
  writeExecutable,
} from "./ci-workflow.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const routes = [
  { name: "Boat", backend: "boat", runner: "boat-xlarge", attempt: 1, boat: true },
  { name: "Boat retry", backend: "boat", runner: "boat-xlarge", attempt: 2, boat: false },
  { name: "GitHub", backend: "github", runner: "ubuntu-24.04", attempt: 1, boat: false },
  {
    name: "hybrid",
    backend: "hybrid",
    runner: "blacksmith-2vcpu-ubuntu-2404",
    attempt: 1,
    boat: false,
  },
] as const;

it.each(routes)("runs $name Node tests through the correct permission boundary", (route) => {
  const root = dirs.make("openclaw-boat-node-step-");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  mkdirSync(path.join(root, "scripts"));
  writeFileSync(path.join(root, "scripts/ci-run-node-test-shard.mts"), "");
  const calls = path.join(root, "calls");
  writeExecutable(path.join(bin, "node"), [
    "#!/bin/bash",
    'printf "node %s\\n" "$*" >> "$CALLS"',
    "exit 7",
  ]);
  writeExecutable(path.join(bin, "setpriv"), [
    "#!/bin/bash",
    'printf "setpriv %s %s\\n" "$1" "$2" >> "$CALLS"',
    "shift 2",
    'exec "$@"',
  ]);
  const step = requiredWorkflowStep(
    readCiWorkflow().jobs["checks-node-core-test-nondist-shard"].steps,
    "Run Node test shard",
  );
  const selected = evaluateWorkflowExpression(step.env.BOAT_TEST_RUNNER ?? "${{ false }}", {
    eventName: "pull_request",
    repository: "openclaw/openclaw",
    runAttempt: route.attempt,
    matrix: { runner: route.runner, runner_label: route.runner },
  });
  const result = runWorkflowShellScript(step.run, {
    linuxWorkflow: true,
    cwd: root,
    env: { PATH: `${bin}:/usr/bin:/bin`, CALLS: calls, BOAT_TEST_RUNNER: String(selected) },
  });
  expect(result.status, result.stderr).toBe(7);
  expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
    ...(route.boat ? ["setpriv --inh-caps=-dac_read_search --ambient-caps=-dac_read_search"] : []),
    "node --import tsx scripts/ci-run-node-test-shard.mts",
  ]);
});

it.each(routes)("preserves Android build JVM options for $name", (route) => {
  const root = dirs.make("openclaw-boat-android-step-");
  const android = path.join(root, "apps/android");
  mkdirSync(android, { recursive: true });
  mkdirSync(path.join(root, ".ci-harness/scripts"), { recursive: true });
  writeFileSync(
    path.join(root, ".ci-harness/scripts/ci-collect-checks.sh"),
    'run_check() { shift; "$@"; }\nfinish_checks() { :; }\n',
  );
  const calls = path.join(root, "calls");
  writeExecutable(path.join(android, "gradlew"), [
    "#!/bin/bash",
    'printf "%s\\n" "$JAVA_TOOL_OPTIONS" > "$CALLS"',
  ]);
  const step = requiredWorkflowStep(
    readCiWorkflow().jobs.android.steps,
    "Run Android ${{ matrix.task }}",
  );
  const context = {
    eventName: "pull_request" as const,
    repository: "openclaw/openclaw",
    headRepository: "openclaw/openclaw",
    runAttempt: route.attempt,
    runnerBackend: route.backend,
    preflightOutputs: {
      effective_runner_backend: route.backend,
      placement_runner_backend: route.backend === "boat" ? "hybrid" : route.backend,
    },
  };
  const runner = route.boat ? "boat-large" : route.attempt > 1 ? "ubuntu-24.04" : route.runner;
  const job = readCiWorkflow().jobs.android;
  expect(evaluateWorkflowExpression(job["runs-on"], context)).toBe(runner);
  expect(
    evaluateWorkflowExpression(job["runs-on"], {
      ...context,
      eventName: "workflow_dispatch",
      dispatchId: "full-release-validation-fixture",
      releaseRunnerGroup: "fixture-group",
      preflightOutputs: { ...context.preflightOutputs, ci_qualification: "true" },
    }),
  ).toEqual({ group: "fixture-group", labels: runner });
  const result = runWorkflowShellScript(step.run, {
    linuxWorkflow: true,
    cwd: android,
    env: {
      PATH: "/usr/bin:/bin",
      CALLS: calls,
      BOAT_TEST_RUNNER: String(
        evaluateWorkflowExpression(step.env.BOAT_TEST_RUNNER ?? "${{ false }}", context),
      ),
      CI_RUNNER_BACKEND: String(evaluateWorkflowExpression(step.env.CI_RUNNER_BACKEND, context)),
      JAVA_TOOL_OPTIONS: "-Dfixture=true",
      TASK: "test-third-party",
      RUN_LINT: "false",
      APP_LINT: "",
      OPENCLAW_ROBOLECTRIC_INIT: "fixture.gradle",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(calls, "utf8").trim()).toBe("-Dfixture=true");
});

it.each(routes)("routes real-Gateway UI for $name", (route) => {
  const job = readCiWorkflow().jobs["checks-ui-e2e-real-gateway"];
  const context = {
    eventName: "pull_request" as const,
    repository: "openclaw/openclaw",
    headRepository: "openclaw/openclaw",
    runAttempt: route.attempt,
    runnerBackend: route.backend,
    preflightOutputs: {
      effective_runner_backend: route.backend,
      placement_runner_backend: route.backend === "boat" ? "hybrid" : route.backend,
    },
  };
  for (const frozenTarget of ["false", "true", ""]) {
    const preflightOutputs = { ...context.preflightOutputs, frozen_target: frozenTarget };
    const runner =
      route.backend === "hybrid"
        ? frozenTarget === "false"
          ? "blacksmith-4vcpu-ubuntu-2404"
          : "blacksmith-8vcpu-ubuntu-2404"
        : "ubuntu-24.04";
    expect(evaluateWorkflowExpression(job["runs-on"], { ...context, preflightOutputs })).toBe(
      runner,
    );
    expect(
      evaluateWorkflowExpression(job["runs-on"], {
        ...context,
        eventName: "workflow_dispatch",
        dispatchId: "full-release-validation-fixture",
        releaseRunnerGroup: "fixture-group",
        preflightOutputs: { ...preflightOutputs, ci_qualification: "true" },
      }),
    ).toEqual(
      route.backend === "boat" ? "ubuntu-24.04" : { group: "fixture-group", labels: runner },
    );
  }
});

it.each([
  ["boat", 1, 25],
  ["boat", 2, 15],
  ["github", 1, 15],
  ["hybrid", 1, 15],
  ["blacksmith", 1, 15],
  ["runson", 1, 15],
  ["", 1, 15],
] as const)("budgets core lint for %s attempt %s", (backend, attempt, minutes) => {
  const timeout = readCiWorkflow().jobs["check-lint-hosted-core-shard"]["timeout-minutes"];
  expect(
    typeof timeout === "string"
      ? evaluateWorkflowExpression(timeout, {
          eventName: "pull_request",
          repository: "openclaw/openclaw",
          runAttempt: attempt,
          preflightOutputs: { effective_runner_backend: backend },
        })
      : timeout,
  ).toBe(minutes);
});

it.each(["push", "pull_request", "workflow_dispatch"] as const)(
  "keeps full Boat lint stripes separate for %s",
  (eventName) => {
    const result = runCiManifestFixture({
      bundledPlanner: true,
      eventName,
      changedPaths: ["tsconfig.json"],
      runnerProfile: "hybrid",
      historicalCompatibility: false,
      scopeEnv: {
        OPENCLAW_CI_RUNNER_BACKEND: "boat",
        OPENCLAW_CI_NODE_RUNNER_BACKEND: "boat",
        OPENCLAW_CI_EFFECTIVE_RUNNER_BACKEND: "boat",
        OPENCLAW_CI_RELEASE_GATE: eventName === "workflow_dispatch" ? "true" : "false",
        OPENCLAW_CI_QUALIFICATION: eventName === "workflow_dispatch" ? "true" : "false",
        OPENCLAW_CI_SHAPE: "main",
      },
    });
    expect(result.status, result.output).toBe(0);
    expect(
      JSON.parse(expectDefined(result.outputs.lint_core_matrix, "core lint matrix")).include.map(
        (row: { stripe: number }) => row.stripe,
      ),
    ).toEqual([1, 2, 3, 4, 5]);
  },
);

it("keeps baseline memory and retry routing independent", () => {
  const baseline = readCiWorkflow().jobs["checks-baseline-ratchets"];
  for (const attempt of [1, 2]) {
    expect(
      evaluateWorkflowExpression(baseline["runs-on"], {
        eventName: "pull_request",
        repository: "openclaw/openclaw",
        headRepository: "openclaw/openclaw",
        runAttempt: attempt,
        runnerBackend: "boat",
        preflightOutputs: {
          effective_runner_backend: "boat",
          placement_runner_backend: "hybrid",
          node_runner_backend: "boat",
        },
      }),
    ).toBe(attempt === 1 ? "boat-large" : "ubuntu-24.04");
  }
});

it.each(["boat", "hybrid"] as const)(
  "keeps the %s lint shell aligned with its matrix",
  (backend) => {
    const root = dirs.make("openclaw-boat-lint-step-");
    mkdirSync(path.join(root, ".ci-harness/scripts"), { recursive: true });
    mkdirSync(path.join(root, "scripts"));
    writeFileSync(path.join(root, "scripts/run-oxlint-shards.mts"), "");
    writeFileSync(
      path.join(root, ".ci-harness/scripts/ci-static-step.sh"),
      'run_static_check() { printf "%s\\n" "$*" >> "$CALLS"; }\nfinish_static_checks() { :; }\n',
    );
    const step = requiredWorkflowStep(
      readCiWorkflow().jobs["check-lint-hosted-core-shard"].steps,
      "Run hosted core lint stripe",
    );
    const script = step.run.replace(/\$\{\{[^}]+\}\}/gu, (expression: string) =>
      String(
        evaluateWorkflowExpression(expression, {
          eventName: "push",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          preflightOutputs: {
            runner_profile: "hybrid",
            node_runner_backend: backend,
            frozen_target: "false",
          },
        }),
      ),
    );
    const calls = path.join(root, "calls");
    const result = runWorkflowShellScript(script, {
      linuxWorkflow: true,
      cwd: root,
      env: {
        PATH: "/usr/bin:/bin",
        CALLS: calls,
        CORE_STRIPE: "2",
        FROZEN_TARGET: "false",
        RUNNER_PROFILE: "hybrid",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(
      readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => /--core-stripe=(\d+)\/5/u.exec(line)?.[1]),
    ).toEqual(backend === "boat" ? ["2"] : ["3", "4", "5"]);
  },
);

it("preserves physical Blacksmith labels in check-shard", () => {
  const result = runCiManifestFixture({
    bundledPlanner: true,
    eventName: "push",
    changedPaths: ["tsconfig.json"],
    runnerProfile: "blacksmith",
    historicalCompatibility: false,
  });
  expect(result.status, result.output).toBe(0);
  const rows = JSON.parse(expectDefined(result.outputs.check_matrix, "check matrix")).include;
  for (const [task, runner] of [
    ["npm-lock", "blacksmith-2vcpu-ubuntu-2404"],
    ["test-types", "blacksmith-4vcpu-ubuntu-2404"],
  ] as const) {
    const row = expectDefined(
      rows.find((candidate: { task: string }) => candidate.task === task),
      task,
    );
    expect(
      evaluateWorkflowExpression(readCiWorkflow().jobs["check-shard"]["runs-on"], {
        eventName: "push",
        repository: "openclaw/openclaw",
        runAttempt: 1,
        runnerBackend: "blacksmith",
        preflightOutputs: result.outputs,
        matrix: row,
      }),
    ).toBe(runner);
  }
});

it("routes materialized late check-plan rows onto Boat", () => {
  const result = runCiManifestFixture({
    bundledPlanner: true,
    checkFamilyScope: true,
    changedPlannerSource: `
      import { writeFileSync } from "node:fs";
      writeFileSync(new URL("./ci-extension-lint-plan.mts", import.meta.url),
        ${JSON.stringify(`export { resolveCiExtensionLintSelection } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/ci-extension-lint-plan.mts")).href)};\n`)});
      writeFileSync(new URL("../run-oxlint-shards.mts", import.meta.url),
        ${JSON.stringify(`export { createExtensionOxlintShards, createOxlintExtensionRootScope, selectExtensionOxlintStripe } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/run-oxlint-shards.mts")).href)};\n`)});
      export const createChangedNodeTestShards = () => [];
    `,
    eventName: "pull_request",
    changedPaths: ["tsconfig.json"],
    runnerProfile: "hybrid",
    historicalCompatibility: false,
    scopeEnv: {
      OPENCLAW_CI_RUNNER_BACKEND: "boat",
      OPENCLAW_CI_NODE_RUNNER_BACKEND: "boat",
      OPENCLAW_CI_EFFECTIVE_RUNNER_BACKEND: "boat",
    },
  });
  expect(result.status, result.output).toBe(0);
  expect(result.outputs.run_check_plan).toBe("true");
  const rows = JSON.parse(
    expectDefined(result.checkPlanOutputs.check_matrix, "late matrix"),
  ).include;
  const types = expectDefined(
    rows.find((row: { task: string }) => row.task === "test-types"),
    "types",
  );
  expect(types.runner).toBe("boat-large");
  expect(types.runner_label).toBe("boat-large");
  expect(
    evaluateWorkflowExpression(readCiWorkflow().jobs["check-shard"]["runs-on"], {
      eventName: "pull_request",
      repository: "openclaw/openclaw",
      headRepository: "openclaw/openclaw",
      runAttempt: 1,
      runnerBackend: "boat",
      preflightOutputs: { ...result.outputs, placement_runner_backend: "hybrid" },
      matrix: types,
    }),
  ).toBe("boat-large");
});
