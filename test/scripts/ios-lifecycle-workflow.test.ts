import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  formatIosSimulatorSelectionSummary,
  resolveIosSimulatorTestSelection,
} from "../../scripts/lib/ci-ios-smoke-plan.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { runCiManifestFixture } from "./ci-workflow-manifest.test-support.js";
import { evaluateWorkflowExpression } from "./ci-workflow.test-support.js";

type Command = { tool: string; args: string[]; destination?: string; settings?: string };

function isTestCommand(command: Command) {
  return (
    command.tool === "xcodebuild" &&
    command.args.some((arg) => arg === "test" || arg === "test-without-building")
  );
}

type Step = { name?: string; run?: string; if?: string };
const workflow: {
  jobs: Record<
    string,
    {
      env?: Record<string, string>;
      steps?: Step[];
      strategy?: { matrix?: { phase?: string } };
    }
  >;
} = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const watchStep = workflow.jobs["ios-build"]?.steps?.find(
  (step) => step.name === "Run focused Apple Watch operation simulator tests",
);
const voiceStep = workflow.jobs["ios-build"]?.steps?.find(
  (step) => step.name === "Run focused iOS voice cleanup simulator tests",
);
const iosStep = workflow.jobs["ios-build"]?.steps?.find(
  (step) => step.name === "Run focused iOS lifecycle simulator tests",
);
const prepareStep = workflow.jobs["ios-build"]?.steps?.find(
  (step) => step.name === "Prepare iOS simulator",
);
const buildStep = workflow.jobs["ios-build"]?.steps?.find((step) => step.name === "Build iOS app");
const configureStep = workflow.jobs["ios-build"]?.steps?.find(
  (step) => step.name === "Configure iOS build and report simulator selection",
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runSimulatorStep(mode = "ready", steps = [watchStep], env: Record<string, string> = {}) {
  const root = tempDirs.make("openclaw-watch-workflow-");
  const bin = path.join(root, "bin");
  const harnessLib = path.join(root, ".ci-harness", "scripts", "lib");
  const product = path.join(root, "project derived data", "Watch Product.app");
  mkdirSync(bin, { recursive: true });
  mkdirSync(harnessLib, { recursive: true });
  copyFileSync("scripts/lib/swift-toolchain.sh", path.join(harnessLib, "swift-toolchain.sh"));
  copyFileSync("scripts/lib/ci-ios-smoke-plan.mjs", path.join(harnessLib, "ci-ios-smoke-plan.mjs"));
  mkdirSync(product, { recursive: true });
  const runner = path.join(root, "tools.mjs");
  writeFileSync(
    runner,
    String.raw`
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
const [tool, ...args] = process.argv.slice(2);
const root = process.env.WATCH_FIXTURE_ROOT;
const mode = process.env.WATCH_FIXTURE_MODE;
appendFileSync(path.join(root, "commands.jsonl"), JSON.stringify({
  tool, args, destination: process.env.IOS_DEST,
  settings: process.env.XCODE_XCCONFIG_FILE ? readFileSync(process.env.XCODE_XCCONFIG_FILE, "utf8") : undefined,
}) + "\n");
if (tool === "installer") {
  if (mode.endsWith("install-failed")) process.exit(23);
  mkdirSync(args[0], { recursive: true });
  copyFileSync(path.join(root, "bin", "simslim"), path.join(args[0], "simslim"));
} else if (tool === "simslim") {
  if (mode.endsWith(args[0] + "-failed")) process.exit(23);
} else if (tool === "uname") {
  console.log("arm64");
} else if (tool === "xcrun") {
  if (args[1] === "list" && args[2] === "pairs") {
    console.log(JSON.stringify({ pairs: mode === "unpaired" ? {} : {
      unrelated: { watch: { udid: "other-watch" }, phone: { udid: "other-phone" } },
      selected: { watch: { udid: "watch-fixture" }, phone: { udid: "companion-fixture" } }
    } }));
  } else if (args[1] === "list") {
    console.log(JSON.stringify({ devices: { watch: [
      { name: mode.startsWith("voice") ? "iPhone fixture" : "Apple Watch fixture", isAvailable: true,
        udid: mode.includes("slim") ? "11111111-2222-3333-4444-555555555555" : "watch-fixture" }
    ] } }));
  } else if (args[1] === "bootstatus" && mode.endsWith("boot-failed")) {
    console.error("Intentional simulator boot failure");
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
} else if (args.some((arg) => arg === "test" || arg === "test-without-building") && mode === "voice-tests-failed") {
  process.exit(25);
} else if (args.includes("build-for-testing")) {
  const derivedIndex = args.indexOf("-derivedDataPath");
  if (derivedIndex >= 0) {
    mkdirSync(path.join(args[derivedIndex + 1], "Build/Products/Debug-watchsimulator/OpenClawWatchApp.app"), { recursive: true });
  }
}
`,
  );
  // Exercise the restart helper itself below; this fixture checks workflow ordering.
  for (const tool of ["xcrun", "xcodebuild", "pnpm", "uname", "installer", "simslim"]) {
    const executable = path.join(bin, tool);
    writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${runner}' '${tool}' "$@"\n`);
    chmodSync(executable, 0o755);
  }
  // The build runner also uses Python to execute its logged shell command. Only
  // intercept the restart helper; the inline build wrapper must still execute.
  const python = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
    encoding: "utf8",
  });
  expect(python.status, python.stderr).toBe(0);
  const pythonWrapper = path.join(bin, "python3");
  writeFileSync(
    pythonWrapper,
    `#!/bin/sh
if [ "$1" = "scripts/ios-access-restart-proof.py" ]; then
  exec '${process.execPath}' '${runner}' python3 "$@"
fi
exec '${python.stdout.trim()}' "$@"
`,
  );
  chmodSync(pythonWrapper, 0o755);
  if (mode.includes("slim")) {
    const scripts = path.join(root, "scripts");
    mkdirSync(scripts);
    if (!mode.endsWith("missing-installer")) {
      copyFileSync(path.join(bin, "installer"), path.join(scripts, "install-simslim.sh"));
    }
    if (!mode.endsWith("missing-prepare")) {
      copyFileSync(
        "scripts/ios-simulator-prepare.sh",
        path.join(scripts, "ios-simulator-prepare.sh"),
      );
    }
  }
  const environmentFile = path.join(root, "github-env");
  const summaryFile = path.join(root, "summary.md");
  writeFileSync(environmentFile, "");
  writeFileSync(summaryFile, "");
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
      CI: "true",
      OPENCLAW_CI_SIMSLIM_BINARY: "",
      WATCH_FIXTURE_ROOT: root,
      WATCH_FIXTURE_MODE: mode,
      GITHUB_ENV: environmentFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      IOS_SIMULATOR_SELECTION: JSON.stringify(resolveIosSimulatorTestSelection(null)),
      IOS_CI_PHASE: "smoke",
      IOS_MAIN_TIER: "false",
      HISTORICAL_TARGET: "false",
      IOS_DEST: "",
      XCODE_XCCONFIG_FILE: "",
      ...env,
    },
  });
  const trace = path.join(root, "commands.jsonl");
  const commands: Command[] = existsSync(trace)
    ? readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  return {
    result,
    commands,
    product,
    summary: readFileSync(summaryFile, "utf8"),
  };
}

