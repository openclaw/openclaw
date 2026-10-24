import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  evaluateWorkflow as evaluateWorkflowExpression,
  readCiWorkflow,
  requiredWorkflowStep,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const ciWorkflow = readCiWorkflow();
const ciStep = (job: string, name: string): WorkflowStep =>
  requiredWorkflowStep(ciWorkflow.jobs[job].steps, name);
function checkFixture(prefix: string, scripts: string[]) {
  const root = temporary.make(prefix);
  for (const script of scripts) {
    const target = path.join(root, ".ci-harness/scripts", script);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(new URL(`../../scripts/${script}`, import.meta.url), target);
  }
  return root;
}

describe("native CI failure collection", () => {
  const fixture = () =>
    checkFixture("ci-native-complete-", ["ci-collect-checks.sh", "lib/swift-toolchain.sh"]);

  function executable(root: string, name: string, source: string) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `#!/bin/bash\n${source}\n`);
    chmodSync(file, 0o755);
  }

  function run(root: string, script: string, env: Record<string, string> = {}, cwd = root) {
    return spawnSync("/bin/bash", ["-euo", "pipefail", "-c", script], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        HISTORICAL_TARGET: "false",
        RUNNER_TEMP: root,
        GITHUB_OUTPUT: path.join(root, "outputs"),
        TRACE: path.join(root, "trace"),
        ...env,
      },
    });
  }

  it("OpenClawKit trait builds share a fresh scratch and clean it after testing", () => {
    const root = fixture();
    const optOut = ciStep(
      "macos-swift-packages",
      "OpenClawKit Talk-trait opt-out (no ElevenLabsKit when default traits disabled)",
    );
    const tests = ciStep("macos-swift-packages", "OpenClawKit tests");
    const result = run(
      root,
      `
swift() { printf '%s\\n' "$*" >> "$TRACE"; }
export -f swift
${optOut.run}
if [[ -f "$GITHUB_ENV" ]]; then source "$GITHUB_ENV"; fi
${tests.run}
${ciStep("macos-swift-packages", "Clean OpenClawKit build scratch").run}
`,
      { GITHUB_ENV: path.join(root, "environment"), OPENCLAWKIT_TEST_EXECUTION: "serial" },
    );
    expect(result.status, result.stderr).toBe(0);
    const commands = readFileSync(path.join(root, "trace"), "utf8").trim().split("\n");
    const scratchPaths = commands.map((command) => command.match(/--scratch-path (\S+)/)?.[1]);
    expect(scratchPaths[0]).toBeTruthy();
    expect(new Set(scratchPaths).size).toBe(1);
    expect(existsSync(scratchPaths[0]!)).toBe(false);
    expect(commands[0]).toContain("show-dependencies --disable-default-traits");
    expect(commands[1]).toContain("--target OpenClawKit --disable-default-traits");
    expect(commands[2]).toContain("test --package-path apps/shared/OpenClawKit");
    expect(commands[2]).not.toContain("--disable-default-traits");
    expect(
      evaluateWorkflowExpression(
        `\${{ ${ciStep("macos-swift-packages", "Clean OpenClawKit build scratch").if} }}`,
        {
          eventName: "schedule",
          cancelled: true,
          failed: true,
          env: { OPENCLAWKIT_SCRATCH: scratchPaths[0]! },
        },
      ),
    ).toBe(true);
  });

  it.each(["macos-swift", "ios-build"])(
    "%s runs formatting after Swift lint fails and retains the failure",
    (job) => {
      const root = fixture();
      executable(root, "scripts/lint-swift.sh", 'echo lint >> "$TRACE"; exit 7');
      executable(root, "scripts/format-swift.sh", 'echo format >> "$TRACE"');
      const result = run(root, ciStep(job, "Swift lint").run!);
      expect(result.status, result.stderr).not.toBe(0);
      expect(readFileSync(path.join(root, "trace"), "utf8").trim().split("\n")).toEqual([
        "lint",
        "format",
      ]);
    },
  );

  it.each([
    { task: "test-wear", lint: "true", appLint: "play", benchmark: "false", count: 3 },
    { task: "ktlint", lint: "false", appLint: "third-party", benchmark: "true", count: 3 },
    { task: "build-play", lint: "false", appLint: "", benchmark: "false", count: 3 },
  ])("Android $task runs trailing commands after the first Gradle failure", (row) => {
    const root = fixture();
    executable(root, "apps/android/gradlew", 'printf "%s\\n" "$*" >> "$TRACE"; exit 7');
    const result = run(
      root,
      ciStep("android", "Run Android ${{ matrix.task }}").run!,
      {
        TASK: row.task,
        RUN_LINT: row.lint,
        APP_LINT: row.appLint,
        BUILD_BENCHMARK: row.benchmark,
        OPENCLAW_ROBOLECTRIC_INIT: "fixture-init.gradle",
        CI_RUNNER_BACKEND: "github",
        GITHUB_EVENT_NAME: "pull_request",
        CI_MAIN_QUALIFICATION: "false",
      },
      path.join(root, "apps/android"),
    );
    expect(result.status, result.stderr).not.toBe(0);
    const commands = readFileSync(path.join(root, "trace"), "utf8").trim().split("\n");
    expect(commands).toHaveLength(row.count);
    for (const command of commands) {
      expect(command).toContain("--continue");
    }
  });
});

