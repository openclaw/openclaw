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
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { evaluateWorkflowExpression, type WorkflowStep } from "./ci-workflow.test-support.js";

const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
  jobs: Record<string, { steps: WorkflowStep[] }>;
};

function step(job: string, name: string): WorkflowStep {
  const result = workflow.jobs[job]?.steps.find((entry) => entry.name === name);
  if (!result) {
    throw new Error(`Missing ${job} step: ${name}`);
  }
  return result;
}

describe("native CI failure collection", () => {
  const temporary = useAutoCleanupTempDirTracker(afterEach);

  function fixture() {
    const root = temporary.make("ci-native-complete-");
    const harness = path.join(root, ".ci-harness/scripts");
    mkdirSync(path.join(harness, "lib"), { recursive: true });
    copyFileSync("scripts/ci-collect-checks.sh", path.join(harness, "ci-collect-checks.sh"));
    copyFileSync("scripts/lib/swift-toolchain.sh", path.join(harness, "lib/swift-toolchain.sh"));
    return root;
  }

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
    const optOut = step(
      "macos-swift",
      "OpenClawKit Talk-trait opt-out (no ElevenLabsKit when default traits disabled)",
    );
    const tests = step("macos-swift", "OpenClawKit tests");
    const result = run(
      root,
      `
swift() { printf '%s\\n' "$*" >> "$TRACE"; }
export -f swift
${optOut.run}
if [[ -f "$GITHUB_ENV" ]]; then source "$GITHUB_ENV"; fi
${tests.run}
${step("macos-swift", "Clean OpenClawKit build scratch").run}
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
        `\${{ ${step("macos-swift", "Clean OpenClawKit build scratch").if} }}`,
        {
          eventName: "schedule",
          repository: "openclaw/openclaw",
          runAttempt: 1,
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
      const result = run(root, step(job, "Swift lint").run!);
      expect(result.status, result.stderr).not.toBe(0);
      expect(readFileSync(path.join(root, "trace"), "utf8").trim().split("\n")).toEqual([
        "lint",
        "format",
      ]);
    },
  );

  it("macOS runs rendered and named-profile groups after the default-profile group fails", () => {
    const root = fixture();
    executable(root, "scripts/test-macos-native.mts", "exit 0");
    const result = run(
      root,
      `swift() { echo swift-build >> "$TRACE"; }
sysctl() { echo 2; }
node() {
  if [[ "$1" == -e ]]; then echo fixture; return; fi
  printf '%s\\n' "$*" >> "$TRACE"
  if [[ "$*" == *'default'*'--skip'* ]]; then return 7; fi
}
${step("macos-swift", "Swift test").run!}`,
    );
    expect(result.status, result.stderr).not.toBe(0);
    const commands = readFileSync(path.join(root, "trace"), "utf8").trim().split("\n");
    expect(commands).toHaveLength(4);
    expect(commands[1]).toContain("default --package-path");
    expect(commands[2]).toContain("--filter QuickChatCatalogPresentationTests");
    expect(commands[3]).toContain("named --package-path");
  });

  it("macOS does not start test groups when test compilation fails", () => {
    const root = fixture();
    const result = run(
      root,
      `swift() { return 7; }
node() { if [[ "$1" == -e ]]; then echo fixture; else echo unexpected >> "$TRACE"; fi; }
${step("macos-swift", "Swift test").run!}`,
    );
    expect(result.status, result.stderr).toBe(7);
    expect(result.stdout).not.toContain("macOS default profile");
  });

  it("iOS runs the Access proof and Watch UI tests after lifecycle tests fail", () => {
    const root = fixture();
    const result = run(
      root,
      `xcodebuild() { printf '%s\\n' "$*" >> "$TRACE"; return 7; }
python3() { printf '%s\\n' "$*" >> "$TRACE"; }
${step("ios-build", "Run focused iOS lifecycle simulator tests").run!}`,
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
      step("android", "Run Android ${{ matrix.task }}").run!,
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
    const context = {
      eventName: "pull_request" as const,
      repository: "openclaw/openclaw",
      runAttempt: 1,
      failed: true,
      matrix: { phase },
      env: { HISTORICAL_TARGET: "false", MACOS_PRIMARY_PHASE: "tests" },
      preflightOutputs: { run_openclawkit_tests: "true", validation_tier: "full" },
      steps: { ...setup, "macos-node-tooling": { outputs: {}, outcome: "skipped" as const } },
    };
    expect(evaluateWorkflowExpression(step(job, name).if, context)).toBe(true);
    expect(evaluateWorkflowExpression(step(job, name).if, { ...context, cancelled: true })).toBe(
      false,
    );
    expect(
      evaluateWorkflowExpression(step(job, name).if, {
        ...context,
        steps: { ...context.steps, [producer]: { outputs: {}, outcome: "failure" } },
      }),
    ).toBe(false);
  });
});
