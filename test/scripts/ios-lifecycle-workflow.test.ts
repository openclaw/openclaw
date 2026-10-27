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
import {
  formatIosSimulatorSelectionSummary,
  resolveIosSimulatorTestSelection,
} from "../../scripts/lib/ci-ios-smoke-plan.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { evaluateWorkflowExpression } from "./ci-workflow.test-support.js";

type Command = { tool: string; args: string[]; destination?: string; settings?: string };

function isTestCommand(command: Command) {
  return (
    command.tool === "xcodebuild" &&
    command.args.some((arg) => arg === "test" || arg === "test-without-building")
  );
}
const argsFor = (commands: Command[], tool: string) =>
  commands.filter((command) => command.tool === tool).map((command) => command.args);
const selectedTests = (args: string[]) => args.filter((arg) => arg.startsWith("-only-testing:"));
const xcodeActions = (commands: Command[], actions: string[]) =>
  argsFor(commands, "xcodebuild").map((args) => args.find((arg) => actions.includes(arg)));
const selectors = (target: string, names: string[]) =>
  names.map((name) => `-only-testing:${target}/${name}`);
const resultBundle = (name: string) => `apps/ios/build/LifecycleTestResults/${name}.xcresult`;
const buildSettings = "ARCHS = arm64\nCOMPILER_INDEX_STORE_ENABLE = NO\n";
function expectArgs(args: string[] | undefined, required: string[]) {
  expect(args).toEqual(expect.arrayContaining(required));
}

type Step = {
  id?: string;
  name?: string;
  run?: string;
  if?: string;
};
const workflow: { jobs: Record<string, { steps?: Step[] }> } = parse(
  readFileSync(".github/workflows/ci.yml", "utf8"),
);
const findStep = (name: string) =>
  workflow.jobs["ios-build"]?.steps?.find((step) => step.name === name);
