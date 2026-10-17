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
  readWorkflow,
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
const failedContext = {
  eventName: "pull_request" as const,
  repository: "openclaw/openclaw",
  runAttempt: 2,
  failed: true,
};
type WorkflowContext = Parameters<typeof evaluateWorkflowExpression>[1];
function expectAdmission(
  expression: unknown,
  admitted: WorkflowContext,
  rejected: WorkflowContext[] = [],
) {
  expect(evaluateWorkflowExpression(expression, admitted)).toBe(true);
  for (const candidate of [{ ...admitted, cancelled: true }, ...rejected]) {
    expect(evaluateWorkflowExpression(expression, candidate)).toBe(false);
  }
}

describe("complete CI failure reporting", () => {
  it("keeps mobile correctness out of preflight and in the required security job", () => {
    expect(
      ciWorkflow.jobs.preflight.steps.some(
        (entry: WorkflowStep) => entry.name === "Check mobile protocol event coverage",
      ),
    ).toBe(false);
    const coverage = ciStep("security-fast", "Check mobile protocol event coverage");
    const admitted = {
      ...failedContext,
      preflightOutputs: { run_protocol_event_coverage: "true" },
      steps: { node_setup: { outputs: {}, outcome: "success" as const } },
    };
    expectAdmission(coverage.if, admitted);
    expect(ciWorkflow.jobs["ci-gate"].needs).toContain("security-fast");
  });

  it.each([
    "check-shard",
    "check-lint-hosted-core-shard",
    "check-lint-hosted-extension-shard",
    "check-test-types-hosted-core-shard",
  ])("admits %s after guards fail only when the real producer outputs exist", (job) => {
    const admitted = {
      ...failedContext,
      runnerProfile: "hybrid" as const,
      preflightOutputs: {
        run_check: "true",
        run_check_plan: "true",
        shared_sdk_declarations: "true",
      },
      additionalNeeds: {
        "check-plan": {
          result: "failure" as const,
          outputs: {
            check_matrix: '{"include":[]}',
            run_lint_core: "true",
            run_lint_extensions: "true",
          },
        },
        "check-extension-package-boundary": {
          result: "failure" as const,
          outputs: { artifact_id: "123" },
        },
      },
    };
    expectAdmission(ciWorkflow.jobs[job].if, admitted, [
      {
        ...admitted,
        additionalNeeds: {
          ...admitted.additionalNeeds,
          "check-plan": { result: "failure", outputs: {} },
        },
      },
    ]);
  });

  it.each([
    "Check bundled plugin generated assets",
    "Smoke test CLI launcher help",
    "Smoke test CLI launcher status json",
    "Smoke test built CLI with Bun",
    "Verify built browser native host",
    "Run built artifact checks",
  ])("runs %s after another built check fails but requires dist", (name) => {
    const check = ciStep("build-artifacts", name);
    const admitted = {
      ...failedContext,
      preflightOutputs: { run_browser_native_host: "true" },
      steps: {
        dist_build: { outputs: {}, outcome: "success" as const },
        dist_build_cache: { outputs: {} },
      },
    };
    expectAdmission(check.if, admitted, [
      {
        ...admitted,
        steps: { ...admitted.steps, dist_build: { outputs: {}, outcome: "failure" } },
      },
    ]);
  });

  it("publishes a prepared SDK and consumes an uploaded candidate despite unrelated producer failures", () => {
    const publish = ciStep("check-extension-package-boundary", "Publish this run's prepared SDK");
    expect(
      evaluateWorkflowExpression(publish.if, {
        ...failedContext,
        steps: { prepare_sdk: { outputs: {}, outcome: "success" } },
      }),
    ).toBe(true);
    const candidate = {
      ...failedContext,
      sha: "candidate",
      preflightOutputs: { run_published_driver_update: "true", checkout_revision: "candidate" },
      additionalNeeds: {
        "build-artifacts": {
          result: "failure" as const,
          outputs: { published_driver_artifact_id: "123" },
        },
      },
    };
    expect(
      evaluateWorkflowExpression(ciWorkflow.jobs["published-driver-update"].if, candidate),
    ).toBe(true);
    expect(
      evaluateWorkflowExpression(ciWorkflow.jobs["published-driver-update"].if, {
        ...candidate,
        additionalNeeds: { "build-artifacts": { result: "failure", outputs: {} } },
      }),
    ).toBe(false);
  });

  it("keeps Docker seed lanes complete and static evidence independent of attempt", () => {
    expect(
      ciStep("docker-seed-e2e", "Run Docker seed tier").env?.OPENCLAW_DOCKER_ALL_FAIL_FAST,
    ).toBe("0");
    for (const [job, name] of [
      ["check-shard", "Run check shard"],
      ["check-lint-hosted-core-shard", "Run hosted core lint stripe"],
      ["check-lint-hosted-extension-shard", "Run hosted extension lint stripe"],
      ["check-test-types-hosted-core-shard", "Run hosted core test-types stripe"],
    ]) {
      expect(ciStep(job!, name!).env?.OPENCLAW_CI_STATIC_EVIDENCE).toBe("1");
    }
  });
});

