import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { expectDefined } from "@openclaw/normalization-core";
import { globSync } from "tinyglobby";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  cleanupOwnedKeychain,
  createOwnedKeychain,
  probeOwnedKeychain,
} from "../../.github/actions/ios-signing-keychain/keychain.mjs";
import { collectReleaseInventory } from "../../scripts/lib/mobile-release-evidence.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { cleanupTempDirs, makeTempDir, useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { runVitestShutdownCommand } from "../helpers/vitest-shutdown-command.js";
import { commit, git, initGit, write as writeFile } from "./mobile-release-git.test-support.js";
import { registerBoundedSignalTests } from "./mobile-release-process.test-support.js";

const testNodeExecPath = resolveTestNodeExecPath();
const tempRoots = useAutoCleanupTempDirTracker(afterEach);
const joinedObservationRoots: string[] = [];
afterEach(() => cleanupTempDirs(joinedObservationRoots));

type WorkflowStep = {
  env?: Record<string, string>;
  if?: string;
  name: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

function bash(
  source: string,
  env: NodeJS.ProcessEnv,
  options: { cwd?: string; timeout?: number } = {},
) {
  return spawnSync("/bin/bash", ["-c", source], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    ...options,
  });
}

function writeExecutable(root: string, file: string, source: string, mode = 0o755): string {
  const destination = path.join(root, file);
  fs.writeFileSync(destination, source, { mode });
  return destination;
}

function writeExecutables(root: string, sources: Record<string, string>) {
  for (const [file, source] of Object.entries(sources)) {
    writeExecutable(root, file, source);
  }
  return (name: string) => path.join(root, name);
}

function signingEnv(workspace: string, runnerTemp: string, extra: NodeJS.ProcessEnv = {}) {
  return { ...process.env, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: runnerTemp, ...extra };
}

function ownedKeychain(runnerTemp: string, filename = "signing.keychain", contents?: string) {
  const root = fs.mkdtempSync(path.join(runnerTemp, "openclaw-ios-signing-keychain-"));
  const file = path.join(root, filename);
  if (contents !== undefined) {
    fs.writeFileSync(file, contents);
  }
  return { root, file };
}

function keychainFixture(workspace: string, suffix: string, partial = false) {
  const runnerTemp = tempRoots.make(`openclaw-ios-keychain-${partial ? "partial-" : ""}`);
  const environmentFile = path.join(runnerTemp, "environment");
  const stateFile = path.join(runnerTemp, "state");
  const env = signingEnv(workspace, runnerTemp, {
    GITHUB_ENV: environmentFile,
    GITHUB_STATE: stateFile,
  });
  let actionOutput = "";
  let expectedDeletion: string | undefined;
  const commands: string[][] = [];
  const argument = (args: string[], prefix: string) =>
    expectDefined(args.find((value) => value.startsWith(prefix))?.slice(prefix.length), prefix);
  const runCommand = async (
    executable: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv },
  ) => {
    commands.push(args);
    expect(executable).toBe("bundle");
    if (args.includes("create_keychain")) {
      const requestedPath = argument(args, "path:");
      expect(readText(stateFile)).toContain(`requested_path=${requestedPath}\n`);
      expect(options.env?.KEYCHAIN_PASSWORD).toMatch(/^[a-f0-9]{64}$/u);
      expect(args.join("\n")).not.toContain(options.env?.KEYCHAIN_PASSWORD);
      fs.writeFileSync(`${requestedPath}${suffix}`, `${partial ? "partial" : "owned"} keychain\n`);
      if (partial) {
        throw new Error("partial create");
      }
    } else if (args.includes("delete_keychain")) {
      const file = argument(args, "keychain_path:");
      if (expectedDeletion !== undefined) {
        expect(file).toBe(expectedDeletion);
      }
      fs.unlinkSync(file);
    } else {
      throw new Error(`Unexpected Fastlane action: ${args.join(" ")}`);
    }
    return { stderr: "", stdout: "" };
  };
  return {
    environmentFile,
    commands,
    output: () => actionOutput,
    state: () => readOutputs(stateFile),
    create: () =>
      createOwnedKeychain({
        env,
        runCommand,
        output: {
          write(value: string) {
            actionOutput += value;
            return true;
          },
        },
      }),
    cleanup: (expectedPath?: string) => {
      expectedDeletion = expectedPath;
      const state = readOutputs(stateFile);
      return cleanupOwnedKeychain({
        runCommand,
        env: {
          ...env,
          STATE_owned_root: state.owned_root,
          STATE_requested_path: state.requested_path,
          ...(partial ? {} : { STATE_resolved_path: state.resolved_path }),
        },
      });
    },
  };
}

function expectFilesExist(expected: boolean, ...files: string[]): void {
  expect(files.map((file) => [file, fs.existsSync(file)])).toEqual(
    files.map((file) => [file, expected]),
  );
}

function readOutputs(file: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function readText(...parts: string[]): string {
  return fs.readFileSync(path.join(...parts), "utf8");
}

function expectContains(value: string | undefined, ...fragments: string[]): void {
  for (const fragment of fragments) {
    expect(value).toContain(fragment);
  }
}

function stepIndex(steps: WorkflowStep[], name: string): number {
  return steps.findIndex((step) => step.name === name);
}

function releaseSteps(file: string): WorkflowStep[] {
  const workflow = parse(readText(file)) as { jobs: { release: { steps: WorkflowStep[] } } };
  return workflow.jobs.release.steps;
}

function shell(...lines: string[]): string {
  return ["#!/bin/bash", "set -euo pipefail", ...lines, ""].join("\n");
}

function adbFixture(
  options: {
    serial?: string;
    avd?: string;
    boot?: string;
    properties?: string;
    logcat?: string;
    shellFirst?: boolean;
    onlyDevices?: boolean;
  } = {},
): string {
  const serial = options.serial ?? "emulator-5554";
  const devices = serial ? `${serial}\\tdevice product:sdk model:sdk\\n` : "\\n";
  const emu = [
    '"${1:-}" == "-s" && "${3:-}" == "emu"',
    options.avd ? `printf '${options.avd}\\nOK\\n'` : "printf '%s\\nOK\\n' \"${AVD_NAME:?}\"",
  ];
  const properties = [
    '"${1:-}" == "-s" && "${3:-}" == "shell"',
    options.properties ?? "printf '1\\n'",
  ];
  const branches = options.onlyDevices
    ? []
    : [
        ...(options.shellFirst ? [properties, emu] : [emu]),
        ...(options.boot
          ? [
              [
                '"${1:-}" == "-s" && "${3:-}" == "shell" && "${5:-}" == "sys.boot_completed"',
                options.boot,
              ],
            ]
          : []),
        ...(options.shellFirst ? [] : [properties]),
        ...(options.logcat ? [['"${1:-}" == "-s" && "${3:-}" == "logcat"', options.logcat]] : []),
      ];
  return shell(
    'if [[ "${1:-}" == "devices" ]]; then',
    `  printf 'List of devices attached\\n${devices}'`,
    ...branches.flatMap(([condition, body]) => [`elif [[ ${condition} ]]; then`, `  ${body}`]),
    "fi",
  );
}

function evaluateWorkflowExpression(expression: string, context: Record<string, unknown>): unknown {
  return runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/gu, ""), context);
}

function releaseArtifactFiles(workflowFile: string, artifactPrefix: string, runnerTemp: string) {
  const upload = releaseSteps(workflowFile).find(
    (step) =>
      step.uses?.startsWith("actions/upload-artifact@") &&
      typeof step.with?.name === "string" &&
      step.with.name.startsWith(artifactPrefix),
  );
  if (typeof upload?.with?.path !== "string" || !upload.with.path) {
    throw new Error(`Missing ${artifactPrefix} upload in ${workflowFile}`);
  }
  expect(
    evaluateWorkflowExpression(upload.if ?? "success()", {
      always: () => true,
      success: () => false,
      failure: () => true,
      cancelled: () => false,
      github: { event_name: "workflow_dispatch" },
      inputs: { operation: "release" },
    }),
  ).toBe(true);
  const patterns = upload.with.path
    .trim()
    .split(/\r?\n/u)
    .map((pattern) => pattern.replaceAll("${{ runner.temp }}", runnerTemp));
  return globSync(patterns, { cwd: runnerTemp, dot: true }).toSorted();
}

