import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { evaluateWorkflowExpression } from "./ci-workflow.test-support.js";

type Command = { tool: string; args: string[]; destination?: string; settings?: string };

const workflow: {
  jobs: Record<
    string,
    {
      steps: {
        name?: string;
        id?: string;
        if?: string;
        run?: string;
        "continue-on-error"?: boolean;
        env?: Record<string, string>;
        with?: Record<string, string>;
      }[];
    }
  >;
} = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const watchStep = workflow.jobs["ios-build"]?.steps.find(
  (step) => step.name === "Run focused Apple Watch operation simulator tests",
);
const voiceStep = workflow.jobs["ios-build"]?.steps.find(
  (step) => step.name === "Run focused iOS voice cleanup simulator tests",
);
const nativeActionStep = workflow.jobs["ios-build"]?.steps.find(
  (step) => step.name === "Run focused iOS native action simulator tests",
);
const gatewayTestsStep = workflow.jobs["ios-build"]?.steps.find(
  (step) =>
    step.name === "Prove native iOS actions against a real Gateway" &&
    step.if?.startsWith("matrix.phase == 'tests'"),
);
const installedStep = workflow.jobs["ios-build"]?.steps.find(
  (step) => step.id === "ios_installed_shortcuts",
);
const prepareStep = workflow.jobs["ios-build"]?.steps.find(
  (step) => step.name === "Prepare iOS simulator",
);
const buildStep = workflow.jobs["ios-build"]?.steps.find((step) => step.name === "Build iOS app");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runSimulatorStep(mode = "ready", steps = [watchStep], env: Record<string, string> = {}) {
  const root = tempDirs.make("openclaw-watch-workflow-");
  const bin = path.join(root, "bin");
  const harnessLib = path.join(root, ".ci-harness", "scripts", "lib");
  const product = path.join(root, "project derived data", "Watch Product.app");
  mkdirSync(bin, { recursive: true });
  mkdirSync(harnessLib, { recursive: true });
  copyFileSync("scripts/lib/swift-toolchain.sh", path.join(harnessLib, "swift-toolchain.sh"));
  mkdirSync(product, { recursive: true });
  const runner = path.join(root, "tools.mjs");
  writeFileSync(
    runner,
    String.raw`
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
const [tool, ...args] = process.argv.slice(2);
const root = process.env.WATCH_FIXTURE_ROOT;
const mode = process.env.WATCH_FIXTURE_MODE;
if (tool === "node" && !args.some((arg) =>
  ["scripts/test-native-action-gateway.mts", "scripts/test-ios-shortcuts-installed.mts"].includes(arg)
)) {
  const forwarded = spawnSync(process.execPath, args, { stdio: "inherit" });
  process.exit(forwarded.status ?? 1);
}
appendFileSync(path.join(root, "commands.jsonl"), JSON.stringify({
  tool, args, destination: process.env.IOS_DEST,
  settings: process.env.XCODE_XCCONFIG_FILE ? readFileSync(process.env.XCODE_XCCONFIG_FILE, "utf8") : undefined,
}) + "\n");
if (mode === "voice-qa-build-failed" && tool === "pnpm" && args[0] === "build") {
  process.exit(31);
}
if (mode === "voice-gateway-proof-failed" && args.includes("scripts/test-native-action-gateway.mts")) {
  process.exit(32);
}
if (mode === "voice-installed-proof-failed" && args.includes("scripts/test-ios-shortcuts-installed.mts")) {
  process.exit(33);
}
if (tool === "uname") {
  console.log("arm64");
} else if (tool === "xcrun") {
  if (args[1] === "list") {
    console.log(JSON.stringify({ devices: { watch: [
      { name: mode.startsWith("voice") ? "iPhone fixture" : "Apple Watch fixture", isAvailable: true, udid: "watch-fixture" }
    ] } }));
  } else if (args[1] === "bootstatus" && mode.endsWith("boot-failed")) {
    process.exit(23);
  } else if (args[1] === "install" && !existsSync(args[3])) {
    process.exit(24);
  }
} else if (args.includes("-showBuildSettings")) {
  const product = {
    target: "OpenClawWatchApp",
    buildSettings: {
      TARGET_BUILD_DIR: mode === "relative-product" ? "relative" : path.join(root, "project derived data"),
      FULL_PRODUCT_NAME: "Watch Product.app"
    }
  };
  const other = { target: "OtherTarget", buildSettings: { TARGET_BUILD_DIR: "/wrong", FULL_PRODUCT_NAME: "Wrong.app" } };
  console.log(JSON.stringify(mode === "missing-product" ? [other] :
    mode === "ambiguous-product" ? [product, product] : [other, product]));
} else if (args.includes("build-for-testing")) {
  const derivedIndex = args.indexOf("-derivedDataPath");
  if (derivedIndex >= 0) {
    mkdirSync(path.join(args[derivedIndex + 1], "Build/Products/Debug-watchsimulator/OpenClawWatchApp.app"), { recursive: true });
  }
}
`,
  );
  for (const tool of ["xcrun", "xcodebuild", "pnpm", "uname", "node"]) {
    const executable = path.join(bin, tool);
    writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${runner}' '${tool}' "$@"\n`);
    chmodSync(executable, 0o755);
  }
  const environmentFile = path.join(root, "github-env");
  writeFileSync(environmentFile, "");
  const script = steps
    .map((step) => {
      if (!step?.run) {
        throw new Error("Missing simulator workflow step");
      }
      return `${step.run}\nset -a\nsource "$GITHUB_ENV"\nset +a`;
    })
    .join("\n");
  const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      RUNNER_TEMP: root,
      WATCH_FIXTURE_ROOT: root,
      WATCH_FIXTURE_MODE: mode,
      GITHUB_ENV: environmentFile,
      IOS_CI_PHASE: "smoke",
      HISTORICAL_TARGET: "false",
      IOS_DEST: "",
      XCODE_XCCONFIG_FILE: "",
      ...env,
    },
  });
  const commands: Command[] = readFileSync(path.join(root, "commands.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return { result, commands, product };
}

describe.skipIf(process.platform === "win32")("Watch simulator workflow", () => {
  it("reuses project build products and installs the exact Watch target before running its tests", () => {
    const { result, commands, product } = runSimulatorStep();
    expect(result.status, result.stderr).toBe(0);
    const xcodeCommands = commands.filter((command) => command.tool === "xcodebuild");
    for (const command of xcodeCommands) {
      expect(command.args).not.toContain("-derivedDataPath");
    }
    expect(
      commands.filter((command) => command.tool === "xcrun").map((command) => command.args),
    ).toEqual([
      ["simctl", "list", "devices", "available", "--json"],
      ["simctl", "boot", "watch-fixture"],
      ["simctl", "bootstatus", "watch-fixture", "-b"],
      ["simctl", "install", "watch-fixture", product],
    ]);
    expect(
      xcodeCommands.map((command) =>
        command.args.find((arg) =>
          ["build-for-testing", "-showBuildSettings", "test-without-building"].includes(arg),
        ),
      ),
    ).toEqual(["build-for-testing", "-showBuildSettings", "test-without-building"]);
    for (const command of xcodeCommands.filter(
      (entry) =>
        entry.args.includes("build-for-testing") || entry.args.includes("test-without-building"),
    )) {
      expect(command.args).toEqual(
        expect.arrayContaining([
          "OpenClawWatchApp",
          "Debug",
          "platform=watchOS Simulator,id=watch-fixture",
          "-parallel-testing-enabled",
          "NO",
          "-only-testing:OpenClawWatchTests/WatchInboxStoreOperationTests",
          "-only-testing:OpenClawWatchTests/WatchRealtimeMediaTests",
          "-only-testing:OpenClawWatchTests/WatchGatewayConfigurationTests",
          "CODE_SIGNING_ALLOWED=NO",
        ]),
      );
    }
    expect(
      xcodeCommands.find((command) => command.args.includes("test-without-building"))?.args,
    ).toContain("apps/ios/build/LifecycleTestResults/OpenClawWatchOperationTests.xcresult");
  });

  it.each(["missing-product", "ambiguous-product", "relative-product"])(
    "rejects %s settings before simulator installation or test execution",
    (mode) => {
      const { result, commands } = runSimulatorStep(mode);
      expect(result.status).not.toBe(0);
      expect(commands.some((command) => command.args.includes("install"))).toBe(false);
      expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(
        false,
      );
    },
  );

  it("preserves simulator readiness failure without installing or running tests", () => {
    const { result, commands } = runSimulatorStep("boot-failed");
    expect(result.status).toBe(23);
    expect(commands.some((command) => command.args.includes("install"))).toBe(false);
    expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("iOS voice cleanup workflow", () => {
  it.each([
    ["tests", "false"],
    ["smoke", "true"],
  ])("keeps the generic simulator build for phase=%s historical=%s", (phase, historical) => {
    const { result, commands } = runSimulatorStep("voice", [buildStep], {
      IOS_CI_PHASE: phase,
      HISTORICAL_TARGET: historical,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(commands).toEqual([{ tool: "pnpm", args: ["ios:build"], destination: "" }]);
  });

  it("retains universal build settings and verbose diagnostics in full manual validation", () => {
    const { result, commands } = runSimulatorStep("voice", [prepareStep, buildStep, voiceStep], {
      IOS_CI_PHASE: "tests",
    });
    expect(result.status, result.stderr).toBe(0);
    const appBuild = commands.find((command) => command.tool === "pnpm");
    expect(appBuild?.destination).toBe("");
    expect(commands.every((command) => command.settings === undefined)).toBe(true);
    const testRun = commands.find((command) => command.tool === "xcodebuild");
    expect(testRun?.args).toEqual(
      expect.arrayContaining(["-collect-test-diagnostics", "on-failure"]),
    );
  });

  it("stops before compilation and XCTest when the selected iPhone cannot boot", () => {
    const { result, commands } = runSimulatorStep("voice-boot-failed", [
      prepareStep,
      buildStep,
      voiceStep,
    ]);
    expect(result.status).toBe(23);
    expect(commands.every((command) => command.tool === "xcrun")).toBe(true);
  });

  it("executes cleanup and sibling suites with normal Debug simulator signing", () => {
    const { result, commands } = runSimulatorStep("voice", [prepareStep, buildStep, voiceStep]);
    expect(result.status, result.stderr).toBe(0);
    const appBuild = commands.find((command) => command.tool === "pnpm");
    expect(appBuild?.destination).toBe("platform=iOS Simulator,id=watch-fixture");
    expect(appBuild?.settings).toBe("ARCHS = arm64\nCOMPILER_INDEX_STORE_ENABLE = NO\n");
    expect(
      commands.filter((command) => command.tool === "xcrun").map((command) => command.args),
    ).toEqual([
      ["simctl", "list", "devices", "available", "--json"],
      ["simctl", "bootstatus", "watch-fixture", "-b"],
    ]);
    const builds = commands.filter((command) => command.tool === "xcodebuild");
    expect(builds).toHaveLength(1);
    const build = builds[0];
    if (!build) {
      throw new Error("Missing voice cleanup xcodebuild command");
    }
    expect(build.args.filter((arg) => arg.startsWith("-only-testing:"))).toEqual([
      "-only-testing:OpenClawTests/TalkRealtimeVoiceSessionCleanupTests",
      "-only-testing:OpenClawTests/TalkRealtimeConsultCancellationTests",
      "-only-testing:OpenClawTests/TalkRealtimeTranscriptWriteQueueTests",
      "-only-testing:OpenClawTests/TalkModeManagerTests",
      "-only-testing:OpenClawTests/ManagedDocumentEnvelopeTests",
      "-only-testing:OpenClawTests/IOSMediaArtifactLoaderTests",
      "-only-testing:OpenClawTests/OpenClawTypographyTests",
    ]);
    expect(build.args).toEqual(expect.arrayContaining(["-configuration", "Debug", "test"]));
    expect(build.args).toContain(appBuild?.destination);
    expect(build.settings).toBe(appBuild?.settings);
    expect(build.args).toEqual(expect.arrayContaining(["-collect-test-diagnostics", "never"]));
    expect(build.args.some((arg) => arg.startsWith("CODE_SIGN"))).toBe(false);
  });
});

describe("iOS native action workflow", () => {
  it("keeps Gateway, installed and native proofs fatal with one shared Gateway command", () => {
    const steps = workflow.jobs["ios-build"]!.steps;
    const gatewaySteps = steps.filter(
      (step) => step.name === "Prove native iOS actions against a real Gateway",
    );
    expect(gatewaySteps).toHaveLength(2);
    expect(gatewaySteps[0]!.run).toBe(gatewaySteps[1]!.run);
    for (const step of steps.filter((candidate) =>
      [
        "Build iOS app",
        "Prove native managed document download and export",
        "Run focused iOS voice cleanup simulator tests",
        "Prove native iOS actions against a real Gateway",
        "Prove installed iOS automatic run opening",
        "Run focused iOS native action simulator tests",
        "Run focused iOS lifecycle simulator tests",
        "Run focused Apple Watch operation simulator tests",
      ].includes(candidate.name ?? ""),
    )) {
      // No status override: GitHub requires prior success before starting more compute.
      expect(step.if).not.toMatch(/\b(?:always|failure|cancelled)\s*\(/);
      expect(step["continue-on-error"]).toBeUndefined();
    }
    expect(steps.filter((step) => step.id === "ios_installed_shortcuts")).toHaveLength(1);
    expect(steps.filter((step) => step.id === "ios_native_action_tests")).toHaveLength(1);
    expect(steps.indexOf(installedStep!)).toBeLessThan(steps.indexOf(nativeActionStep!));
    expect(
      steps.findIndex((step) => step.name === "Export native action visual proof"),
    ).toBeGreaterThan(steps.indexOf(nativeActionStep!));
  });

  it.skipIf(process.platform === "win32").each([
    ["voice-qa-build-failed", 31, false],
    ["voice-gateway-proof-failed", 32, false],
    ["voice-installed-proof-failed", 33, true],
  ] as const)("stops full native proof after %s", (mode, status, installedAttempted) => {
    const { result, commands } = runSimulatorStep(
      mode,
      [prepareStep, buildStep, voiceStep, gatewayTestsStep, installedStep, nativeActionStep],
      { IOS_CI_PHASE: "tests", PROOF_SOURCE_SHA: "fixture-source" },
    );
    expect(result.status, result.stderr).toBe(status);
    const invoked = (script: string) => commands.some((command) => command.args.includes(script));
    expect(invoked("scripts/test-native-action-gateway.mts")).toBe(status !== 31);
    expect(invoked("scripts/test-ios-shortcuts-installed.mts")).toBe(installedAttempted);
    expect(
      commands.some((command) =>
        command.args.includes("-only-testing:OpenClawTests/NativeActionRouterTests"),
      ),
    ).toBe(false);
  });

  it("binds installed Shortcuts to the exact checkout after the private QA build and uploads only its receipt", () => {
    const steps = workflow.jobs["ios-build"]!.steps;
    const index = steps.findIndex((step) => step.id === "ios_installed_shortcuts");
    expect(index).toBeGreaterThan(0);
    const step = steps[index]!;
    expect(steps[index - 1]!.env?.OPENCLAW_BUILD_PRIVATE_QA).toBe("1");
    expect(steps[index - 1]!.run).toContain("pnpm build qaRuntime");
    expect(step.env?.PROOF_SOURCE_SHA).toBe("${{ needs.preflight.outputs.checkout_revision }}");
    expect(step.run).toContain(
      "node --import ./scripts/tsx.mjs scripts/test-ios-shortcuts-installed.mts",
    );
    expect(step.run).toContain('--matrix automatic-run-opening --target-sha "$PROOF_SOURCE_SHA"');
    expect(step.run).not.toContain("IOS_SIMULATOR_ID");
    const upload = steps.find(
      (candidate) => candidate.name === "Upload installed iOS Shortcuts receipt",
    )!;
    expect(upload.with?.path).toBe("${{ runner.temp }}/ios-shortcuts-installed.json");
    expect(upload.with?.["if-no-files-found"]).toBe("error");
    for (const phase of ["smoke", "tests", "release"]) {
      for (const compatibility of ["true", "false"]) {
        expect(
          evaluateWorkflowExpression(`\${{ ${step.if} }}`, {
            eventName: "workflow_dispatch",
            repository: "openclaw/openclaw",
            runAttempt: 1,
            matrix: { phase },
            preflightOutputs: { compatibility_target: compatibility },
          }),
        ).toBe(phase === "tests" && compatibility === "false");
      }
    }
    for (const outcome of ["success", "failure", "cancelled", "skipped", undefined] as const) {
      expect(
        evaluateWorkflowExpression(upload.if, {
          eventName: "workflow_dispatch",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          steps: { ios_installed_shortcuts: { outputs: {}, outcome } },
        }),
      ).toBe(outcome !== "skipped" && outcome !== undefined);
    }
  });
  it.skipIf(process.platform === "win32").each(["smoke", "tests"])(
    "runs each complete native suite once using the prepared %s simulator policy",
    (phase) => {
      const { result, commands } = runSimulatorStep(
        "voice",
        [prepareStep, buildStep, nativeActionStep],
        {
          IOS_CI_PHASE: phase,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const builds = commands.filter((command) => command.tool === "xcodebuild");
      expect(builds).toHaveLength(1);
      const args = builds[0]!.args;
      expect(
        commands.filter((command) => command.tool === "xcrun").map((command) => command.args),
      ).toEqual([
        ["simctl", "list", "devices", "available", "--json"],
        ["simctl", "bootstatus", "watch-fixture", "-b"],
      ]);
      expect(args).toEqual(
        expect.arrayContaining(["-destination", "platform=iOS Simulator,id=watch-fixture"]),
      );
      expect(args).toEqual(
        expect.arrayContaining([
          "-collect-test-diagnostics",
          phase === "smoke" ? "never" : "on-failure",
        ]),
      );
      const appBuild = commands.find((command) => command.tool === "pnpm");
      expect(appBuild?.destination).toBe(
        phase === "smoke" ? "platform=iOS Simulator,id=watch-fixture" : "",
      );
      expect(builds[0]!.settings).toBe(
        phase === "smoke" ? "ARCHS = arm64\nCOMPILER_INDEX_STORE_ENABLE = NO\n" : undefined,
      );
      expect(appBuild?.settings).toBe(builds[0]!.settings);
      const selectors = [
        "-only-testing:OpenClawTests/NativeActionRouterTests",
        "-only-testing:OpenClawTests/NativeActionVisualProofTests",
        "-only-testing:OpenClawTests/SwiftUIRenderSmokeTests",
      ];
      expect(args.filter((arg) => arg.startsWith("-only-testing:"))).toEqual(selectors);
      expect(args).toEqual(expect.arrayContaining(["-configuration", "Debug", "test"]));
      expect(args.some((arg) => arg.startsWith("CODE_SIGN"))).toBe(false);
      const bundle = args[args.indexOf("-resultBundlePath") + 1];
      expect(bundle).toBe("apps/ios/build/LifecycleTestResults/OpenClawNativeActionTests.xcresult");
      const steps = workflow.jobs["ios-build"]!.steps;
      for (const selector of selectors) {
        expect(steps.filter((step) => step.run?.includes(selector))).toEqual([nativeActionStep]);
      }
      const exporter = steps.find((step) => step.name === "Export native action visual proof");
      expect(exporter?.run).toContain(`bundle = ${JSON.stringify(bundle)}`);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not run native suites after prepared simulator boot failure",
    () => {
      const { result, commands } = runSimulatorStep("voice-boot-failed", [
        prepareStep,
        nativeActionStep,
      ]);
      expect(result.status).toBe(23);
      expect(commands.every((command) => command.tool === "xcrun")).toBe(true);
    },
  );

  it.each(["success", "failure", "cancelled", "skipped"] as const)(
    "exports the attempted native result on %s independently of lifecycle tests",
    (outcome) => {
      const exporter = workflow.jobs["ios-build"]!.steps.find(
        (step) => step.name === "Export native action visual proof",
      );
      expect(nativeActionStep?.id).toBe("ios_native_action_tests");
      expect(
        evaluateWorkflowExpression(exporter?.if, {
          eventName: "pull_request",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          steps: {
            ios_native_action_tests: { outputs: {}, outcome },
            ios_lifecycle_tests: { outputs: {}, outcome: "success" },
          },
        }),
      ).toBe(outcome !== "skipped");
    },
  );
});