describe("built artifact proof upload", () => {
  it.each([
    { outcome: "success", selected: true, upload: true },
    { outcome: "failure", selected: true, upload: true },
    { outcome: "skipped", selected: true, upload: false },
    { outcome: "cancelled", selected: true, upload: false },
    { outcome: "success", selected: false, upload: false },
  ] as const)(
    "handles producer $outcome with selection $selected",
    ({ outcome, selected, upload }) => {
      const steps = readCiWorkflow().jobs["build-artifacts"].steps as WorkflowStep[];
      const producer = requiredWorkflowStep(steps, "Run built artifact checks");
      const publisher = requiredWorkflowStep(steps, "Upload Discord component attachment proof");
      const producerId = expectDefined(producer.id, "producer step identity");
      const condition = expectDefined(publisher.if, "upload condition");

      expect(
        evaluateWorkflowExpression(`\${{ ${condition} }}`, {
          failed: outcome === "failure" || outcome === "skipped",
          cancelled: outcome === "cancelled",
          preflightOutputs: { run_discord_component_proof: String(selected) },
          steps: { [producerId]: { outputs: {}, outcome } },
        }),
      ).toBe(upload);
      expect(publisher.with?.["if-no-files-found"]).toBe("error");
    },
  );
});

describe("PR failure reporting", () => {
  it("waits for every workload and uses read-only grants for canonical PRs including forks", () => {
    const workflow = readCiWorkflow();
    const report = workflow.jobs["pr-failure-report"];
    expect(report.needs).toEqual(
      workflow.jobs["ci-gate"].needs.filter((name: string) => name !== "pr-failure-report"),
    );
    expect(report.permissions).toEqual({
      contents: "read",
      actions: "read",
      "pull-requests": "read",
    });
    expect(
      Object.entries(workflow.jobs)
        .filter(
          ([, job]) =>
            (job as { permissions?: { actions?: string } }).permissions?.actions === "write",
        )
        .map(([name]) => name),
    ).toEqual([]);
    for (const [eventName, headRepository, runAttempt, preflightResult, admitted] of [
      ["pull_request", "openclaw/openclaw", 1, "success", true],
      ["pull_request", "contributor/openclaw", 1, "success", true],
      ["pull_request", "openclaw/openclaw", 2, "success", true],
      ["pull_request", "openclaw/openclaw", 1, "failure", true],
      ["push", "openclaw/openclaw", 1, "success", false],
      ["workflow_dispatch", "openclaw/openclaw", 1, "success", false],
    ] as const) {
      expect(
        evaluateWorkflowExpression(report.if, {
          eventName,
          headRepository,
          runAttempt,
          preflightResult,
          preflightOutputs: { run_checks_node_core_nondist: "false" },
        }),
      ).toBe(admitted);
    }
    for (const overrides of [
      { cancelled: true },
      { draft: true },
      { repository: "contributor/openclaw" },
    ]) {
      expect(evaluateWorkflowExpression(report.if, { ...overrides })).toBe(false);
    }
  });
  it("gates cancelled workflows and drafts", () => {
    const gate = readCiWorkflow().jobs["ci-gate"];
    for (const eventName of ["pull_request", "push", "workflow_dispatch"] as const) {
      for (const cancelled of [true, false]) {
        for (const draft of [true, false]) {
          expect(
            evaluateWorkflowExpression(gate.if, { ciOnPush: "true", cancelled, draft, eventName }),
            JSON.stringify({ cancelled, draft, eventName }),
          ).toBe(!cancelled && (eventName !== "pull_request" || !draft));
        }
      }
    }
    expect(
      evaluateWorkflowExpression(gate.if, { cancelled: true, failureReportResult: "failure" }),
    ).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "accepts only the completed report's supported test and static exceptions",
    () => {
      const verify = readCiWorkflow().jobs["ci-gate"].steps.find(
        (entry: WorkflowStep) => entry.name === "Verify selected CI lanes",
      );
      for (const [name, result, receipt, attempt, exit] of [
        ["checks-node-core-test-nondist-shard", "failure", "1", 1, 0],
        ["checks-node-core-test-nondist-shard", "failure", "", 1, 1],
        ["checks-node-core-test-nondist-shard", "failure", "1", 2, 1],
        ["checks-node-core-test-nondist-shard", "cancelled", "1", 1, 1],
        ["check-test-types-hosted-core-shard", "failure", "1", 1, 0],
        ["check-lint-hosted-core-shard", "failure", "1", 1, 0],
        ["check-additional-shard", "failure", "1", 1, 1],
      ] as const) {
        const allowed = evaluateWorkflowExpression(verify.env.ALLOW_KNOWN_MAIN_RED, {
          runAttempt: attempt,
          preflightOutputs: { run_checks_node_core_nondist: "true" },
          failureReportResult: "success",
          failureReportOutputs: { known_main_red_attempt: receipt },
        });
        const run = spawnSync("/bin/bash", ["-c", verify.run], {
          encoding: "utf8",
          env: {
            ...process.env,
            ALLOW_KNOWN_MAIN_RED: String(allowed),
            JOB_RESULTS: `${name}=${result}|true`,
          },
        });
        expect(run.status, run.stdout).toBe(exit);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps retry and non-Node reports informational without extending the known-main-red allowance",
    () => {
      const workflow = readCiWorkflow();
      const verify = workflow.jobs["ci-gate"].steps.find(
        (entry: WorkflowStep) => entry.name === "Verify selected CI lanes",
      );
      for (const [runAttempt, nodeSelected] of [
        [2, true],
        [1, false],
      ] as const) {
        for (const failureReportResult of ["success", "failure", "skipped"]) {
          const context = {
            runAttempt,
            failureReportResult,
            preflightOutputs: { run_checks_node_core_nondist: String(nodeSelected) },
            failureReportOutputs: { known_main_red_attempt: String(runAttempt) },
          };
          expect(evaluateWorkflowExpression(workflow.jobs["pr-failure-report"].if, context)).toBe(
            true,
          );
          expect(evaluateWorkflowExpression(verify.env.ALLOW_KNOWN_MAIN_RED, context)).toBe(false);
          const reportRow = verify.env.JOB_RESULTS.split("\n")
            .find((line: string) => line.startsWith("pr-failure-report="))
            .replace(/\$\{\{[\s\S]*?\}\}/gu, (expression: string) =>
              String(evaluateWorkflowExpression(expression, context)),
            );
          expect(reportRow).toBe("pr-failure-report=skipped|false");
          const run = spawnSync("/bin/bash", ["-c", verify.run], {
            encoding: "utf8",
            env: {
              ...process.env,
              JOB_RESULTS: `preflight=success|true\nsecurity-fast=success|true\n${reportRow}`,
            },
          });
          expect(run.status, run.stdout).toBe(0);
        }
      }
    },
  );
});