function runChecks(job: string, name: string, env: Record<string, string> = {}) {
  const script = ciStep(job, name).run!.replaceAll(
    "source .ci-harness/scripts/ci-collect-checks.sh",
    `source '${path.resolve("scripts/ci-collect-checks.sh")}'`,
  );
  return spawnSync(
    "/bin/bash",
    [
      "-c",
      `${String.raw`
    pnpm() {
      printf 'CHECK %s\n' "$*"
      if [ "$1" = "$FAIL_COMMAND" ]; then return 1; fi
      return 0
    }
    env() {
      while [ "$#" -gt 0 ]; do
        case "$1" in -u) shift 2 ;; *=*) shift ;; *) break ;; esac
      done
      "$@"
    }
    node() {
      if [ "$1" = '--input-type=module' ]; then
        return 1
      elif [ "$1" = '-e' ]; then
        if [ "$FAIL_SCRIPT" != '' ] && [[ "$2" == *"$FAIL_SCRIPT"* ]]; then return 1; fi
      else
        printf 'CHECK node %s\n' "$*"
      fi
    }
    nproc() { printf '8\n'; }
    git() { if [ "$1" = cat-file ]; then return 0; fi; printf 'base\n'; }
  `}\n${script}`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FROZEN_TARGET: "false",
        HISTORICAL_TARGET: "false",
        NARROW_CHECK_PATHS_JSON: "",
        CHECKOUT_BASE_SHA: "",
        CI_CORE_TYPE_GRAPHS_JSON: "",
        CI_TYPE_GRAPHS_JSON: "",
        FAIL_COMMAND: "check:max-lines-ratchet",
        FAIL_SCRIPT: "",
        ...env,
      },
    },
  );
}

