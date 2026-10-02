import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { parse } from "yaml";
import {
  createVoiceFixture,
  runWatchPhase,
} from "../../scripts/ios-watch-operator-https-proof.mts";
import * as watchProof from "../../scripts/ios-watch-operator-https-proof.mts";
import {
  formatIosSimulatorSelectionSummary,
  resolveIosSimulatorTestSelection,
} from "../../scripts/lib/ci-ios-smoke-plan.mjs";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { waitForDead, waitForFile, waitForPidFile } from "../helpers/process-wait.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../helpers/tls-fixture.js";
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
const qualification = parse(readFileSync(".github/workflows/ios-periphery.yml", "utf8"));
const qualificationSteps: {
  id?: string;
  name: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}[] = qualification.jobs.scan.steps;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runXcodeSelection(qualificationMode: boolean, failure = "") {
  const root = tempDirs.make("watch-xcode-selection-");
  const envFile = path.join(root, "github-env");
  const commandsFile = path.join(root, "commands");
  const step = qualificationSteps.find((entry) => entry.name === "Verify Xcode");
  assert(step?.run);
  // Execute the actual workflow shell; only filesystem and native commands are fixtures.
  const prelude = String.raw`
function sudo {
  printf 'sudo:%s\n' "$*" >> "$XCODE_COMMANDS"
  [[ "$XCODE_FAILURE" != "select" ]]
}
function xcodebuild {
  local selected="$DEVELOPER_DIR"
  if [[ -z "$selected" ]]; then selected=unset; fi
  printf 'xcodebuild:%s\n' "$selected" >> "$XCODE_COMMANDS"
  [[ "$XCODE_FAILURE" != "xcodebuild" ]]
}
function swift {
  local selected="$DEVELOPER_DIR"
  if [[ -z "$selected" ]]; then selected=unset; fi
  printf 'swift:%s\n' "$selected" >> "$XCODE_COMMANDS"
  [[ "$XCODE_FAILURE" != "swift" ]]
}
`;
  const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", prelude + step.run], {
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      DEVELOPER_DIR: "",
      WATCH_QUALIFICATION: String(qualificationMode),
      XCODE_FAILURE: failure,
      XCODE_COMMANDS: commandsFile,
      GITHUB_ENV: envFile,
    },
  });
  return {
    result,
    commands: existsSync(commandsFile) ? readFileSync(commandsFile, "utf8").trim().split("\n") : [],
    environment: existsSync(envFile) ? readFileSync(envFile, "utf8") : "",
  };
}

function runSimulatorStep(
  mode = "ready",
  steps = [watchStep],
  env: Record<string, string> = {},
  phases?: string[],
) {
  const root = tempDirs.make("openclaw-watch-workflow-");
  const bin = path.join(root, "bin");
  const harnessLib = path.join(root, ".ci-harness", "scripts", "lib");
  const temporaryRoot = path.join(root, "temporary");
  const product = path.join(root, "project derived data", "Watch Product.app");
  const testProduct = path.join(product, "PlugIns", "Watch Tests.xctest");
  mkdirSync(bin, { recursive: true });
  mkdirSync(harnessLib, { recursive: true });
  copyFileSync("scripts/lib/swift-toolchain.sh", path.join(harnessLib, "swift-toolchain.sh"));
  copyFileSync("scripts/lib/ci-ios-smoke-plan.mjs", path.join(harnessLib, "ci-ios-smoke-plan.mjs"));
  mkdirSync(temporaryRoot);
  mkdirSync(testProduct, { recursive: true });
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(
    path.join(root, "scripts/ios-watch-operation-tests.sh"),
    readFileSync("scripts/ios-watch-operation-tests.sh"),
  );
  const runner = path.join(root, "tools.mjs");
  writeFileSync(
    runner,
    String.raw`
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
const [tool, ...args] = process.argv.slice(2);
const root = process.env.WATCH_FIXTURE_ROOT;
const mode = process.env.WATCH_FIXTURE_MODE;
if ((tool === "xcodebuild" && args.includes("-showBuildSettings") && mode === "settings-command-failed") ||
    (tool === "xcodebuild" && !args.includes("-showBuildSettings") && mode === "build-command-failed") ||
    (tool === "xcrun" && args[1] === "install" && mode === "install-command-failed")) {
  console.error("error: fixture command failed");
  process.exit(27);
}
const productPath = path.join(root, "project derived data", "Watch Product.app");
const targetTempDir = path.join(root, "project intermediates", "Watch Product.build");
const generatedPath = path.join(targetTempDir, "Watch Product.app-Simulated.xcent");
const applicationID = (mode === "mixed-case-prefix" ? "SeedFix123" : "SEEDFIX123") + ".org.example.watch";
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
  if (args[0] === "lipo") {
    if (args[1] === "-archs") {
      console.log(mode.startsWith("universal") ? "x86_64 arm64" : "arm64");
    } else {
      writeFileSync(args[5], args[3]);
    }
  } else if (args[0] === "segedit") {
    if (mode.startsWith("universal") && args[1] === path.join(productPath, "OpenClawWatchApp")) {
      throw new Error("segedit only operates on thin Mach-O files");
    }
    const output = args[5];
    if (output === "-" || !path.isAbsolute(output) ||
        (statSync(path.dirname(output)).mode & 0o777) !== 0o700) {
      throw new Error("Expected a private extraction directory and real output file");
    }
    if (mode === "missing-section") process.exit(26);
    const entitlements = mode === "missing-application-id" ? {} : {
      "application-identifier": (mode === "wrong-application-id" ||
        (mode === "universal-wrong-application-id" && args[1].endsWith("host-arm64"))) ?
        "SEEDFIX123.org.example.other" : mode === "wrong-compiled-seed" ?
        "TEAMFIX123.org.example.watch" : mode === "compiled-seed-case-mismatch" ?
        "seedfix123.org.example.watch" : applicationID
    };
    if (mode === "explicit-private-group") {
      entitlements["keychain-access-groups"] = ["SEEDFIX123.org.example.watch"];
    } else if (mode === "malformed-keychain-groups") {
      entitlements["keychain-access-groups"] = "not-an-array";
    }
    writeFileSync(output, mode === "malformed-section" ? "not a plist" : JSON.stringify(entitlements));
  } else if (args[1] === "list" && args[2] === "pairs") {
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
  const signing = {
    DEVELOPMENT_TEAM: mode === "missing-app-team" ? "" : "TEAMFIX123",
    CODE_SIGN_STYLE: "Manual",
    CODE_SIGN_ENTITLEMENTS: "Fixture/Watch.entitlements",
    CODE_SIGNING_ALLOWED: "NO",
    CODE_SIGN_IDENTITY: "Apple Development",
    CODE_SIGN_INJECT_BASE_ENTITLEMENTS: "NO",
    ...Object.fromEntries(args.filter((arg) => arg.startsWith("CODE_SIGN")).map((arg) => arg.split("=")))
  };
  const product = {
    target: "OpenClawWatchApp",
    buildSettings: {
      ...signing,
      TARGET_BUILD_DIR: mode === "relative-product" ? "relative" : path.join(root, "project derived data"),
      TARGET_TEMP_DIR: targetTempDir,
      FULL_PRODUCT_NAME: "Watch Product.app",
      EXECUTABLE_NAME: "OpenClawWatchApp",
      PRODUCT_BUNDLE_IDENTIFIER: mode === "missing-bundle-id" ? "" : "org.example.watch"
    }
  };
  const tests = {
    target: "OpenClawWatchTests",
    buildSettings: {
      ...signing,
      DEVELOPMENT_TEAM: mode === "team-mismatch" ? "OTHERTEAM1" :
        mode === "missing-test-team" ? "" : signing.DEVELOPMENT_TEAM,
      CODE_SIGN_ENTITLEMENTS: "Fixture/WatchTests.entitlements",
      TARGET_BUILD_DIR: path.join(root, "project derived data", "Watch Product.app", "PlugIns"),
      FULL_PRODUCT_NAME: "Watch Tests.xctest",
      PRODUCT_BUNDLE_IDENTIFIER: "org.example.watch.tests",
      TEST_HOST: path.join(root, "project derived data", "Watch Product.app",
        mode === "wrong-test-host" ? "OtherHost" : "OpenClawWatchApp")
    }
  };
  const other = { target: "OtherTarget", buildSettings: { TARGET_BUILD_DIR: "/wrong", FULL_PRODUCT_NAME: "Wrong.app" } };
  console.log(JSON.stringify(!args.includes("build-for-testing") ? [other, product] :
    mode === "missing-product" ? [other, tests] :
    mode === "ambiguous-product" ? [product, product, tests] :
    mode === "duplicate-test-target" ? [other, product, tests, tests] :
    mode === "missing-test-product" ? [other, product] : [other, product, tests]));
} else if (tool === "codesign") {
  if (args.includes("--verify")) {
    if ((mode === "invalid-signature" && args.at(-1).endsWith(".app")) ||
        (mode === "invalid-test-signature" && args.at(-1).endsWith(".xctest"))) {
      process.exit(25);
    }
  } else {
    console.log(JSON.stringify({ "get-task-allow": true }));
  }
} else if (tool === "plutil") {
  const input = args.at(-1);
  const plist = JSON.parse(readFileSync(input === "-" ? 0 : input, "utf8"));
  if (mode === "cleanup-failed" && /^entitlements(?:-\w+)?\.plist$/.test(path.basename(input)) &&
      path.dirname(path.dirname(input)) === process.env.TMPDIR) {
    chmodSync(process.env.TMPDIR, 0o500);
  }
  console.log(JSON.stringify(plist));
} else if (args.some((arg) => arg === "test" || arg === "test-without-building") && mode === "voice-tests-failed") {
  process.exit(25);
} else if (args.includes("build-for-testing")) {
  mkdirSync(targetTempDir, { recursive: true });
  if (mode !== "missing-generated") {
    const generated = mode === "missing-generated-id" ? {} : {
      "application-identifier": mode === "unresolved-generated-id" ?
        "$(AppIdentifierPrefix)org.example.watch" : mode === "invalid-generated-prefix" ?
        "BAD_PREFIX.org.example.watch" : mode === "wrong-generated-bundle" ?
        "SEEDFIX123.org.example.other" : applicationID
    };
    writeFileSync(generatedPath, mode === "malformed-generated" ? "not a plist" : JSON.stringify(generated));
  }
  writeFileSync(path.join(productPath, "Info.plist"), JSON.stringify({
    CFBundleIdentifier: mode === "built-bundle-mismatch" ? "org.example.other" : "org.example.watch"
  }));
  const derivedIndex = args.indexOf("-derivedDataPath");
  if (derivedIndex >= 0) {
    mkdirSync(path.join(args[derivedIndex + 1], "Build/Products/Debug-watchsimulator/OpenClawWatchApp.app"), { recursive: true });
  }
}
`,
  );
  for (const tool of [
    "xcrun",
    "xcodebuild",
    "codesign",
    "plutil",
    "pnpm",
    "uname",
    "installer",
    "simslim",
  ]) {
    const executable = path.join(bin, tool);
    writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${runner}' '${tool}' "$@"\n`);
    chmodSync(executable, 0o755);
  }
  if (mode.includes("slim")) {
    const scripts = path.join(root, "scripts");
    mkdirSync(scripts, { recursive: true });
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
  const script =
    "set -euo pipefail\n" +
    steps
      .map((step) => {
        if (!step?.run) {
          throw new Error("Missing simulator workflow step");
        }
        return `${step.run}\nset -a\nsource "$GITHUB_ENV"\nset +a`;
      })
      .join("\n");
  let result;
  try {
    const options = {
      cwd: root,
      encoding: "utf8" as const,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        RUNNER_TEMP: root,
        TMPDIR: temporaryRoot,
        TMP: temporaryRoot,
        TEMP: temporaryRoot,
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
        IOS_DEST: steps.some((step) => step?.name === watchStep?.name) ? undefined : "",
        XCODE_XCCONFIG_FILE: "",
        ...env,
      },
    };
    if (phases) {
      const state = path.join(root, "owned-build");
      mkdirSync(state, { mode: 0o700 });
      for (const phase of phases) {
        if (mode === "wrong-owned-device" && phase !== "build") {
          const file = path.join(state, "build.json");
          writeFileSync(
            file,
            JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), simulator: randomUUID() }),
          );
        }
        result = spawnSync(
          "/bin/bash",
          [
            "scripts/ios-watch-operation-tests.sh",
            path.join(root, `${phase}.xcresult`),
            "11111111-1111-4111-8111-111111111111",
            phase,
            state,
          ],
          options,
        );
        if (result.status !== 0) {
          break;
        }
      }
    } else {
      result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", script], options);
    }
  } finally {
    chmodSync(temporaryRoot, 0o700);
  }
  assert(result);
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
    testProduct,
    temporaryRoot,
    root,
    summary: readFileSync(summaryFile, "utf8"),
  };
}