describe("mobile release CI tools", () => {
  const releasePlatforms = [
    {
      platform: "ios",
      workflow: ".github/workflows/ios-store-release.yml",
      buildDirectory: "app-store",
      binaries: ["OpenClaw.ipa", "OpenClaw.ipa.sha256"],
    },
    {
      platform: "android",
      workflow: ".github/workflows/android-store-release.yml",
      buildDirectory: "release-artifacts",
      binaries: ["OpenClaw-phone.aab", "OpenClaw-wear.aab", "OpenClaw.apk", "OpenClaw.aab.sha256"],
    },
  ];
  describe.each(releasePlatforms)(
    "$platform release artifact recovery",
    ({ platform, workflow }) => {
      it("checks out and verifies the dispatch commit before accessing signing credentials", () => {
        const steps = releaseSteps(workflow);
        expect(steps[0]).toMatchObject({
          uses: expect.stringMatching(/^actions\/checkout@/u),
          with: { ref: "${{ github.sha }}", "fetch-depth": platform === "android" ? 1 : 0 },
        });
        const verification = expectDefined(steps[1]?.run, "Release checkout verification");
        const root = tempRoots.make("openclaw-release-dispatch-");
        initGit(root, { name: "Release Fixture", email: "release@example.invalid" });
        writeFile(root, "README.md", "Synthetic release source\n");
        const sha = commit(root, "Initial source");
        git(root, "checkout", "--detach", sha);
        const verify = (expectedSha: string) =>
          spawnSync("bash", ["-c", verification], {
            cwd: root,
            env: { ...process.env, GITHUB_SHA: expectedSha },
            encoding: "utf8",
          });
        expect(verify(sha).status).toBe(0);
        expect(verify("0".repeat(40)).status).toBe(1);
      });
    },
  );

  it("retains Android release evidence and ancestry without unrelated branch history", () => {
    const root = tempRoots.make("openclaw-android-release-history-");
    const remote = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    const checkout = path.join(root, "checkout");
    initGit(seed, { name: "Release Fixture", email: "release@example.invalid" });
    const phoneFile = "apps/android/app/src/main/Chat.kt";
    const wearFile = "apps/android/wear/src/main/Notifications.kt";
    writeFile(seed, phoneFile, "initial phone\n");
    writeFile(seed, wearFile, "initial watch\n");
    const phoneBaseline = commit(seed, "Initial release");
    writeFile(seed, phoneFile, "phone chat\n");
    commit(seed, "Improve phone chat");
    writeFile(seed, wearFile, "watch notifications\n");
    const source = commit(seed, "Improve watch notifications");
    writeFile(seed, "README.md", "Main advanced while queued\n");
    const currentMain = commit(seed, "Advance main");
    git(seed, "checkout", "-b", "wear-public", phoneBaseline);
    writeFile(seed, wearFile, "older public watch\n");
    const wearBaseline = commit(seed, "Public watch correction");
    git(seed, "checkout", "-b", "unrelated", phoneBaseline);
    writeFile(seed, "unrelated.txt", "Not needed by this release\n");
    const unrelated = commit(seed, "Unrelated branch");
    git(seed, "tag", "unrelated-tag");
    git(root, "clone", "--bare", seed, remote);
    git(remote, "config", "uploadpack.allowFilter", "true");
    const baselines = [
      { sha: phoneBaseline, ref: "refs/openclaw/mobile-releases/android/2026.10.70-1" },
      { sha: wearBaseline, ref: "refs/openclaw/mobile-releases/android/2026.10.70-2" },
    ];
    for (const { sha, ref } of baselines) {
      git(remote, "update-ref", ref, sha);
    }
    initGit(checkout, { name: "Release Fixture", email: "release@example.invalid" });
    git(checkout, "remote", "add", "origin", pathToFileURL(remote).href);
    git(checkout, "fetch", "--no-tags", "--depth=1", "origin", source);
    git(checkout, "checkout", "--detach", source);
    const steps = releaseSteps(".github/workflows/android-store-release.yml");
    const history = expectDefined(
      steps[stepIndex(steps, "Fetch release source history")]?.run,
      "Android release history step",
    );
    const fetched = bash(history, { GITHUB_SHA: source }, { cwd: checkout });
    expect(fetched.status, fetched.stderr).toBe(0);
    expect(git(checkout, "rev-parse", "--is-shallow-repository")).toBe("false");
    expect(git(checkout, "for-each-ref", "--format=%(refname)")).toBe("refs/remotes/origin/main");
    expect(git(checkout, "rev-parse", "origin/main")).toBe(source);
    expect(
      git(checkout, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)"),
    ).not.toContain(unrelated);
    git(checkout, "fetch", "--no-tags", "origin", "refs/heads/main");
    expect(git(checkout, "rev-parse", "FETCH_HEAD")).toBe(currentMain);
    expect(git(checkout, "rev-parse", "origin/main")).toBe(currentMain);
    git(checkout, "merge-base", "--is-ancestor", source, currentMain);
    const staged = path.join(root, "staged");
    git(checkout, "worktree", "add", "--detach", staged, source);
    for (const { sha, ref } of baselines) {
      git(staged, "fetch", "--no-tags", "origin", ref);
      expect(git(staged, "rev-parse", "FETCH_HEAD")).toBe(sha);
      const options = {
        platform: "android" as const,
        baseline: sha,
        source,
        deadline: Date.now() + 30_000,
      };
      const expected = collectReleaseInventory({ ...options, rootDir: seed });
      expect(expected.commits).toEqual(["Improve watch notifications", "Improve phone chat"]);
      expect(collectReleaseInventory({ ...options, rootDir: staged })).toEqual(expected);
    }
    expect(git(staged, "rev-parse", "HEAD")).toBe(source);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(source);
    expect(git(staged, "status", "--porcelain")).toBe("");
  });

  it.each([
    ...releasePlatforms.flatMap(({ platform, workflow, buildDirectory, binaries }) =>
      ["collected", "interrupted"].map((state) => {
        const recovery = `${platform}-release-recovery`;
        const build = `${recovery}/source/apps/${platform}/build`;
        const directory =
          state === "collected" ? `${recovery}/artifacts` : `${build}/${buildDirectory}`;
        const selections = [
          {
            prefix: `${platform}-release-artifacts-`,
            expected: binaries.map((file) => `${directory}/${file}`),
            excluded: [
              `${build}/release-signing/upload.jks`,
              `${build}/release-signing/AuthKey.p8`,
              `${build}/release-signing/${binaries[0]}`,
              `${directory}/credentials.json`,
              `${directory}/.env`,
              `${directory}/nested/${binaries[0]}`,
              `${build}/SnapshotLogs/xcodebuild.log`,
              `${build}/SnapshotTestResults/result.xcresult/Info.plist`,
            ],
          },
        ];
        if (platform === "android") {
          selections.push({
            prefix: "android-release-recovery-",
            expected: ["android-plan.json", "release-notes.json", "firebase-result.json"].map(
              (file) => `${recovery}/${file}`,
            ),
            excluded: [`${recovery}/credentials.json`],
          });
        }
        return { name: `${platform} signed artifacts (${state})`, workflow, selections };
      }),
    ),
    ...["collected", "interrupted"].map((state) => {
      const source = "ios-release-recovery/source/apps/ios";
      const collected = "ios-release-recovery/screenshot-diagnostics";
      const screenshots =
        state === "collected" ? `${collected}/screenshots` : `${source}/fastlane/screenshots/en-US`;
      const results = state === "collected" ? collected : `${source}/build/SnapshotTestResults`;
      const resources = state === "collected" ? collected : `${source}/build`;
      return {
        name: `iOS screenshot diagnostics (${state})`,
        workflow: ".github/workflows/ios-store-release.yml",
        selections: [
          {
            prefix: "ios-release-screenshot-diagnostics-",
            expected: [
              `${screenshots}/01-chat.png`,
              `${results}/capture-attempts.json`,
              `${resources}/screenshot-diagnostics.json`,
              "ios-resource-timeline.jsonl",
            ],
            excluded: [
              `${screenshots}/capture.log`,
              `${screenshots}/nested/private.png`,
              `${results}/pairing.json`,
              `${results}/result.xcresult/Info.plist`,
              `${collected}/SnapshotLogs/xcodebuild.log`,
              `${source}/build/SnapshotLogs/xcodebuild.log`,
              `${source}/build/release-signing/AuthKey.p8`,
              `${source}/fastlane/.env`,
              `${resources}/private-diagnostics.json`,
              `${resources}/nested/screenshot-diagnostics.json`,
              "private-resource-timeline.jsonl",
            ],
          },
        ],
      };
    }),
    {
      name: "Android screenshot diagnostics after a capture failure",
      workflow: ".github/workflows/android-store-release.yml",
      selections: [
        {
          prefix: "android-release-emulator-diagnostics-",
          expected: ["phone", "wear"].flatMap((formFactor) =>
            [
              "emulator.log",
              "emulator-args.txt",
              "process-status.txt",
              "ui-dumps/openclaw-settings.xml",
              "activity-start/openclaw-settings.txt",
              "diagnostics/host-resources.log",
              "diagnostics/phases.log",
              "diagnostics/last-anr.txt",
              "diagnostics/system-events.log",
            ].map(
              (file) =>
                `android-release-recovery/source/.artifacts/android-screenshots/latest/${formFactor}/${file}`,
            ),
          ),
          excluded: [
            ...[
              "phone/logcat.txt",
              "wear/ui-dumps/private.xml",
              "phone/activity-start/private.txt",
              "phone/ui-dumps/nested/openclaw-settings.xml",
            ].map(
              (file) =>
                `android-release-recovery/source/.artifacts/android-screenshots/latest/${file}`,
            ),
            "android-release-recovery/source/apps/android/build/release-signing/google-play.json",
          ],
        },
      ],
    },
  ])("uploads only allowed $name", ({ workflow, selections }) => {
    const runnerTemp = tempRoots.make("openclaw-release-artifact-selection-");
    for (const { prefix, expected, excluded } of selections) {
      for (const file of expected) {
        writeFile(runnerTemp, file, "synthetic safe release artifact");
      }
      for (const file of excluded) {
        writeFile(runnerTemp, file, "synthetic excluded data");
      }
      expect(releaseArtifactFiles(workflow, prefix, runnerTemp)).toEqual(expected.toSorted());
    }
  });

  it("keeps the Android emulator diagnostic manual, exact-SHA-bound, and secretless", async () => {
    const source = readText(".github/workflows/android-emulator-diagnostic.yml");
    type DiagnosticJob = {
      env?: Record<string, string>;
      needs?: string;
      permissions: Record<string, string>;
      "runs-on": string;
      steps: WorkflowStep[];
      "timeout-minutes": string | number;
    };
    const workflow = parse(source) as {
      jobs: { "validate-target": DiagnosticJob; diagnose: DiagnosticJob };
      on: { workflow_dispatch: { inputs: { operation: { default: string; options: string[] } } } };
      permissions: Record<string, string>;
    };
    const validationJob = workflow.jobs["validate-target"];
    const job = workflow.jobs.diagnose;
    const steps = job.steps;
    const stepsFor = (operation: string) =>
      steps.filter(
        (step) =>
          !step.if ||
          evaluateWorkflowExpression(step.if, {
            inputs: { operation },
            always: () => true,
          }),
      );
    const findStep = (operation: string, name: string) =>
      expectDefined(
        stepsFor(operation).find((step) => step.name === name),
        name,
      );
    const [validate, validationTrustedCheckout, checkout, head, parity] = validationJob.steps;
    const trustedCheckout = findStep("boot", "Checkout trusted Android tooling");
    const setup = findStep("boot", "Setup Android toolchain");
    const kvm = findStep("boot", "Collect Linux KVM acceleration proof");
    const diagnosticStep = findStep("boot", "Run phone emulator diagnostic");
    const artifact = findStep("boot", "Upload Android emulator diagnostic");
    const screenshotCheckout = findStep("screenshots", "Checkout screenshot source");
    const screenshotHead = findStep("screenshots", "Verify screenshot source");
    const screenshotNode = findStep("screenshots", "Setup screenshot Node environment");
    const screenshots = findStep("screenshots", "Capture phone and Wear screenshots");
    const screenshotArtifact = findStep("screenshots", "Upload screenshot diagnostics");

    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.on.workflow_dispatch.inputs.operation).toMatchObject({
      default: "boot",
      options: ["boot", "screenshots"],
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const activeJob of [validationJob, job]) {
      expect(activeJob.permissions).toEqual({ contents: "read" });
      expect(activeJob["runs-on"]).toBe("ubuntu-24.04");
    }
    expect(job.needs).toBe("validate-target");
    for (const [operation, timeout] of [
      ["boot", 25],
      ["screenshots", 40],
    ] as const) {
      expect(
        evaluateWorkflowExpression(String(job["timeout-minutes"]), { inputs: { operation } }),
      ).toBe(timeout);
    }
    expect(job.env).toEqual({
      ANDROID_SCREENSHOT_EMULATOR_TIMEOUT_SECONDS: "180",
      AVD_NAME: "OpenClaw_Screenshots_API36",
      DEVICE_PROFILE: "pixel_2",
      SYSTEM_IMAGE: "system-images;android-36;google_apis;x86_64",
    });
    expect(validate?.env).toEqual({ TARGET_SHA: "${{ inputs.target_sha }}" });
    expect(validate?.run).toContain('[[ ! "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]');
    for (const sourceCheckout of [validationTrustedCheckout, trustedCheckout, screenshotCheckout]) {
      expect(sourceCheckout?.with).toMatchObject({
        ref: "${{ github.workflow_sha }}",
        "persist-credentials": false,
      });
    }
    expect(checkout?.with).toMatchObject({
      ref: "${{ inputs.target_sha }}",
      "persist-credentials": false,
      path: "candidate",
    });
    expect(head?.env).toEqual({ TARGET_SHA: "${{ inputs.target_sha }}" });
    expect(head?.run).toContain('test "$(git -C candidate rev-parse HEAD)" = "$TARGET_SHA"');
    expect(screenshotHead.env).toEqual({ TARGET_SHA: "${{ inputs.target_sha }}" });
    const screenshotSteps = stepsFor("screenshots");
    expect(screenshotSteps.indexOf(screenshotHead)).toBeLessThan(
      screenshotSteps.indexOf(screenshotNode),
    );
    expect(screenshotSteps).not.toContain(diagnosticStep);
    expect(stepsFor("boot")).not.toContain(screenshots);
    for (const [targetSha, status] of [
      [git(process.cwd(), "rev-parse", "HEAD"), 0],
      ["0".repeat(40), 1],
    ] as const) {
      expect(
        bash(expectDefined(screenshotHead.run, "screenshot source verification"), {
          TARGET_SHA: targetSha,
        }).status,
      ).toBe(status);
    }
    expect(screenshotNode.with).toMatchObject({ "cache-mode": "off" });
    expect(screenshots).toMatchObject({
      env: {
        ANDROID_SCREENSHOT_DIAGNOSTICS: "1",
        SIPS: "${{ runner.temp }}/openclaw-android-tools/android-sips-linux.sh",
      },
      run: "bash scripts/android-screenshots.sh",
    });
    expect(screenshotArtifact.with).toMatchObject({ "retention-days": 7 });
    expect(setup).toMatchObject({
      uses: "./.mobile-release-tooling/.github/actions/setup-android-toolchain",
      with: { "cache-mode": "off", "install-screenshot-emulators": "true" },
    });
    expect(JSON.stringify(steps)).not.toContain("candidate/");

    const toolchainAction = parse(
      readText(".github/actions/setup-android-toolchain/action.yml"),
    ) as { runs: { steps: Array<{ name: string; run?: string }> } };
    const kvmSetup = toolchainAction.runs.steps.find(
      (step) => step.name === "Configure Linux KVM acceleration",
    )?.run;
    if (!kvmSetup) {
      throw new Error("Android toolchain action is missing its KVM setup");
    }

    const runKvmFixture = (emulatorSource: string, timeoutMode = "run") => {
      const root = tempRoots.make("openclaw-android-kvm-");
      const bin = path.join(root, "bin");
      const output = path.join(root, "android-emulator-kvm-check.txt");
      const sentinel = path.join(root, "sentinel");
      const rule = path.join(root, "kvm.rules");
      const udevTrace = path.join(root, "udev.trace");
      fs.mkdirSync(bin);
      const executable = writeExecutables(bin, {
        timeout: shell(
          'if [[ "${KVM_TIMEOUT_MODE:-run}" == "timeout" ]]; then exit 124; fi',
          "shift 3",
          'exec "$@"',
        ),
        sudo: '#!/bin/bash\nexec "$@"\n',
        udevadm: '#!/bin/bash\nprintf "%s\\n" "$*" >>"$KVM_UDEV_TRACE"\n',
        stat: '#!/bin/bash\nprintf "%s:kvm:660\\n" "$(/usr/bin/id -u)"\n',
        emulator: emulatorSource,
      });
      // The real action runs unchanged except for host-only paths and privileged tool boundaries.
      const body = kvmSetup
        .replaceAll("/usr/bin/timeout", executable("timeout"))
        .replaceAll("/usr/bin/sudo", executable("sudo"))
        .replaceAll("/usr/bin/udevadm", executable("udevadm"))
        .replaceAll("/usr/bin/stat", executable("stat"))
        .replaceAll("/etc/udev/rules.d/99-openclaw-android-kvm.rules", rule)
        .replaceAll("/dev/kvm", "/dev/null");
      const result = bash(
        [body, 'printf "boot-or-signing\\n" >"$KVM_SENTINEL"'].join("\n"),
        {
          KVM_SENTINEL: sentinel,
          KVM_TIMEOUT_MODE: timeoutMode,
          KVM_UDEV_TRACE: udevTrace,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          RUNNER_OS: "Linux",
          RUNNER_ARCH: "X64",
          RUNNER_TEMP: root,
        },
        { timeout: 5_000 },
      );
      return { output: readText(output), result, root, rule, sentinel, udevTrace };
    };

    const usableKvm = runKvmFixture(
      "#!/bin/bash\nprintf 'KVM (version 12) is installed and usable.\\n'\n",
    );
    expect(usableKvm.result.status, usableKvm.result.stderr).toBe(0);
    expect(readText(usableKvm.sentinel)).toBe("boot-or-signing\n");
    expect(readText(usableKvm.rule)).toBe(
      `SUBSYSTEM=="misc", KERNEL=="kvm", OWNER="${process.getuid?.()}", GROUP="kvm", MODE="0660"\n`,
    );
    expect(readText(usableKvm.udevTrace).trim().split("\n")).toEqual([
      "control --reload-rules",
      "trigger --action=change --subsystem-match=misc --sysname-match=kvm",
      "settle --timeout=15",
    ]);
    const kvmDiagnosticDir = path.join(usableKvm.root, "diagnostic");
    fs.mkdirSync(kvmDiagnosticDir);
    expect(kvm?.if).toBe("always()");
    const collectKvm = bash(kvm?.run ?? "", {
      RUNNER_TEMP: usableKvm.root,
      DIAGNOSTIC_DIR: kvmDiagnosticDir,
    });
    expect(collectKvm.status, collectKvm.stderr).toBe(0);
    expect(readText(kvmDiagnosticDir, "emulator-kvm-check.txt")).toBe(usableKvm.output);

    const unavailableKvm = runKvmFixture(
      "#!/bin/bash\nprintf 'acceleration unavailable\\n'\nexit 7\n",
    );
    expect(unavailableKvm.result.status).not.toBe(0);
    expect(unavailableKvm.output).toContain("exit_status=7");
    expect(fs.existsSync(unavailableKvm.sentinel)).toBe(false);

    const unconfirmedKvm = runKvmFixture("#!/bin/bash\nprintf 'unknown acceleration\\n'\n");
    expect(unconfirmedKvm.result.status).not.toBe(0);
    expect(unconfirmedKvm.result.stdout).toContain("did not confirm usable KVM acceleration");
    expect(fs.existsSync(unconfirmedKvm.sentinel)).toBe(false);

    const timedOutKvm = runKvmFixture("#!/bin/bash\nexit 99\n", "timeout");
    expect(timedOutKvm.result.status).not.toBe(0);
    expectContains(timedOutKvm.output, "exit_status=124", "timed_out=true");
    expect(fs.existsSync(timedOutKvm.sentinel)).toBe(false);

    const parityScript = parity?.run ?? "";

    const actionPath = ".github/actions/setup-android-toolchain/action.yml";
    const trustedAction = "name: fixture\nruns:\n  using: composite\n  steps: []\n";
    const runParityGate = (candidate: "matching" | "modified" | "symlink") => {
      const root = tempRoots.make("openclaw-android-emulator-diagnostic-parity-");
      const trusted = path.join(root, ".mobile-release-tooling");
      const target = path.join(root, "candidate");
      const runnerTemp = path.join(root, "runner-temp");
      const sentinel = path.join(root, "setup-ran");
      fs.mkdirSync(runnerTemp);
      for (const repository of [trusted, target]) {
        initGit(repository, { name: "OpenClaw Test", email: "test@openclaw.invalid" });
      }
      writeFile(trusted, actionPath, trustedAction);
      if (candidate === "symlink") {
        const candidatePath = path.join(target, actionPath);
        fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
        fs.symlinkSync(path.join(trusted, actionPath), candidatePath);
      } else {
        writeFile(
          target,
          actionPath,
          candidate === "matching"
            ? trustedAction
            : trustedAction.replace("fixture", "substituted"),
        );
      }
      commit(trusted, "trusted action");
      commit(target, "candidate action");

      const result = bash(
        `${parityScript}\nprintf 'setup\\n' >"$SETUP_SENTINEL"\n`,
        {
          RUNNER_TEMP: runnerTemp,
          SETUP_SENTINEL: sentinel,
        },
        { cwd: root },
      );
      return { result, sentinel };
    };

    const matching = runParityGate("matching");
    expect(matching.result.status, matching.result.stderr).toBe(0);
    expect(readText(matching.sentinel)).toBe("setup\n");
    for (const candidate of ["modified", "symlink"] as const) {
      const rejected = runParityGate(candidate);
      expect(rejected.result.status).not.toBe(0);
      expect(fs.existsSync(rejected.sentinel)).toBe(false);
    }

    const diagnostic = expectDefined(diagnosticStep.run, "boot diagnostic script");
    expect(diagnostic).toContain("final_cold_boot_observation_seconds=900");
    const accelFunctionStart = diagnostic.indexOf("capture_accel_check() {");
    const accelFunctionEnd = diagnostic.indexOf("\n\nsample_owned_qemu()", accelFunctionStart);
    const accelFunction = diagnostic
      .slice(accelFunctionStart, accelFunctionEnd)
      .replace("accel_check_timeout_seconds=10", "accel_check_timeout_seconds=3");
    const runAccelCheck = (emulatorSource: string) => {
      const root = tempRoots.make("openclaw-android-emulator-accel-check-");
      const bin = path.join(root, "bin");
      const diagnosticDir = path.join(root, "diagnostic");
      fs.mkdirSync(bin);
      fs.mkdirSync(diagnosticDir);
      writeExecutable(bin, "emulator", emulatorSource);
      const result = bash(
        `set -euo pipefail\n${accelFunction}\ncapture_accel_check\n`,
        {
          DIAGNOSTIC_DIR: diagnosticDir,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        { timeout: 7_000 },
      );
      return {
        output: readText(diagnosticDir, "emulator-accel-check.txt"),
        result,
      };
    };

    const nonzeroAccel = runAccelCheck("#!/bin/bash\nprintf 'unavailable\\n'\nexit 7\n");
    expect(nonzeroAccel.result.status, nonzeroAccel.result.stderr).toBe(0);
    expectContains(nonzeroAccel.output, "unavailable", "exit_status=7", "timed_out=false");

    const timedOutAccel = runAccelCheck("#!/bin/bash\nexec sleep 30\n");
    expect(timedOutAccel.result.status, timedOutAccel.result.stderr).toBe(0);
    expectContains(timedOutAccel.output, "exit_status=124", "timed_out=true");

    const observationFunctionStart = diagnostic.indexOf("run_bounded_probe() {");
    const cleanupFunctionStart = diagnostic.indexOf("cleanup() {");
    const observationFunctions = diagnostic
      .slice(observationFunctionStart, cleanupFunctionStart)
      .replace("observation_poll_seconds=2", "observation_poll_seconds=1")
      .replace("final_snapshot_lead_seconds=15", "final_snapshot_lead_seconds=4")
      .replace("snapshot_properties_max_bytes=65536", "snapshot_properties_max_bytes=64")
      .replace("snapshot_logcat_max_bytes=262144", "snapshot_logcat_max_bytes=128");
    const runPostDeadlineObservation = async (
      adbSource: string,
      options: {
        deadlineSeconds?: number;
        functions?: string;
        initialSerial?: string;
        preObservationDelaySeconds?: number;
      } = {},
    ) => {
      const root = makeTempDir([], "openclaw-android-emulator-post-deadline-");
      const bin = path.join(root, "bin");
      const diagnosticDir = path.join(root, "diagnostic");
      const clockPath = path.join(root, "observation-clock.txt");
      const deadlineSeconds = options.deadlineSeconds ?? 12;
      const functions = options.functions ?? observationFunctions;
      const preObservationDelaySeconds = options.preObservationDelaySeconds ?? 0;
      fs.mkdirSync(bin);
      fs.mkdirSync(diagnosticDir);
      writeExecutable(bin, "adb", adbSource);
      const startedAt = Date.now();
      const result = await runVitestShutdownCommand({
        bin: "/bin/bash",
        args: [
          "-c",
          [
            "set -euo pipefail",
            // Observation waits use a clock; the timeout and cleanup probes below use real time.
            "unset SECONDS",
            "SECONDS=0",
            "sleep() {",
            '  if [[ -n "${probe_pid:-}" ]]; then',
            // Join the short-lived adb fixture without racing its output or exit status.
            '    wait "$probe_pid" 2>/dev/null || :',
            "  else",
            "    SECONDS=$((SECONDS + $1))",
            "  fi",
            "}",
            `trap 'printf "%s\\n" "$SECONDS" >"$OBSERVATION_CLOCK_FILE"' EXIT`,
            "sample_owned_qemu() { :; }",
            functions,
            "readiness_failure_latched=0",
            "emulator_pid=$$",
            "final_cold_boot_observation_seconds=900",
            `emulator_observation_deadline=$((SECONDS + ${deadlineSeconds}))`,
            'export AVD_NAME="OpenClaw_Screenshots_API36"',
            `sleep ${preObservationDelaySeconds}`,
            'fail_after_readiness_timeout "latched readiness failure" "${INITIAL_SERIAL:-}"',
          ].join("\n"),
        ],
        env: {
          ...process.env,
          DIAGNOSTIC_DIR: diagnosticDir,
          INITIAL_SERIAL: options.initialSerial ?? "",
          OBSERVATION_CLOCK_FILE: clockPath,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        timeoutMs: 20_000,
        maxBytes: 1024 * 1024,
      }).catch((error: unknown) => {
        throw new Error(`Android observation failed; fixture retained at ${root}`, {
          cause: error,
        });
      });
      // A rejected managed join leaves this root outside automatic cleanup.
      joinedObservationRoots.push(root);
      const snapshotsRoot = path.join(diagnosticDir, "cold-boot-snapshots");
      return {
        durationMs: Date.now() - startedAt,
        elapsedSeconds: Number(readText(clockPath).trim()),
        observations: readText(diagnosticDir, "post-deadline-observations.log"),
        result: { ...result, status: result.code },
        snapshots: fs.existsSync(snapshotsRoot) ? fs.readdirSync(snapshotsRoot).toSorted() : [],
        snapshotsRoot,
      };
    };

    const lateReadyNearCeilingFunctions = observationFunctions.replace(
      "final_snapshot_lead_seconds=4",
      "final_snapshot_lead_seconds=60",
    );
    const lateReady = await runPostDeadlineObservation(adbFixture({ shellFirst: true }), {
      functions: lateReadyNearCeilingFunctions,
    });
    expect(lateReady.result.status).toBe(1);
    expect(lateReady.result.stderr).toContain("::error::latched readiness failure");
    expectContains(
      lateReady.observations,
      "late_adb_online_at=",
      "late_boot_completed_at=",
      "observation_stop=late-boot-completed",
    );
    expect(lateReady.snapshots).toEqual(["first-online"]);
    expect(readText(lateReady.snapshotsRoot, "first-online", "boot-properties.txt")).toContain(
      "probe_exit_status=0",
    );

    const [failedBootProbeResult, boundedSnapshotsResult] = await Promise.allSettled([
      runPostDeadlineObservation(
        adbFixture({
          boot: "exit 7",
          properties: "printf '[init.svc.example]: [running]\\n'",
          logcat: "printf 'system crash evidence line\\n'",
        }),
        { functions: lateReadyNearCeilingFunctions },
      ),
      runPostDeadlineObservation(
        adbFixture({
          boot: "printf '\\n'",
          properties: "for _ in {1..40}; do printf '[init.svc.example]: [running]\\n'; done",
          logcat: "for _ in {1..40}; do printf 'system crash evidence line\\n'; done",
        }),
      ),
    ]);
    if (
      failedBootProbeResult.status === "rejected" ||
      boundedSnapshotsResult.status === "rejected"
    ) {
      throw new AggregateError(
        [failedBootProbeResult, boundedSnapshotsResult].flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        ),
        "Android observation scenarios failed",
      );
    }
    const failedBootProbeNearCeiling = failedBootProbeResult.value;
    const boundedSnapshots = boundedSnapshotsResult.value;
    expect(failedBootProbeNearCeiling.result.status).toBe(1);
    expect(failedBootProbeNearCeiling.elapsedSeconds).toBe(12);
    expect(failedBootProbeNearCeiling.observations).toContain("boot_status=7");
    expect(failedBootProbeNearCeiling.snapshots).toEqual(["first-online", "near-ceiling"]);

    const unrelatedDevice = await runPostDeadlineObservation(adbFixture({ avd: "Another_AVD" }));
    expect(unrelatedDevice.result.status).toBe(1);
    expect(unrelatedDevice.observations).toContain("observation_stop=unexpected-avd");
    expect(unrelatedDevice.observations).not.toContain("late_adb_online_at=");
    expect(unrelatedDevice.observations).not.toContain("late_boot_completed_at=");
    expect(unrelatedDevice.snapshots).toEqual([]);

    const changedDevice = await runPostDeadlineObservation(
      adbFixture({ serial: "emulator-5556", onlyDevices: true }),
      { initialSerial: "emulator-5554" },
    );
    expect(changedDevice.result.status).toBe(1);
    expect(changedDevice.observations).toContain("observation_stop=unexpected-device-change");
    expect(changedDevice.snapshots).toEqual([]);

    const absoluteCap = await runPostDeadlineObservation(
      adbFixture({ serial: "", onlyDevices: true }),
      { deadlineSeconds: 3, preObservationDelaySeconds: 2 },
    );
    expect(absoluteCap.result.status).toBe(1);
    expect(absoluteCap.elapsedSeconds).toBe(3);
    expect(absoluteCap.result.stderr).toContain("::error::latched readiness failure");
    expect(absoluteCap.observations).toContain("observation_cap_seconds=900");
    expect(absoluteCap.durationMs).toBeLessThan(5_000);
    expect(absoluteCap.observations).toContain("observation_stop=observation-cap-reached");

    expect(boundedSnapshots.result.status).toBe(1);
    expect(boundedSnapshots.elapsedSeconds).toBe(12);
    expect(boundedSnapshots.observations).toContain("observation_stop=observation-cap-reached");
    expect(boundedSnapshots.snapshots).toEqual(["first-online", "near-ceiling"]);
    for (const snapshot of boundedSnapshots.snapshots) {
      const properties = readText(boundedSnapshots.snapshotsRoot, snapshot, "boot-properties.txt");
      const logcat = readText(boundedSnapshots.snapshotsRoot, snapshot, "system-crash-logcat.txt");
      expectContains(properties, "output_truncated=true", "retained_bytes=64");
      expectContains(logcat, "output_truncated=true", "retained_bytes=128");
    }

    const probeFunctionEnd = observationFunctions.indexOf("\n\nobserve_after_readiness_timeout()");
    const probeFunction = observationFunctions.slice(0, probeFunctionEnd);
    const fastProbeStartedAt = Date.now();
    const fastProbe = bash(
      [
        "set -euo pipefail",
        probeFunction,
        'run_bounded_probe "$PROBE_OUTPUT" "$((SECONDS + 10))" /usr/bin/true',
        'printf "status=%s timed_out=%s\\n" "$probe_status" "$probe_timed_out"',
      ].join("\n"),
      {
        PROBE_OUTPUT: path.join(tempRoots.make("openclaw-android-probe-fast-"), "probe.txt"),
      },
      { timeout: 2_000 },
    );
    expect(fastProbe.status, fastProbe.stderr).toBe(0);
    expect(fastProbe.stdout).toBe("status=0 timed_out=false\n");
    expect(Date.now() - fastProbeStartedAt).toBeLessThan(2_000);

    const probeTimeoutRoot = tempRoots.make("openclaw-android-probe-timeout-");
    const probePidFile = path.join(probeTimeoutRoot, "probe.pid");
    const probeTimeout = bash(
      [
        "set -euo pipefail",
        "unset SECONDS",
        "SECONDS=0",
        'mkfifo "$PROBE_READY_FILE"',
        'exec 3<>"$PROBE_READY_FILE"',
        // Expire only after the child has installed its TERM trap and recorded its PID.
        "sleep() {",
        "  read -r ready <&3",
        '  [[ "$ready" == ready ]]',
        "  SECONDS=1",
        "}",
        probeFunction,
        'run_bounded_probe "$PROBE_OUTPUT" "$((SECONDS + 1))" /bin/bash -c ' +
          '\'trap "" TERM; printf "%s\\n" "$$" >"$PROBE_PID_FILE"; printf "ready\\n" >&3; exec sleep 30\'',
        'printf "status=%s timed_out=%s\\n" "$probe_status" "$probe_timed_out"',
      ].join("\n"),
      {
        PROBE_OUTPUT: path.join(probeTimeoutRoot, "probe.txt"),
        PROBE_PID_FILE: probePidFile,
        PROBE_READY_FILE: path.join(probeTimeoutRoot, "probe.ready"),
      },
      { timeout: 5_000 },
    );
    expect(probeTimeout.status, probeTimeout.stderr).toBe(0);
    expect(probeTimeout.stdout).toBe("status=124 timed_out=true\n");
    const probePid = Number.parseInt(readText(probePidFile).trim(), 10);
    expect(() => process.kill(probePid, 0)).toThrow();

    const cleanupFunctionEnd = diagnostic.indexOf("\ntrap cleanup EXIT", cleanupFunctionStart);
    const cleanupFunction = diagnostic.slice(cleanupFunctionStart, cleanupFunctionEnd);
    const hangingRoot = tempRoots.make("openclaw-android-emulator-hanging-adb-");
    const hangingBin = path.join(hangingRoot, "bin");
    const hangingDiagnosticDir = path.join(hangingRoot, "diagnostic");
    const adbPidFile = path.join(hangingRoot, "adb.pid");
    const emulatorPidFile = path.join(hangingRoot, "emulator.pid");
    fs.mkdirSync(hangingBin);
    fs.mkdirSync(hangingDiagnosticDir);
    writeExecutables(hangingBin, {
      adb: '#!/bin/bash\nset -euo pipefail\nprintf \'%s\\n\' "$$" >"$ADB_PID_FILE"\nexec sleep 30\n',
      avdmanager: "#!/bin/bash\nset -euo pipefail\nprintf 'cleanup\\n' >>\"$CLEANUP_TRACE\"\n",
      ps: "#!/bin/bash\nexit 0\n",
    });
    const hangingResult = bash(
      [
        "set -euo pipefail",
        "sample_owned_qemu() { :; }",
        observationFunctions,
        cleanupFunction,
        "readiness_failure_latched=0",
        "adb_started=1",
        "final_cold_boot_observation_seconds=900",
        "emulator_observation_deadline=$((SECONDS + 3))",
        'export AVD_NAME="OpenClaw_Screenshots_API36"',
        "sleep 30 &",
        "emulator_pid=$!",
        'printf "%s\\n" "$emulator_pid" >"$EMULATOR_PID_FILE"',
        "trap cleanup EXIT",
        'fail_after_readiness_timeout "latched readiness failure" ""',
      ].join("\n"),
      {
        ADB_PID_FILE: adbPidFile,
        CLEANUP_TRACE: path.join(hangingRoot, "cleanup.trace"),
        DIAGNOSTIC_DIR: hangingDiagnosticDir,
        EMULATOR_PID_FILE: emulatorPidFile,
        PATH: `${hangingBin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      { timeout: 10_000 },
    );
    expect(hangingResult.status, hangingResult.stderr).toBe(1);
    const hangingObservations = readText(hangingDiagnosticDir, "post-deadline-observations.log");
    expectContains(
      hangingObservations,
      "adb_timed_out=true",
      "observation_stop=observation-cap-reached",
    );
    expect(readText(hangingRoot, "cleanup.trace")).toBe("cleanup\n");
    expect(readText(hangingDiagnosticDir, "cleanup.log")).toContain(
      "adb_kill_server_skipped_after_latched_timeout=true",
    );
    for (const pidFile of [adbPidFile, emulatorPidFile]) {
      const pid = Number.parseInt(readText(pidFile).trim(), 10);
      expect(() => process.kill(pid, 0)).toThrow();
    }
    expect(diagnostic).toMatch(
      /fail_after_readiness_timeout \\\n\s+"Timed out waiting for exactly one Android emulator device" ""/u,
    );
    expect(diagnostic).toMatch(
      /fail_after_readiness_timeout \\\n\s+"Timed out waiting for Android emulator boot completion" "\$serial"/u,
    );
    expect(artifact).toMatchObject({
      if: "always()",
      with: {
        path: "${{ runner.temp }}/android-emulator-diagnostic",
        "retention-days": 7,
      },
    });
    expect(source).not.toMatch(/\$\{\{\s*secrets\./u);
    expect(source).not.toContain("environment:");
    expect(source).not.toMatch(/\b(?:pnpm|gradle|fastlane)\b/iu);
    expect(source).not.toMatch(/apps-signing|MATCH_PASSWORD|GOOGLE_PLAY|upload-and-record/iu);
  });

  it("isolates Ubuntu APT sources before Android tooling setup", () => {
    const workflowFiles = [
      ".github/workflows/android-emulator-diagnostic.yml",
      ".github/workflows/android-store-release.yml",
    ] as const;

    const readToolingBody = (file: string): string => {
      const workflow = parse(readText(file)) as {
        jobs: Record<string, { steps?: Array<{ name: string; run?: string }> }>;
      };
      const matches = Object.values(workflow.jobs)
        .flatMap((job) => job.steps ?? [])
        .filter((step) => step.name === "Prepare trusted Linux Android tooling");
      if (matches.length !== 1 || !matches[0]?.run) {
        throw new Error(`${file}: missing unique Linux Android tooling step`);
      }
      return matches[0].run;
    };

    const diagnosticTooling = readToolingBody(".github/workflows/android-emulator-diagnostic.yml");
    expect(diagnosticTooling).toMatch(
      /width="\$\{dimensions%x\*\}"\n\s+height="\$\{dimensions#\*x\}"\n\s+\/usr\/bin\/convert \\\n\s+\\\( -size "\$dimensions" 'gradient:#000000-#ff0000' \\\) \\\n\s+\\\( -size "\$\{height\}x\$\{width\}" 'gradient:#000000-#00ff00' -transpose \\\) \\\n\s+-compose plus -composite \\\n\s+-alpha set -channel A -evaluate set 60% \+channel \\\n\s+"\$smoke_dir\/input-\$\{dimensions\}\.png"/u,
    );
    expect(diagnosticTooling).not.toContain("gradient:rgba(");
    expect(diagnosticTooling).not.toContain("'xc:");
    expect(diagnosticTooling).toMatch(
      /\/usr\/bin\/identify \+ping \\\n\s+-format 'format=%m width=%w height=%h colorspace=%\[colorspace\] type=%\[type\] channels=%\[channels\] quality=%Q\\n'/u,
    );
    expect(diagnosticTooling).not.toContain("/usr/bin/identify -ping");

    const pathExists = (target: string) =>
      fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined;

    const runToolingFixture = (
      file: string,
      options: {
        broadSource?: boolean;
        sourceState?: "empty" | "missing" | "nonempty";
        sourcePartsState?: "absent" | "directory" | "symlink";
        updateExit?: number;
      } = {},
    ) => {
      const root = tempRoots.make("openclaw-android-apt-source-");
      const bin = path.join(root, "bin");
      const runnerTemp = path.join(root, "runner-temp");
      const diagnosticDir = path.join(root, "diagnostic");
      const aptSource = path.join(root, "ubuntu.sources");
      const aptSourceParts = path.join(runnerTemp, "openclaw-android-apt-sourceparts-disabled");
      const aptLog = path.join(root, "apt.log");
      const installSentinel = path.join(root, "install-ran");
      const adapterSentinel = path.join(root, "adapter-ran");
      const kvmSentinel = path.join(root, "kvm-ran");
      const adapterSource = shell(
        'output=""',
        "while (( $# > 0 )); do",
        '  if [[ "$1" == "--out" ]]; then output="$2"; shift 2; else shift; fi',
        "done",
        'test -n "$output"',
        'printf "jpeg\\n" >"$output"',
        'printf "adapter\\n" >"$ADAPTER_SENTINEL"',
      );
      fs.mkdirSync(bin);
      fs.mkdirSync(runnerTemp);
      fs.mkdirSync(diagnosticDir);
      if ((options.sourceState ?? "nonempty") !== "missing") {
        fs.writeFileSync(
          aptSource,
          options.sourceState === "empty" ? "" : "Types: deb\nURIs: fixture.invalid\n",
        );
      }
      if (options.sourcePartsState === "directory") {
        fs.mkdirSync(aptSourceParts);
      } else if (options.sourcePartsState === "symlink") {
        fs.symlinkSync(path.join(root, "missing-sourceparts"), aptSourceParts);
      }

      const executable = writeExecutables(bin, {
        timeout: shell(
          "while (( $# > 0 )); do",
          '  case "$1" in',
          "    --signal=*|--kill-after=*) shift ;;",
          "    300s) shift; break ;;",
          "    *) exit 91 ;;",
          "  esac",
          "done",
          'exec "$@"',
        ),
        sudo: shell(
          'test "$1" = "env"',
          "shift",
          'while (( $# > 0 )) && [[ "$1" == *=* ]]; do export "$1"; shift; done',
          'exec "$@"',
        ),
        "apt-get": shell(
          'printf "%s\\n" "$*" >>"$APT_LOG"',
          'if (( $# < 5 )) || [[ "$1" != "-o" || "$2" != "Dir::Etc::sourcelist=$APT_SOURCE" ||',
          '  "$3" != "-o" || "$4" != "Dir::Etc::sourceparts=$APT_SOURCE_PARTS" ]]; then',
          "  exit 100",
          "fi",
          'if [[ "$5" == "update" ]]; then exit "${APT_UPDATE_EXIT:-0}"; fi',
          'test "$5" = "install"',
          'test "$6" = "-y"',
          'test "$7" = "--no-install-recommends"',
          'test "$8" = "imagemagick"',
          'printf "install\\n" >"$INSTALL_SENTINEL"',
        ),
        convert: shell('output="${!#}"', 'printf "png\\n" >"$output"'),
        identify: shell(
          "printf 'format=JPEG width=1 height=1 colorspace=sRGB type=TrueColor channels=3.0 quality=95\\n'",
        ),
        git: shell(
          'test "$1" = "-C"',
          "shift 2",
          'case "$1 $2" in',
          '  "rev-parse HEAD") printf "%s\\n" "$GITHUB_WORKFLOW_SHA" ;;',
          '  "ls-tree HEAD") printf "100755 blob fixtureoid scripts/android-sips-linux.sh\\n" ;;',
          '  "cat-file blob")',
          '    cat "$ADAPTER_SOURCE"',
          "    ;;",
          "  *) exit 92 ;;",
          "esac",
        ),
      });

      for (const trustedRoot of [path.join(root, ".mobile-release-tooling"), root]) {
        writeFile(trustedRoot, "scripts/android-sips-linux.sh", adapterSource);
        fs.chmodSync(path.join(trustedRoot, "scripts/android-sips-linux.sh"), 0o755);
      }
      writeExecutable(root, "adapter-source.sh", adapterSource);

      let body = readToolingBody(file);
      if (options.broadSource) {
        body = body
          .replace('/usr/bin/apt-get "${apt_options[@]}" update', "/usr/bin/apt-get update")
          .replace('/usr/bin/apt-get "${apt_options[@]}" install', "/usr/bin/apt-get install");
      }
      body = body
        .replaceAll("/usr/bin/timeout", executable("timeout"))
        .replaceAll("/usr/bin/sudo", executable("sudo"))
        .replaceAll("/usr/bin/apt-get", executable("apt-get"))
        .replaceAll("/usr/bin/convert", executable("convert"))
        .replaceAll("/usr/bin/identify", executable("identify"))
        .replaceAll("/etc/apt/sources.list.d/ubuntu.sources", aptSource);

      const result = bash(
        [body, 'printf "kvm\\n" >"$KVM_SENTINEL"'].join("\n"),
        {
          ADAPTER_SENTINEL: adapterSentinel,
          ADAPTER_SOURCE: path.join(root, "adapter-source.sh"),
          APT_LOG: aptLog,
          APT_SOURCE: aptSource,
          APT_SOURCE_PARTS: aptSourceParts,
          APT_UPDATE_EXIT: String(options.updateExit ?? 0),
          DIAGNOSTIC_DIR: diagnosticDir,
          GITHUB_WORKFLOW_SHA: "a".repeat(40),
          INSTALL_SENTINEL: installSentinel,
          KVM_SENTINEL: kvmSentinel,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          RUNNER_ARCH: "X64",
          RUNNER_OS: "Linux",
          RUNNER_TEMP: runnerTemp,
        },
        { cwd: root, timeout: 5_000 },
      );
      return {
        adapterSentinel: path.join(runnerTemp, "openclaw-android-tools/android-sips-linux.sh"),
        aptSource,
        aptSourceParts,
        calls: fs.existsSync(aptLog) ? readText(aptLog).trim().split("\n").filter(Boolean) : [],
        installSentinel,
        kvmSentinel,
        result,
      };
    };

    for (const file of workflowFiles) {
      const broad = runToolingFixture(file, { broadSource: true });
      expect(broad.result.status, `${file}: broad source should fail`).toBe(100);
      expectFilesExist(false, broad.installSentinel, broad.adapterSentinel, broad.kvmSentinel);

      const restricted = runToolingFixture(file);
      expect(
        restricted.result.status,
        `${file}: signal=${restricted.result.signal ?? "none"}\n${restricted.result.stderr}`,
      ).toBe(0);
      expect(restricted.calls).toEqual([
        `-o Dir::Etc::sourcelist=${restricted.aptSource} -o Dir::Etc::sourceparts=${restricted.aptSourceParts} update`,
        `-o Dir::Etc::sourcelist=${restricted.aptSource} -o Dir::Etc::sourceparts=${restricted.aptSourceParts} install -y --no-install-recommends imagemagick`,
      ]);
      expect(pathExists(restricted.aptSourceParts)).toBe(false);
      expectFilesExist(
        true,
        restricted.installSentinel,
        restricted.adapterSentinel,
        restricted.kvmSentinel,
      );

      const failedUpdate = runToolingFixture(file, { updateExit: 100 });
      expect(failedUpdate.result.status).toBe(100);
      expect(failedUpdate.calls).toHaveLength(1);
      expectFilesExist(
        false,
        failedUpdate.installSentinel,
        failedUpdate.adapterSentinel,
        failedUpdate.kvmSentinel,
      );

      for (const sourceState of ["missing", "empty"] as const) {
        const guarded = runToolingFixture(file, { sourceState });
        expect(guarded.result.status, `${file}: ${sourceState} source`).not.toBe(0);
        expect(guarded.calls).toEqual([]);
        expectFilesExist(false, guarded.adapterSentinel, guarded.kvmSentinel);
      }

      for (const sourcePartsState of ["directory", "symlink"] as const) {
        const guarded = runToolingFixture(file, { sourcePartsState });
        expect(guarded.result.status, `${file}: ${sourcePartsState} source parts`).not.toBe(0);
        expect(guarded.calls).toEqual([]);
        expect(pathExists(guarded.aptSourceParts)).toBe(true);
        expectFilesExist(false, guarded.adapterSentinel, guarded.kvmSentinel);
      }
    }
  });

  it("prepares native tooling and runs the iOS signing proof through Fastlane", () => {
    const steps = releaseSteps(".github/workflows/ios-store-release.yml");
    const xcodeIndex = stepIndex(steps, "Select Xcode");
    const rustIndex = stepIndex(steps, "Install Watch Rust toolchain");
    const createIndex = stepIndex(steps, "Create job-owned iOS signing keychain");
    const signingProofIndex = stepIndex(steps, "Validate readonly iOS signing key access");
    const uploadIndex = stepIndex(steps, "Prepare and upload iOS release");

    const rustStep = steps[rustIndex];

    expect(xcodeIndex).toBeGreaterThanOrEqual(0);
    expect(rustIndex).toBeGreaterThan(xcodeIndex);
    expect(signingProofIndex).toBeGreaterThan(rustIndex);
    expect(rustStep?.if).toBe("hashFiles('apps/shared/OpenClawWatchRTC/Cargo.toml') != ''");
    expectContains(
      rustStep?.run,
      `watch_toolchain="$(awk -F '"' '/^channel =/ { print $2; exit }' apps/shared/OpenClawWatchRTC/rust-toolchain.toml)"`,
      'test -n "$watch_toolchain"',
      'rustup toolchain install "$watch_toolchain" --profile minimal --component rust-src',
      'echo "$HOME/.cargo/bin" >> "$GITHUB_PATH"',
    );

    expect(createIndex).toBeGreaterThan(-1);
    expect(steps[createIndex]?.uses).toBe("./.github/actions/ios-signing-keychain");
    expect(signingProofIndex).toBeGreaterThan(createIndex);
    expect(uploadIndex).toBeGreaterThan(signingProofIndex);
    expect(steps[signingProofIndex]?.env).toEqual({
      MATCH_PASSWORD: "${{ secrets.MATCH_PASSWORD }}",
    });
    const signingProof = steps[signingProofIndex]?.run;
    expect(signingProof).toBeTruthy();
    const fixtureRoot = tempRoots.make("openclaw-ios-signing-proof-");
    const workspace = path.join(fixtureRoot, "workspace");
    const home = path.join(fixtureRoot, "home");
    const preparedBin = path.join(fixtureRoot, "prepared-bin");
    const loginBin = path.join(fixtureRoot, "login-bin");
    const eventsPath = path.join(fixtureRoot, "events");
    for (const directory of [
      home,
      preparedBin,
      loginBin,
      path.join(workspace, "scripts/lib"),
      path.join(workspace, "apps/ios"),
    ]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.copyFileSync(
      "scripts/lib/ios-fastlane.sh",
      path.join(workspace, "scripts/lib/ios-fastlane.sh"),
    );
    fs.copyFileSync("apps/ios/Gemfile", path.join(workspace, "apps/ios/Gemfile"));
    fs.writeFileSync(
      path.join(home, ".bash_profile"),
      'export PATH="$FIXTURE_LOGIN_BIN:/usr/bin:/bin"\n',
    );
    writeExecutables(preparedBin, {
      pnpm: [
        "#!/bin/bash",
        'printf "pnpm:%s\\n" "$*" >>"$FIXTURE_EVENTS"',
        "exec /bin/bash -lc 'source ./scripts/lib/ios-fastlane.sh && cd apps/ios && run_ios_fastlane ios signing_check'",
        "",
      ].join("\n"),
      bundle: shell(
        '[[ "$BUNDLE_GEMFILE" == "$FIXTURE_WORKSPACE/apps/ios/Gemfile" ]]',
        '[[ "$PWD" == "$FIXTURE_WORKSPACE/apps/ios" ]]',
        'printf "bundle:%s\\n" "$*" >>"$FIXTURE_EVENTS"',
        'if [[ "$2" == "check" ]]; then',
        '  [[ "${FIXTURE_FAIL_CHECK:-0}" != "1" ]] || exit 42',
        'elif [[ "$2" != "exec" || "$3" != "fastlane" || "$4" != "ios" || "$5" != "signing_check" ]]; then',
        "  exit 43",
        "fi",
      ),
      node: shell(
        '[[ "$PWD" == "$FIXTURE_WORKSPACE" ]]',
        '[[ "$*" == ".github/actions/ios-signing-keychain/keychain.mjs probe" ]]',
        'printf "probe:root-cwd\\n" >>"$FIXTURE_EVENTS"',
      ),
    });
    writeExecutable(
      loginBin,
      "bundle",
      ["#!/bin/bash", 'printf "login-bundle:%s\\n" "$*" >>"$FIXTURE_EVENTS"', "exit 42", ""].join(
        "\n",
      ),
    );

    const runSigningProof = (extraEnv: NodeJS.ProcessEnv = {}) => {
      fs.writeFileSync(eventsPath, "");
      const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", signingProof ?? ""], {
        cwd: workspace,
        encoding: "utf8",
        env: {
          FIXTURE_EVENTS: eventsPath,
          FIXTURE_LOGIN_BIN: loginBin,
          FIXTURE_WORKSPACE: workspace,
          HOME: home,
          MATCH_PASSWORD: "fixture-password",
          PATH: `${preparedBin}:/usr/bin:/bin`,
          ...extraEnv,
        },
        timeout: 5_000,
      });
      return {
        events: readText(eventsPath).trim().split("\n").filter(Boolean),
        result,
      };
    };

    const prepared = runSigningProof();
    expect(prepared.result.status, prepared.result.stderr).toBe(0);
    expect(prepared.events).toEqual([
      "bundle:_4.0.23_ check",
      "bundle:_4.0.23_ exec fastlane ios signing_check",
      "probe:root-cwd",
    ]);

    const failedCheck = runSigningProof({ FIXTURE_FAIL_CHECK: "1" });
    expect(failedCheck.result.status).not.toBe(0);
    expect(failedCheck.events).toEqual(["bundle:_4.0.23_ check"]);

    const action = parse(readText(".github/actions/ios-signing-keychain/action.yml")) as {
      runs: {
        main: string;
        post: string;
        "post-if": string;
        using: string;
      };
    };
    expect(action.runs).toEqual({
      using: "node24",
      main: "keychain.mjs",
      post: "post.mjs",
      "post-if": "always()",
    });
  });

  it("keeps an absent-state iOS keychain post cleanup side-effect free", () => {
    const runnerTemp = tempRoots.make("openclaw-ios-keychain-post-runner-");
    const workspace = tempRoots.make("openclaw-ios-keychain-post-workspace-");
    fs.mkdirSync(path.join(workspace, "apps/ios"), { recursive: true });
    const fakeBin = path.join(runnerTemp, "bin");
    const bundleMarker = path.join(runnerTemp, "bundle-called");
    const environmentFile = path.join(runnerTemp, "environment");
    const stateFile = path.join(runnerTemp, "state");
    fs.mkdirSync(fakeBin);
    writeExecutable(fakeBin, "bundle", '#!/bin/sh\n: > "$BUNDLE_MARKER"\nexit 99\n', 0o700);

    const result = spawnSync(process.execPath, [".github/actions/ios-signing-keychain/post.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: signingEnv(workspace, runnerTemp, {
        BUNDLE_MARKER: bundleMarker,
        GITHUB_ENV: environmentFile,
        GITHUB_STATE: stateFile,
        PATH: `${fakeBin}:/usr/bin:/bin`,
      }),
    });

    expect(result.status, result.stderr).toBe(0);
    expectFilesExist(false, bundleMarker, environmentFile, stateFile);
    expect(
      fs
        .readdirSync(runnerTemp)
        .some((entry) => entry.startsWith("openclaw-ios-signing-keychain-")),
    ).toBe(false);
  });

  it("masks and owns both resolved iOS keychain filename forms through post cleanup", async () => {
    const workspace = tempRoots.make("openclaw-ios-keychain-workspace-");
    fs.mkdirSync(path.join(workspace, "apps/ios"), { recursive: true });
    for (const filenameSuffix of ["", "-db"] as const) {
      const fixture = keychainFixture(workspace, filenameSuffix);
      const created = await fixture.create();
      expect(created.resolvedPath).toBe(`${created.requestedPath}${filenameSuffix}`);
      expect(fs.statSync(created.ownedRoot).mode & 0o777).toBe(0o700);
      expect(fixture.output()).toBe(`::add-mask::${created.password}\n`);
      expect(readText(fixture.environmentFile)).toBe(
        `MATCH_KEYCHAIN_NAME=${created.resolvedPath}\n` +
          `MATCH_KEYCHAIN_PASSWORD=${created.password}\n`,
      );
      const state = fixture.state();
      expect(state.resolved_path).toBe(created.resolvedPath);
      await fixture.cleanup();
      expect(fs.existsSync(created.ownedRoot)).toBe(false);
      expect(fixture.commands.map((args) => args[4])).toEqual([
        "create_keychain",
        "delete_keychain",
      ]);
      expect(fixture.commands.at(-1)).toContain(`keychain_path:${created.resolvedPath}`);
    }

    const source = readText(".github/actions/ios-signing-keychain/keychain.mjs");
    expect(source.indexOf("maskSecret(password, output)")).toBeLessThan(
      source.indexOf(
        'appendCommandValue(environmentFile, "MATCH_KEYCHAIN_PASSWORD", password, appendFile)',
      ),
    );
    expectContains(
      source,
      "default_keychain: false",
      "lock_after_timeout: true",
      "timeout: KEYCHAIN_LIFETIME_SECONDS",
    );
    expect(source).not.toContain("skip_set_partition_list");
  });

  it("cleans a partial iOS keychain create and refuses paths outside its ownership", async () => {
    const workspace = tempRoots.make("openclaw-ios-keychain-partial-workspace-");
    fs.mkdirSync(path.join(workspace, "apps/ios"), { recursive: true });
    for (const filenameSuffix of ["", "-db"] as const) {
      const fixture = keychainFixture(workspace, filenameSuffix, true);
      await expect(fixture.create()).rejects.toThrow("partial create");
      expect(fs.existsSync(fixture.environmentFile)).toBe(false);
      const state = fixture.state();
      const partialPath = `${state.requested_path}${filenameSuffix}`;
      expect(fs.existsSync(partialPath)).toBe(true);
      await fixture.cleanup(partialPath);
      expect(fs.existsSync(expectDefined(state.owned_root, "owned keychain root"))).toBe(false);
    }

    const runnerTemp = tempRoots.make("openclaw-ios-keychain-guard-runner-");
    const env = signingEnv(workspace, runnerTemp);
    const outsidePath = path.join(runnerTemp, "outside.keychain-db");
    fs.writeFileSync(outsidePath, "not owned\n");
    const { root: ownedRoot, file: requestedPath } = ownedKeychain(runnerTemp);
    let cleanupCalled = false;
    const cleanup = (state: NodeJS.ProcessEnv) =>
      cleanupOwnedKeychain({
        env: { ...env, ...state },
        runCommand: async () => {
          cleanupCalled = true;
          return { stderr: "", stdout: "" };
        },
      });
    await expect(
      cleanup({
        STATE_owned_root: ownedRoot,
        STATE_requested_path: requestedPath,
        STATE_resolved_path: outsidePath,
      }),
    ).rejects.toThrow("Unexpected owned keychain path");
    expect(cleanupCalled).toBe(false);
    expect(fs.existsSync(outsidePath)).toBe(true);

    const { root: ambiguousRoot, file: ambiguousRequestedPath } = ownedKeychain(
      runnerTemp,
      "signing.keychain",
      "requested keychain\n",
    );
    fs.writeFileSync(`${ambiguousRequestedPath}-db`, "database keychain\n");
    await expect(
      cleanup({
        STATE_owned_root: ambiguousRoot,
        STATE_requested_path: ambiguousRequestedPath,
      }),
    ).rejects.toThrow("Refusing ambiguous job-owned keychain cleanup");
    expect(cleanupCalled).toBe(false);
  });

  it("binds both iOS keychain filename forms to the configured signing team", async () => {
    const runnerTemp = tempRoots.make("openclaw-ios-keychain-probe-runner-");
    const workspace = tempRoots.make("openclaw-ios-keychain-probe-workspace-");
    writeFile(
      workspace,
      "apps/ios/Config/AppStoreSigning.json",
      `${JSON.stringify({ teamId: "FWJYW4S8P8" }, null, 2)}\n`,
    );
    const identityHash = "A".repeat(40);
    const probe = (
      keychainPath: string,
      runCommand: (
        executable: string,
        args: string[],
        options: { timeoutMs?: number },
      ) => Promise<{ stderr: string; stdout: string }>,
    ) =>
      probeOwnedKeychain({
        env: signingEnv(workspace, runnerTemp, { MATCH_KEYCHAIN_NAME: keychainPath }),
        runCommand,
      });
    for (const keychainFilename of ["signing.keychain", "signing.keychain-db"] as const) {
      const { file: keychainPath } = ownedKeychain(
        runnerTemp,
        keychainFilename,
        "owned keychain\n",
      );
      const calls: Array<{ args: string[]; executable: string; timeoutMs?: number }> = [];
      const runCommand = async (
        executable: string,
        args: string[],
        options: { timeoutMs?: number },
      ) => {
        calls.push({ args, executable, timeoutMs: options.timeoutMs });
        if (executable === "/usr/bin/security") {
          expect(args.at(-1)).toBe(keychainPath);
          return {
            stderr: "",
            stdout: `  1) ${identityHash} "Apple Distribution: OpenClaw Foundation (FWJYW4S8P8)"\n`,
          };
        }
        const probePath = args.at(-1);
        expect(executable).toBe("/usr/bin/codesign");
        expect(fs.readFileSync(probePath as string)).toEqual(fs.readFileSync("/usr/bin/true"));
        if (args.includes("--force")) {
          expect(args).toContain(keychainPath);
        }
        if (args.includes("--display")) {
          return { stderr: "TeamIdentifier=FWJYW4S8P8\n", stdout: "" };
        }
        return { stderr: "", stdout: "" };
      };

      await expect(probe(keychainPath, runCommand)).resolves.toEqual({
        identity: "Apple Distribution: OpenClaw Foundation (FWJYW4S8P8)",
        teamId: "FWJYW4S8P8",
      });
      expect(calls.map(({ executable }) => executable)).toEqual([
        "/usr/bin/security",
        "/usr/bin/codesign",
        "/usr/bin/codesign",
        "/usr/bin/codesign",
      ]);
      expect(calls.every(({ timeoutMs }) => timeoutMs !== undefined && timeoutMs <= 30_000)).toBe(
        true,
      );
      expect(calls.some(({ executable, args }) => executable === args.at(-1))).toBe(false);
      expect(
        fs
          .readdirSync(runnerTemp)
          .some((entry) => entry.startsWith("openclaw-ios-codesign-probe-")),
      ).toBe(false);
    }

    const { file: wrongTeamPath } = ownedKeychain(
      runnerTemp,
      "signing.keychain",
      "owned keychain\n",
    );
    await expect(
      probeOwnedKeychain({
        env: signingEnv(workspace, runnerTemp, { MATCH_KEYCHAIN_NAME: wrongTeamPath }),
        runCommand: async () => ({
          stderr: "",
          stdout: `  1) ${identityHash} "Apple Distribution: Other Team (AAAAAAAAAA)"\n`,
        }),
      }),
    ).rejects.toThrow("Expected one Apple Distribution identity for team FWJYW4S8P8, found 0");

    let unsafeCommandCount = 0;
    const rejectUnsafeCommand = async () => {
      unsafeCommandCount += 1;
      return { stderr: "", stdout: "" };
    };
    const { file: missingPath } = ownedKeychain(runnerTemp);
    const { file: symlinkPath } = ownedKeychain(runnerTemp);
    const symlinkTarget = path.join(runnerTemp, "foreign.keychain");
    fs.writeFileSync(symlinkTarget, "foreign keychain\n");
    fs.symlinkSync(symlinkTarget, symlinkPath);
    for (const [file, error] of [
      [missingPath, "Owned keychain is missing"],
      [symlinkPath, "Owned keychain path is not a regular file"],
    ] as const) {
      await expect(probe(file, rejectUnsafeCommand)).rejects.toThrow(error);
    }
    expect(unsafeCommandCount).toBe(0);
  });

  registerBoundedSignalTests();

  it("bounds owned child process trees", async () => {
    const runnerTemp = tempRoots.make("openclaw-ios-keychain-process-runner-");
    if (process.platform !== "win32") {
      const exerciseOwnedProcessTree = async ({
        expectedError,
        grandchildSource,
        maxOutputBytes,
        name,
        timeoutMs,
      }: {
        expectedError: string;
        grandchildSource: string;
        maxOutputBytes?: number;
        name: string;
        timeoutMs: number;
      }) => {
        const pidFile = path.join(runnerTemp, `${name}.pid`);
        const parentSource = [
          // A timeout during PID publication must not terminate the fixture before it writes.
          'process.on("SIGTERM", () => {});',
          'const { spawn } = require("node:child_process");',
          'const fs = require("node:fs");',
          `const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], {`,
          '  stdio: ["ignore", process.stdout, process.stderr],',
          "});",
          "fs.writeFileSync(process.env.PID_FILE, `${process.pid}\\n${child.pid}\\n`);",
          "setInterval(() => {}, 1000);",
        ].join("\n");
        const runnerSource = `
import fs from "node:fs";
import { runBounded } from ${JSON.stringify(pathToFileURL(path.resolve(".github/actions/ios-signing-keychain/keychain.mjs")).href)};
const startedAt = Date.now();
let message = "";
try {
  await runBounded(process.execPath, ["-e", ${JSON.stringify(parentSource)}], {
    env: { ...process.env, PID_FILE: ${JSON.stringify(pidFile)} },
    maxOutputBytes: ${JSON.stringify(maxOutputBytes)},
    terminateGraceMs: 200,
    timeoutMs: ${timeoutMs},
  });
} catch (error) {
  message = error instanceof Error ? error.message : String(error);
}
const processIds = fs.readFileSync(${JSON.stringify(pidFile)}, "utf8").trim().split("\\n").map(Number);
let processGroupAlive = true;
try { process.kill(-processIds[0], 0); } catch (error) {
  if (error?.code !== "ESRCH") throw error;
  processGroupAlive = false;
}
process.stdout.write(JSON.stringify({ elapsedMs: Date.now() - startedAt, message, processGroupAlive, processIds }));
`;
        const result = spawnSync(
          testNodeExecPath,
          ["--input-type=module", "--eval", runnerSource],
          { cwd: process.cwd(), encoding: "utf8", env: process.env },
        );
        expect(result.status, result.stderr).toBe(0);
        const outcome = JSON.parse(result.stdout) as {
          elapsedMs: number;
          message: string;
          processGroupAlive: boolean;
          processIds: number[];
        };
        expect(outcome.message).toContain(expectedError);
        expect(outcome.elapsedMs).toBeLessThan(3_000);
        const processIds = outcome.processIds;
        expect(processIds).toHaveLength(2);
        const processGroupId = processIds[0];
        if (
          typeof processGroupId !== "number" ||
          !Number.isSafeInteger(processGroupId) ||
          processGroupId <= 0
        ) {
          throw new Error(`Invalid owned process-group ID: ${processGroupId}`);
        }
        expect(outcome.processGroupAlive).toBe(false);
      };

      await exerciseOwnedProcessTree({
        expectedError: "timed out after 1000ms",
        grandchildSource: 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 5000);',
        name: "timeout-tree",
        timeoutMs: 1_000,
      });
      await exerciseOwnedProcessTree({
        expectedError: "exceeded the 4096-byte output limit",
        grandchildSource:
          'process.on("SIGTERM", () => {}); setInterval(() => process.stdout.write("x".repeat(2048)), 1);',
        maxOutputBytes: 4096,
        name: "output-cap-tree",
        timeoutMs: 5_000,
      });
    }
  });
});