describe.skipIf(process.platform === "win32")("SimSlim workflow admission", () => {
  it("prewarms and slims the build's exact iPhone before testing", () => {
    const { result, commands } = runSimulatorStep("voice-slim", [
      configureStep,
      prepareStep,
      buildStep,
      voiceStep,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const slim = commands.filter(({ tool }) => tool === "simslim");
    expect(slim.map(({ args }) => args[0])).toEqual(["on", "verify"]);
    for (const { args } of slim) {
      expect(args[1]).toBe("11111111-2222-3333-4444-555555555555");
    }
    expect(commands.indexOf(slim[1]!)).toBeLessThan(commands.findIndex(isTestCommand));
    expect(
      commands.filter(({ tool, args }) => tool === "xcrun" && args[1] === "bootstatus"),
    ).toHaveLength(3);
  });

  it.each(["missing-installer", "missing-prepare"])("keeps %s targets stock", (mode) => {
    const { result, commands } = runSimulatorStep(`voice-slim-${mode}`, [
      configureStep,
      prepareStep,
      buildStep,
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(commands.some(({ tool }) => tool === "simslim" || tool === "installer")).toBe(false);
    expect(commands.some(({ tool }) => tool === "pnpm")).toBe(true);
  });

  it.each(["install", "on", "verify", "boot"])("stops before XCTest on %s failure", (mode) => {
    const { result, commands } = runSimulatorStep(`voice-slim-${mode}-failed`, [
      configureStep,
      prepareStep,
      buildStep,
      voiceStep,
    ]);
    expect(result.status).toBe(23);
    expect(commands.some(({ tool }) => tool === "pnpm")).toBe(true);
    expect(commands.some(isTestCommand)).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("Watch simulator workflow", () => {
  it.each(["ready", "unpaired"])(
    "prepares the %s Watch destination before running its tests",
    (mode) => {
      const { result, commands, product } = runSimulatorStep(mode, [watchStep], {
        OPENCLAW_CI_SIMSLIM_BINARY: "/must-not-run-simslim",
      });
      expect(result.status, result.stderr).toBe(0);
      const xcodeCommands = commands.filter((command) => command.tool === "xcodebuild");
      for (const command of xcodeCommands) {
        expect(command.args).not.toContain("-derivedDataPath");
      }
      expect(
        commands.filter((command) => command.tool === "xcrun").map((command) => command.args),
      ).toEqual([
        ["simctl", "list", "devices", "available", "--json"],
        ["simctl", "list", "pairs", "--json"],
        ...(mode === "unpaired" ? [] : [["simctl", "bootstatus", "companion-fixture", "-b"]]),
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
    },
  );

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
    const { result, commands } = runSimulatorStep(
      "voice",
      [configureStep, prepareStep, buildStep, voiceStep],
      {
        IOS_CI_PHASE: "tests",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const appBuild = commands.find((command) => command.tool === "pnpm");
    expect(appBuild?.destination).toBe("");
    expect(commands.every((command) => command.settings === undefined)).toBe(true);
    const testRun = commands.find((command) => command.tool === "xcodebuild");
    expect(testRun?.args).toEqual(
      expect.arrayContaining(["-collect-test-diagnostics", "on-failure"]),
    );
  });

  it("fails after the overlapping build without XCTest when the selected iPhone cannot boot", () => {
    const { result, commands } = runSimulatorStep("voice-boot-failed", [
      configureStep,
      prepareStep,
      buildStep,
      voiceStep,
    ]);
    expect(result.status).toBe(23);
    expect(commands.some((command) => command.tool === "pnpm")).toBe(true);
    expect(commands.some(isTestCommand)).toBe(false);
    expect(result.stdout).toContain("Intentional simulator boot failure");
  });

  it.each([
    ["smoke", "false"],
    ["tests", "true"],
  ])(
    "executes cleanup and sibling suites with normal Debug signing: %s, main=%s",
    (phase, main) => {
      const { result, commands } = runSimulatorStep(
        "voice",
        [configureStep, prepareStep, buildStep, voiceStep, iosStep],
        { IOS_CI_PHASE: phase, IOS_MAIN_TIER: main },
      );
      expect(result.status, result.stderr).toBe(0);
      const appBuild = commands.find((command) => command.tool === "pnpm");
      expect(appBuild?.args).toEqual([phase === "smoke" ? "ios:gen" : "ios:build"]);
      expect(appBuild?.destination).toBe("platform=iOS Simulator,id=watch-fixture");
      expect(appBuild?.settings).toBe("ARCHS = arm64\nCOMPILER_INDEX_STORE_ENABLE = NO\n");
      expect(
        commands.filter((command) => command.tool === "xcrun").map((command) => command.args),
      ).toEqual([
        ["simctl", "list", "devices", "available", "--json"],
        ["simctl", "bootstatus", "watch-fixture", "-b"],
      ]);
      const builds = commands.filter((command) => command.tool === "xcodebuild");
      expect(
        builds.map((command) =>
          command.args.find((arg) =>
            ["build-for-testing", "test", "test-without-building"].includes(arg),
          ),
        ),
      ).toEqual(
        phase === "smoke"
          ? ["build-for-testing", "test-without-building", "test-without-building"]
          : ["test", "test"],
      );
      for (const command of builds) {
        expect(command.args).toEqual(expect.arrayContaining(["-configuration", "Debug"]));
        expect(command.args).toContain(appBuild?.destination);
        expect(command.settings).toBe(appBuild?.settings);
        expect(command.args.some((arg) => arg.startsWith("CODE_SIGN"))).toBe(false);
      }
      const build = builds.find(isTestCommand);
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
      expect(build.args).toEqual(expect.arrayContaining(["-collect-test-diagnostics", "never"]));
      if (phase === "smoke") {
        const sources = readdirSync("apps/ios/Tests", { recursive: true })
          .filter((file): file is string => typeof file === "string" && file.endsWith(".swift"))
          .map((file) => ({
            file: `apps/ios/Tests/${file}`,
            source: readFileSync(path.join("apps/ios/Tests", file), "utf8"),
          }));
        const testCommands = builds.filter(isTestCommand);
        for (const [index, group] of ["voice", "lifecycle"].entries()) {
          const selectors = testCommands[index]!.args.filter((arg) =>
            arg.startsWith("-only-testing:"),
          );
          for (const selector of selectors) {
            const suite = selector.split("/")[1]!;
            const declarations = sources.filter(({ source }) =>
              new RegExp(`\\b(?:struct|class|enum)\\s+${suite}\\b`, "u").test(source),
            );
            expect(declarations, `Source owner for ${selector}`).toHaveLength(1);
            const file = declarations[0]!.file;
            const selection = resolveIosSimulatorTestSelection([file]);
            expect(
              group === "voice" ? selection.voice.selected : selection.lifecycle.selected,
              `The ${group} group must run when its ${suite} source ${file} changes`,
            ).toBe(true);
          }
        }
      }
    },
  );
});

describe.skipIf(process.platform === "win32")("iOS Access simulator workflow", () => {
  const authClasses = [
    "CloudflareAccessClientTests",
    "CloudflareAccessBrowserPresenterTests",
    "CloudflareAccessTransferTests",
    "CloudflareAccessSessionStoreTests",
  ];

  it("executes the actual auth test classes during smoke and excludes compatibility targets", () => {
    expect(iosStep?.if).toContain("matrix.phase == 'smoke'");
    expect(iosStep?.if).toContain("needs.preflight.outputs.compatibility_target != 'true'");
    expect(workflow.jobs["ios-build"]?.env?.IOS_CI_PHASE).toBe("${{ matrix.phase }}");
    const { result, commands } = runSimulatorStep("voice", [
      configureStep,
      prepareStep,
      buildStep,
      iosStep,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const tests = commands.filter(isTestCommand);
    expect(tests).toHaveLength(1);
    expect(tests[0]?.args).toContain("platform=iOS Simulator,id=watch-fixture");
    expect(tests[0]?.args.filter((arg) => arg.startsWith("-only-testing:"))).toEqual([
      ...authClasses.map((name) => `-only-testing:OpenClawTests/${name}`),
      "-only-testing:OpenClawTests/ChatTypingFocusTests",
      "-only-testing:OpenClawTests/ChatSendHydrationTests",
      "-only-testing:OpenClawTests/GatewayIngressControllerTests",
      "-only-testing:OpenClawTests/GatewayIngressLoginPreparationTests",
      "-only-testing:OpenClawTests/GatewayConnectionControllerTests",
      "-only-testing:OpenClawTests/LegacyManualGatewayMigrationTests",
      "-only-testing:OpenClawTests/GatewayOperatorFleetTests",
      "-only-testing:OpenClawTests/IOSMediaArtifactLoaderTests",
      "-only-testing:OpenClawTests/OpenClawTypographyTests",
      "-only-testing:OpenClawTests/GatewayConnectionSecurityTests",
      "-only-testing:OpenClawTests/GatewaySettingsStoreTests",
    ]);
    expect(commands.at(-1)).toEqual({
      tool: "python3",
      args: ["scripts/ios-access-restart-proof.py", "watch-fixture"],
      destination: "platform=iOS Simulator,id=watch-fixture",
      settings: "ARCHS = arm64\nCOMPILER_INDEX_STORE_ENABLE = NO\n",
    });
    for (const name of authClasses) {
      expect(readFileSync(`apps/ios/Tests/${name}.swift`, "utf8")).toContain(`struct ${name}`);
    }
    expect(
      readFileSync("apps/ios/Tests/GatewayIngressLoginPreparationTests.swift", "utf8"),
    ).toContain("struct GatewayIngressLoginPreparationTests");
    expect(readFileSync("apps/ios/Tests/GatewayConnectionControllerTests.swift", "utf8")).toContain(
      "struct LegacyManualGatewayMigrationTests",
    );
  });

  it("keeps full lifecycle and UI tests alongside Access tests in full validation", () => {
    const { result, commands } = runSimulatorStep(
      "voice",
      [configureStep, prepareStep, buildStep, iosStep],
      {
        IOS_CI_PHASE: "tests",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const tests = commands.filter(isTestCommand);
    expect(tests).toHaveLength(2);
    expect(tests[0]?.args).toEqual(
      expect.arrayContaining([
        ...authClasses.map((name) => `-only-testing:OpenClawTests/${name}`),
        "-only-testing:OpenClawTests/ChatTypingFocusTests",
        "-only-testing:OpenClawTests/ChatSendHydrationTests",
        "-only-testing:OpenClawTests/GatewayIngressControllerTests",
        "-only-testing:OpenClawTests/GatewayIngressLoginPreparationTests",
        "-only-testing:OpenClawTests/GatewayConnectionControllerTests",
        "-only-testing:OpenClawTests/LegacyManualGatewayMigrationTests",
        "-only-testing:OpenClawTests/GatewayConnectionSecurityTests",
        "-only-testing:OpenClawTests/GatewaySettingsStoreTests",
        "-only-testing:OpenClawLogicTests/WatchVoiceTurnTrackerTests",
        "-only-testing:OpenClawTests/NodeAppModelInvokeTests",
        "-only-testing:OpenClawTests/OpenClawTypographyTests",
      ]),
    );
    expect(tests[1]?.args.filter((arg) => arg.startsWith("-only-testing:"))).toEqual([
      "-only-testing:OpenClawUITests/OpenClawSnapshotUITests/testWatchMessageDeliveryIsReachableFromSettings",
      "-only-testing:OpenClawUITests/BootstrapSetupFailureUITests",
    ]);
    const restart = commands.findIndex((command) => command.tool === "python3");
    expect(restart).toBeGreaterThan(commands.indexOf(tests[0]!));
    expect(restart).toBeLessThan(commands.indexOf(tests[1]!));
  });

  it.each(["smoke", "tests"])(
    "propagates auth test errors without later UI tests (%s)",
    (phase) => {
      const { result, commands } = runSimulatorStep(
        "voice-tests-failed",
        [configureStep, prepareStep, buildStep, iosStep],
        {
          IOS_CI_PHASE: phase,
        },
      );
      expect(result.status).toBe(25);
      expect(commands.filter(isTestCommand)).toHaveLength(1);
      expect(commands.some((command) => command.tool === "python3")).toBe(false);
    },
  );
});

describe("iOS simulator owner selection", () => {
  it.each([
    ["apps/ios/Sources/Voice/TalkModeManager.swift", true, true],
    ["apps/ios/Sources/Onboarding/OnboardingWizardView.swift", true, true],
    ["apps/ios/Sources/FutureFeature/NewService.swift", true, true],
    ["apps/ios/WatchApp/Sources/WatchInboxView.swift", true, false],
    ["apps/ios/ActivityWidget/OpenClawLiveActivity.swift", true, false],
    ["apps/ios/Tests/TalkModeConfigParsingTests.swift", true, false],
    ["apps/ios/Tests/Fixtures/managed-document-message.json", true, false],
    ["apps/ios/Tests/CloudflareAccessTestTokens.swift", false, true],
    ["apps/ios/Tests/CloudflareAccessBrowserPresenterTests.swift", false, true],
    ["apps/ios/Tests/GatewayIngressActivationTests.swift", false, true],
    ["apps/ios/Tests/GatewayIngressWireTests.swift", false, true],
    ["apps/ios/Tests/GatewayIngressLoginPreparationTests.swift", false, true],
    ["apps/ios/Tests/GatewayOperatorFleetTests.swift", false, true],
    ["scripts/ios-access-restart-proof.py", false, true],
    ["apps/ios/Tests/GatewayAccessRestartTests.swift", false, true],
    ["apps/ios/Tests/IOSMediaArtifactLoaderTests.swift", true, true],
    ["apps/ios/Tests/OpenClawTypographyTests.swift", true, true],
    ["apps/ios/Tests/ChatSendHydrationTests.swift", false, true],
    ["apps/ios/Tests/RootTabsNavigationTests.swift", false, false],
    ["apps/shared/OpenClawKit/Tests/OpenClawKitTests/ChatViewModelTests.swift", false, false],
    ["apps/shared/OpenClawKit/Sources/OpenClawNativeState/NativeState.swift", true, true],
    ["apps/macos/Tests/OpenClawIPCTests/GatewayWebSocketTestSupport.swift", true, true],
    ["apps/macos/Tests/OpenClawIPCTests/DashboardHTTPFixture.swift", true, true],
    ["apps/macos/Tests/OpenClawIPCTests/AsyncTestGate.swift", true, true],
    ["apps/macos/Tests/OpenClawIPCTests/TestWait.swift", true, true],
    ["apps/swabble/Sources/SwabbleKit/Speech.swift", true, true],
    ["apps/swabble/Sources/swabble/main.swift", false, false],
    ["apps/ios/fastlane/Fastfile", false, false],
  ] as const)(
    "selects the actual runtime, test, and resource owners for %s",
    (file, voice, lifecycle) => {
      const selected = resolveIosSimulatorTestSelection([file]);
      expect(selected.voice.selected).toBe(voice);
      expect(selected.lifecycle.selected).toBe(lifecycle);
      for (const group of [selected.voice, selected.lifecycle]) {
        expect(group.reasons.some((reason: string) => reason.includes(file))).toBe(group.selected);
      }
    },
  );

  it.each([
    "apps/ios/project.yml",
    "apps/ios/Config/Signing.xcconfig",
    "apps/ios/Sources/Fonts/Inter[opsz,wght].ttf",
    "apps/ios/Tests/Info.plist",
    "apps/shared/OpenClawKit/Package.swift",
    "apps/swabble/Package.resolved",
    "apps/shared/OpenClawKit/Sources/OpenClawChatUI/Resources/Mermaid/index.html",
    "scripts/lib/swift-toolchain.sh",
    "scripts/ios-simulator-prepare.sh",
    "scripts/ios-generate-test-tls-identity.sh",
    "scripts/lib/ci-ios-smoke-plan.mjs",
    ".github/workflows/ci.yml",
    "pnpm-lock.yaml",
  ])("retains both groups when shared build or bundle input changes: %s", (file) => {
    const selected = resolveIosSimulatorTestSelection([file]);
    expect(selected.voice.selected).toBe(true);
    expect(selected.lifecycle.selected).toBe(true);
  });

  it.each([
    null,
    ["../apps/ios/Tests/ChatTypingFocusTests.swift"],
    ["/unknown"],
    ["invalid\npath"],
  ])(
    "falls back to full coverage when changed paths are unavailable or invalid: %j",
    (changedPaths) => {
      const selected = resolveIosSimulatorTestSelection(changedPaths);
      expect(selected.mode).toBe("full");
      expect(selected.voice.selected).toBe(true);
      expect(selected.lifecycle.selected).toBe(true);
    },
  );

  it("never turns an unselected iOS job back on, even with the full-sequence override", () => {
    const selected = resolveIosSimulatorTestSelection(null, { enabled: false, forceFull: true });
    expect(selected.voice.selected).toBe(false);
    expect(selected.lifecycle.selected).toBe(false);
  });
});

function admittedSimulatorSteps(
  selection: ReturnType<typeof resolveIosSimulatorTestSelection>,
  phase = "smoke",
  compatibility = false,
) {
  return [configureStep, prepareStep, buildStep, voiceStep, iosStep].filter((step) => {
    if (!step) {
      throw new Error("Missing iOS simulator workflow step");
    }
    if (!step.if) {
      return true;
    }
    const expression = step.if.startsWith("${{") ? step.if : `\${{ ${step.if} }}`;
    return evaluateWorkflowExpression(expression, {
      repository: "openclaw/openclaw",
      eventName: "pull_request",
      runAttempt: 1,
      matrix: { phase },
      preflightOutputs: {
        compatibility_target: String(compatibility),
        run_ios_voice_cleanup_tests: String(selection.voice.selected),
        run_ios_lifecycle_tests: String(selection.lifecycle.selected),
      },
    });
  });
}

describe.skipIf(process.platform === "win32")("iOS selected simulator workflow", () => {
  it.each([
    { owner: "apps/ios/fastlane/Fastfile", groups: [] },
    { owner: "apps/ios/Tests/TalkModeConfigParsingTests.swift", groups: ["voice"] },
    { owner: "apps/ios/Tests/ChatSendHydrationTests.swift", groups: ["lifecycle"] },
  ])("builds the app and runs only selected groups for $owner", ({ owner, groups }) => {
    const selection = resolveIosSimulatorTestSelection([owner]);
    const steps = admittedSimulatorSteps(selection);
    expect(steps).toContain(buildStep);
    expect(steps.includes(prepareStep)).toBe(groups.length > 0);
    const { result, commands, summary } = runSimulatorStep("voice-slim", steps, {
      IOS_SIMULATOR_SELECTION: JSON.stringify(selection),
    });
    expect(result.status, result.stderr).toBe(0);
    const builds = commands.filter(
      ({ tool, args }) => tool === "xcodebuild" && args.includes("build-for-testing"),
    );
    expect(builds).toHaveLength(1);
    expect(builds[0]?.settings).toBe("ARCHS = arm64\nCOMPILER_INDEX_STORE_ENABLE = NO\n");
    expect(builds[0]?.args).toContain(
      groups.length
        ? "platform=iOS Simulator,id=11111111-2222-3333-4444-555555555555"
        : "generic/platform=iOS Simulator",
    );
    const tests = commands.filter(isTestCommand);
    expect(tests).toHaveLength(groups.length);
    for (const test of tests) {
      expect(test.args).toContain("test-without-building");
      expect(test.args).not.toContain("test");
      expect(test.args).toContain(
        groups[0] === "voice"
          ? "-only-testing:OpenClawTests/TalkRealtimeVoiceSessionCleanupTests"
          : "-only-testing:OpenClawTests/ChatTypingFocusTests",
      );
    }
    if (!groups.length) {
      expect(commands.some(({ tool }) => ["xcrun", "installer", "simslim"].includes(tool))).toBe(
        false,
      );
    }
    expect(summary).toBe(formatIosSimulatorSelectionSummary(selection));
    for (const group of ["voice", "lifecycle"]) {
      expect(summary).toContain(`| ${group} | ${groups.includes(group) ? "yes" : "no"} |`);
    }
  });

  it("retains the full tests phase and compatibility exclusions regardless of PR group flags", () => {
    const none = resolveIosSimulatorTestSelection([]);
    expect(admittedSimulatorSteps(none, "tests")).toEqual([
      configureStep,
      prepareStep,
      buildStep,
      voiceStep,
      iosStep,
    ]);
    const all = resolveIosSimulatorTestSelection(null);
    expect(admittedSimulatorSteps(all)).toEqual([
      configureStep,
      prepareStep,
      buildStep,
      voiceStep,
      iosStep,
    ]);
    for (const phase of ["smoke", "tests"]) {
      const compatible = admittedSimulatorSteps(all, phase, true);
      expect(compatible).toContain(buildStep);
      expect(compatible).not.toContain(prepareStep);
      expect(compatible).not.toContain(voiceStep);
      expect(compatible).not.toContain(iosStep);
    }
  });
});

function runRestartProof(mode = "ready", format = 1) {
  const root = tempDirs.make("openclaw-access-restart-");
  const result = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      String.raw`
import contextlib, datetime, importlib.util, io, json, os, pathlib, plistlib, subprocess, sys
helper, root, mode, format = sys.argv[1:]
format = int(format)
root = pathlib.Path(root)
os.chdir(root)
spec = importlib.util.spec_from_file_location("restart_proof", helper)
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)
products = root / "Build Products"
app = products / "Debug-iphonesimulator/OpenClaw.app"
tests = app / "PlugIns/OpenClawTests.xctest"
data = root / "app data"
data.mkdir()
for bundle, identifier in [(app, "test.openclaw.app"), (tests, "test.openclaw.tests")]:
    bundle.mkdir(parents=True, exist_ok=True)
    (bundle / "fixture").write_bytes(b"unchanged executable")
    (bundle / "Info.plist").write_bytes(plistlib.dumps({"CFBundleExecutable": "fixture", "CFBundleIdentifier": identifier}))
target = {"BlueprintName": "OpenClawTests", "TestHostPath": "__TESTROOT__/Debug-iphonesimulator/OpenClaw.app",
     "TestBundlePath": "__TESTHOST__/PlugIns/OpenClawTests.xctest", "UITargetAppPath": "unused",
     "OnlyTestIdentifiers": ["OldSelection"], "SkipTestIdentifiers": ["AnotherSelection"],
     "TestingEnvironmentVariables": {"DYLD_FRAMEWORK_PATH": "__TESTROOT__/Debug-iphonesimulator"}}
document = {"OpenClawTests": target, "OpenClawLogicTests": {"BlueprintName": "OpenClawLogicTests"}}
if format == 2:
    document = {"TestConfigurations": [{"Name": "Default", "IsEnabled": True, "TestTargets": [
        {"BlueprintName": "OpenClawLogicTests"}, target]}]}
if format != 0:
    document["__xctestrun_metadata__"] = {"FormatVersion": format}
(products / "OpenClaw_iphonesimulator.xctestrun").write_bytes(plistlib.dumps(document))
commands, runs, boot_timeouts = [], [], []
booted = True
receipt = None
source = "a" * 40
def run(args, capture=False, env=None, timeout=None):
    global booted, receipt
    commands.append(args)
    if args[0] == "git":
        return source
    if "-showBuildSettings" in args:
        return json.dumps([{"target": "OpenClaw", "buildSettings": {
            "BUILD_DIR": str(products), "TARGET_BUILD_DIR": str(app.parent), "FULL_PRODUCT_NAME": app.name}}])
    if "test-without-building" in args:
        booted = mode == "already-booted"
        config = plistlib.loads(pathlib.Path(args[args.index("-xctestrun") + 1]).read_bytes())
        runs.append({"config": config, "environment": {key: value for key, value in env.items()
            if key.startswith("TEST_RUNNER_OPENCLAW_ACCESS_RESTART_")}})
        nonce = env["TEST_RUNNER_OPENCLAW_ACCESS_RESTART_NONCE"]
        receipt = data / "Library/Application Support" / ("access-restart-" + nonce + ".plist")
        if mode != "missing-handoff":
            receipt.parent.mkdir(parents=True)
            handoff = {"phase": "verified", "nonce": nonce, "source": source, "simulator": "simulator-fixture",
                "installation": proof.installation_identity(app, tests, data), "seedPID": 2147483647,
                "verifyPID": 2147483646, "seedProcessExited": True,
                "expiresAt": datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) + datetime.timedelta(hours=1)}
            if mode == "seed-only": handoff["phase"] = "seeded"
            if mode == "same-pid": handoff["verifyPID"] = handoff["seedPID"]
            if mode == "unconfirmed-exit": handoff["seedProcessExited"] = False
            if mode == "wrong-source": handoff["source"] = "b" * 40
            if mode == "wrong-nonce": handoff["nonce"] = "foreign"
            if mode == "wrong-receipt-device": handoff["simulator"] = "another-device"
            if mode == "expired-control": handoff["expiresAt"] = datetime.datetime(2000, 1, 1)
            if mode == "changed-container": handoff["installation"]["container"]["inode"] += 1
            receipt.write_bytes(plistlib.dumps(handoff))
        if mode == "changed-binary": (app / "fixture").write_bytes(b"replacement executable")
        if mode == "changed-test-binary": (tests / "fixture").write_bytes(b"replacement test executable")
        if mode == "reinstalled-same-bytes":
            executable = tests / "fixture"
            replacement = tests / "replacement"
            replacement.write_bytes(executable.read_bytes())
            replacement.replace(executable)
        if mode == "xcodebuild-failed": raise subprocess.CalledProcessError(65, args)
    if "xcresulttool" in args:
        device = {"deviceId": "simulator-fixture", "deviceName": "iPhone"}
        configuration = {"configurationId": "1", "configurationName": "Default"}
        if "summary" in args:
            count = 0 if mode == "zero-tests" else (2 if mode == "execution-count" else 1)
            device_run = {"device": {**device}, "testPlanConfiguration": {**configuration},
                "passedTests": 2, "failedTests": 0, "skippedTests": 0, "expectedFailures": 0}
            if mode == "wrong-summary-device": device_run["device"]["deviceId"] = "foreign"
            if mode == "wrong-summary-configuration": device_run["testPlanConfiguration"]["configurationId"] = "foreign"
            return json.dumps({"result": "Passed", "totalTestCount": count, "passedTests": count,
                "failedTests": 0, "skippedTests": 1 if mode == "skipped" else 0,
                "expectedFailures": 0, "testFailures": [],
                "devicesAndConfigurations": [device_run] * (2 if mode == "extra-summary-device" else 1)})
        identifier = "GatewayAccessRestartTests/testAcknowledgedSignOutSurvivesProcessRestart()"
        repetitions = [{"nodeType": "Repetition", "nodeIdentifier": str(index),
            "name": f"Repetition {index}", "result": "Passed"} for index in (1, 2)]
        if mode == "one-repetition": repetitions.pop()
        if mode == "extra-repetition": repetitions.append({**repetitions[0], "nodeIdentifier": "3", "name": "Repetition 3"})
        if mode == "duplicate-repetition": repetitions[1] = repetitions[0]
        if mode == "missing-repetition-id": repetitions[1].pop("nodeIdentifier")
        if mode == "failed-repetition": repetitions[1]["result"] = "Failed"
        if mode == "skipped-repetition": repetitions[1]["result"] = "Skipped"
        if mode == "unknown-result-shape": repetitions = []
        if mode in ("explicit-case-runs", "extra-case-run"):
            for repetition in repetitions:
                repetition["children"] = [{"nodeType": "Test Case Run", "name": "Execution", "result": "Passed"}]
        if mode == "extra-case-run": repetitions[1]["children"].append(repetitions[1]["children"][0])
        if mode == "unscoped-execution": repetitions.append({"nodeType": "Test Case Run", "name": "Extra", "result": "Passed"})
        if mode == "wrapped-repetition": repetitions = [{"nodeType": "Device", "nodeIdentifier": device["deviceId"],
            "children": [{"nodeType": "Test Plan Configuration", "nodeIdentifier": "1", "children": repetitions}]}]
        if mode == "nested-repetition": repetitions[0]["children"] = [{**repetitions[1]}]
        if "test-details" in args:
            assert args[-2:] == ["--test-id", identifier]
            if mode == "wrong-device": device["deviceId"] = "another-device"
            if mode == "wrong-configuration": configuration["configurationId"] = "foreign"
            return json.dumps({"testIdentifier": "WrongCase" if mode == "wrong-details-case" else identifier,
                "testResult": "Passed", "arguments": ["unexpected"] if mode == "parameterized-case" else [],
                "devices": [device], "testPlanConfigurations": [configuration] * (2 if mode == "extra-configuration" else 1),
                "testRuns": repetitions})
        identifier = "WrongCase" if mode == "wrong-case" else identifier
        if mode == "tree-repetition-mismatch": repetitions[1]["nodeIdentifier"] = "foreign"
        case = {"nodeType": "Test Case", "nodeIdentifier": identifier, "result": "Passed", "children": repetitions}
        bundle = {"nodeType": "Unit test bundle", "name": "WrongBundle" if mode == "wrong-bundle" else "OpenClawTests",
            "children": [{"nodeType": "Test Suite", "name": "GatewayAccessRestartTests",
                "children": [case] * (2 if mode == "extra-case" else 1)}]}
        if mode == "wrong-tree-device": device["deviceId"] = "foreign"
        if mode == "wrong-tree-configuration": configuration["configurationId"] = "foreign"
        return json.dumps({"testNodes": [{"nodeType": "Test Plan", "name": "OpenClaw", "children": [bundle]}],
            "devices": [device], "testPlanConfigurations": [configuration]})
    if "bootstatus" in args:
        assert args == ["xcrun", "simctl", "bootstatus", "simulator-fixture", "-b"]
        boot_timeouts.append(timeout)
        if mode == "boot-failed": raise RuntimeError("simulator boot failed")
        booted = True
    if "get_app_container" in args:
        if not booted:
            raise RuntimeError("Unable to lookup in current state: Shutdown")
        return str(app if args[-1] == "app" else data)
    return ""
proof.run = run
proof.process_exists = lambda pid: mode == "live-seed"
error = None
with contextlib.redirect_stdout(io.StringIO()):
    try:
        proof.main("simulator-fixture")
    except Exception as failure:
        error = str(failure)
print(json.dumps({"error": error, "commands": commands, "runs": runs, "bootTimeouts": boot_timeouts,
    "receiptRetained": receipt is not None and receipt.exists()}))
`,
      path.resolve("scripts/ios-access-restart-proof.py"),
      root,
      mode,
      String(format),
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    error: string | null;
    commands: string[][];
    bootTimeouts: number[];
    receiptRetained: boolean;
    runs: {
      environment: Record<string, string>;
      config: {
        OpenClawTests?: Record<string, unknown>;
        OpenClawLogicTests?: Record<string, unknown>;
        TestConfigurations?: { TestTargets: Record<string, unknown>[] }[];
        __xctestrun_metadata__?: { FormatVersion: number };
      };
    }[];
  };
}

describe("iOS Access process restart proof", () => {
  it.each([0, 1, 2])("preserves format %s for two fixed process repetitions", (format) => {
    const { error, commands, runs, bootTimeouts, receiptRetained } = runRestartProof(
      "ready",
      format,
    );
    expect(error).toBeNull();
    expect(runs).toHaveLength(1);
    expect(bootTimeouts).toEqual([120]);
    expect(receiptRetained).toBe(false);
    const { config, environment } = runs[0]!;
    expect(config["__xctestrun_metadata__"]?.FormatVersion).toBe(format || undefined);
    expect(config).not.toHaveProperty("OpenClawLogicTests");
    const targets =
      format === 2 ? config.TestConfigurations![0]!.TestTargets : [config.OpenClawTests!];
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      BlueprintName: "OpenClawTests",
      TestHostPath: "__TESTROOT__/Debug-iphonesimulator/OpenClaw.app",
      TestBundlePath: "__TESTHOST__/PlugIns/OpenClawTests.xctest",
      UITargetAppPath: "unused",
      TestingEnvironmentVariables: { DYLD_FRAMEWORK_PATH: "__TESTROOT__/Debug-iphonesimulator" },
    });
    for (const key of ["OnlyTestIdentifiers", "SkipTestIdentifiers", "UseDestinationArtifacts"]) {
      expect(targets[0]).not.toHaveProperty(key);
    }
    expect(environment.TEST_RUNNER_OPENCLAW_ACCESS_RESTART_DEVICE).toBe("simulator-fixture");
    expect(environment).not.toHaveProperty("TEST_RUNNER_OPENCLAW_ACCESS_RESTART_PHASE");
    const invocations = commands.filter((args) => args.includes("test-without-building"));
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toEqual(
      expect.arrayContaining([
        "-test-iterations",
        "2",
        "-test-repetition-relaunch-enabled",
        "YES",
        "-parallel-testing-enabled",
        "NO",
        "platform=iOS Simulator,id=simulator-fixture",
        "-only-testing:OpenClawTests/GatewayAccessRestartTests/testAcknowledgedSignOutSurvivesProcessRestart",
      ]),
    );
    expect(commands.filter((args) => args.includes("build-for-testing"))).toHaveLength(1);
    for (const operation of [
      "install",
      "uninstall",
      "erase",
      "terminate",
      "-retry-tests-on-failure",
      "-run-tests-until-failure",
    ]) {
      expect(commands.some((args) => args.includes(operation))).toBe(false);
    }
  });

  it.each(["already-booted", "execution-count"])(
    "accepts %s with two explicit passing repetitions and a verified handoff",
    (mode) => {
      const { error, bootTimeouts, receiptRetained } = runRestartProof(mode);
      expect(error).toBeNull();
      expect(bootTimeouts).toEqual([120]);
      expect(receiptRetained).toBe(false);
    },
  );

  it("rejects xcodebuild failure even when the result records and final receipt would pass", () => {
    const { error, commands, receiptRetained } = runRestartProof("xcodebuild-failed");
    expect(error).toContain("exit status 65");
    expect(commands.some((args) => args.includes("xcresulttool"))).toBe(false);
    expect(commands.some((args) => args.includes("get_app_container"))).toBe(false);
    expect(receiptRetained).toBe(true);
  });

  it("stops before container inspection if readiness fails", () => {
    const { error, commands, receiptRetained } = runRestartProof("boot-failed");
    expect(error).toBe("simulator boot failed");
    expect(commands.at(-1)).toEqual(["xcrun", "simctl", "bootstatus", "simulator-fixture", "-b"]);
    expect(receiptRetained).toBe(true);
  });

  it("rejects an unknown generated format before a test process starts", () => {
    const { error, runs } = runRestartProof("ready", 3);
    expect(error).toBe("Unsupported generated test run format");
    expect(runs).toEqual([]);
  });

  it.each([
    "zero-tests",
    "skipped",
    "wrong-case",
    "extra-case",
    "wrong-device",
    "extra-configuration",
    "wrong-details-case",
    "parameterized-case",
    "wrong-bundle",
    "wrong-summary-device",
    "wrong-summary-configuration",
    "extra-summary-device",
    "wrong-tree-device",
    "wrong-tree-configuration",
    "wrong-configuration",
    "one-repetition",
    "extra-repetition",
    "duplicate-repetition",
    "failed-repetition",
    "skipped-repetition",
    "unknown-result-shape",
    "extra-case-run",
    "unscoped-execution",
    "explicit-case-runs",
    "nested-repetition",
    "missing-repetition-id",
    "tree-repetition-mismatch",
    "wrapped-repetition",
    "missing-handoff",
    "seed-only",
    "same-pid",
    "live-seed",
    "unconfirmed-exit",
    "wrong-source",
    "wrong-nonce",
    "wrong-receipt-device",
    "expired-control",
    "changed-container",
    "changed-binary",
    "changed-test-binary",
    "reinstalled-same-bytes",
  ])("rejects %s without claiming restart proof", (mode) => {
    const { error, runs, receiptRetained } = runRestartProof(mode);
    expect(error).toBeTruthy();
    expect(runs).toHaveLength(1);
    expect(receiptRetained).toBe(mode !== "missing-handoff");
  });
});

it.each([
  { event: "pull_request", kill: "", full: false, releaseGate: false, historical: false },
  { event: "pull_request", kill: "true", full: true, releaseGate: false, historical: false },
  { event: "pull_request", kill: "1", full: true, releaseGate: false, historical: false },
  { event: "schedule", kill: "", full: true, releaseGate: false, historical: false },
  { event: "workflow_dispatch", kill: "", full: true, releaseGate: false, historical: false },
  { event: "workflow_dispatch", kill: "", full: true, releaseGate: false, historical: true },
  { event: "workflow_dispatch", kill: "", full: true, releaseGate: true, historical: false },
] as const)(
  "publishes iOS manifest decisions for $event, override=$kill, release=$releaseGate, historical=$historical",
  ({ event, kill, full, releaseGate, historical }) => {
    const result = runCiManifestFixture({
      bundledPlanner: true,
      historicalCompatibility: historical,
      eventName: event,
      releaseGate,
      changedPaths: ["apps/ios/Tests/ChatSendHydrationTests.swift"],
      scopeEnv: {
        OPENCLAW_CI_RUN_IOS_BUILD: "true",
        OPENCLAW_CI_IOS_SIMULATOR_FULL: kill,
        OPENCLAW_CI_VALIDATION_TIER: event === "schedule" ? "main" : "full",
      },
    });
    expect(result.status, result.output).toBe(0);
    expect(result.outputs.run_ios_build).toBe("true");
    expect(result.outputs.run_ios_voice_cleanup_tests).toBe(String(full));
    expect(result.outputs.run_ios_lifecycle_tests).toBe("true");
    const selection: ReturnType<typeof resolveIosSimulatorTestSelection> = JSON.parse(
      result.outputs.ios_simulator_selection!,
    );
    expect(selection.voice.selected).toBe(full);
    expect(selection.lifecycle.selected).toBe(true);
    expect(result.summary).toContain("iOS simulator test selection");
    expect(result.summary).toContain(`| voice | ${full ? "yes" : "no"} |`);
    expect(result.summary).toContain("| lifecycle | yes |");
    const phases = evaluateWorkflowExpression(workflow.jobs["ios-build"]?.strategy?.matrix?.phase, {
      repository: "openclaw/openclaw",
      eventName: event,
      runAttempt: 1,
      releaseGate,
      preflightOutputs: result.outputs,
    });
    expect(phases).toEqual(
      event === "schedule" || historical
        ? ["tests"]
        : event === "workflow_dispatch" && !releaseGate
          ? ["release", "tests"]
          : ["smoke"],
    );
  },
);