function runWatchStep(mode = "ready", qualificationMode = false, phases?: string[]) {
  const step = qualificationMode
    ? qualificationSteps.find(
        (entry) => entry.name === "Run focused Apple Watch operation simulator tests",
      )
    : watchStep;
  return runSimulatorStep(mode, [step], {}, phases);
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
  it.each([false, true])(
    "uses canonical Xcode selection for qualification=%s",
    (qualificationMode) => {
      const { result, commands, environment } = runXcodeSelection(qualificationMode);
      expect(result.status, result.stderr).toBe(0);
      expect(commands).toEqual([
        "sudo:xcode-select -s /Applications/Xcode.app/Contents/Developer",
        "xcodebuild:unset",
        "swift:unset",
      ]);
      expect(environment).toBe("");
    },
  );

  it.each([
    ["select", 1],
    ["xcodebuild", 2],
    ["swift", 3],
  ] as const)("stops Xcode admission on %s failure", (failure, commandCount) => {
    const { result, commands } = runXcodeSelection(true, failure);
    expect(result.status).not.toBe(0);
    expect(commands).toHaveLength(commandCount);
  });

  it.each(["success", "failure", "cancelled", "skipped"])(
    "runs subsequent captures only after successful HTTPS/voice qualification: %s",
    (outcome) => {
      const live = qualificationSteps.find((step) => step.id === "watch_https");
      const captures = qualificationSteps.find(
        (step) => step.name === "Capture direct Watch review surfaces",
      );
      const condition = captures?.if;
      assert(live && condition);
      assert(condition.startsWith("${{") && condition.endsWith("}}"));
      // This workflow condition uses the JS-compatible &&/==/! expression subset.
      const admitted = runInNewContext(condition.slice(3, -2), {
        github: { event_name: "workflow_dispatch" },
        inputs: { watch_qualification: true },
        steps: { watch_tests: { outcome: "success" }, watch_https: { outcome } },
        cancelled: () => false,
      });
      expect(admitted).toBe(outcome === "success");
    },
  );

  it.each(["ready", "unpaired", "universal"])(
    "prepares the %s Watch and companion before testing the exact product",
    (mode) => {
      const { result, commands, product, testProduct, root, temporaryRoot } = runWatchStep(mode);
      expect(result.status, result.stderr).toBe(0);
      const xcodeCommands = commands.filter((command) => command.tool === "xcodebuild");
      for (const command of xcodeCommands) {
        expect(command.args).not.toContain("-derivedDataPath");
        expect(command.args).not.toContain("-target");
        expect(command.args).not.toContain("-alltargets");
      }
      expect(
        commands
          .filter((command) => command.tool === "xcrun" && command.args[0] === "simctl")
          .map((command) => command.args),
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
      const build = xcodeCommands.find((command) => !command.args.includes("-showBuildSettings"));
      const settingsQuery = xcodeCommands.find((command) =>
        command.args.includes("-showBuildSettings"),
      );
      expect(
        settingsQuery?.args.filter((arg) => arg !== "-showBuildSettings" && arg !== "-json"),
      ).toEqual(build?.args);
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
            "-only-testing:OpenClawWatchTests/WatchDirectConversationTests",
            "-only-testing:OpenClawWatchTests/WatchGatewayControllerTests",
            "CODE_SIGNING_ALLOWED=YES",
            "CODE_SIGN_IDENTITY=-",
            "CODE_SIGN_INJECT_BASE_ENTITLEMENTS=YES",
          ]),
        );
        expect(
          command.args.some((arg) =>
            /^(DEVELOPMENT_TEAM|CODE_SIGN_STYLE|CODE_SIGN_ENTITLEMENTS|PROVISIONING_PROFILE_SPECIFIER)=/.test(
              arg,
            ),
          ),
        ).toBe(false);
      }
      const installIndex = commands.findIndex((command) => command.args.includes("install"));
      expect(
        commands.slice(0, installIndex).filter((command) => command.tool === "codesign"),
      ).toEqual([
        { tool: "codesign", args: ["--verify", "--strict", product] },
        { tool: "codesign", args: ["--verify", "--strict", testProduct] },
      ]);
      const extractions = commands.filter(
        (command) => command.tool === "xcrun" && command.args[0] === "segedit",
      );
      expect(extractions).toHaveLength(mode === "universal" ? 2 : 1);
      for (const extraction of extractions) {
        expect(extraction.args.slice(2, 5)).toEqual(["-extract", "__TEXT", "__entitlements"]);
        const plistPath = extraction.args[5];
        assert(plistPath, "Expected an extracted entitlement plist");
        expect(plistPath).not.toBe("-");
        expect(path.dirname(path.dirname(plistPath))).toBe(temporaryRoot);
      }
      expect(
        commands.slice(0, installIndex).filter((command) => command.tool === "plutil"),
      ).toEqual([
        { tool: "plutil", args: ["-convert", "json", "-o", "-", path.join(product, "Info.plist")] },
        {
          tool: "plutil",
          args: [
            "-convert",
            "json",
            "-o",
            "-",
            path.join(
              root,
              "project intermediates",
              "Watch Product.build",
              "Watch Product.app-Simulated.xcent",
            ),
          ],
        },
        ...extractions.map(({ args }) => ({
          tool: "plutil",
          args: ["-convert", "json", "-o", "-", args[5]],
        })),
      ]);
      expect(readdirSync(temporaryRoot)).toEqual([]);
      expect(result.stderr.split("\n")[0]).toBe(
        '{"watchBuildSettings":{"OpenClawWatchApp":1,"OpenClawWatchTests":1}}',
      );
      expect(result.stderr).toContain('"team":"TEAMFIX123"');
      expect(result.stderr).toContain('"applicationID":"SEEDFIX123.org.example.watch"');
      expect(result.stderr).toContain('"style":"Manual"');
      expect(result.stderr).toContain('"entitlementsFile":"Fixture/Watch.entitlements"');
      expect(result.stderr).toContain('"entitlementsSource":"__TEXT,__entitlements"');
      expect(result.stderr).toContain('"keychainAccessGroups":null');
      expect(
        xcodeCommands.find((command) => command.args.includes("test-without-building"))?.args,
      ).toContain("apps/ios/build/LifecycleTestResults/OpenClawWatchOperationTests.xcresult");
    },
  );

  it.each([
    "missing-product",
    "ambiguous-product",
    "relative-product",
    "missing-test-product",
    "duplicate-test-target",
    "wrong-test-host",
    "invalid-signature",
    "invalid-test-signature",
    "missing-section",
    "malformed-section",
    "missing-application-id",
    "wrong-application-id",
    "universal-wrong-application-id",
    "wrong-compiled-seed",
    "compiled-seed-case-mismatch",
    "missing-generated",
    "malformed-generated",
    "missing-generated-id",
    "unresolved-generated-id",
    "invalid-generated-prefix",
    "wrong-generated-bundle",
    "missing-app-team",
    "missing-test-team",
    "team-mismatch",
    "missing-bundle-id",
    "built-bundle-mismatch",
    "malformed-keychain-groups",
  ])("rejects %s settings before simulator installation or test execution", (mode) => {
    const { result, commands, temporaryRoot } = runWatchStep(mode);
    expect(result.status).not.toBe(0);
    const appCount = mode === "missing-product" ? 0 : mode === "ambiguous-product" ? 2 : 1;
    const testCount =
      mode === "missing-test-product" ? 0 : mode === "duplicate-test-target" ? 2 : 1;
    expect(result.stderr.split("\n")[0]).toBe(
      JSON.stringify({
        watchBuildSettings: { OpenClawWatchApp: appCount, OpenClawWatchTests: testCount },
      }),
    );
    if (appCount !== 1) {
      expect(result.stderr).toContain(
        `Expected one OpenClawWatchApp target from Xcode, got ${appCount}`,
      );
    } else if (testCount !== 1) {
      expect(result.stderr).toContain(
        `Expected one OpenClawWatchTests target from Xcode, got ${testCount}`,
      );
    }
    if (mode === "missing-app-team") {
      expect(result.stderr).toContain("Missing configured Watch app development team");
    } else if (mode === "team-mismatch" || mode === "missing-test-team") {
      expect(result.stderr).toContain("Configured Watch test team does not match the app team");
    } else if (mode === "missing-bundle-id") {
      expect(result.stderr).toContain("Missing configured Watch app bundle identifier");
    } else if (mode === "built-bundle-mismatch") {
      expect(result.stderr).toContain(
        "Built Watch bundle identifier does not match its configuration",
      );
    } else if (
      [
        "missing-generated-id",
        "unresolved-generated-id",
        "invalid-generated-prefix",
        "wrong-generated-bundle",
      ].includes(mode)
    ) {
      expect(result.stderr).toContain(
        "Expected a fully evaluated generated Watch application identifier for the configured bundle",
      );
    } else if (
      [
        "wrong-compiled-seed",
        "compiled-seed-case-mismatch",
        "universal-wrong-application-id",
      ].includes(mode)
    ) {
      expect(result.stderr).toContain(
        "Simulated Watch host application identifier does not match its build identity",
      );
    }
    if (mode === "missing-generated" || mode === "malformed-generated") {
      expect(
        commands.some(
          (command) =>
            command.tool === "plutil" && command.args.at(-1)?.endsWith("-Simulated.xcent"),
        ),
      ).toBe(true);
      expect(commands.some((command) => command.args[0] === "segedit")).toBe(false);
    }
    expect(result.stderr).not.toContain("OtherTarget");
    expect(result.stderr).not.toContain("/wrong");
    expect(commands.some((command) => command.args.includes("install"))).toBe(false);
    expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(false);
    expect(readdirSync(temporaryRoot)).toEqual([]);
  });

  it("stops before installation and test execution when extraction cleanup fails", () => {
    const { result, commands, temporaryRoot } = runWatchStep("cleanup-failed");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/EACCES|EPERM/);
    expect(commands.some((command) => command.tool === "plutil")).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.tool === "plutil" &&
          /\/entitlements(?:-\w+)?\.plist$/.test(command.args.at(-1) ?? ""),
      ),
    ).toBe(true);
    expect(commands.some((command) => command.args.includes("install"))).toBe(false);
    expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(false);
    expect(readdirSync(temporaryRoot)).toHaveLength(1);
  });

  it("accepts an explicitly provided private Keychain group without changing signing configuration", () => {
    const { result, commands } = runWatchStep("explicit-private-group");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('"keychainAccessGroups":["SEEDFIX123.org.example.watch"]');
    expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(true);
  });

  it("preserves a mixed-case generated App ID prefix independently of the configured team", () => {
    const { result, commands } = runWatchStep("mixed-case-prefix");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('"team":"TEAMFIX123"');
    expect(result.stderr).toContain('"applicationID":"SeedFix123.org.example.watch"');
    expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(true);
  });

  it("preserves simulator readiness failure without installing or running tests", () => {
    const { result, commands } = runWatchStep("boot-failed");
    expect(result.status).toBe(23);
    expect(commands.some((command) => command.args.includes("install"))).toBe(false);
    expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(false);
  });

  it("runs the same Watch suites in qualification mode and retains an independent result bundle", () => {
    const normal = runWatchStep();
    const focused = runWatchStep("ready", true);
    expect(focused.result.status, focused.result.stderr).toBe(0);
    const testSelection = (commands: Command[]) =>
      commands
        .find((command) => command.args.includes("test-without-building"))
        ?.args.filter((arg) => arg.startsWith("-only-testing:"));
    expect(testSelection(focused.commands)).toEqual(testSelection(normal.commands));
    expect(
      focused.commands.find((command) => command.args.includes("test-without-building"))?.args,
    ).toContain(path.join(focused.root, "watch-qualification/WatchOperationTests.xcresult"));
  });

  it("builds an owned qualification host once, then uses only that simulator without fixture phases in normal suites", () => {
    const { result, commands, product, root } = runWatchStep("ready", false, [
      "build",
      "identity",
      "negative",
      "positive",
      "voice",
    ]);
    expect(result.status, result.stderr).toBe(0);
    const xcode = commands.filter((command) => command.tool === "xcodebuild");
    expect(
      xcode.filter(
        (command) =>
          command.args.includes("build-for-testing") &&
          !command.args.includes("-showBuildSettings"),
      ),
    ).toHaveLength(1);
    expect(xcode.filter((command) => command.args.includes("test-without-building"))).toHaveLength(
      4,
    );
    for (const command of xcode) {
      expect(command.args).not.toContain("-derivedDataPath");
      for (const [option, value] of [
        ["-project", "apps/ios/OpenClaw.xcodeproj"],
        ["-scheme", "OpenClawWatchApp"],
        ["-configuration", "Debug"],
      ] as const) {
        expect(command.args[command.args.indexOf(option) + 1]).toBe(value);
      }
      expect(command.args.filter((arg) => arg.startsWith("CODE_SIGN"))).toEqual([
        "CODE_SIGNING_ALLOWED=YES",
        "CODE_SIGN_IDENTITY=-",
        "CODE_SIGN_INJECT_BASE_ENTITLEMENTS=YES",
      ]);
      expect(command.args).toContain(
        "platform=watchOS Simulator,id=11111111-1111-4111-8111-111111111111",
      );
      expect(command.args.filter((arg) => arg.startsWith("-only-testing:"))).toEqual([
        "-only-testing:OpenClawWatchTests/WatchOperatorHTTPSQualificationTests",
      ]);
    }
    const build = xcode.find((command) => !command.args.includes("-showBuildSettings"));
    const settingsQuery = xcode.find((command) => command.args.includes("-showBuildSettings"));
    expect(
      settingsQuery?.args.filter((arg) => arg !== "-showBuildSettings" && arg !== "-json"),
    ).toEqual(build?.args);
    expect(JSON.parse(readFileSync(path.join(root, "owned-build", "build.json"), "utf8"))).toEqual({
      simulator: "11111111-1111-4111-8111-111111111111",
      appPath: product,
      bundleID: "org.example.watch",
    });
    expect(
      commands.filter((command) => command.args[0] === "simctl").map((command) => command.args),
    ).toEqual([["simctl", "install", "11111111-1111-4111-8111-111111111111", product]]);
  });

  it.each([
    ["ready", 0, "install"],
    ["build-command-failed", 27, "build-for-testing"],
    ["settings-command-failed", 27, "build-settings"],
    ["invalid-signature", 1, "host-validation"],
    ["install-command-failed", 27, "install"],
  ])("retains ordered build diagnostics for %s without pipeline ambiguity", (mode, exit, last) => {
    const { result } = runWatchStep(mode, false, ["build"]);
    expect(result.status).toBe(exit);
    const markers = result.stderr
      .split("\n")
      .filter((line) => line.startsWith("OPENCLAW_WATCH_BUILD\t"));
    const labels = ["build-for-testing", "build-settings", "host-validation", "install"];
    const reached = labels.slice(0, labels.indexOf(last) + 1);
    expect(markers).toEqual(
      reached.flatMap((label) => [
        `OPENCLAW_WATCH_BUILD\tstart\t${label}`,
        `OPENCLAW_WATCH_BUILD\tend\t${label}\t${label === last ? exit : 0}`,
      ]),
    );
  });

  it.each(["unknown-phase", "wrong-owned-device"])(
    "rejects %s before native phase execution",
    (mode) => {
      const { result, commands } = runWatchStep(
        mode,
        false,
        mode === "unknown-phase" ? ["unrecognized"] : ["build", "positive"],
      );
      expect(result.status).not.toBe(0);
      expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(
        false,
      );
    },
  );

  it("keeps qualification opt-in and separates test evidence from Periphery reports", () => {
    expect(qualification.on.workflow_dispatch.inputs.watch_qualification.default).toBe(false);
    for (const name of [
      "Run Periphery",
      "Build Periphery report",
      "Upload Periphery report",
      "Fail on dead code",
    ]) {
      expect(qualificationSteps.find((step) => step.name === name)?.if).toContain(
        "!(github.event_name == 'workflow_dispatch' && inputs.watch_qualification)",
      );
    }
    const artifact = qualificationSteps.find(
      (step) => step.name === "Upload Watch qualification evidence",
    );
    expect(artifact?.if).toContain("always()");
    expect(artifact?.with?.["if-no-files-found"]).toBe("error");
    expect(String(artifact?.with?.path).trim().split("\n")).toEqual([
      "${{ runner.temp }}/watch-qualification/source-head.txt",
      "${{ runner.temp }}/watch-qualification/xcode-version.txt",
      "${{ runner.temp }}/watch-qualification/shared-tests.log",
      "${{ runner.temp }}/watch-qualification/watch-tests.log",
      "${{ runner.temp }}/watch-qualification/WatchOperationTests.xcresult",
      "${{ runner.temp }}/watch-qualification/ui-fixtures",
      "${{ runner.temp }}/watch-qualification/operator-https.json",
    ]);
    const liveHTTPS = qualificationSteps.find(
      (step) => step.name === "Prove Watch operator HTTPS and native voice retirement",
    );
    expect(liveHTTPS?.if).toContain(
      "github.event_name == 'workflow_dispatch' && inputs.watch_qualification",
    );
    expect(liveHTTPS?.run).toBe(
      "node --import ./scripts/tsx.mjs scripts/ios-watch-operator-https-proof.mts",
    );
    const shared = qualificationSteps.find(
      (step) => step.name === "Run focused shared Watch transport tests",
    );
    expect(shared?.run).toContain("GatewayOperatorHTTPSessionTests");
    expect(shared?.run).toContain("GatewayOperatorHTTPWireTests");
    expect(shared?.run).toContain("--no-parallel");
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
    ]);
    for (const name of authClasses) {
      expect(readFileSync(`apps/ios/Tests/${name}.swift`, "utf8")).toContain(`struct ${name}`);
    }
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
    const tests = commands.filter((command) => command.tool === "xcodebuild");
    expect(tests).toHaveLength(2);
    expect(tests[0]?.args).toEqual(
      expect.arrayContaining([
        ...authClasses.map((name) => `-only-testing:OpenClawTests/${name}`),
        "-only-testing:OpenClawTests/ChatTypingFocusTests",
        "-only-testing:OpenClawTests/ChatSendHydrationTests",
        "-only-testing:OpenClawLogicTests/WatchVoiceTurnTrackerTests",
        "-only-testing:OpenClawTests/NodeAppModelInvokeTests",
        "-only-testing:OpenClawTests/OpenClawTypographyTests",
      ]),
    );
    expect(tests[1]?.args.filter((arg) => arg.startsWith("-only-testing:"))).toEqual([
      "-only-testing:OpenClawUITests/OpenClawSnapshotUITests/testWatchMessageDeliveryIsReachableFromSettings",
      "-only-testing:OpenClawUITests/BootstrapSetupFailureUITests",
    ]);
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
    ["apps/ios/Tests/ChatSendHydrationTests.swift", false, true],
    ["apps/ios/Tests/RootTabsNavigationTests.swift", false, false],
    ["apps/shared/OpenClawKit/Tests/OpenClawKitTests/ChatViewModelTests.swift", false, false],
    ["apps/shared/OpenClawKit/Sources/OpenClawNativeState/NativeState.swift", true, true],
    ["apps/macos/Tests/OpenClawIPCTests/GatewayWebSocketTestSupport.swift", true, true],
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
describe("Watch build command diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  async function command(
    source: string,
    report: Record<string, unknown>,
    timeout = 2000,
    label = "watch-build",
    saved?: unknown[],
  ) {
    return watchProof.runWatchQualificationCommand(label, process.execPath, ["-e", source], {
      environment: process.env,
      report,
      save: async () => {
        saved?.push(structuredClone(report));
      },
      timeout,
    });
  }

  it("retains sanitized build output and the first failure after successful and failed cleanup", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const report: Record<string, unknown> = {};
    const saved: unknown[] = [];
    await expect(
      command(
        String.raw`
      (async () => {
        process.stderr.write("OPENCLAW_WATCH_");
        await new Promise(resolve => setTimeout(resolve, 10));
        process.stderr.write("BUILD\tstart\tbuild-settings\n");
        process.stderr.write("OPENCLAW_WATCH_BUILD\tstart\tprivate-label\n");
        process.stderr.write("OPENCLAW_WATCH_BUILD\tstart\tinstall\tprivate-argument\n");
        process.stderr.write("error: Authorization: Bear");
        await new Promise(resolve => setTimeout(resolve, 10));
        process.stderr.write("er private-fixture-credential\n");
        for (const part of [
          "error: /Users/private-", "person/project/file.swift failed\n",
          "Authorization: Bear", "er private-fixture-credential\n",
          "error: https://private.internal/path?token=private-fixture-credential\n",
          "error: private-person@example.invalid 192.168.4.5 11111111-1111-4111-8111-111111111111\n",
          "-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----\n"
        ]) {
          process.stdout.write(part);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        process.stderr.write("error: fixture failure\n");
        process.stderr.write("OPENCLAW_WATCH_BUILD\tend\tbuild-settings\t27\n");
        process.exitCode = 27;
      })();
    `,
        report,
        2000,
        "watch-build",
        saved,
      ),
    ).rejects.toThrow();
    const failed = structuredClone(report.failedChild);
    expect(failed).toMatchObject({
      label: "watch-build",
      outcome: "exit",
      code: 27,
      signal: null,
      build: {
        steps: [
          { event: "start", label: "build-settings" },
          { event: "end", label: "build-settings", code: 27 },
        ],
        stderr: expect.stringContaining("error: fixture failure"),
      },
    });
    expect(saved.at(-1)).toMatchObject({ failedChild: failed });
    await command("", report, 2000, "watch-shutdown", saved);
    await expect(
      command("process.exitCode = 9", report, 2000, "watch-delete", saved),
    ).rejects.toThrow();
    expect(report.failedChild).toEqual(failed);
    expect(report.child).toMatchObject({ label: "watch-delete", code: 9 });
    const published = JSON.stringify([report, saved, consoleLog.mock.calls]);
    for (const privateValue of [
      "private-person",
      "private-fixture-credential",
      "private.internal",
      "192.168.4.5",
      "11111111-",
      "private-key-material",
      "private-label",
      "private-argument",
    ]) {
      expect(published).not.toContain(privateValue);
    }
    expect(published).not.toContain("-e");
  });

  it.each(["private-person/project", "private person/private project"])(
    "preserves located compiler errors without publishing the path: %s",
    async (directory) => {
      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
      const report: Record<string, unknown> = {};
      const saved: unknown[] = [];
      const message =
        "error: main actor-isolated static property 'scopes' cannot be accessed from outside of the actor";
      const diagnostic = `/Users/${directory}/WatchOperatorHTTPSQualificationTests.swift:142:95: ${message}\n`;
      await expect(
        command(
          `process.stdout.write(${JSON.stringify(diagnostic)}); process.stderr.write(${JSON.stringify(diagnostic)}); process.exitCode = 1;`,
          report,
          2000,
          "watch-build",
          saved,
        ),
      ).rejects.toThrow();
      expect(report.failedChild).toMatchObject({
        build: {
          stdout: `[path]:142:95: ${message}`,
          stderr: `[path]:142:95: ${message}`,
        },
      });
      expect(JSON.stringify([report, saved, consoleLog.mock.calls])).not.toMatch(
        /Users|private.person|private project|WatchOperatorHTTPSQualificationTests/,
      );
    },
  );

  it("does not publish ambiguous progress paths or their private suffix words", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const report: Record<string, unknown> = {};
    const saved: unknown[] = [];
    const diagnostic =
      "SwiftCompile /Users/private person/private project/Watch.swift normal arm64 private-note\n";
    await expect(
      command(
        `process.stdout.write(${JSON.stringify(diagnostic)}); process.stderr.write(${JSON.stringify(diagnostic)}); process.exitCode = 1;`,
        report,
        2000,
        "watch-build",
        saved,
      ),
    ).rejects.toThrow();
    expect(report.failedChild).toMatchObject({ build: { stdout: "", stderr: "" } });
    expect(JSON.stringify([report, saved, consoleLog.mock.calls])).not.toMatch(
      /Users|private|person|project|Watch|SwiftCompile/,
    );
  });

  it.skipIf(process.platform === "win32")(
    "retains leader exit facts when held output rejects before close",
    { timeout: 20000 },
    async ({ signal }) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      // This fixture owns the deliberate failed join and releases its held pipes afterward.
      const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "watch-held-output-"));
      const owner = createVitestResourceOwner(directory);
      const file = (name: string) => path.join(directory, name);
      const output = "error: held output fixture\n";
      const leaf = `
const fs = require("node:fs");
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(file("release"))})) clearInterval(timer);
}, 5);
fs.writeFileSync(${JSON.stringify(file("leaf.pid"))}, String(process.pid));
process.send("ready");
process.disconnect();
`;
      const leader = `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(file("leader.pid"))}, String(process.pid));
const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(leaf)}], {
  detached: true, stdio: ["ignore", "inherit", "inherit", "ipc"],
});
child.once("message", () => {
  fs.writeSync(1, ${JSON.stringify(output)});
  process.exit(7);
});
`;
      const report: Record<string, unknown> = {};
      const completion = watchProof
        .runWatchQualificationCommand("watch-build", process.execPath, ["-e", leader], {
          environment: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory },
          report,
          save: async () => {
            if (report.child) {
              writeFileSync(file("closed"), "closed");
            }
          },
          timeout: 15000,
        })
        .catch((error: unknown) => error);
      await runQaGatewayFixture(
        async () => {
          const failure = await completion;
          expect(failure).toMatchObject({ code: "EPROCESSGROUP_CLEANUP_FAILED" });
          expect(hasUnjoinedWork(failure)).toBe(true);
          expect(report.child).toBeUndefined();
          expect(report.failedChild).toMatchObject({
            code: 7,
            signal: null,
            outputBytes: Buffer.byteLength(output),
            outcome: "rejected",
            errorCode: "EPROCESSGROUP_CLEANUP_FAILED",
            unjoined: true,
          });
          const firstFailure = structuredClone(report.failedChild);
          expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
          writeFileSync(file("release"), "release");
          await waitForFile(file("closed"), signal);
          expect(report.child).toMatchObject({ code: 7, outputBytes: Buffer.byteLength(output) });
          await command("", report, 2000, "watch-delete");
          expect(report.failedChild).toEqual(firstFailure);
        },
        async () => {
          writeFileSync(file("release"), "release");
          await completion;
          for (const name of ["leader.pid", "leaf.pid"]) {
            if (existsSync(file(name))) {
              await waitForDead(await waitForPidFile(file(name), signal), signal);
            }
          }
          rmSync(directory, { recursive: true, force: true });
        },
      );
    },
  );

  it.each(["timeout", "signal", "spawn"])(
    "classifies %s without inferring timeout from SIGTERM",
    async (kind) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const report: Record<string, unknown> = {};
      const run =
        kind === "spawn"
          ? watchProof.runWatchQualificationCommand(
              "watch-build",
              "/missing-watch-fixture-tool",
              [],
              {
                environment: process.env,
                report,
                save: async () => {},
              },
            )
          : command(
              kind === "timeout"
                ? "setInterval(() => {}, 1000)"
                : "process.kill(process.pid, 'SIGTERM')",
              report,
              kind === "timeout" ? 350 : 2000,
            );
      await expect(run).rejects.toThrow();
      expect(report.failedChild).toMatchObject({
        outcome: kind === "signal" ? "signal" : "rejected",
        errorCode: kind === "timeout" ? "ETIMEDOUT" : kind === "spawn" ? "ENOENT" : null,
        elapsedMs: expect.any(Number),
      });
    },
  );

  it("keeps the four MiB combined output cutoff and joins its rejected child", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const report: Record<string, unknown> = {};
    const failure = await command(
      `
      process.stdout.write("error: fixture start\\n");
      process.stderr.write(Buffer.alloc(4 * 1024 * 1024 + 1, 120));
    `,
      report,
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "ABORT_ERR" });
    expect(hasUnjoinedWork(failure)).toBe(false);
    expect(report.failedChild).toMatchObject({
      outcome: "rejected",
      errorCode: "ABORT_ERR",
      unjoined: false,
      build: { truncated: true },
    });
    expect((report.failedChild as { outputBytes: number }).outputBytes).toBeGreaterThan(
      4 * 1024 * 1024,
    );
  });

  it("bounds both build streams and does not expose output after identity admission", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const report: Record<string, unknown> = {};
    await expect(
      command(
        `
      process.stdout.write(("error: bounded fixture\\n").repeat(10000));
      process.stderr.write(("error: bounded fixture\\n").repeat(10000));
      process.exitCode = 1;
    `,
        report,
      ),
    ).rejects.toThrow();
    const failed = report.failedChild as { build: { stdout: string; stderr: string } };
    expect(Buffer.byteLength(failed.build.stdout)).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(failed.build.stderr)).toBeLessThanOrEqual(4096);
    const privateReport: Record<string, unknown> = {};
    await expect(
      command(
        "console.error('private-phase-token'); process.exitCode = 1",
        privateReport,
        2000,
        "watch-positive",
      ),
    ).rejects.toThrow();
    expect(privateReport.failedChild).not.toHaveProperty("build");
    expect(JSON.stringify([privateReport, consoleLog.mock.calls])).not.toContain(
      "private-phase-token",
    );
    expect(privateReport).not.toHaveProperty("identityOutput");
  });

  it.each(["passed", "failed", "skipped"] as const)(
    "records only attributed identity scalars across split UTF8 and ANSI: %s",
    async (outcome) => {
      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
      const report: Record<string, unknown> = {};
      const saved: unknown[] = [];
      const text = [
        "\u001b[32m\u25c7 Suite WatchOperatorHTTPSQualificationTests started.\u001b[0m",
        ...(outcome === "skipped" ? [] : ["\u25c7 Test qualification() started."]),
        outcome === "skipped"
          ? '\u21b7 Test qualification() skipped: "/Users/private person/input.json private-token"'
          : `\u2714 Test qualification() ${outcome} after 0.001 seconds${outcome === "failed" ? " with 1 issue" : ""}.`,
        `\u2714 Suite WatchOperatorHTTPSQualificationTests ${outcome === "failed" ? "failed" : "passed"} after 0.002 seconds${outcome === "failed" ? " with 1 issue" : ""}.`,
        `\u2714 Test run with 1 test in 1 suite ${outcome === "failed" ? "failed" : "passed"} after 0.003 seconds${outcome === "failed" ? " with 1 issue" : ""}.`,
        "private-person@example.invalid https://private.internal/path 192.168.4.5",
        "11111111-1111-4111-8111-111111111111 private-identity private-input",
        "",
      ].join("\n");
      const source = `
        (async () => {
          const bytes = Buffer.from(${JSON.stringify(text)});
          for (let offset = 0; offset < bytes.length; offset += 2) {
            await new Promise(resolve => process.stderr.write(bytes.subarray(offset, offset + 2), resolve));
            await new Promise(resolve => setImmediate(resolve));
          }
          process.exitCode = ${outcome === "failed" ? 1 : 0};
        })();
      `;
      const result = command(source, report, 2000, "watch-identity", saved);
      if (outcome === "failed") {
        await expect(result).rejects.toThrow();
      } else {
        await result;
      }
      const diagnostic = {
        reportedCount: 1,
        summaryOutcome: outcome === "failed" ? "failed" : "passed",
        attribution: "expected-suite",
        expectedQualificationStart: outcome !== "skipped",
        expectedQualificationPass: outcome === "passed",
        expectedQualificationFail: outcome === "failed",
        expectedQualificationSkip: outcome === "skipped",
        truncated: false,
      };
      expect(report.identityOutput).toEqual(diagnostic);
      expect(saved.at(-1)).toMatchObject({ identityOutput: diagnostic });
      expect(Buffer.byteLength(JSON.stringify(diagnostic))).toBeLessThan(512);
      expect(JSON.stringify([report, saved, consoleLog.mock.calls])).not.toMatch(
        /private|Users|input\.json|192\.168|11111111-|https:|skipped:/,
      );
    },
  );

  it.each([
    ["missing suite", "", "unavailable"],
    ["wrong suite", "\u25c7 Suite OtherTests started.\n", "ambiguous"],
    [
      "conflicting suites",
      "\u25c7 Suite WatchOperatorHTTPSQualificationTests started.\n\u25c7 Suite OtherTests started.\n",
      "ambiguous",
    ],
    [
      "lookalike suite",
      "\u25c7 Suite WatchOperatorHTTPSQualificationTestsExtra started.\n",
      "ambiguous",
    ],
    ["missing output", "", "unavailable"],
    [
      "conflicting outcomes",
      "\u25c7 Suite WatchOperatorHTTPSQualificationTests started.\n",
      "ambiguous",
    ],
    [
      "cross-stream suite",
      "\u25c7 Suite WatchOperatorHTTPSQualificationTests started.\n",
      "ambiguous",
    ],
  ])("keeps identity attribution conservative for %s", async (mode, suite, attribution) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const report: Record<string, unknown> = {};
    const events =
      mode === "missing output"
        ? ""
        : "\u25c7 Test qualification() started.\n\u2714 Test qualification() passed after 0.001 seconds.\n" +
          (mode === "conflicting outcomes" ? "\u21b7 Test qualification() skipped.\n" : "");
    await command(
      mode === "cross-stream suite"
        ? `process.stdout.write(${JSON.stringify(suite)}); process.stderr.write(${JSON.stringify(events)});`
        : `process.stdout.write(${JSON.stringify(suite + events)});`,
      report,
      2000,
      "watch-identity",
    );
    expect(report.identityOutput).toMatchObject({
      reportedCount: null,
      summaryOutcome: "unavailable",
      attribution,
      expectedQualificationStart: null,
      expectedQualificationPass: null,
      expectedQualificationFail: null,
      expectedQualificationSkip: null,
    });
  });

  it.each(["0", "-1", "1.5", "NaN", "9007199254740992", "1 private-token", "conflict"])(
    "does not manufacture an identity execution verdict from summary count %s",
    async (count) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const report: Record<string, unknown> = {};
      const text =
        count === "conflict"
          ? "\u2714 Test run with 1 test in 1 suite passed after 0.001 seconds.\n\u2718 Test run with 2 tests in 1 suite failed after 0.001 seconds.\n"
          : `\u2714 Test run with ${count} tests in 0 suites passed after 0.001 seconds.\n`;
      await command(
        `process.stdout.write(${JSON.stringify(text)});`,
        report,
        2000,
        "watch-identity",
      );
      expect(report.identityOutput).toMatchObject({
        reportedCount: count === "0" ? 0 : null,
        summaryOutcome:
          count === "0" ? "passed" : count === "conflict" ? "ambiguous" : "unavailable",
        attribution: "unavailable",
        expectedQualificationPass: null,
      });
      expect(JSON.stringify(report)).not.toContain("private-token");
    },
  );

  it("retains scalar-only identity diagnostics on combined-stream overflow", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const report: Record<string, unknown> = {};
    await expect(
      command(
        `process.stdout.write("\\u25c7 Suite WatchOperatorHTTPSQualificationTests started.\\n");
         process.stderr.write(Buffer.alloc(4 * 1024 * 1024 + 1, 120));`,
        report,
        2000,
        "watch-identity",
      ),
    ).rejects.toThrow();
    expect(report.failedChild).toMatchObject({ errorCode: "ABORT_ERR", unjoined: false });
    expect(report.identityOutput).toEqual({
      reportedCount: null,
      summaryOutcome: "ambiguous",
      attribution: "ambiguous",
      expectedQualificationStart: null,
      expectedQualificationPass: null,
      expectedQualificationFail: null,
      expectedQualificationSkip: null,
      truncated: true,
    });
    expect(JSON.stringify([report, consoleLog.mock.calls])).not.toContain("xxxx");
  });

  it.each([
    ["suite-start", "Suite WatchOperatorHTTPSQualificationTests started.secret"],
    ["suite-end", "Suite WatchOperatorHTTPSQualificationTests passed after private-token"],
    ["test-start", "Test qualification() started.secret"],
    ["test-end", "Test qualification() passed after /Users/private person/input.json"],
    ["test-end", "Test qualification() passed after 0.001 seconds. private-token"],
    ["test-end", "Test qualification() failed after NaN seconds."],
    ["test-end", "Test qualification() failed after 0.001 seconds with 1 issues."],
    ["test-end", "Test qualification() failed after 0.001 seconds with 2 issue."],
    ["test-end", 'Test qualification() skipped: "private-token" trailing'],
    ["summary", "Test run with 1 test in 1 suite passed after private-token"],
    ["summary", "Test run with 1 test in 1 suite passed after 0.001 seconds. trailing"],
    ["summary", "Test run with 1 test in 1 suite passed after 0.001 seconds with private-token."],
  ])("leaves malformed identity %s message unavailable: %s", async (part, malformed) => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const report: Record<string, unknown> = {};
    const lines = {
      "suite-start": "Suite WatchOperatorHTTPSQualificationTests started.",
      "test-start": "Test qualification() started.",
      "test-end": "Test qualification() passed after 0.001 seconds.",
      "suite-end": "Suite WatchOperatorHTTPSQualificationTests passed after 0.002 seconds.",
      summary: "Test run with 1 test in 1 suite passed after 0.003 seconds.",
    };
    await command(
      `process.stdout.write(${JSON.stringify(
        Object.entries(lines)
          .map(([key, line]) => (key === part ? malformed : line))
          .join("\n") + "\n",
      )});`,
      report,
      2000,
      "watch-identity",
    );
    expect(report.identityOutput).toMatchObject(
      part === "summary"
        ? { reportedCount: null, summaryOutcome: "unavailable" }
        : {
            attribution: "unavailable",
            expectedQualificationStart: null,
            expectedQualificationPass: null,
            expectedQualificationFail: null,
            expectedQualificationSkip: null,
          },
    );
    expect(JSON.stringify([report, consoleLog.mock.calls])).not.toMatch(
      /private|Users|secret|trailing/,
    );
  });
});

