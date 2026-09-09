import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

type Command = { tool: string; args: string[] };

const workflow: { jobs: Record<string, { steps: { name?: string; run?: string }[] }> } = parse(
  readFileSync(".github/workflows/ci.yml", "utf8"),
);
const watchStep = workflow.jobs["ios-build"]?.steps.find(
  (step) => step.name === "Run focused Apple Watch operation simulator tests",
);
const qualification = parse(readFileSync(".github/workflows/ios-periphery.yml", "utf8"));
const qualificationSteps: {
  name: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}[] = qualification.jobs.scan.steps;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runWatchStep(mode = "ready", qualificationMode = false) {
  const root = tempDirs.make("openclaw-watch-workflow-");
  const bin = path.join(root, "bin");
  const temporaryRoot = path.join(root, "temporary");
  const product = path.join(root, "project derived data", "Watch Product.app");
  const testProduct = path.join(product, "PlugIns", "Watch Tests.xctest");
  mkdirSync(bin, { recursive: true });
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
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
const [tool, ...args] = process.argv.slice(2);
const root = process.env.WATCH_FIXTURE_ROOT;
const mode = process.env.WATCH_FIXTURE_MODE;
const productPath = path.join(root, "project derived data", "Watch Product.app");
const targetTempDir = path.join(root, "project intermediates", "Watch Product.build");
const generatedPath = path.join(targetTempDir, "Watch Product.app-Simulated.xcent");
const applicationID = (mode === "mixed-case-prefix" ? "SeedFix123" : "SEEDFIX123") + ".org.example.watch";
appendFileSync(path.join(root, "commands.jsonl"), JSON.stringify({ tool, args }) + "\n");
if (tool === "xcrun") {
  if (args[0] === "segedit") {
    const output = args[5];
    if (output === "-" || !path.isAbsolute(output) ||
        (statSync(path.dirname(output)).mode & 0o777) !== 0o700) {
      throw new Error("Expected a private extraction directory and real output file");
    }
    if (mode === "missing-section") process.exit(26);
    const entitlements = mode === "missing-application-id" ? {} : {
      "application-identifier": mode === "wrong-application-id" ?
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
  } else if (args[1] === "list") {
    console.log(JSON.stringify({ devices: { watch: [
      { name: "Apple Watch fixture", isAvailable: true, udid: "watch-fixture" }
    ] } }));
  } else if (args[1] === "bootstatus" && mode === "boot-failed") {
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
  if (mode === "cleanup-failed" && path.basename(input) === "entitlements.plist" &&
      path.dirname(path.dirname(input)) === process.env.TMPDIR) {
    chmodSync(process.env.TMPDIR, 0o500);
  }
  console.log(JSON.stringify(plist));
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
  for (const tool of ["xcrun", "xcodebuild", "codesign", "plutil"]) {
    const executable = path.join(bin, tool);
    writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${runner}' '${tool}' "$@"\n`);
    chmodSync(executable, 0o755);
  }
  const step = qualificationMode
    ? qualificationSteps.find(
        (entry) => entry.name === "Run focused Apple Watch operation simulator tests",
      )
    : watchStep;
  if (!step?.run) {
    throw new Error("Missing Watch simulator workflow step");
  }
  let result;
  try {
    result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", step.run], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        RUNNER_TEMP: root,
        TMPDIR: temporaryRoot,
        TMP: temporaryRoot,
        TEMP: temporaryRoot,
        WATCH_FIXTURE_ROOT: root,
        WATCH_FIXTURE_MODE: mode,
      },
    });
  } finally {
    chmodSync(temporaryRoot, 0o700);
  }
  const commands: Command[] = readFileSync(path.join(root, "commands.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return { result, commands, product, testProduct, root, temporaryRoot };
}

describe.skipIf(process.platform === "win32")("Watch simulator workflow", () => {
  it("reuses project build products and installs the exact Watch target before running its tests", () => {
    const { result, commands, product, testProduct, root, temporaryRoot } = runWatchStep();
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
    const extraction = commands.find(
      (command) => command.tool === "xcrun" && command.args[0] === "segedit",
    );
    expect(extraction?.args.slice(0, 5)).toEqual([
      "segedit",
      path.join(product, "OpenClawWatchApp"),
      "-extract",
      "__TEXT",
      "__entitlements",
    ]);
    const plistPath = extraction?.args[5];
    assert(plistPath, "Expected an extracted entitlement plist");
    expect(plistPath).not.toBe("-");
    expect(path.dirname(path.dirname(plistPath))).toBe(temporaryRoot);
    expect(commands.slice(0, installIndex).filter((command) => command.tool === "plutil")).toEqual([
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
      { tool: "plutil", args: ["-convert", "json", "-o", "-", plistPath] },
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
  });

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
    } else if (mode === "wrong-compiled-seed" || mode === "compiled-seed-case-mismatch") {
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
          command.tool === "plutil" && command.args.at(-1)?.endsWith("/entitlements.plist"),
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
      (step) => step.name === "Prove Foundation operator HTTPS against a real Gateway",
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