const watchStep = findStep("Run focused Apple Watch operation simulator tests");
const voiceStep = findStep("Run focused iOS voice cleanup simulator tests");
const iosStep = findStep("Run focused iOS lifecycle simulator tests");
const prepareStep = findStep("Prepare iOS simulator");
const buildStep = findStep("Build iOS app");
const configureStep = findStep("Configure iOS build and report simulator selection");
const configuredSteps = [configureStep, prepareStep, buildStep];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runSimulatorStep(mode = "ready", steps = [watchStep], env: Record<string, string> = {}) {
  const root = tempDirs.make("openclaw-watch-workflow-");
  const bin = path.join(root, "bin");
  const harnessLib = path.join(root, ".ci-harness", "scripts", "lib");
  const product = path.join(root, "project derived data", "Watch Product.app");
  mkdirSync(bin, { recursive: true });
  mkdirSync(harnessLib, { recursive: true });
  for (const file of [
    "lib/swift-toolchain.sh",
    "lib/ci-ios-smoke-plan.mjs",
    "ci-xcodebuild.py",
    "swift-build-cache-metadata.py",
    "ci-collect-checks.sh",
  ]) {
    copyFileSync(path.join("scripts", file), path.join(harnessLib, "..", file));
  }
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
  mkdirSync(args[0], { recursive: true });
  copyFileSync(path.join(root, "bin", "simslim"), path.join(args[0], "simslim"));
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
}
`,
  );
  // Exercise the restart helper itself below; this fixture checks workflow ordering.
  for (const tool of ["xcrun", "xcodebuild", "pnpm", "uname", "sysctl", "installer", "simslim"]) {
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
    copyFileSync(path.join(bin, "installer"), path.join(scripts, "install-simslim.sh"));
    copyFileSync(
      "scripts/ios-simulator-prepare.sh",
      path.join(scripts, "ios-simulator-prepare.sh"),
    );
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
      IOS_FROZEN_TARGET: "false",
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

describe.skipIf(process.platform === "win32")("Watch simulator workflow", () => {
  it.each(["ready", "unpaired"])("prepares the %s destination before XCTest", (mode) => {
    const { result, commands, product } = runSimulatorStep(mode, [watchStep], {
      OPENCLAW_CI_SIMSLIM_BINARY: "/must-not-run-simslim",
    });
    expect(result.status, result.stderr).toBe(0);
    const xcodeCommands = commands.filter((command) => command.tool === "xcodebuild");
    for (const command of xcodeCommands) {
      expect(command.args).not.toContain("-derivedDataPath");
    }
    expect(argsFor(commands, "xcrun")).toEqual([
      ["simctl", "list", "devices", "available", "--json"],
      ["simctl", "list", "pairs", "--json"],
      ...(mode === "unpaired" ? [] : [["simctl", "bootstatus", "companion-fixture", "-b"]]),
      ["simctl", "boot", "watch-fixture"],
      ["simctl", "bootstatus", "watch-fixture", "-b"],
      ["simctl", "install", "watch-fixture", product],
    ]);
    const actions = ["build-for-testing", "-showBuildSettings", "test-without-building"];
    expect(xcodeActions(commands, actions)).toEqual(actions);
    for (const command of xcodeCommands.filter(
      (entry) =>
        entry.args.includes("build-for-testing") || entry.args.includes("test-without-building"),
    )) {
      const selected = selectedTests(command.args);
      expect(selected.length).toBeGreaterThan(0);
      expect(
        selected.every((selector) => selector.startsWith("-only-testing:OpenClawWatchTests/")),
      ).toBe(true);
      expectArgs(command.args, [
        "OpenClawWatchApp",
        "Debug",
        "platform=watchOS Simulator,id=watch-fixture",
        "-parallel-testing-enabled",
        "NO",
        "CODE_SIGNING_ALLOWED=NO",
      ]);
    }
    expect(
      xcodeCommands.find((command) => command.args.includes("test-without-building"))?.args,
    ).toContain(resultBundle("OpenClawWatchOperationTests"));
  });

  it.each(["missing-product", "ambiguous-product", "relative-product", "boot-failed"])(
    "rejects %s before install or XCTest",
    (mode) => {
      const { result, commands } = runSimulatorStep(mode);
      if (mode === "boot-failed") {
        expect(result.status).toBe(23);
      } else {
        expect(result.status).not.toBe(0);
      }
      expect(commands.some((command) => command.args.includes("install"))).toBe(false);
      expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(
        false,
      );
    },
  );
});

describe.skipIf(process.platform === "win32")("iOS Access simulator workflow", () => {
  it.each(["smoke", "tests"])("executes auth and admitted lifecycle/UI suites in %s", (phase) => {
    const { result, commands } = runSimulatorStep("voice", [...configuredSteps, iosStep], {
      IOS_CI_PHASE: phase,
    });
    expect(result.status, result.stderr).toBe(0);
    const tests = commands.filter(isTestCommand);
    expect(tests).toHaveLength(phase === "smoke" ? 1 : 2);
    expect(tests[0]?.args).toContain("platform=iOS Simulator,id=watch-fixture");
    expectArgs(tests[0]?.args, [
      "-collect-test-diagnostics",
      "never",
      "-resultBundlePath",
      resultBundle("OpenClawLifecycleTests"),
      "-only-testing:OpenClawTests/ChatComposerTextViewIOSTests",
    ]);
    const authSelectors = selectors("OpenClawTests", [
      "CloudflareAccessClientTests",
      "CloudflareAccessBrowserPresenterTests",
      "CloudflareAccessTransferTests",
      "CloudflareAccessSessionStoreTests",
      "GatewayConnectionSecurityTests",
    ]);
    expect(tests[0]?.args).toEqual(expect.arrayContaining(authSelectors));
    expect(commands.filter((command) => command.tool === "python3")).toHaveLength(1);
    if (phase === "smoke") {
      expect(commands.at(-1)).toEqual({
        tool: "python3",
        args: ["scripts/ios-access-restart-proof.py", "watch-fixture"],
        destination: "platform=iOS Simulator,id=watch-fixture",
        settings: buildSettings,
      });
      return;
    }
    expectArgs(tests[0]?.args, [
      ...authSelectors,
      "-only-testing:OpenClawLogicTests/WatchVoiceTurnTrackerTests",
      "-only-testing:OpenClawTests/NodeAppModelInvokeTests",
    ]);
    expect(selectedTests(tests[1]!.args)).toEqual([
      "-only-testing:OpenClawUITests/OpenClawSnapshotUITests/testWatchMessageDeliveryIsReachableFromSettings",
      "-only-testing:OpenClawUITests/BootstrapSetupFailureUITests",
    ]);
    const restart = commands.findIndex((command) => command.tool === "python3");
    expect(restart).toBeGreaterThan(commands.indexOf(tests[0]!));
    expect(restart).toBeLessThan(commands.indexOf(tests[1]!));
  });

  it.each(["smoke", "tests"])("retains auth errors after restart/UI checks (%s)", (phase) => {
    const { result, commands } = runSimulatorStep(
      "voice-tests-failed",
      [...configuredSteps, iosStep],
      {
        IOS_CI_PHASE: phase,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("[apple-command] Exit 25");
    expect(commands.filter(isTestCommand)).toHaveLength(phase === "smoke" ? 1 : 2);
    expect(commands.filter((command) => command.tool === "python3")).toHaveLength(1);
  });
});

describe("iOS simulator owner selection", () => {
  it.each(["apps/swabble/Sources/SwabbleKit/Speech.swift", "scripts/lib/swift-toolchain.sh"])(
    "selects both groups for shared owner %s",
    (file) => {
      const selected = resolveIosSimulatorTestSelection([file]);
      expect(selected).toMatchObject({ voice: { selected: true }, lifecycle: { selected: true } });
      for (const group of [selected.voice, selected.lifecycle]) {
        expect(group.reasons.some((reason: string) => reason.includes(file))).toBe(group.selected);
      }
    },
  );

  it("does not force full coverage for an unadmitted job", () => {
    expect(
      resolveIosSimulatorTestSelection(null, { enabled: false, forceFull: true }),
    ).toMatchObject({
      mode: "not-selected",
      voice: { selected: false },
      lifecycle: { selected: false },
    });
  });
});

function admittedSimulatorSteps(selection: ReturnType<typeof resolveIosSimulatorTestSelection>) {
  const outcomes: Record<
    string,
    { outputs: Record<string, string>; outcome: "success" | "skipped" }
  > = Object.fromEntries(
    ["select-xcode", "node-env", "ios-swift-tools", "watch-rust-toolchain"].map((id) => [
      id,
      { outputs: {}, outcome: "success" },
    ]),
  );
  return [...configuredSteps, voiceStep, iosStep].filter((step) => {
    if (!step) {
      throw new Error("Missing iOS simulator workflow step");
    }
    if (!step.if) {
      return true;
    }
    const expression = step.if.startsWith("${{") ? step.if : `\${{ ${step.if} }}`;
    const selected = evaluateWorkflowExpression(expression, {
      repository: "openclaw/openclaw",
      eventName: "pull_request",
      runAttempt: 1,
      matrix: { phase: "smoke" },
      steps: outcomes,
      preflightOutputs: {
        compatibility_target: "false",
        run_ios_voice_cleanup_tests: String(selection.voice.selected),
        run_ios_lifecycle_tests: String(selection.lifecycle.selected),
      },
    });
    if (step.id) {
      outcomes[step.id] = { outputs: {}, outcome: selected ? "success" : "skipped" };
    }
    return selected;
  });
}

it.skipIf(process.platform === "win32").each([
  { owner: "apps/ios/fastlane/Fastfile", groups: [] },
  { owner: "apps/ios/Tests/TalkModeConfigParsingTests.swift", groups: ["voice"] },
  { owner: "apps/ios/Tests/ChatSendHydrationTests.swift", groups: ["lifecycle"] },
  {
    owner: "apps/shared/OpenClawKit/Tests/OpenClawKitTests/ChatComposerTextViewIOSTests.swift",
    groups: ["lifecycle"],
  },
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
  expect(builds[0]?.settings).toBe(buildSettings);
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
    if (owner.endsWith("/ChatComposerTextViewIOSTests.swift")) {
      expect(test.args).toContain("-only-testing:OpenClawTests/ChatComposerTextViewIOSTests");
    }
  }
  if (!groups.length) {
    expect(commands.some(({ tool }) => ["installer", "simslim"].includes(tool))).toBe(false);
    expect(argsFor(commands, "xcrun")).toEqual([["simctl", "list", "devices", "booted"]]);
  }
  expect(summary).toBe(formatIosSimulatorSelectionSummary(selection));
});

function runRestartProof(mode = "ready", format = 1, prepared = false) {
  const root = tempDirs.make("openclaw-access-restart-");
  const result = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      String.raw`