describe("Watch qualification phase admission", () => {
  afterEach(() => vi.restoreAllMocks());

  function phaseOwner(home = tempDirs.make("watch-phase-")): Parameters<typeof runWatchPhase>[2] {
    const directory = path.join(home, "Library", "Caches", "OpenClawQualification");
    mkdirSync(directory, { recursive: true });
    return {
      current: { home, directory },
      bundleID: "private.fixture.bundle",
      evidenceDirectory: tempDirs.make("watch-phase-evidence-"),
      resolveContainer: async () => home,
      report: {},
    };
  }

  it("carries the resolved container through consecutive phases and private capture", async () => {
    const root = tempDirs.make("watch-location-");
    const suffix = path.join("Library", "Caches", "OpenClawQualification");
    const evidenceDirectory = path.join(root, "evidence");
    mkdirSync(evidenceDirectory);
    const original = path.join(root, "original");
    mkdirSync(path.join(original, suffix), { recursive: true });
    let nativeHome = original;
    const resolveContainer = vi.fn(async () => nativeHome);
    const owner = {
      current: { home: original, directory: path.join(original, suffix) } as {
        home: string;
        directory: string;
      } | null,
      bundleID: "private.fixture.bundle",
      evidenceDirectory,
      resolveContainer,
      report: {},
    };
    const run = randomUUID();
    for (const [index, phase] of (["identity", "negative"] as const).entries()) {
      const before = owner.current!;
      const result = await runWatchPhase(phase, run, owner, async () => {
        expect(owner.current).toBeNull();
        expect(resolveContainer).toHaveBeenCalledTimes(index);
        const input = JSON.parse(readFileSync(path.join(before.directory, "input.json"), "utf8"));
        const identity = statSync(before.directory, { bigint: true });
        nativeHome = path.join(root, `relocated-${index}`);
        renameSync(before.home, nativeHome);
        const directory = path.join(nativeHome, suffix);
        const relocated = statSync(directory, { bigint: true });
        expect([relocated.dev, relocated.ino]).toEqual([identity.dev, identity.ino]);
        rmSync(path.join(directory, "input.json"));
        writeFileSync(
          path.join(directory, "result.json"),
          JSON.stringify({ ...input, ok: true, ownersJoined: true }),
          { mode: 0o600 },
        );
      });
      expect(result).toMatchObject({ run, phase, ok: true, ownersJoined: true });
      expect(owner.current).toEqual({
        home: realpathSync(nativeHome),
        directory: path.join(realpathSync(nativeHome), suffix),
      });
      expect(resolveContainer).toHaveBeenCalledTimes(index + 1);
      const captured = path.join(evidenceDirectory, `${phase}-result.json`);
      expect(JSON.parse(readFileSync(captured, "utf8"))).toEqual(result);
      expect(statSync(captured).mode & 0o777).toBe(0o600);
    }
  });

  it.each(["failed", "relative", "file", "unjoined"])(
    "does not admit or privately capture a valid old result after %s location resolution",
    async (mode) => {
      const root = tempDirs.make("watch-location-failure-");
      const directory = path.join(root, "Library", "Caches", "OpenClawQualification");
      const evidenceDirectory = path.join(root, "evidence");
      mkdirSync(directory, { recursive: true });
      mkdirSync(evidenceDirectory);
      const file = path.join(root, "not-a-directory");
      writeFileSync(file, "");
      const owner = {
        current: { home: root, directory } as { home: string; directory: string } | null,
        bundleID: "private.fixture.bundle",
        evidenceDirectory,
        report: {},
        resolveContainer: vi.fn(async () => {
          if (mode === "failed") {
            throw new Error("private-query-failure");
          }
          if (mode === "unjoined") {
            throw Object.assign(new Error("private-query-child"), {
              processTreeState: "indeterminate",
            });
          }
          return mode === "relative" ? "relative-container" : file;
        }),
      };
      const outcome = await runWatchPhase("identity", randomUUID(), owner, async () => {
        const input = JSON.parse(readFileSync(path.join(directory, "input.json"), "utf8"));
        rmSync(path.join(directory, "input.json"));
        writeFileSync(
          path.join(directory, "result.json"),
          JSON.stringify({ ...input, ok: true, ownersJoined: true }),
          { mode: 0o600 },
        );
      }).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(AggregateError);
      expect(outcome).toMatchObject({ phaseFailure: { ownersJoined: false } });
      expect(hasUnjoinedWork(outcome)).toBe(true);
      expect(owner.current).toBeNull();
      expect(existsSync(path.join(evidenceDirectory, "identity-result.json"))).toBe(false);
      expect(owner.resolveContainer).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(owner.report)).not.toContain(root);
    },
  );

  it.each([
    "same",
    "alias",
    "moved",
    "renamed",
    "missing-after-write",
    "stale",
    "duplicate",
    "truncated",
    "malformed",
    "oversized",
    "unforwarded",
    "post-query-failure",
    "late-after-admission",
    "unjoined",
    "unterminated",
    "attributes-unavailable",
    "split-streams",
    "overflow",
    "run-mismatch",
    "phase-mismatch",
    "nonce-mismatch",
    "owner-acknowledgement",
    "input-consumption",
    "native-not-ok",
    "post-query-success",
    "query-unjoined",
  ])("keeps the diagnostic bridge separate from admission: %s", async (mode) => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const root = tempDirs.make("watch-bridge-");
    const original = path.join(root, "original");
    const current = path.join(root, "current");
    const suffix = path.join("Library", "Caches", "OpenClawQualification");
    const directory = path.join(original, suffix);
    mkdirSync(directory, { recursive: true });
    if (mode === "alias") {
      symlinkSync(original, current, "dir");
    } else if (mode === "moved") {
      mkdirSync(path.join(current, suffix), { recursive: true });
    }
    const bundleID = "private.fixture.bundle";
    const report: Record<string, unknown> = {};
    let input!: { run: string; phase: string; nonce: string };
    const fingerprint = (domain: string, values: string[], nonce = input.nonce) =>
      createHash("sha256")
        .update(
          ["openclaw.watch.bridge.v1", nonce.toLowerCase(), domain, ...values].join("\0") + "\0",
        )
        .digest("hex");
    const identity = (target: string, domain: string) => {
      const info = statSync(target, { bigint: true });
      return fingerprint(domain, [info.dev.toString(), info.ino.toString()]);
    };
    const record = (event: string, target: string) =>
      [
        "OPENCLAW_WATCH_BRIDGE",
        "1",
        event,
        fingerprint(
          "phase",
          [input.run.toLowerCase(), input.phase],
          mode === "stale" ? randomUUID() : input.nonce,
        ),
        mode === "attributes-unavailable"
          ? "unavailable"
          : identity(path.join(target, suffix), "directory"),
        mode === "attributes-unavailable" ? "unavailable" : identity(target, "home"),
        mode === "attributes-unavailable" ? "unavailable" : fingerprint("bundle", [bundleID]),
      ].join("\t") + "\n";
    const resolveContainer = vi.fn(async () => {
      if (["post-query-failure", "post-query-success"].includes(mode)) {
        throw new Error("/Users/private-person private-query-description");
      }
      if (mode === "query-unjoined") {
        throw Object.assign(new Error("private-query-child"), {
          processTreeState: "indeterminate",
        });
      }
      return ["alias", "moved", "renamed"].includes(mode) ? current : original;
    });
    const owner = phaseOwner(original);
    owner.resolveContainer = resolveContainer;
    owner.report = report;
    const outcome = await runWatchPhase("identity", randomUUID(), owner, async () => {
      input = JSON.parse(readFileSync(path.join(directory, "input.json"), "utf8"));
      if (mode !== "input-consumption") {
        rmSync(path.join(directory, "input.json"));
      }
      if (mode === "renamed") {
        const before = statSync(directory, { bigint: true });
        renameSync(original, current);
        const after = statSync(path.join(current, suffix), { bigint: true });
        expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
      }
      const target = ["moved", "renamed"].includes(mode) ? current : original;
      const resultFile = path.join(target, suffix, "result.json");
      const result = {
        ...input,
        ok: mode !== "native-not-ok",
        ownersJoined: mode !== "owner-acknowledgement",
      };
      if (mode === "run-mismatch") {
        result.run = randomUUID();
      }
      if (mode === "phase-mismatch") {
        result.phase = "negative";
      }
      if (mode === "nonce-mismatch") {
        result.nonce = randomUUID();
      }
      writeFileSync(resultFile, JSON.stringify(result), { mode: 0o600 });
      if (
        ![
          "same",
          "alias",
          "moved",
          "renamed",
          "run-mismatch",
          "phase-mismatch",
          "nonce-mismatch",
          "owner-acknowledgement",
          "input-consumption",
          "native-not-ok",
          "post-query-success",
          "query-unjoined",
        ].includes(mode)
      ) {
        rmSync(resultFile);
      }
      if (mode === "unjoined") {
        throw Object.assign(new Error("private-child"), { processTreeState: "indeterminate" });
      }
      let stdout = record("consumed", target) + record("written", target);
      if (mode === "duplicate") {
        stdout += record("written", target);
      } else if (mode === "malformed") {
        stdout += "OPENCLAW_WATCH_BRIDGE\tprivate-token /Users/private-person\n";
      } else if (mode === "oversized") {
        stdout += "OPENCLAW_WATCH_BRIDGE\t" + "private-token".repeat(100) + "\n";
      } else if (mode === "unforwarded") {
        stdout = "native output unavailable\n";
      } else if (mode === "unterminated") {
        stdout = stdout.trimEnd();
      }
      if (["split-streams", "overflow"].includes(mode)) {
        return watchProof.runWatchQualificationCommand(
          "watch-identity",
          process.execPath,
          [
            "-e",
            `
          (async () => {
            const output = Buffer.from(${JSON.stringify(record("consumed", target))});
            for (let offset = 0; offset < output.length; offset += 2) {
              await new Promise(resolve => process.stdout.write(output.subarray(offset, offset + 2), resolve));
            }
            process.stderr.write(${JSON.stringify(record("written", target))});
            process.stderr.write(${mode === "overflow" ? "Buffer.alloc(4 * 1024 * 1024 + 1, 120)" : JSON.stringify("\u001b[32mprivate-\u00e9-input\u001b[0m\n")});
          })();
        `,
          ],
          { environment: process.env, report: {}, save: async () => {}, timeout: 2000 },
        );
      }
      return {
        stdout,
        stderr: "private-person@example.invalid\n",
        truncated: mode === "truncated",
      };
    }).catch((error: unknown) => error);
    const good = ["same", "alias", "moved", "renamed"].includes(mode);
    if (good) {
      expect(outcome).toMatchObject({ ok: true, ownersJoined: true });
    } else {
      expect(outcome).toBeInstanceOf(AggregateError);
      const admissionFailure = [
        "run-mismatch",
        "phase-mismatch",
        "nonce-mismatch",
        "owner-acknowledgement",
        "input-consumption",
        "native-not-ok",
      ].includes(mode)
        ? mode
        : ["unjoined", "post-query-failure", "post-query-success", "query-unjoined"].includes(mode)
          ? null
          : "result-missing";
      expect(outcome).toMatchObject({
        phaseFailure: {
          admissionFailure,
          ownersJoined: mode === "native-not-ok",
        },
      });
      expect(hasUnjoinedWork(outcome)).toBe(mode !== "native-not-ok");
    }
    expect(resolveContainer).toHaveBeenCalledTimes(mode === "unjoined" ? 0 : 1);
    const ambiguous = [
      "stale",
      "duplicate",
      "truncated",
      "malformed",
      "oversized",
      "unterminated",
      "overflow",
    ].includes(mode);
    if (mode === "renamed") {
      expect(report.phaseBridge).toMatchObject({ sameCanonicalHome: false });
    }
    expect(report.phaseBridge).toMatchObject({
      phase: "identity",
      original: {
        beforeExecution: {
          directory: expect.any(String),
          home: expect.any(String),
          input: "present",
          result: "absent",
        },
      },
      sameCanonicalHome: [
        "unjoined",
        "post-query-failure",
        "post-query-success",
        "query-unjoined",
      ].includes(mode)
        ? null
        : !["moved", "renamed"].includes(mode),
      native: {
        state: ambiguous
          ? "ambiguous"
          : ["unforwarded", "unjoined"].includes(mode)
            ? "unavailable"
            : "complete",
      },
      query:
        mode === "unjoined"
          ? "not-joined"
          : ["post-query-failure", "post-query-success", "query-unjoined"].includes(mode)
            ? "failed"
            : "ok",
    });
    if (mode === "unjoined") {
      expect(report.phaseBridge).toMatchObject({ original: { afterAdmission: null } });
    }
    if (["same", "alias", "moved", "renamed", "missing-after-write"].includes(mode)) {
      const bridge = report.phaseBridge as {
        original: {
          beforeExecution: { directory: string };
          afterAdmission: { directory: string | null; home: string | null; result: string };
        };
        current: { directory: string; result: string };
        native: { consumed: { directory: string }; written: { directory: string } };
      };
      expect(bridge.current.directory === bridge.original.beforeExecution.directory).toBe(
        mode !== "moved",
      );
      if (mode === "renamed") {
        expect(bridge.original.afterAdmission).toEqual({
          directory: null,
          home: null,
          input: "absent",
          result: "absent",
        });
      } else {
        expect(bridge.original.afterAdmission.directory).toBe(
          bridge.original.beforeExecution.directory,
        );
      }
      expect(bridge.native.consumed.directory).toBe(bridge.current.directory);
      expect(bridge.native.written.directory).toBe(bridge.current.directory);
      expect(bridge.current.result).toBe(mode === "missing-after-write" ? "absent" : "present");
    }
    if (mode === "late-after-admission") {
      writeFileSync(
        path.join(directory, "result.json"),
        JSON.stringify({ ...input, ok: true, ownersJoined: true }),
        { mode: 0o600 },
      );
      expect(report.phaseBridge).toMatchObject({
        original: { afterAdmission: { result: "absent" } },
        current: { result: "absent" },
        sameCanonicalHome: true,
      });
      expect(existsSync(path.join(owner.evidenceDirectory, "identity-result.json"))).toBe(false);
      expect(resolveContainer).toHaveBeenCalledTimes(1);
    }
    if (mode === "attributes-unavailable") {
      expect(report.phaseBridge).toMatchObject({
        native: {
          consumed: { directory: null, home: null, bundle: null },
          written: { directory: null, home: null, bundle: null },
        },
      });
    }
    expect(JSON.stringify([report, consoleLog.mock.calls])).not.toMatch(
      /private-|Users|watch-bridge-|fixture\.bundle/,
    );
    expect(JSON.stringify(report)).not.toContain(input!.nonce);
    expect(JSON.stringify(report)).not.toContain(input!.run);
  });

  it.each(["helper", "native", "unjoined", "malformed", "stale", "missing"])(
    "preserves only bounded public diagnostics for %s failure",
    async (mode) => {
      const owner = phaseOwner();
      const directory = owner.current!.directory;
      const failure = await runWatchPhase("negative", randomUUID(), owner, async () => {
        const file = path.join(directory, "input.json");
        const input = JSON.parse(readFileSync(file, "utf8"));
        rmSync(file);
        if (mode !== "missing") {
          const errors =
            mode === "malformed"
              ? [
                  null,
                  "private-description",
                  { domain: "private-domain", code: 1 },
                  { domain: "NSURLErrorDomain", code: "private-code" },
                  { domain: "other", code: 1.5 },
                  { domain: "other", code: Number.MAX_SAFE_INTEGER + 1 },
                  { domain: "NSOSStatusErrorDomain", code: -50, description: "private-detail" },
                ]
              : Array.from({ length: 10 }, (_, index) => ({
                  domain: "NSURLErrorDomain",
                  code: -1200 - index,
                  description: "private-detail",
                }));
          writeFileSync(
            path.join(directory, "result.json"),
            JSON.stringify({
              ...input,
              nonce: mode === "stale" ? randomUUID() : input.nonce,
              ok: mode === "helper",
              ownersJoined: mode !== "unjoined",
              errors,
              token: "private-token",
              deviceID: "private-identity",
              path: "/private/fixture/result",
            }),
            { mode: 0o600 },
          );
        }
        if (mode === "helper") {
          throw new Error("private-helper-description");
        }
      }).then(
        () => {
          throw new Error("Expected phase failure");
        },
        (error: unknown) => error as AggregateError & { phaseFailure: unknown },
      );
      const unverified = ["unjoined", "stale", "missing"].includes(mode);
      expect(failure.phaseFailure).toEqual({
        phase: "negative",
        ownersJoined: !unverified,
        helperExecutionFailed: mode === "helper",
        admissionFailure:
          mode === "missing"
            ? "result-missing"
            : mode === "stale"
              ? "nonce-mismatch"
              : mode === "unjoined"
                ? "owner-acknowledgement"
                : mode === "helper"
                  ? null
                  : "native-not-ok",
        errors: ["stale", "missing"].includes(mode)
          ? []
          : mode === "malformed"
            ? [{ domain: "NSOSStatusErrorDomain", code: -50 }]
            : Array.from({ length: 8 }, (_, index) => ({
                domain: "NSURLErrorDomain",
                code: -1200 - index,
              })),
      });
      expect(hasUnjoinedWork(new AggregateError([failure], "outer phase failure"))).toBe(
        unverified,
      );
      expect(JSON.stringify(failure.phaseFailure)).not.toContain("private");
    },
  );

  it.for([
    ["run", "run-mismatch"],
    ["phase", "phase-mismatch"],
    ["nonce", "nonce-mismatch"],
    ["failed", "native-not-ok"],
    ["missing", "result-missing"],
    ["skipped", "input-consumption"],
    ["oversized", "result-invalid"],
    ["mode", "result-invalid"],
    ["json", "result-invalid"],
    ["unreadable", "result-unreadable"],
    ["unjoined", "owner-acknowledgement"],
    ["multiple", "run-mismatch"],
    ["owner and native", "owner-acknowledgement"],
  ] as const)(
    "records the first current %s admission failure despite a valid old result",
    async ([mode, admissionFailure], context) => {
      if (mode === "unreadable" && (process.platform === "win32" || process.getuid?.() === 0)) {
        context.skip();
      }
      const owner = phaseOwner();
      const oldDirectory = owner.current!.directory;
      const currentHome = tempDirs.make("watch-current-");
      const directory = path.join(currentHome, "Library", "Caches", "OpenClawQualification");
      mkdirSync(directory, { recursive: true });
      owner.resolveContainer = vi.fn(async () => currentHome);
      let failure: AggregateError & { phaseFailure: unknown };
      try {
        failure = await runWatchPhase("negative", randomUUID(), owner, async () => {
          const oldInput = path.join(oldDirectory, "input.json");
          const input = JSON.parse(readFileSync(oldInput, "utf8"));
          rmSync(oldInput);
          writeFileSync(
            path.join(oldDirectory, "result.json"),
            JSON.stringify({ ...input, ok: true, ownersJoined: true }),
            { mode: 0o600 },
          );
          const file = path.join(directory, "input.json");
          writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
          if (mode === "missing") {
            rmSync(file);
            return;
          }
          if (!["skipped", "multiple", "owner and native"].includes(mode)) {
            rmSync(file);
          }
          const result = { ...input, ok: true, ownersJoined: true };
          if (["run", "phase", "nonce"].includes(mode)) {
            result[mode] = "stale";
          }
          if (mode === "failed") {
            result.ok = false;
          }
          if (mode === "oversized") {
            result.extra = "x".repeat(16384);
          }
          if (["unjoined", "multiple", "owner and native"].includes(mode)) {
            result.ownersJoined = false;
          }
          if (["multiple", "owner and native"].includes(mode)) {
            result.ok = false;
          }
          if (mode === "multiple") {
            result.run = result.phase = result.nonce = "private-stale";
          }
          writeFileSync(
            path.join(directory, "result.json"),
            mode === "json" ? "{" : JSON.stringify(result),
            {
              mode: mode === "mode" ? 0o644 : 0o600,
            },
          );
          if (mode === "mode") {
            chmodSync(path.join(directory, "result.json"), 0o644);
          }
          if (mode === "unreadable") {
            chmodSync(directory, 0o000);
          }
        }).then(
          () => {
            throw new Error("Expected phase failure");
          },
          (error: unknown) => error as AggregateError & { phaseFailure: unknown },
        );
      } finally {
        chmodSync(directory, 0o700);
      }
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.phaseFailure).toMatchObject({
        phase: "negative",
        helperExecutionFailed: false,
        admissionFailure,
        ownersJoined: mode === "failed",
      });
      expect(hasUnjoinedWork(failure)).toBe(mode !== "failed");
      expect(owner.current).toBeNull();
      expect(owner.resolveContainer).toHaveBeenCalledTimes(1);
      if (mode === "failed") {
        expect(
          JSON.parse(
            readFileSync(path.join(owner.evidenceDirectory, "negative-result.json"), "utf8"),
          ),
        ).toMatchObject({ ok: false, ownersJoined: true });
      }
      if (mode === "owner and native") {
        expect(failure.errors).toHaveLength(2);
      }
      expect(JSON.stringify(failure.phaseFailure)).not.toMatch(/private|watch-phase-/);
    },
  );

  it.each(["missing", "nonce", "unjoined", "skipped"])(
    "keeps favorable identity console output separate from %s admission failure",
    async (mode) => {
      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const owner = phaseOwner();
        const directory = owner.current!.directory;
        const report: Record<string, unknown> = {};
        const failure = await runWatchPhase("identity", randomUUID(), owner, async () => {
          await watchProof.runWatchQualificationCommand(
            "watch-identity",
            process.execPath,
            [
              "-e",
              'console.log("\\u25c7 Suite WatchOperatorHTTPSQualificationTests started.\\n\\u25c7 Test qualification() started.\\n\\u2714 Test qualification() passed after 0.001 seconds.\\n\\u2714 Test run with 1 test in 1 suite passed after 0.001 seconds.");',
            ],
            { environment: process.env, report, save: async () => {} },
          );
          const file = path.join(directory, "input.json");
          const input = JSON.parse(readFileSync(file, "utf8"));
          if (mode !== "skipped") {
            rmSync(file);
          }
          if (mode !== "missing") {
            writeFileSync(
              path.join(directory, "result.json"),
              JSON.stringify({
                ...input,
                nonce: mode === "nonce" ? randomUUID() : input.nonce,
                ownersJoined: mode !== "unjoined",
                ok: true,
              }),
              { mode: 0o600 },
            );
          }
        }).catch((error: unknown) => error);
        expect(report.identityOutput).toMatchObject({
          reportedCount: 1,
          summaryOutcome: "passed",
          expectedQualificationPass: true,
        });
        expect(failure).toBeInstanceOf(AggregateError);
        expect(hasUnjoinedWork(failure)).toBe(true);
      } finally {
        consoleLog.mockRestore();
      }
    },
  );

  it("accepts only a consumed request and matching current result", async () => {
    const owner = phaseOwner();
    const directory = owner.current!.directory;
    const run = randomUUID();
    const result = await runWatchPhase("identity", run, owner, async () => {
      const file = path.join(directory, "input.json");
      const input = JSON.parse(readFileSync(file, "utf8"));
      rmSync(file);
      writeFileSync(
        path.join(directory, "result.json"),
        JSON.stringify({ ...input, ok: true, ownersJoined: true }),
        {
          mode: 0o600,
        },
      );
    });
    expect(result).toMatchObject({ run, phase: "identity", ok: true });
  });
});

