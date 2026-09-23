import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

type Command = { tool: string; args: string[]; destination?: string; settings?: string };

const workflow: { jobs: Record<string, { steps: { name?: string; run?: string }[] }> } = parse(
  readFileSync(".github/workflows/ci.yml", "utf8"),
);
const watchStep = workflow.jobs["ios-build"]?.steps.find(
  (step) => step.name === "Run focused Apple Watch operation simulator tests",
);
const voiceStep = workflow.jobs["ios-build"]?.steps.find(
  (step) => step.name === "Run focused iOS voice cleanup simulator tests",
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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
const [tool, ...args] = process.argv.slice(2);
const root = process.env.WATCH_FIXTURE_ROOT;
const mode = process.env.WATCH_FIXTURE_MODE;
appendFileSync(path.join(root, "commands.jsonl"), JSON.stringify({
  tool, args, destination: process.env.IOS_DEST,
  settings: process.env.XCODE_XCCONFIG_FILE ? readFileSync(process.env.XCODE_XCCONFIG_FILE, "utf8") : undefined,
}) + "\n");
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
  for (const tool of ["xcrun", "xcodebuild", "pnpm", "uname"]) {
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
