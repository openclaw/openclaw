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

type Command = { tool: string; args: string[]; destination?: string; settings?: string };

type Step = { name?: string; run?: string; if?: string };
const workflow: { jobs: Record<string, { env?: Record<string, string>; steps?: Step[] }> } = parse(
  readFileSync(".github/workflows/ci.yml", "utf8"),
);
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
} else if (args.includes("test") && mode === "voice-tests-failed") {
  process.exit(25);
} else if (args.includes("build-for-testing")) {
  const derivedIndex = args.indexOf("-derivedDataPath");
  if (derivedIndex >= 0) {
    mkdirSync(path.join(args[derivedIndex + 1], "Build/Products/Debug-watchsimulator/OpenClawWatchApp.app"), { recursive: true });
  }
}
`,
  );
  for (const tool of ["xcrun", "xcodebuild", "pnpm", "python3", "uname", "installer", "simslim"]) {
    const executable = path.join(bin, tool);
    writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${runner}' '${tool}' "$@"\n`);
    chmodSync(executable, 0o755);
  }
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
      CI: "true",
      GITHUB_OUTPUT: path.join(root, "github-output"),
      OPENCLAW_CI_SIMSLIM_BINARY: "",
      WATCH_FIXTURE_ROOT: root,
      WATCH_FIXTURE_MODE: mode,
      GITHUB_ENV: environmentFile,
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
  const output = path.join(root, "github-output");
  return {
    result,
    commands,
    product,
    output: existsSync(output) ? readFileSync(output, "utf8") : "",
  };
}

describe.skipIf(process.platform === "win32")("SimSlim workflow admission", () => {
  it("prewarms and slims the exact iPhone before building and testing", () => {
    const { result, commands } = runSimulatorStep("voice-slim", [
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
    expect(commands.indexOf(slim[1]!)).toBeLessThan(
      commands.findIndex(({ tool }) => tool === "pnpm"),
    );
    expect(
      commands.filter(({ tool, args }) => tool === "xcrun" && args[1] === "bootstatus"),
    ).toHaveLength(2);
  });

  it.each(["missing-installer", "missing-prepare"])("keeps %s targets stock", (mode) => {
    const { result, commands } = runSimulatorStep(`voice-slim-${mode}`, [prepareStep, buildStep]);
    expect(result.status, result.stderr).toBe(0);
    expect(commands.some(({ tool }) => tool === "simslim" || tool === "installer")).toBe(false);
    expect(commands.some(({ tool }) => tool === "pnpm")).toBe(true);
  });

  it.each(["install", "on", "verify", "boot"])("stops before builds on %s failure", (mode) => {
    const { result, commands } = runSimulatorStep(`voice-slim-${mode}-failed`, [
      prepareStep,
      buildStep,
      voiceStep,
    ]);
    expect(result.status).toBe(23);
    expect(commands.some(({ tool }) => tool === "pnpm" || tool === "xcodebuild")).toBe(false);
  });

  it("publishes the screenshot binary only after installation succeeds", () => {
    const install = workflow.jobs["ios-screenshot-shard"]?.steps?.find(
      ({ name }) => name === "Install iOS simulator tooling",
    );
    const ready = runSimulatorStep("voice-slim", [install]);
    expect(ready.result.status, ready.result.stderr).toBe(0);
    expect(ready.output).toMatch(/^binary=.+\/openclaw-simslim\/simslim\n$/);
    const failed = runSimulatorStep("voice-slim-install-failed", [install]);
    expect(failed.result.status).toBe(23);
    expect(failed.output).toBe("");
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

  it.each([
    ["smoke", "false"],
    ["tests", "true"],
  ])(
    "executes cleanup and sibling suites with normal Debug signing: %s, main=%s",
    (phase, main) => {
      const { result, commands } = runSimulatorStep("voice", [prepareStep, buildStep, voiceStep], {
        IOS_CI_PHASE: phase,
        IOS_MAIN_TIER: main,
      });
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
    },
  );
});

describe.skipIf(process.platform === "win32")("iOS Access simulator workflow", () => {
  const authClasses = [
    "CloudflareAccessClientTests",
    "CloudflareAccessTransferTests",
    "CloudflareAccessSessionStoreTests",
  ];

  it("executes the actual auth test classes during smoke and excludes compatibility targets", () => {
    expect(iosStep?.if).toContain("matrix.phase == 'smoke'");
    expect(iosStep?.if).toContain("needs.preflight.outputs.compatibility_target != 'true'");
    expect(workflow.jobs["ios-build"]?.env?.IOS_CI_PHASE).toBe("${{ matrix.phase }}");
    const { result, commands } = runSimulatorStep("voice", [prepareStep, iosStep]);
    expect(result.status, result.stderr).toBe(0);
    const tests = commands.filter((command) => command.tool === "xcodebuild");
    expect(tests).toHaveLength(1);
    expect(tests[0]?.args).toContain("platform=iOS Simulator,id=watch-fixture");
    expect(tests[0]?.args.filter((arg) => arg.startsWith("-only-testing:"))).toEqual(
      expect.arrayContaining([
        ...authClasses.map((name) => `-only-testing:OpenClawTests/${name}`),
        "-only-testing:OpenClawTests/GatewayIngressControllerTests",
        "-only-testing:OpenClawTests/GatewayAccessDeviceAuthBindingTests",
        "-only-testing:OpenClawTests/GatewayConnectionControllerTests",
        "-only-testing:OpenClawTests/GatewayConnectionSecurityTests",
        "-only-testing:OpenClawTests/GatewaySettingsStoreTests",
        "-only-testing:OpenClawTests/GatewayOperatorFleetTests",
      ]),
    );
    expect(
      commands.filter((command) => command.tool === "python3").map((command) => command.args),
    ).toEqual([["scripts/ios-access-restart-proof.py", "watch-fixture"]]);
    for (const name of authClasses) {
      expect(readFileSync(`apps/ios/Tests/${name}.swift`, "utf8")).toContain(`struct ${name}`);
    }
  });

  it("keeps full lifecycle and UI tests alongside Access tests in full validation", () => {
    const { result, commands } = runSimulatorStep("voice", [prepareStep, iosStep], {
      IOS_CI_PHASE: "tests",
    });
    expect(result.status, result.stderr).toBe(0);
    const tests = commands.filter((command) => command.tool === "xcodebuild");
    expect(tests).toHaveLength(2);
    expect(tests[0]?.args).toEqual(
      expect.arrayContaining([
        ...authClasses.map((name) => `-only-testing:OpenClawTests/${name}`),
        "-only-testing:OpenClawTests/GatewayAccessDeviceAuthBindingTests",
        "-only-testing:OpenClawLogicTests/WatchVoiceTurnTrackerTests",
        "-only-testing:OpenClawTests/NodeAppModelInvokeTests",
        "-only-testing:OpenClawTests/OpenClawTypographyTests",
      ]),
    );
    expect(tests[1]?.args).toContain(
      "-only-testing:OpenClawUITests/OpenClawSnapshotUITests/testWatchMessageDeliveryIsReachableFromSettings",
    );
  });

  it("fails on auth test errors before attempting later UI tests", () => {
    const { result, commands } = runSimulatorStep("voice-tests-failed", [prepareStep, iosStep], {
      IOS_CI_PHASE: "tests",
    });
    expect(result.status).toBe(25);
    expect(commands.filter((command) => command.tool === "xcodebuild")).toHaveLength(1);
  });
});