describe("CI check failure collection", () => {
  it.each([
    ["native-i18n", "Check native app generated locale parity", "node_setup"],
    ["control-ui-i18n", "Check Control UI locale parity", "node_setup"],
    ["checks-ui", "Test Control UI", "ui_chromium"],
    ["checks-ui", "Install Playwright WebKit", "node_setup"],
    ["checks-ui", "Test Control UI WebKit overlays and focus", "ui_webkit"],
    ["checks-ui-e2e-real-gateway", "Prove desktop resize over node and SSH", "real_gateway_build"],
    [
      "checks-ui-e2e-real-gateway",
      "Test Control UI suites with a real Gateway",
      "real_gateway_build",
    ],
    ["check-docs", "Check config docs baseline", "node_setup"],
    ["check-docs", "Check plugin inventory", "node_setup"],
    ["check-docs", "Check docs", "clawhub_docs"],
    ["skills-python", "Test skill Python scripts", "python_tooling"],
    ["security-fast", "Audit changed GitHub workflows with zizmor", "security_scanners"],
    ["security-fast", "Detect committed private keys", "scanner_config"],
  ])("runs %s / %s after sibling failures with its prerequisite", (job, name, prerequisite) => {
    const condition = ciStep(job, name).if;
    expect(condition).toContain("!cancelled()");
    expect(condition).toContain(`steps.${prerequisite}.outcome == 'success'`);
    expect(ciWorkflow.jobs[job]!.steps.some((item: WorkflowStep) => item.id === prerequisite)).toBe(
      true,
    );
  });

  it.each([
    [
      "guards",
      "pnpm lint:auth:pairing-account-scope",
      {
        FAIL_COMMAND: "check:no-conflict-markers",
        RUN_PR_MADGE_IMPORT_CYCLES: "true",
        RUN_PR_KYSELY_GUARDRAILS: "true",
      },
    ],
    [
      "lint",
      "pnpm format:check",
      {
        FAIL_COMMAND: "lint",
        HOSTED_RUNNER_STRIPES: "false",
        FORMAT_CHECK: "true",
        RUN_UI_TESTS: "true",
        RELEASE_GATE: "false",
        RUN_CONTROL_UI_I18N: "false",
      },
    ],
    [
      "test-types",
      "pnpm tsgo:test:root",
      {
        FAIL_COMMAND: "tsgo:extensions:test",
        HOSTED_RUNNER_STRIPES: "false",
        CHANGED_CORE_TEST_PATHS_JSON: '["src/a.test.ts"]',
      },
    ],
  ] as const)("collects later %s checks and preserves failure", (task, last, env) => {
    const result = runChecks("check-shard", "Run check shard", { TASK: task, ...env });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain(last.replace("pnpm ", "CHECK "));
    if (task === "guards") {
      expect(result.stdout).toContain("CHECK check:madge-import-cycles");
      expect(result.stdout).toContain("CHECK lint:kysely");
    }
  });

  it("finishes every baseline ratchet after the first failure", () => {
    const result = runChecks("checks-baseline-ratchets", "Run baseline ratchets", {
      RATCHET_BASE_REF: "base",
      RATCHET_PR_HEAD_SHA: "",
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("CHECK check:max-lines-ratchet --base base");
    expect(result.stdout).toContain("CHECK plugins:inventory:check");
    expect(result.stdout.match(/^CHECK /gm)).toHaveLength(8);
  });
  it("runs protocol checks after bundled tests fail", () => {
    const result = runChecks("checks-fast-core", "Run ${{ matrix.task }} (${{ matrix.runtime }})", {
      FAIL_COMMAND: "test:bundled",
      TASK: "bundled-protocol",
      RUN_BUNDLED_TESTS: "true",
      PROTOCOL_SINCE_BASE_SHA: "base",
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("CHECK test:bundled");
    expect(result.stdout).toContain("CHECK protocol:check");
  });
  it("finishes main-push security ratchets and protocol checks after a failure", () => {
    const result = runChecks("security-fast", "Check main push ratchets and protocol additions", {
      BASE_SHA: "base",
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout.match(/^CHECK /gm)).toHaveLength(7);
    expect(result.stdout).toContain("scripts/check-protocol-since.mts");
  });
  it("finishes legacy native locale checks after a failed native check", () => {
    const result = runChecks("native-i18n", "Verify native app i18n source", {
      FAIL_SCRIPT: "native:i18n:verify",
      FAIL_COMMAND: "native:i18n:check",
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout.match(/^CHECK /gm)).toHaveLength(3);
    expect(result.stdout).toContain("CHECK android:i18n:check");
    expect(result.stdout).toContain("CHECK apple:i18n:check");
  });
});

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
      "macos-swift",
      "OpenClawKit Talk-trait opt-out (no ElevenLabsKit when default traits disabled)",
    );
    const tests = ciStep("macos-swift", "OpenClawKit tests");
    const result = run(
      root,
      `
swift() { printf '%s\\n' "$*" >> "$TRACE"; }
export -f swift
${optOut.run}
if [[ -f "$GITHUB_ENV" ]]; then source "$GITHUB_ENV"; fi
${tests.run}
${ciStep("macos-swift", "Clean OpenClawKit build scratch").run}
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
        `\${{ ${ciStep("macos-swift", "Clean OpenClawKit build scratch").if} }}`,
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

  it("iOS runs the Access proof and Watch UI tests after lifecycle tests fail", () => {
    const root = fixture();
    const result = run(
      root,
      `xcodebuild() { printf '%s\\n' "$*" >> "$TRACE"; return 7; }
python3() { printf '%s\\n' "$*" >> "$TRACE"; }
${ciStep("ios-build", "Run focused iOS lifecycle simulator tests").run!}`,
      { IOS_CI_PHASE: "tests", IOS_MAIN_TIER: "false", IOS_SIMULATOR_ID: "fixture-simulator" },
    );
    expect(result.status, result.stderr).not.toBe(0);
    const commands = readFileSync(path.join(root, "trace"), "utf8").trim().split("\n");
    expect(commands).toHaveLength(3);
    expect(commands[0]).toContain("OpenClawLifecycleTests.xcresult");
    expect(commands[1]).toBe("scripts/ios-access-restart-proof.py fixture-simulator");
    expect(commands[2]).toContain("OpenClawWatchDeliveryUITests.xcresult");
  });

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

  it.each([
    ["macos-swift", "Install XcodeGen / SwiftLint / SwiftFormat", "select-xcode", "tests"],
    ["macos-swift", "Native state schema version contract", "macos-node-assets", "tests"],
    ["macos-swift", "Swift lint", "macos-swift-tools", "tests"],
    ["macos-swift", "Swift build (release)", "select-xcode", "release"],
    ["macos-swift", "Swift test", "macos-native-assets", "tests"],
    [
      "macos-swift",
      "OpenClawKit Talk-trait opt-out (no ElevenLabsKit when default traits disabled)",
      "select-xcode",
      "packages",
    ],
    ["macos-swift", "OpenClawKit tests", "select-xcode", "packages"],
    ["macos-swift", "Swabble tests", "select-xcode", "packages"],
    ["ios-build", "Test Watch RTC engine", "watch-rust-toolchain", "tests"],
    ["ios-build", "Install iOS Swift tooling", "node-env", "tests"],
    ["ios-build", "Swift lint", "ios-swift-tools", "tests"],
    ["ios-build", "Configure iOS build and report simulator selection", "node-env", "tests"],
    ["ios-build", "Prepare iOS simulator", "ios-configure", "tests"],
    ["ios-build", "Build iOS app", "ios-swift-tools", "tests"],
    ["ios-build", "Build iOS app (Release)", "ios-swift-tools", "release"],
    ["ios-build", "Prove native managed document download and export", "ios-swift-tools", "tests"],
    ["ios-build", "Run focused iOS voice cleanup simulator tests", "ios-app-build", "tests"],
    ["ios-build", "Run focused iOS lifecycle simulator tests", "ios-app-build", "tests"],
    ["ios-build", "Run focused Apple Watch operation simulator tests", "ios-app-build", "tests"],
  ])("%s / %s ignores unrelated failure but requires %s", (job, name, producer, phase) => {
    const setup = Object.fromEntries(
      [
        "select-xcode",
        "node-env",
        "macos-node-assets",
        "macos-swift-tools",
        "macos-native-assets",
        "ios-swift-tools",
        "ios-configure",
        "ios-simulator",
        "watch-rust-toolchain",
        "ios-app-build",
      ].map((id) => [id, { outputs: {}, outcome: "success" as const }]),
    );
    const nativeContext = {
      eventName: "pull_request" as const,
      repository: "openclaw/openclaw",
      runAttempt: 1,
      failed: true,
      matrix: { phase },
      env: { HISTORICAL_TARGET: "false", MACOS_PRIMARY_PHASE: "tests" },
      preflightOutputs: { run_openclawkit_tests: "true", validation_tier: "full" },
      steps: { ...setup, "macos-node-tooling": { outputs: {}, outcome: "skipped" as const } },
    };
    expectAdmission(ciStep(job, name).if, nativeContext, [
      {
        ...nativeContext,
        steps: { ...nativeContext.steps, [producer]: { outputs: {}, outcome: "failure" } },
      },
    ]);
  });
});

describe("built artifact proof upload", () => {
  it.each([
    { outcome: "success", selected: true, upload: true },
    { outcome: "failure", selected: true, upload: true },
    { outcome: "skipped", selected: true, upload: false },
    { outcome: "cancelled", selected: true, upload: false },
    { outcome: undefined, selected: true, upload: false },
    { outcome: "success", selected: false, upload: false },
    { outcome: "failure", selected: false, upload: false },
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

describe("workflow fixture reads", () => {
  it("keeps nested fixture mutations local to each read", () => {
    const file = path.join(temporary.make("openclaw-workflow-read-"), "action.yml");
    writeFileSync(file, "runs:\n  steps:\n    - run: original\n");
    const fixture = readWorkflow(file);
    fixture.runs.steps[0].run = "mutated";
    fixture.runs.steps.push({ run: "extra" });
    expect(readWorkflow(file)).toEqual({ runs: { steps: [{ run: "original" }] } });
  });

  it("observes changed source at a previously read path", () => {
    const file = path.join(temporary.make("openclaw-workflow-read-"), "action.yml");
    writeFileSync(file, "name: before\n");
    expect(readWorkflow(file)).toEqual({ name: "before" });
    writeFileSync(file, "name: after\n");
    expect(readWorkflow(file)).toEqual({ name: "after" });
  });
});

describe("PR failure reporting", () => {
  it("keeps critical-path routing and adds default Blacksmith failure reporting", () => {
    const gate = readCiWorkflow().jobs["ci-gate"];
    const context = {
      eventName: "pull_request" as const,
      repository: "openclaw/openclaw",
      runAttempt: 1,
      runnerProfile: "blacksmith" as const,
      failureReportOutputs: { failure_job_id: "42" },
    };
    for (const runnerBackend of ["", "blacksmith"] as const) {
      expect(evaluateWorkflowExpression(gate["runs-on"], { ...context, runnerBackend })).toBe(
        "blacksmith-4vcpu-ubuntu-2404",
      );
    }
    for (const override of [
      { failureReportOutputs: {} },
      { runAttempt: 2 },
      { runnerProfile: "github" as const },
      { runnerBackend: "github" as const },
      { eventName: "push" as const },
      { eventName: "workflow_dispatch" as const },
      { headRepository: "contributor/openclaw" },
    ]) {
      expect(evaluateWorkflowExpression(gate["runs-on"], { ...context, ...override })).toBe(
        "ubuntu-24.04",
      );
    }
    for (const runnerBackend of ["hybrid", "runson"] as const) {
      expect(
        evaluateWorkflowExpression(gate["runs-on"], {
          ...context,
          runnerBackend,
          runnerProfile: "hybrid",
          failureReportOutputs: {},
        }),
      ).toBe(runnerBackend === "hybrid" ? "ubuntu-24.04" : "blacksmith-4vcpu-ubuntu-2404");
      const report = readCiWorkflow().jobs["pr-failure-report"];
      expect(
        evaluateWorkflowExpression(report["runs-on"], {
          ...context,
          runnerBackend,
          runnerProfile: "hybrid",
        }),
      ).toBe(runnerBackend === "hybrid" ? "ubuntu-24.04" : "blacksmith-4vcpu-ubuntu-2404");
      expect(
        evaluateWorkflowExpression(report["runs-on"], {
          ...context,
          runnerBackend,
          headRepository: "contributor/openclaw",
        }),
      ).toBe("ubuntu-24.04");
    }
  });

  it("keeps hybrid qualification and release runner reservations intact", () => {
    const workflow = readCiWorkflow();
    for (const nodeRunnerBackend of ["hybrid", "runson"]) {
      const context = {
        eventName: "workflow_dispatch" as const,
        repository: "openclaw/openclaw",
        runAttempt: 1,
        runnerBackend: "hybrid" as const,
        preflightOutputs: {
          ci_qualification: "true",
          qualification_runner_backend: "hybrid",
          node_runner_backend: nodeRunnerBackend,
        },
      };
      expect(evaluateWorkflowExpression(workflow.jobs.preflight["runs-on"], context)).toBe(
        "ubuntu-24.04",
      );
      expect(evaluateWorkflowExpression(workflow.jobs["ci-gate"]["runs-on"], context)).toBe(
        "blacksmith-4vcpu-ubuntu-2404",
      );
      for (const jobName of ["preflight", "ci-gate"]) {
        expect(
          evaluateWorkflowExpression(workflow.jobs[jobName]["runs-on"], {
            ...context,
            preflightOutputs: {},
            dispatchId: "full-release-validation-123-1",
            releaseRunnerGroup: "Release reserved",
          }),
        ).toEqual({ group: "Release reserved", labels: "ubuntu-24.04" });
      }
    }
  });

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
    "finishes selected compiler and lint groups after every non-cancellation failure",
    () => {
      const workflow = readCiWorkflow();
      const central = workflow.jobs["check-shard"].steps.find(
        (step: WorkflowStep) => step.name === "Run check shard",
      );
      const hosted = workflow.jobs["check-test-types-hosted-core-shard"].steps.find(
        (step: WorkflowStep) => step.name === "Run hosted core test-types stripe",
      );
      const root = checkFixture("ci-type-groups-", ["ci-static-step.sh", "ci-collect-checks.sh"]);
      const calls = path.join(root, "calls");
      mkdirSync(path.join(root, "scripts"));
      writeFileSync(path.join(root, "scripts/run-oxlint-shards.mts"), "// --extension-stripe\n");
      writeFileSync(
        path.join(root, "node"),
        '#!/bin/bash\nprintf "%s\\n" "$*" >> "$CALLS_FILE"\nif [[ "$*" == *"${FAIL_MARKER:-first}"* ]]; then exit "$COMPILER_EXIT"; fi\n',
        { mode: 0o755 },
      );
      const runCompiler = (script: string, env: Record<string, string>) =>
        spawnSync("/bin/bash", ["-c", script], {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, PATH: `${root}:${process.env.PATH}`, CALLS_FILE: calls, ...env },
        });
      const checkGroups = (
        script: string,
        kind: string,
        env: Record<string, string>,
        scenarios: readonly (readonly [string, string])[],
      ) => {
        for (const [evidence, compilerExit] of scenarios) {
          writeFileSync(calls, "");
          const run = runCompiler(script, {
            ...env,
            COMPILER_EXIT: compilerExit,
            OPENCLAW_CI_STATIC_EVIDENCE: evidence,
          });
          expect(run.status, run.stderr).toBe(Number(compilerExit));
          expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(2);
          expect(run.stdout).toContain(`[ci-static:${kind}:step] {"version":1,"groups":2}`);
        }
      };
      checkGroups(
        central.run,
        "tsgo",
        {
          NARROW_CHECK_PATHS_JSON: '["src/example.ts"]',
          TASK: "test-types",
          CI_CORE_TYPE_GRAPHS_JSON: '["first"]',
          CI_CORE_TYPE_CONCURRENCY: "1",
          CI_TYPE_GRAPHS_JSON: '["second"]',
        },
        [
          ["1", "2"],
          ["0", "2"],
          ["1", "1"],
        ],
      );
      const run = runCompiler(hosted.run, {
        COMPILER_EXIT: "2",
        OPENCLAW_CI_STATIC_EVIDENCE: "1",
        CI_TYPE_GRAPHS_JSON: '["first"]',
      });
      expect(run.status, run.stderr).toBe(2);
      expect(run.stdout).toContain('[ci-static:tsgo:step] {"version":1,"groups":1}');

      const lint = workflow.jobs["check-lint-hosted-core-shard"].steps.find(
        (step: WorkflowStep) => step.name === "Run hosted core lint stripe",
      );
      const lintScript = lint.run.replace(/\$\{\{[\s\S]*?\}\}/gu, (expression: string) =>
        String(evaluateWorkflowExpression(expression, { runnerProfile: "github" })),
      );
      checkGroups(
        lintScript,
        "oxlint",
        {
          FAIL_MARKER: "--only=core",
          CORE_STRIPE: "1",
          FROZEN_TARGET: "false",
          RUNNER_PROFILE: "github",
          RELEASE_GATE: "false",
        },
        [
          ["1", "1"],
          ["0", "1"],
          ["1", "2"],
        ],
      );
    },
  );

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
        ["check-shard", "failure", "1", 1, 0],
        ["check-test-types-hosted-core-shard", "failure", "1", 1, 0],
        ["check-test-types-hosted-core-shard", "failure", "", 1, 1],
        ["check-lint-hosted-core-shard", "failure", "1", 1, 0],
        ["check-lint-hosted-extension-shard", "failure", "1", 1, 0],
        ["check-lint-hosted-core-shard", "failure", "", 1, 1],
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

  it.skipIf(process.platform === "win32")(
    "publishes the classification table and machine-readable failures without changing the gate result",
    () => {
      const gate = readCiWorkflow().jobs["ci-gate"];
      const step = gate.steps.find(
        (entry: WorkflowStep) => entry.name === "Report PR failure classification",
      );
      const context: Parameters<typeof evaluateWorkflowExpression>[1] = {
        eventName: "pull_request",
        repository: "openclaw/openclaw",
        runAttempt: 2,
      };
      expect(evaluateWorkflowExpression(`\${{ ${step.if} }}`, context)).toBe(false);
      const summary = "| Job | Class |\n| --- | --- |\n| checks-node-example | pre-existing |\n";
      const failures = [
        {
          job: "checks-node-example",
          conclusion: "failure",
          class: "pre-existing",
          mainRunId: 90,
          mainJobId: 42,
          reason: "matching failure signature",
        },
      ];
      const summaryPath = path.join(temporary.make("pr-failure-gate-"), "summary.md");
      const outputs = {
        summary_json: JSON.stringify(summary),
        failures_json: JSON.stringify(failures),
      };
      expect(
        evaluateWorkflowExpression(`\${{ ${step.if} }}`, {
          ...context,
          failureReportOutputs: outputs,
        }),
      ).toBe(true);
      const result = spawnSync("/bin/bash", ["-c", step.run], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: summaryPath,
          SUMMARY_JSON: outputs.summary_json,
          FAILURES_JSON: outputs.failures_json,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(summaryPath, "utf8")).toBe(summary);
      expect(result.stdout).toContain(summary);
      expect(result.stdout).toContain(outputs.failures_json);
    },
  );
});