describe("Watch voice fixture lifecycle", () => {
  it.each(["sent", "closed"])(
    "reports old hello %s and joins callbacks plus both socket owners",
    async (outcome) => {
      const fixture = createVoiceFixture({
        cert: Buffer.from(TEST_TLS_CERT_PEM),
        key: Buffer.from(TEST_TLS_KEY_PEM),
        controlToken: "control-fixture",
        oldToken: "old-fixture",
        replacementToken: "new-fixture",
        deviceID: "fixture-device",
      });
      const endpoint = await fixture.listen();
      const clients: WebSocket[] = [];
      const raw = connect(Number(new URL(endpoint).port), "127.0.0.1");
      const rawClosed = once(raw, "close");
      const control = (action: string) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          // This local fixture certificate is deliberately not a system-trust qualification.
          const request = httpsRequest(
            `${endpoint}/${action}`,
            {
              rejectUnauthorized: false,
              agent: false,
              headers: { Authorization: "Bearer control-fixture" },
            },
            (response) => {
              let text = "";
              response.on("data", (chunk) => {
                text += chunk;
              });
              response.on("end", () => {
                try {
                  assert.equal(response.statusCode, 200);
                  resolve(JSON.parse(text));
                } catch (error) {
                  reject(error instanceof Error ? error : new Error("Invalid fixture response"));
                }
              });
            },
          );
          request.on("error", reject);
          request.end();
        });
      const open = async (token: string) => {
        const socket = new WebSocket(endpoint.replace("https:", "wss:"), {
          rejectUnauthorized: false,
        });
        clients.push(socket);
        const challenge = once(socket, "message");
        await once(socket, "open");
        await challenge;
        socket.send(
          JSON.stringify({
            type: "req",
            id: randomUUID(),
            method: "connect",
            params: {
              minProtocol: 4,
              maxProtocol: 4,
              device: { id: "fixture-device" },
              role: "operator",
              scopes: ["operator.read", "operator.talk"],
              auth: { deviceToken: token },
            },
          }),
        );
        return socket;
      };
      try {
        await once(raw, "connect");
        const old = await open("old-fixture");
        expect(await control("connected")).toEqual({ oldConnectObserved: true });
        if (outcome === "closed") {
          const closed = once(old, "close");
          old.close();
          await closed;
        }
        const oldHello = outcome === "sent" ? once(old, "message") : Promise.resolve();
        expect(await control("release")).toEqual({ oldHelloOutcome: outcome });
        await oldHello;
        const fresh = await open("new-fixture");
        await once(fresh, "message");
        fresh.send(JSON.stringify({ type: "req", id: randomUUID(), method: "agents.list" }));
        expect(await control("fresh")).toEqual({ freshAuthenticated: true });
        expect(await control("status")).toEqual({
          freshAuthenticated: true,
          oldHelloOutcome: outcome,
        });
      } finally {
        const closed = clients
          .filter((client) => client.readyState !== WebSocket.CLOSED)
          .map((client) => once(client, "close"));
        await fixture.close();
        await Promise.all([rawClosed, ...closed]);
      }
    },
  );
});