import contextlib, datetime, importlib.util, io, json, os, pathlib, plistlib, subprocess, sys
helper, root, mode, format, prepared = sys.argv[1:]
os.environ["IOS_TEST_BUILD_PREPARED"] = prepared
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
      String(prepared),
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
  it.each([
    { mode: "ready", format: 0, prepared: false },
    { mode: "ready", format: 2, prepared: false },
    { mode: "ready", format: 1, prepared: true },
    { mode: "already-booted", format: 1, prepared: false },
    { mode: "execution-count", format: 1, prepared: false },
  ])("preserves two repetitions (%j)", ({ mode, format, prepared }) => {
    const proof = runRestartProof(mode, format, prepared);
    const { commands, runs } = proof;
    expect(proof).toMatchObject({ error: null, bootTimeouts: [120], receiptRetained: false });
    expect(runs).toHaveLength(1);
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
    expectArgs(invocations[0], [
      "-test-iterations",
      "2",
      "-test-repetition-relaunch-enabled",
      "YES",
      "-parallel-testing-enabled",
      "NO",
      "platform=iOS Simulator,id=simulator-fixture",
      "-only-testing:OpenClawTests/GatewayAccessRestartTests/testAcknowledgedSignOutSurvivesProcessRestart",
    ]);
    expect(commands.filter((args) => args.includes("build-for-testing"))).toHaveLength(
      prepared ? 0 : 1,
    );
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
    expect(runRestartProof("ready", 3)).toMatchObject({
      error: "Unsupported generated test run format",
      runs: [],
    });
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
