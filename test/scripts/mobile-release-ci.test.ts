import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { globSync } from "tinyglobby";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  cleanupOwnedKeychain,
  createOwnedKeychain,
  probeOwnedKeychain,
} from "../../.github/actions/ios-signing-keychain/keychain.mjs";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { cleanupTempDirs, makeTempDir, useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { runVitestShutdownCommand } from "../helpers/vitest-shutdown-command.js";
import { registerBoundedSignalTests } from "./mobile-release-process.test-support.js";

const testNodeExecPath = resolveTestNodeExecPath();
const tempRoots = useAutoCleanupTempDirTracker(afterEach);
const joinedObservationRoots: string[] = [];
afterEach(() => cleanupTempDirs(joinedObservationRoots));

function command(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function git(cwd: string, ...args: string[]): string {
  return command("/usr/bin/git", args, { cwd });
}

function writeFile(root: string, file: string, source: string): void {
  const destination = path.join(root, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, source);
}

function commit(repository: string, message: string): string {
  git(repository, "add", "-A");
  git(repository, "commit", "-m", message);
  return git(repository, "rev-parse", "HEAD");
}

function releaseArtifactFiles(workflowFile: string, artifactPrefix: string, runnerTemp: string) {
  const workflow = parse(fs.readFileSync(workflowFile, "utf8")) as {
    jobs: {
      release: {
        steps: Array<{
          if?: string;
          uses?: string;
          with?: { name?: string; path?: string };
        }>;
      };
    };
  };
  const upload = workflow.jobs.release.steps.find(
    (step) =>
      step.uses?.startsWith("actions/upload-artifact@") &&
      step.with?.name?.startsWith(artifactPrefix),
  );
  if (!upload?.with?.path) {
    throw new Error(`Missing ${artifactPrefix} upload in ${workflowFile}`);
  }
  expect(upload.if).toBe("always()");
  const patterns = upload.with.path
    .trim()
    .split(/\r?\n/u)
    .map((pattern) => pattern.replaceAll("${{ runner.temp }}", runnerTemp));
  return globSync(patterns, { cwd: runnerTemp, dot: true }).toSorted();
}

describe("mobile release CI tools", () => {
  describe.each([
    {
      platform: "ios",
      workflow: ".github/workflows/ios-release.yml",
      buildDirectory: "app-store",
      binaries: ["OpenClaw.ipa", "OpenClaw.ipa.sha256"],
    },
    {
      platform: "android",
      workflow: ".github/workflows/android-store-release.yml",
      buildDirectory: "release-artifacts",
      binaries: ["OpenClaw-phone.aab", "OpenClaw-wear.aab", "OpenClaw.apk", "OpenClaw.aab.sha256"],
    },
  ])("$platform release artifact recovery", ({ platform, workflow, buildDirectory, binaries }) => {
    it.each(["collected", "interrupted"])(
      "uploads only the signed binaries and checksums when collection is %s",
      (state) => {
        const runnerTemp = tempRoots.make("openclaw-release-artifact-selection-");
        const recovery = `${platform}-release-recovery`;
        const build = `${recovery}/source/apps/${platform}/build`;
        const directory =
          state === "collected" ? `${recovery}/artifacts` : `${build}/${buildDirectory}`;
        const expected = binaries.map((file) => `${directory}/${file}`).toSorted();
        for (const file of expected) {
          writeFile(runnerTemp, file, "synthetic signed release artifact");
        }
        for (const file of [
          `${build}/release-signing/upload.jks`,
          `${build}/release-signing/AuthKey.p8`,
          `${build}/release-signing/${binaries[0]}`,
          `${directory}/credentials.json`,
          `${directory}/.env`,
          `${directory}/nested/${binaries[0]}`,
          `${build}/SnapshotLogs/xcodebuild.log`,
          `${build}/SnapshotTestResults/result.xcresult/Info.plist`,
        ]) {
          writeFile(runnerTemp, file, "synthetic excluded data");
        }
        expect(
          releaseArtifactFiles(workflow, `${platform}-release-artifacts-`, runnerTemp),
        ).toEqual(expected);
      },
    );
  });

  it.each(["collected", "interrupted"])(
    "uploads only safe iOS screenshot diagnostics when collection is %s",
    (state) => {
      const runnerTemp = tempRoots.make("openclaw-ios-screenshot-artifact-selection-");
      const recovery = "ios-release-recovery";
      const source = `${recovery}/source/apps/ios`;
      const collected = `${recovery}/screenshot-diagnostics`;
      const screenshots =
        state === "collected" ? `${collected}/screenshots` : `${source}/fastlane/screenshots/en-US`;
      const results = state === "collected" ? collected : `${source}/build/SnapshotTestResults`;
      const expected = [
        `${screenshots}/01-chat.png`,
        `${results}/capture-attempts.json`,
      ].toSorted();
      for (const file of expected) {
        writeFile(runnerTemp, file, "synthetic safe screenshot diagnostic");
      }
      for (const file of [
        `${screenshots}/capture.log`,
        `${screenshots}/nested/private.png`,
        `${results}/pairing.json`,
        `${results}/result.xcresult/Info.plist`,
        `${collected}/SnapshotLogs/xcodebuild.log`,
        `${source}/build/SnapshotLogs/xcodebuild.log`,
        `${source}/build/release-signing/AuthKey.p8`,
        `${source}/fastlane/.env`,
      ]) {
        writeFile(runnerTemp, file, "synthetic excluded data");
      }
      expect(
        releaseArtifactFiles(
          ".github/workflows/ios-release.yml",
          "ios-release-screenshot-diagnostics-",
          runnerTemp,
        ),
      ).toEqual(expected);
    },
  );

  it("uploads only Android emulator startup diagnostics after a screenshot failure", () => {
    const runnerTemp = tempRoots.make("openclaw-android-emulator-artifact-selection-");
    const source = "android-release-recovery/source";
    const diagnostics = `${source}/.artifacts/android-screenshots/latest`;
    const expected = ["phone", "wear"]
      .flatMap((formFactor) =>
        ["emulator.log", "emulator-args.txt", "process-status.txt"].map(
          (file) => `${diagnostics}/${formFactor}/${file}`,
        ),
      )
      .toSorted();
    for (const file of expected) {
      writeFile(runnerTemp, file, "synthetic emulator startup diagnostic");
    }
    for (const file of [
      `${diagnostics}/phone/logcat.txt`,
      `${diagnostics}/wear/ui-dumps/openclaw-home.xml`,
      `${source}/apps/android/build/release-signing/google-play.json`,
    ]) {
      writeFile(runnerTemp, file, "synthetic excluded data");
    }
    expect(
      releaseArtifactFiles(
        ".github/workflows/android-store-release.yml",
        "android-release-emulator-diagnostics-",
        runnerTemp,
      ),
    ).toEqual(expected);
  });

  it("keeps the Android emulator diagnostic manual, exact-SHA-bound, and secretless", async () => {
    const file = ".github/workflows/android-emulator-diagnostic.yml";
    const source = fs.readFileSync(file, "utf8");
    const workflow = parse(source) as {
      jobs: {
        "validate-target": {
          permissions: Record<string, string>;
          "runs-on": string;
          steps: Array<{
            env?: Record<string, string>;
            name: string;
            run?: string;
            uses?: string;
            with?: Record<string, unknown>;
          }>;
          "timeout-minutes": number;
        };
        diagnose: {
          env: Record<string, string>;
          needs: string;
          permissions: Record<string, string>;
          "runs-on": string;
          steps: Array<{
            env?: Record<string, string>;
            if?: string;
            name: string;
            run?: string;
            uses?: string;
            with?: Record<string, unknown>;
          }>;
          "timeout-minutes": number;
        };
      };
      name: string;
      on: {
        workflow_dispatch: {
          inputs: {
            target_sha: {
              default?: unknown;
              description: string;
              required: boolean;
              type: string;
            };
          };
        };
      };
      permissions: Record<string, string>;
      "run-name": string;
    };
    const validationJob = workflow.jobs["validate-target"];
    const validationSteps = validationJob.steps;
    const job = workflow.jobs.diagnose;
    const steps = job.steps;
    const validateIndex = validationSteps.findIndex((step) => step.name === "Validate target SHA");
    const validationTrustedCheckoutIndex = validationSteps.findIndex(
      (step) => step.name === "Checkout trusted Android tooling",
    );
    const checkoutIndex = validationSteps.findIndex(
      (step) => step.name === "Checkout exact target",
    );
    const headIndex = validationSteps.findIndex(
      (step) => step.name === "Verify exact target checkout",
    );
    const parityIndex = validationSteps.findIndex(
      (step) => step.name === "Verify Android toolchain action parity",
    );
    const initializeIndex = steps.findIndex(
      (step) => step.name === "Initialize Android emulator diagnostic",
    );
    const trustedCheckoutIndex = steps.findIndex(
      (step) => step.name === "Checkout trusted Android tooling",
    );
    const setupIndex = steps.findIndex((step) => step.name === "Setup Android toolchain");
    const toolingIndex = steps.findIndex(
      (step) => step.name === "Prepare trusted Linux Android tooling",
    );
    const kvmIndex = steps.findIndex(
      (step) => step.name === "Collect Linux KVM acceleration proof",
    );
    const diagnosticIndex = steps.findIndex(
      (step) => step.name === "Run phone emulator diagnostic",
    );
    const artifactIndex = steps.findIndex(
      (step) => step.name === "Upload Android emulator diagnostic",
    );

    expect(workflow.name).toBe("Android Emulator Diagnostic");
    expect(workflow["run-name"]).toBe(
      "Android emulator diagnostic instrumented (${{ inputs.target_sha }})",
    );
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.on.workflow_dispatch.inputs.target_sha).toEqual({
      description: "Exact lowercase 40-character commit SHA to diagnose",
      required: true,
      type: "string",
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.jobs)).toEqual(["validate-target", "diagnose"]);
    expect(validationJob.permissions).toEqual({ contents: "read" });
    expect(validationJob["runs-on"]).toBe("ubuntu-24.04");
    expect(validationJob["timeout-minutes"]).toBe(5);
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.needs).toBe("validate-target");
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job["timeout-minutes"]).toBe(25);
    expect(job.env).toEqual({
      ANDROID_SCREENSHOT_EMULATOR_TIMEOUT_SECONDS: "180",
      AVD_NAME: "OpenClaw_Screenshots_API36",
      DEVICE_PROFILE: "pixel_2",
      SYSTEM_IMAGE: "system-images;android-36;google_apis;x86_64",
    });

    expect(validateIndex).toBe(0);
    expect(validationTrustedCheckoutIndex).toBe(validateIndex + 1);
    expect(checkoutIndex).toBe(validationTrustedCheckoutIndex + 1);
    expect(headIndex).toBe(checkoutIndex + 1);
    expect(parityIndex).toBe(headIndex + 1);
    expect(initializeIndex).toBe(0);
    expect(trustedCheckoutIndex).toBe(initializeIndex + 1);
    expect(setupIndex).toBe(trustedCheckoutIndex + 1);
    expect(toolingIndex).toBe(setupIndex + 1);
    expect(kvmIndex).toBe(toolingIndex + 1);
    expect(diagnosticIndex).toBe(kvmIndex + 1);
    expect(artifactIndex).toBe(diagnosticIndex + 1);
    expect(validationSteps[validateIndex]?.env).toEqual({
      TARGET_SHA: "${{ inputs.target_sha }}",
    });
    expect(validationSteps[validateIndex]?.run).toContain(
      '[[ ! "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]',
    );
    expect(steps[initializeIndex]?.env).toEqual({
      TARGET_SHA: "${{ inputs.target_sha }}",
    });
    expect(steps[initializeIndex]?.run).toContain(
      'DIAGNOSTIC_DIR="$RUNNER_TEMP/android-emulator-diagnostic"',
    );
    expect(steps[initializeIndex]?.run).toContain(
      'echo "DIAGNOSTIC_DIR=$DIAGNOSTIC_DIR" >>"$GITHUB_ENV"',
    );
    expect(steps[initializeIndex]?.run).toContain(
      "printf 'host_cpu=%s\\n' \"$(awk -F: '/^model name/",
    );
    expect(steps[initializeIndex]?.run).toContain(
      "printf 'host_logical_cpus=%s\\n' \"$(getconf _NPROCESSORS_ONLN)\"",
    );
    expect(steps[initializeIndex]?.run).toContain(
      "printf 'host_memory_bytes=%s\\n' \"$(awk '/^MemTotal:/",
    );
    expect(steps[initializeIndex]?.run).toContain("cat /etc/os-release");
    expect(validationSteps[validationTrustedCheckoutIndex]).toMatchObject({
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: {
        ref: "${{ github.workflow_sha }}",
        "fetch-depth": 1,
        "persist-credentials": false,
        "sparse-checkout": ".github/actions/setup-android-toolchain",
        path: ".mobile-release-tooling",
      },
    });
    expect(validationSteps[checkoutIndex]).toMatchObject({
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: {
        ref: "${{ inputs.target_sha }}",
        "fetch-depth": 1,
        "persist-credentials": false,
        path: "candidate",
      },
    });
    expect(validationSteps[headIndex]?.env).toEqual({
      TARGET_SHA: "${{ inputs.target_sha }}",
    });
    expect(validationSteps[headIndex]?.run).toContain(
      'test "$(git -C candidate rev-parse HEAD)" = "$TARGET_SHA"',
    );
    expect(steps[trustedCheckoutIndex]).toMatchObject({
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: {
        ref: "${{ github.workflow_sha }}",
        "fetch-depth": 1,
        "persist-credentials": false,
        "sparse-checkout":
          ".github/actions/setup-android-toolchain\nscripts/android-sips-linux.sh\n",
        path: ".mobile-release-tooling",
      },
    });
    expect(steps[setupIndex]).toMatchObject({
      uses: "./.mobile-release-tooling/.github/actions/setup-android-toolchain",
      with: {
        "cache-mode": "off",
        "install-screenshot-emulators": "true",
      },
    });
    expect(JSON.stringify(steps)).not.toContain("candidate/");

    const tooling = steps[toolingIndex]?.run ?? "";
    expect(tooling).toContain('apt_source="/etc/apt/sources.list.d/ubuntu.sources"');
    expect(tooling).toContain(
      'apt_source_parts="$RUNNER_TEMP/openclaw-android-apt-sourceparts-disabled"',
    );
    expect(tooling).toContain('test -s "$apt_source"');
    expect(tooling).toContain('[[ -e "$apt_source_parts" || -L "$apt_source_parts" ]]');
    expect(tooling).toContain('/usr/bin/apt-get "${apt_options[@]}" update');
    expect(tooling).toMatch(
      /\/usr\/bin\/apt-get "\$\{apt_options\[@\]\}" install \\\n\s+-y --no-install-recommends imagemagick/u,
    );
    expect(tooling).toContain(
      'test "$(git -C "$trusted_root" rev-parse HEAD)" = "$GITHUB_WORKFLOW_SHA"',
    );
    expect(tooling).toContain('adapter_path="scripts/android-sips-linux.sh"');
    expect(tooling).toContain('git -C "$trusted_root" cat-file blob "$adapter_oid" >"$adapter"');
    expect(tooling).toContain('cmp -s "$trusted_root/$adapter_path" "$adapter"');
    expect(tooling).toContain('"$adapter" -s format jpeg -s formatOptions best');
    expect(tooling).toContain("for dimensions in 1440x2560 454x454; do");
    expect(tooling).toContain(
      '"$smoke_dir/input-${dimensions}.png" --out "$smoke_dir/output-${dimensions}.jpg"',
    );
    expect(tooling).not.toContain("candidate/");

    const toolchainAction = parse(
      fs.readFileSync(".github/actions/setup-android-toolchain/action.yml", "utf8"),
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
      const executable = (name: string, contents: string) => {
        const executablePath = path.join(bin, name);
        fs.writeFileSync(executablePath, contents, { mode: 0o755 });
        return executablePath;
      };
      const timeout = executable(
        "timeout",
        [
          "#!/bin/bash",
          "set -euo pipefail",
          'if [[ "${KVM_TIMEOUT_MODE:-run}" == "timeout" ]]; then exit 124; fi',
          "shift 3",
          'exec "$@"',
          "",
        ].join("\n"),
      );
      const sudo = executable("sudo", '#!/bin/bash\nexec "$@"\n');
      const udevadm = executable(
        "udevadm",
        '#!/bin/bash\nprintf "%s\\n" "$*" >>"$KVM_UDEV_TRACE"\n',
      );
      const stat = executable("stat", '#!/bin/bash\nprintf "%s:kvm:660\\n" "$(/usr/bin/id -u)"\n');
      executable("emulator", emulatorSource);
      // The real action runs unchanged except for host-only paths and privileged tool boundaries.
      const body = kvmSetup
        .replaceAll("/usr/bin/timeout", timeout)
        .replaceAll("/usr/bin/sudo", sudo)
        .replaceAll("/usr/bin/udevadm", udevadm)
        .replaceAll("/usr/bin/stat", stat)
        .replaceAll("/etc/udev/rules.d/99-openclaw-android-kvm.rules", rule)
        .replaceAll("/dev/kvm", "/dev/null");
      const result = spawnSync(
        "/bin/bash",
        ["-c", [body, 'printf "boot-or-signing\\n" >"$KVM_SENTINEL"'].join("\n")],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            KVM_SENTINEL: sentinel,
            KVM_TIMEOUT_MODE: timeoutMode,
            KVM_UDEV_TRACE: udevTrace,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            RUNNER_OS: "Linux",
            RUNNER_ARCH: "X64",
            RUNNER_TEMP: root,
          },
          timeout: 5_000,
        },
      );
      return { output: fs.readFileSync(output, "utf8"), result, root, rule, sentinel, udevTrace };
    };

    const usableKvm = runKvmFixture(
      "#!/bin/bash\nprintf 'KVM (version 12) is installed and usable.\\n'\n",
    );
    expect(usableKvm.result.status, usableKvm.result.stderr).toBe(0);
    expect(fs.readFileSync(usableKvm.sentinel, "utf8")).toBe("boot-or-signing\n");
    expect(fs.readFileSync(usableKvm.rule, "utf8")).toBe(
      `SUBSYSTEM=="misc", KERNEL=="kvm", OWNER="${process.getuid?.()}", GROUP="kvm", MODE="0660"\n`,
    );
    expect(fs.readFileSync(usableKvm.udevTrace, "utf8").trim().split("\n")).toEqual([
      "control --reload-rules",
      "trigger --action=change --subsystem-match=misc --sysname-match=kvm",
      "settle --timeout=15",
    ]);
    const kvmDiagnosticDir = path.join(usableKvm.root, "diagnostic");
    fs.mkdirSync(kvmDiagnosticDir);
    expect(steps[kvmIndex]?.if).toBe("always()");
    command("/bin/bash", ["-c", steps[kvmIndex]?.run ?? ""], {
      env: { ...process.env, RUNNER_TEMP: usableKvm.root, DIAGNOSTIC_DIR: kvmDiagnosticDir },
    });
    expect(fs.readFileSync(path.join(kvmDiagnosticDir, "emulator-kvm-check.txt"), "utf8")).toBe(
      usableKvm.output,
    );

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
    expect(timedOutKvm.output).toContain("exit_status=124");
    expect(timedOutKvm.output).toContain("timed_out=true");
    expect(fs.existsSync(timedOutKvm.sentinel)).toBe(false);

    const parityScript = validationSteps[parityIndex]?.run ?? "";
    expect(parityScript).toContain("git -C .mobile-release-tooling ls-tree");
    expect(parityScript).toContain("git -C candidate ls-tree");
    expect(parityScript).toContain("cat-file blob");
    expect(parityScript).toContain("cmp -s");

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
        fs.mkdirSync(repository);
        git(repository, "init", "-q");
        git(repository, "config", "user.name", "OpenClaw Test");
        git(repository, "config", "user.email", "test@openclaw.invalid");
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

      const result = spawnSync(
        "/bin/bash",
        ["-c", `${parityScript}\nprintf 'setup\\n' >"$SETUP_SENTINEL"\n`],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            RUNNER_TEMP: runnerTemp,
            SETUP_SENTINEL: sentinel,
          },
        },
      );
      return { result, sentinel };
    };

    const matching = runParityGate("matching");
    expect(matching.result.status, matching.result.stderr).toBe(0);
    expect(fs.readFileSync(matching.sentinel, "utf8")).toBe("setup\n");
    for (const candidate of ["modified", "symlink"] as const) {
      const rejected = runParityGate(candidate);
      expect(rejected.result.status).not.toBe(0);
      expect(fs.existsSync(rejected.sentinel)).toBe(false);
    }

    const diagnostic = steps[diagnosticIndex]?.run ?? "";
    expect(diagnostic).toContain(
      'printf \'no\\n\' | avdmanager create avd --force --name "$AVD_NAME" --package "$SYSTEM_IMAGE" --device "$DEVICE_PROFILE"',
    );
    expect(diagnostic).toContain(
      'emulator_args=(-avd "$AVD_NAME" -no-window -no-audio -no-boot-anim -verbose -show-kernel)',
    );
    expect(diagnostic).toContain("capture_accel_check() {");
    expect(diagnostic).toContain("accel_check_timeout_seconds=10");
    expect(diagnostic).toContain('emulator -accel-check >"$accel_raw" 2>&1 &');
    expect(diagnostic).toContain(
      'head -c 16384 "$accel_raw" >"$DIAGNOSTIC_DIR/emulator-accel-check.txt"',
    );
    expect(diagnostic).toContain(
      'printf \'exit_status=%s\\n\' "$accel_status" >>"$DIAGNOSTIC_DIR/emulator-accel-check.txt"',
    );
    expect(diagnostic).toContain(
      'printf \'timed_out=%s\\n\' "$accel_timed_out" >>"$DIAGNOSTIC_DIR/emulator-accel-check.txt"',
    );
    expect(diagnostic).toContain("sample_owned_qemu() {");
    expect(diagnostic).toContain(
      'printf \'\\n[%s] owned_emulator_pid=%s\\n\' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$emulator_pid"',
    );
    expect(diagnostic).toContain(
      'ps -p "$emulator_pid" -o pid=,ppid=,%cpu=,rss=,stat=,etime=,command=',
    );
    expect(diagnostic).toContain('>>"$DIAGNOSTIC_DIR/owned-qemu-samples.log" 2>&1');
    expect(diagnostic.match(/\bsample_owned_qemu\b/gu)).toHaveLength(5);

    const accelFunctionStart = diagnostic.indexOf("capture_accel_check() {");
    const accelFunctionEnd = diagnostic.indexOf("\n\nsample_owned_qemu()", accelFunctionStart);
    expect(accelFunctionStart).toBeGreaterThanOrEqual(0);
    expect(accelFunctionEnd).toBeGreaterThan(accelFunctionStart);
    const accelFunction = diagnostic
      .slice(accelFunctionStart, accelFunctionEnd)
      .replace("accel_check_timeout_seconds=10", "accel_check_timeout_seconds=3");
    const runAccelCheck = (emulatorSource: string) => {
      const root = tempRoots.make("openclaw-android-emulator-accel-check-");
      const bin = path.join(root, "bin");
      const diagnosticDir = path.join(root, "diagnostic");
      fs.mkdirSync(bin);
      fs.mkdirSync(diagnosticDir);
      fs.writeFileSync(path.join(bin, "emulator"), emulatorSource, { mode: 0o755 });
      const result = spawnSync(
        "/bin/bash",
        ["-c", `set -euo pipefail\n${accelFunction}\ncapture_accel_check\n`],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            DIAGNOSTIC_DIR: diagnosticDir,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          },
          timeout: 7_000,
        },
      );
      return {
        output: fs.readFileSync(path.join(diagnosticDir, "emulator-accel-check.txt"), "utf8"),
        result,
      };
    };

    const nonzeroAccel = runAccelCheck("#!/bin/bash\nprintf 'unavailable\\n'\nexit 7\n");
    expect(nonzeroAccel.result.status, nonzeroAccel.result.stderr).toBe(0);
    expect(nonzeroAccel.output).toContain("unavailable");
    expect(nonzeroAccel.output).toContain("exit_status=7");
    expect(nonzeroAccel.output).toContain("timed_out=false");

    const timedOutAccel = runAccelCheck("#!/bin/bash\nexec sleep 30\n");
    expect(timedOutAccel.result.status, timedOutAccel.result.stderr).toBe(0);
    expect(timedOutAccel.output).toContain("exit_status=124");
    expect(timedOutAccel.output).toContain("timed_out=true");

    expect(diagnostic).toContain("observe_after_readiness_timeout() {");
    expect(diagnostic).toContain("final_cold_boot_observation_seconds=900");
    expect(diagnostic).toContain("probe_timeout_seconds=5");
    expect(diagnostic).toContain("final_snapshot_lead_seconds=15");
    expect(diagnostic).toContain("snapshot_properties_max_bytes=65536");
    expect(diagnostic).toContain("snapshot_logcat_max_bytes=262144");
    expect(diagnostic).toContain("capture_cold_boot_snapshot() {");
    expect(diagnostic).toContain(
      "emulator_observation_deadline=$((emulator_launch_seconds + final_cold_boot_observation_seconds))",
    );
    expect(diagnostic).not.toContain("post_deadline_observation_seconds");
    expect(diagnostic).toContain("fail_after_readiness_timeout() {");
    const observationFunctionStart = diagnostic.indexOf("run_bounded_probe() {");
    const observationFunctionEnd = diagnostic.indexOf(
      "\n\nfail_after_readiness_timeout()",
      observationFunctionStart,
    );
    const failureFunctionEnd = diagnostic.indexOf("\n\ncleanup()", observationFunctionEnd);
    expect(observationFunctionStart).toBeGreaterThanOrEqual(0);
    expect(observationFunctionEnd).toBeGreaterThan(observationFunctionStart);
    expect(failureFunctionEnd).toBeGreaterThan(observationFunctionEnd);
    const observationFunctions = diagnostic
      .slice(observationFunctionStart, failureFunctionEnd)
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
      fs.writeFileSync(path.join(bin, "adb"), adbSource, { mode: 0o755 });
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
        elapsedSeconds: Number(fs.readFileSync(clockPath, "utf8").trim()),
        observations: fs.readFileSync(
          path.join(diagnosticDir, "post-deadline-observations.log"),
          "utf8",
        ),
        result: { ...result, status: result.code },
        snapshots: fs.existsSync(snapshotsRoot) ? fs.readdirSync(snapshotsRoot).toSorted() : [],
        snapshotsRoot,
      };
    };

    const lateReady = await runPostDeadlineObservation(`#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "devices" ]]; then
  printf 'List of devices attached\\nemulator-5554\\tdevice product:sdk model:sdk\\n'
elif [[ "\${1:-}" == "-s" && "\${3:-}" == "shell" ]]; then
  printf '1\\n'
elif [[ "\${1:-}" == "-s" && "\${3:-}" == "emu" ]]; then
  printf '%s\\nOK\\n' "\${AVD_NAME:?}"
fi
`);
    expect(lateReady.result.status).toBe(1);
    expect(lateReady.result.stderr).toContain("::error::latched readiness failure");
    expect(lateReady.observations).toContain("late_adb_online_at=");
    expect(lateReady.observations).toContain("late_boot_completed_at=");
    expect(lateReady.observations).toContain("observation_stop=late-boot-completed");
    expect(lateReady.snapshots).toEqual(["first-online"]);
    expect(
      fs.readFileSync(
        path.join(lateReady.snapshotsRoot, "first-online", "boot-properties.txt"),
        "utf8",
      ),
    ).toContain("probe_exit_status=0");

    const lateReadyNearCeilingFunctions = observationFunctions.replace(
      "final_snapshot_lead_seconds=4",
      "final_snapshot_lead_seconds=60",
    );
    const lateReadyNearCeiling = await runPostDeadlineObservation(
      `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "devices" ]]; then
  printf 'List of devices attached\\nemulator-5554\\tdevice product:sdk model:sdk\\n'
elif [[ "\${1:-}" == "-s" && "\${3:-}" == "shell" ]]; then
  printf '1\\n'
elif [[ "\${1:-}" == "-s" && "\${3:-}" == "emu" ]]; then
  printf '%s\\nOK\\n' "\${AVD_NAME:?}"
fi
`,
      { functions: lateReadyNearCeilingFunctions },
    );
    expect(lateReadyNearCeiling.result.status).toBe(1);
    expect(lateReadyNearCeiling.observations).toContain("late_boot_completed_at=");
    expect(lateReadyNearCeiling.observations).toContain("observation_stop=late-boot-completed");
    expect(lateReadyNearCeiling.snapshots).toEqual(["first-online"]);

    const [failedBootProbeResult, boundedSnapshotsResult] = await Promise.allSettled([
      runPostDeadlineObservation(
        `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "devices" ]]; then
  printf 'List of devices attached\\nemulator-5554\\tdevice product:sdk model:sdk\\n'
elif [[ "\${1:-}" == "-s" && "\${3:-}" == "emu" ]]; then
  printf '%s\\nOK\\n' "\${AVD_NAME:?}"
elif [[ "\${1:-}" == "-s" && "\${3:-}" == "shell" && "\${5:-}" == "sys.boot_completed" ]]; then
  exit 7
elif [[ "\${1:-}" == "-s" && "\${3:-}" == "shell" ]]; then
  printf '[init.svc.example]: [running]\\n'
elif [[ "\${1:-}" == "-s" && "\${3:-}" == "logcat" ]]; then
  printf 'system crash evidence line\\n'
fi
`,
        { functions: lateReadyNearCeilingFunctions },
      ),
      runPostDeadlineObservation(`#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "devices" ]]; then
  printf 'List of devices attached\\nemulator-5554\\tdevice product:sdk model:sdk\\n'
elif [[ "\${1:-}" == "-s" && "\${3:-}" == "emu" ]]; then
  printf '%s\\nOK\\n' "\${AVD_NAME:?}"
elif [[ "\${1:-}" == "-s" && "\${3:-}" == "shell" && "\${5:-}" == "sys.boot_completed" ]]; then
  printf '\\n'
elif [[ "\${1:-}" == "-s" && "\${3:-}" == "shell" ]]; then
  for _ in {1..40}; do printf '[init.svc.example]: [running]\\n'; done
elif [[ "\${1:-}" == "-s" && "\${3:-}" == "logcat" ]]; then
  for _ in {1..40}; do printf 'system crash evidence line\\n'; done
fi
`),
    ]);
    if (
      failedBootProbeResult.status === "rejected" &&
      boundedSnapshotsResult.status === "rejected"
    ) {
      throw new AggregateError(
        [failedBootProbeResult.reason, boundedSnapshotsResult.reason],
        "Android observation scenarios failed",
      );
    }
    if (failedBootProbeResult.status === "rejected") {
      throw failedBootProbeResult.reason;
    }
    if (boundedSnapshotsResult.status === "rejected") {
      throw boundedSnapshotsResult.reason;
    }
    const failedBootProbeNearCeiling = failedBootProbeResult.value;
    const boundedSnapshots = boundedSnapshotsResult.value;
    expect(failedBootProbeNearCeiling.result.status).toBe(1);
    expect(failedBootProbeNearCeiling.elapsedSeconds).toBe(12);
    expect(failedBootProbeNearCeiling.observations).toContain("boot_status=7");
    expect(failedBootProbeNearCeiling.snapshots).toEqual(["first-online", "near-ceiling"]);

    const unrelatedDevice = await runPostDeadlineObservation(`#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "devices" ]]; then
  printf 'List of devices attached\\nemulator-5554\\tdevice product:sdk model:sdk\\n'
elif [[ "\${1:-}" == "-s" && "\${3:-}" == "emu" ]]; then
  printf 'Another_AVD\\nOK\\n'
elif [[ "\${1:-}" == "-s" && "\${3:-}" == "shell" ]]; then
  printf '1\\n'
fi
`);
    expect(unrelatedDevice.result.status).toBe(1);
    expect(unrelatedDevice.observations).toContain("observation_stop=unexpected-avd");
    expect(unrelatedDevice.observations).not.toContain("late_adb_online_at=");
    expect(unrelatedDevice.observations).not.toContain("late_boot_completed_at=");
    expect(unrelatedDevice.snapshots).toEqual([]);

    const changedDevice = await runPostDeadlineObservation(
      `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "devices" ]]; then
  printf 'List of devices attached\\nemulator-5556\\tdevice product:sdk model:sdk\\n'
fi
`,
      { initialSerial: "emulator-5554" },
    );
    expect(changedDevice.result.status).toBe(1);
    expect(changedDevice.observations).toContain("observation_stop=unexpected-device-change");
    expect(changedDevice.snapshots).toEqual([]);

    const capped = await runPostDeadlineObservation(
      `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "devices" ]]; then
  printf 'List of devices attached\\n\\n'
fi
`,
      { deadlineSeconds: 2 },
    );
    expect(capped.result.status).toBe(1);
    expect(capped.elapsedSeconds).toBe(2);
    expect(capped.result.stderr).toContain("::error::latched readiness failure");
    expect(capped.observations).toContain("observation_cap_seconds=900");
    expect(capped.observations).toContain("observation_stop=observation-cap-reached");

    const absoluteCap = await runPostDeadlineObservation(
      `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == "devices" ]]; then
  printf 'List of devices attached\\n\\n'
fi
`,
      { deadlineSeconds: 3, preObservationDelaySeconds: 2 },
    );
    expect(absoluteCap.result.status).toBe(1);
    expect(absoluteCap.elapsedSeconds).toBe(3);
    expect(absoluteCap.durationMs).toBeLessThan(5_000);
    expect(absoluteCap.observations).toContain("observation_stop=observation-cap-reached");

    expect(boundedSnapshots.result.status).toBe(1);
    expect(boundedSnapshots.elapsedSeconds).toBe(12);
    expect(boundedSnapshots.observations).toContain("observation_stop=observation-cap-reached");
    expect(boundedSnapshots.snapshots).toEqual(["first-online", "near-ceiling"]);
    for (const snapshot of boundedSnapshots.snapshots) {
      const properties = fs.readFileSync(
        path.join(boundedSnapshots.snapshotsRoot, snapshot, "boot-properties.txt"),
        "utf8",
      );
      const logcat = fs.readFileSync(
        path.join(boundedSnapshots.snapshotsRoot, snapshot, "system-crash-logcat.txt"),
        "utf8",
      );
      expect(properties).toContain("output_truncated=true");
      expect(properties).toContain("retained_bytes=64");
      expect(logcat).toContain("output_truncated=true");
      expect(logcat).toContain("retained_bytes=128");
    }

    const probeFunctionEnd = observationFunctions.indexOf("\n\nobserve_after_readiness_timeout()");
    expect(probeFunctionEnd).toBeGreaterThan(0);
    const probeFunction = observationFunctions.slice(0, probeFunctionEnd);
    const fastProbeStartedAt = Date.now();
    const fastProbe = spawnSync(
      "/bin/bash",
      [
        "-c",
        [
          "set -euo pipefail",
          probeFunction,
          'run_bounded_probe "$PROBE_OUTPUT" "$((SECONDS + 10))" /usr/bin/true',
          'printf "status=%s timed_out=%s\\n" "$probe_status" "$probe_timed_out"',
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PROBE_OUTPUT: path.join(tempRoots.make("openclaw-android-probe-fast-"), "probe.txt"),
        },
        timeout: 2_000,
      },
    );
    expect(fastProbe.status, fastProbe.stderr).toBe(0);
    expect(fastProbe.stdout).toBe("status=0 timed_out=false\n");
    expect(Date.now() - fastProbeStartedAt).toBeLessThan(2_000);

    const probeTimeoutRoot = tempRoots.make("openclaw-android-probe-timeout-");
    const probePidFile = path.join(probeTimeoutRoot, "probe.pid");
    const probeTimeout = spawnSync(
      "/bin/bash",
      [
        "-c",
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
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PROBE_OUTPUT: path.join(probeTimeoutRoot, "probe.txt"),
          PROBE_PID_FILE: probePidFile,
          PROBE_READY_FILE: path.join(probeTimeoutRoot, "probe.ready"),
        },
        timeout: 5_000,
      },
    );
    expect(probeTimeout.status, probeTimeout.stderr).toBe(0);
    expect(probeTimeout.stdout).toBe("status=124 timed_out=true\n");
    const probePid = Number.parseInt(fs.readFileSync(probePidFile, "utf8").trim(), 10);
    expect(() => process.kill(probePid, 0)).toThrow();

    const cleanupFunctionStart = diagnostic.indexOf("cleanup() {");
    const cleanupFunctionEnd = diagnostic.indexOf("\ntrap cleanup EXIT", cleanupFunctionStart);
    expect(cleanupFunctionStart).toBeGreaterThan(failureFunctionEnd);
    expect(cleanupFunctionEnd).toBeGreaterThan(cleanupFunctionStart);
    const cleanupFunction = diagnostic.slice(cleanupFunctionStart, cleanupFunctionEnd);
    const hangingRoot = tempRoots.make("openclaw-android-emulator-hanging-adb-");
    const hangingBin = path.join(hangingRoot, "bin");
    const hangingDiagnosticDir = path.join(hangingRoot, "diagnostic");
    const adbPidFile = path.join(hangingRoot, "adb.pid");
    const emulatorPidFile = path.join(hangingRoot, "emulator.pid");
    fs.mkdirSync(hangingBin);
    fs.mkdirSync(hangingDiagnosticDir);
    fs.writeFileSync(
      path.join(hangingBin, "adb"),
      '#!/bin/bash\nset -euo pipefail\nprintf \'%s\\n\' "$$" >"$ADB_PID_FILE"\nexec sleep 30\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(hangingBin, "avdmanager"),
      "#!/bin/bash\nset -euo pipefail\nprintf 'cleanup\\n' >>\"$CLEANUP_TRACE\"\n",
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(hangingBin, "ps"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
    const hangingResult = spawnSync(
      "/bin/bash",
      [
        "-c",
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
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ADB_PID_FILE: adbPidFile,
          CLEANUP_TRACE: path.join(hangingRoot, "cleanup.trace"),
          DIAGNOSTIC_DIR: hangingDiagnosticDir,
          EMULATOR_PID_FILE: emulatorPidFile,
          PATH: `${hangingBin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        timeout: 10_000,
      },
    );
    expect(hangingResult.status, hangingResult.stderr).toBe(1);
    const hangingObservations = fs.readFileSync(
      path.join(hangingDiagnosticDir, "post-deadline-observations.log"),
      "utf8",
    );
    expect(hangingObservations).toContain("adb_timed_out=true");
    expect(hangingObservations).toContain("observation_stop=observation-cap-reached");
    expect(fs.readFileSync(path.join(hangingRoot, "cleanup.trace"), "utf8")).toBe("cleanup\n");
    expect(fs.readFileSync(path.join(hangingDiagnosticDir, "cleanup.log"), "utf8")).toContain(
      "adb_kill_server_skipped_after_latched_timeout=true",
    );
    for (const pidFile of [adbPidFile, emulatorPidFile]) {
      const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      expect(() => process.kill(pid, 0)).toThrow();
    }
    expect(diagnostic).toContain(
      "device_deadline=$((SECONDS + ANDROID_SCREENSHOT_EMULATOR_TIMEOUT_SECONDS))",
    );
    expect(diagnostic).toContain(
      "boot_deadline=$((SECONDS + ANDROID_SCREENSHOT_EMULATOR_TIMEOUT_SECONDS))",
    );
    expect(diagnostic).toContain('>"$DIAGNOSTIC_DIR/emulator.log" 2>&1 &');
    expect(diagnostic).toContain("adb devices -l");
    expect(diagnostic).toContain('>>"$DIAGNOSTIC_DIR/adb-observations.log" 2>&1');
    expect(diagnostic).toContain('ps -p "$emulator_pid"');
    expect(diagnostic).toContain('kill "$emulator_pid"');
    expect(diagnostic).toContain("adb kill-server");
    expect(diagnostic).toContain("trap cleanup EXIT");
    expect(diagnostic).toMatch(
      /fail_after_readiness_timeout \\\n\s+"Timed out waiting for exactly one Android emulator device" ""/u,
    );
    expect(diagnostic).toMatch(
      /fail_after_readiness_timeout \\\n\s+"Timed out waiting for Android emulator boot completion" "\$serial"/u,
    );
    expect(steps[artifactIndex]).toMatchObject({
      if: "always()",
      uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      with: {
        name: "android-emulator-diagnostic-${{ github.run_id }}-${{ github.run_attempt }}",
        path: "${{ runner.temp }}/android-emulator-diagnostic",
        "retention-days": 7,
      },
    });
    expect(source).not.toMatch(/\$\{\{\s*secrets\./u);
    expect(source).not.toContain("environment:");
    expect(source).not.toMatch(/\b(?:pnpm|gradle|fastlane)\b/iu);
    expect(source).not.toMatch(/apps-signing|MATCH_PASSWORD|GOOGLE_PLAY|upload-and-record/iu);
  });

  it("generates two-axis varied-color Android conversion smoke inputs", () => {
    const workflow = parse(
      fs.readFileSync(".github/workflows/android-emulator-diagnostic.yml", "utf8"),
    ) as {
      jobs: Record<string, { steps?: Array<{ name: string; run?: string }> }>;
    };
    const tooling = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .find((step) => step.name === "Prepare trusted Linux Android tooling")?.run;

    expect(tooling).toMatch(
      /width="\$\{dimensions%x\*\}"\n\s+height="\$\{dimensions#\*x\}"\n\s+\/usr\/bin\/convert \\\n\s+\\\( -size "\$dimensions" 'gradient:#000000-#ff0000' \\\) \\\n\s+\\\( -size "\$\{height\}x\$\{width\}" 'gradient:#000000-#00ff00' -transpose \\\) \\\n\s+-compose plus -composite \\\n\s+-alpha set -channel A -evaluate set 60% \+channel/u,
    );
    expect(tooling).not.toContain("'xc:");
    expect(tooling).toMatch(
      /\/usr\/bin\/identify \+ping \\\n\s+-format 'format=%m width=%w height=%h colorspace=%\[colorspace\] type=%\[type\] channels=%\[channels\] quality=%Q\\n'/u,
    );
    expect(tooling).not.toContain("/usr/bin/identify -ping");
  });

  it("isolates Ubuntu APT sources before Android tooling setup", () => {
    const workflowFiles = [
      ".github/workflows/android-emulator-diagnostic.yml",
      ".github/workflows/android-store-release.yml",
    ] as const;

    const readToolingBody = (file: string): string => {
      const workflow = parse(fs.readFileSync(file, "utf8")) as {
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

    const pathExists = (target: string): boolean => {
      try {
        fs.lstatSync(target);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }
        throw error;
      }
    };

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
      const adapterSource = [
        "#!/bin/bash",
        "set -euo pipefail",
        'output=""',
        "while (( $# > 0 )); do",
        '  if [[ "$1" == "--out" ]]; then output="$2"; shift 2; else shift; fi',
        "done",
        'test -n "$output"',
        'printf "jpeg\\n" >"$output"',
        'printf "adapter\\n" >"$ADAPTER_SENTINEL"',
        "",
      ].join("\n");
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

      const writeExecutable = (name: string, source: string): string => {
        const executable = path.join(bin, name);
        fs.writeFileSync(executable, source, { mode: 0o755 });
        return executable;
      };
      const timeout = writeExecutable(
        "timeout",
        [
          "#!/bin/bash",
          "set -euo pipefail",
          "while (( $# > 0 )); do",
          '  case "$1" in',
          "    --signal=*|--kill-after=*) shift ;;",
          "    300s) shift; break ;;",
          "    *) exit 91 ;;",
          "  esac",
          "done",
          'exec "$@"',
          "",
        ].join("\n"),
      );
      const sudo = writeExecutable(
        "sudo",
        [
          "#!/bin/bash",
          "set -euo pipefail",
          'test "$1" = "env"',
          "shift",
          'while (( $# > 0 )) && [[ "$1" == *=* ]]; do export "$1"; shift; done',
          'exec "$@"',
          "",
        ].join("\n"),
      );
      const aptGet = writeExecutable(
        "apt-get",
        [
          "#!/bin/bash",
          "set -euo pipefail",
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
          "",
        ].join("\n"),
      );
      const convert = writeExecutable(
        "convert",
        [
          "#!/bin/bash",
          "set -euo pipefail",
          'output="${!#}"',
          'printf "png\\n" >"$output"',
          "",
        ].join("\n"),
      );
      const identify = writeExecutable(
        "identify",
        [
          "#!/bin/bash",
          "set -euo pipefail",
          "printf 'format=JPEG width=1 height=1 colorspace=sRGB type=TrueColor channels=3.0 quality=95\\n'",
          "",
        ].join("\n"),
      );
      writeExecutable(
        "git",
        [
          "#!/bin/bash",
          "set -euo pipefail",
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
          "",
        ].join("\n"),
      );

      for (const trustedRoot of [path.join(root, ".mobile-release-tooling"), root]) {
        writeFile(trustedRoot, "scripts/android-sips-linux.sh", adapterSource);
        fs.chmodSync(path.join(trustedRoot, "scripts/android-sips-linux.sh"), 0o755);
      }
      fs.writeFileSync(path.join(root, "adapter-source.sh"), adapterSource, { mode: 0o755 });

      let body = readToolingBody(file);
      if (options.broadSource) {
        body = body
          .replace('/usr/bin/apt-get "${apt_options[@]}" update', "/usr/bin/apt-get update")
          .replace('/usr/bin/apt-get "${apt_options[@]}" install', "/usr/bin/apt-get install");
      }
      body = body
        .replaceAll("/usr/bin/timeout", timeout)
        .replaceAll("/usr/bin/sudo", sudo)
        .replaceAll("/usr/bin/apt-get", aptGet)
        .replaceAll("/usr/bin/convert", convert)
        .replaceAll("/usr/bin/identify", identify)
        .replaceAll("/etc/apt/sources.list.d/ubuntu.sources", aptSource);

      const result = spawnSync(
        "/bin/bash",
        ["-c", [body, 'printf "kvm\\n" >"$KVM_SENTINEL"'].join("\n")],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
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
          timeout: 5_000,
        },
      );
      return {
        adapterSentinel: path.join(runnerTemp, "openclaw-android-tools/android-sips-linux.sh"),
        aptSource,
        aptSourceParts,
        calls: fs.existsSync(aptLog)
          ? fs.readFileSync(aptLog, "utf8").trim().split("\n").filter(Boolean)
          : [],
        installSentinel,
        kvmSentinel,
        result,
      };
    };

    for (const file of workflowFiles) {
      const broad = runToolingFixture(file, { broadSource: true });
      expect(broad.result.status, `${file}: broad source should fail`).toBe(100);
      expect(fs.existsSync(broad.installSentinel)).toBe(false);
      expect(fs.existsSync(broad.adapterSentinel)).toBe(false);
      expect(fs.existsSync(broad.kvmSentinel)).toBe(false);

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
      expect(fs.existsSync(restricted.installSentinel)).toBe(true);
      expect(fs.existsSync(restricted.adapterSentinel)).toBe(true);
      expect(fs.existsSync(restricted.kvmSentinel)).toBe(true);

      const failedUpdate = runToolingFixture(file, { updateExit: 100 });
      expect(failedUpdate.result.status).toBe(100);
      expect(failedUpdate.calls).toHaveLength(1);
      expect(fs.existsSync(failedUpdate.installSentinel)).toBe(false);
      expect(fs.existsSync(failedUpdate.adapterSentinel)).toBe(false);
      expect(fs.existsSync(failedUpdate.kvmSentinel)).toBe(false);

      for (const sourceState of ["missing", "empty"] as const) {
        const guarded = runToolingFixture(file, { sourceState });
        expect(guarded.result.status, `${file}: ${sourceState} source`).not.toBe(0);
        expect(guarded.calls).toEqual([]);
        expect(fs.existsSync(guarded.adapterSentinel)).toBe(false);
        expect(fs.existsSync(guarded.kvmSentinel)).toBe(false);
      }

      for (const sourcePartsState of ["directory", "symlink"] as const) {
        const guarded = runToolingFixture(file, { sourcePartsState });
        expect(guarded.result.status, `${file}: ${sourcePartsState} source parts`).not.toBe(0);
        expect(guarded.calls).toEqual([]);
        expect(pathExists(guarded.aptSourceParts)).toBe(true);
        expect(fs.existsSync(guarded.adapterSentinel)).toBe(false);
        expect(fs.existsSync(guarded.kvmSentinel)).toBe(false);
      }
    }
  });

  it("runs the iOS signing proof through the prepared Fastlane environment", () => {
    const source = fs.readFileSync(".github/workflows/ios-release.yml", "utf8");
    const workflow = parse(source) as {
      jobs: {
        release: {
          steps: Array<{
            env?: Record<string, string>;
            name: string;
            run?: string;
            uses?: string;
            with?: Record<string, unknown>;
          }>;
        };
      };
    };
    const releaseSteps = workflow.jobs.release.steps;
    const createIndex = releaseSteps.findIndex(
      (step) => step.name === "Create job-owned iOS signing keychain",
    );
    const signingProofIndex = releaseSteps.findIndex(
      (step) => step.name === "Validate readonly iOS signing key access",
    );
    const uploadIndex = releaseSteps.findIndex(
      (step) => step.name === "Prepare and upload iOS release",
    );

    expect(createIndex).toBeGreaterThan(-1);
    expect(releaseSteps[createIndex]?.uses).toBe("./.github/actions/ios-signing-keychain");
    expect(signingProofIndex).toBeGreaterThan(createIndex);
    expect(uploadIndex).toBeGreaterThan(signingProofIndex);
    expect(releaseSteps[signingProofIndex]?.env).toEqual({
      MATCH_PASSWORD: "${{ secrets.MATCH_PASSWORD }}",
    });
    const signingProof = releaseSteps[signingProofIndex]?.run;
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
    fs.writeFileSync(
      path.join(preparedBin, "pnpm"),
      [
        "#!/bin/bash",
        'printf "pnpm:%s\\n" "$*" >>"$FIXTURE_EVENTS"',
        "exec /bin/bash -lc 'source ./scripts/lib/ios-fastlane.sh && cd apps/ios && run_ios_fastlane ios signing_check'",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(loginBin, "bundle"),
      ["#!/bin/bash", 'printf "login-bundle:%s\\n" "$*" >>"$FIXTURE_EVENTS"', "exit 42", ""].join(
        "\n",
      ),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(preparedBin, "bundle"),
      [
        "#!/bin/bash",
        "set -euo pipefail",
        '[[ "$BUNDLE_GEMFILE" == "$FIXTURE_WORKSPACE/apps/ios/Gemfile" ]]',
        '[[ "$PWD" == "$FIXTURE_WORKSPACE/apps/ios" ]]',
        'printf "bundle:%s\\n" "$*" >>"$FIXTURE_EVENTS"',
        'if [[ "$2" == "check" ]]; then',
        '  [[ "${FIXTURE_FAIL_CHECK:-0}" != "1" ]] || exit 42',
        'elif [[ "$2" != "exec" || "$3" != "fastlane" || "$4" != "ios" || "$5" != "signing_check" ]]; then',
        "  exit 43",
        "fi",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(preparedBin, "node"),
      [
        "#!/bin/bash",
        "set -euo pipefail",
        '[[ "$PWD" == "$FIXTURE_WORKSPACE" ]]',
        '[[ "$*" == ".github/actions/ios-signing-keychain/keychain.mjs probe" ]]',
        'printf "probe:root-cwd\\n" >>"$FIXTURE_EVENTS"',
        "",
      ].join("\n"),
      { mode: 0o755 },
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
        events: fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean),
        result,
      };
    };

    const prepared = runSigningProof();
    expect(prepared.result.status, prepared.result.stderr).toBe(0);
    expect(prepared.events).toEqual([
      "bundle:_4.0.21_ check",
      "bundle:_4.0.21_ exec fastlane ios signing_check",
      "probe:root-cwd",
    ]);
    expect(signingProof).toContain("source ./scripts/lib/ios-fastlane.sh");
    expect(signingProof).toContain("(cd apps/ios && run_ios_fastlane ios signing_check)");

    const failedCheck = runSigningProof({ FIXTURE_FAIL_CHECK: "1" });
    expect(failedCheck.result.status).not.toBe(0);
    expect(failedCheck.events).toEqual(["bundle:_4.0.21_ check"]);

    const action = parse(
      fs.readFileSync(".github/actions/ios-signing-keychain/action.yml", "utf8"),
    ) as {
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
    fs.writeFileSync(path.join(fakeBin, "bundle"), '#!/bin/sh\n: > "$BUNDLE_MARKER"\nexit 99\n', {
      mode: 0o700,
    });

    const result = spawnSync(process.execPath, [".github/actions/ios-signing-keychain/post.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        BUNDLE_MARKER: bundleMarker,
        GITHUB_ENV: environmentFile,
        GITHUB_STATE: stateFile,
        GITHUB_WORKSPACE: workspace,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        RUNNER_TEMP: runnerTemp,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(bundleMarker)).toBe(false);
    expect(fs.existsSync(environmentFile)).toBe(false);
    expect(fs.existsSync(stateFile)).toBe(false);
    expect(
      fs
        .readdirSync(runnerTemp)
        .some((entry) => entry.startsWith("openclaw-ios-signing-keychain-")),
    ).toBe(false);
    const postSource = fs.readFileSync(".github/actions/ios-signing-keychain/post.mjs", "utf8");
    expect(postSource).toContain('import { cleanupOwnedKeychain } from "./keychain.mjs";');
    expect(postSource).not.toContain("createOwnedKeychain");
  });

  it("masks and owns both resolved iOS keychain filename forms through post cleanup", async () => {
    const workspace = tempRoots.make("openclaw-ios-keychain-workspace-");
    fs.mkdirSync(path.join(workspace, "apps/ios"), { recursive: true });
    for (const filenameSuffix of ["", "-db"] as const) {
      const runnerTemp = tempRoots.make(
        `openclaw-ios-keychain-${filenameSuffix ? "database" : "requested"}-`,
      );
      const environmentFile = path.join(runnerTemp, "environment");
      const stateFile = path.join(runnerTemp, "state");
      const env = {
        ...process.env,
        GITHUB_ENV: environmentFile,
        GITHUB_STATE: stateFile,
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runnerTemp,
      };
      let actionOutput = "";
      const output = {
        write(value: string) {
          actionOutput += value;
          return true;
        },
      };
      const commands: Array<{ args: string[]; executable: string }> = [];
      const runCommand = async (
        executable: string,
        args: string[],
        options: { env?: NodeJS.ProcessEnv },
      ) => {
        commands.push({ args, executable });
        expect(executable).toBe("bundle");
        if (args.includes("create_keychain")) {
          const requestedPath = args.find((argument) => argument.startsWith("path:"))?.slice(5);
          if (!requestedPath) {
            throw new Error("Missing create_keychain path");
          }
          expect(fs.readFileSync(stateFile, "utf8")).toContain(`requested_path=${requestedPath}\n`);
          const password = options.env?.KEYCHAIN_PASSWORD;
          expect(password).toMatch(/^[a-f0-9]{64}$/u);
          expect(args.join("\n")).not.toContain(password);
          fs.writeFileSync(`${requestedPath}${filenameSuffix}`, "owned keychain\n");
        } else if (args.includes("delete_keychain")) {
          const keychainPath = args
            .find((argument) => argument.startsWith("keychain_path:"))
            ?.slice("keychain_path:".length);
          if (!keychainPath) {
            throw new Error("Missing delete_keychain path");
          }
          fs.unlinkSync(keychainPath);
        } else {
          throw new Error(`Unexpected Fastlane action: ${args.join(" ")}`);
        }
        return { stderr: "", stdout: "" };
      };

      const created = await createOwnedKeychain({ env, output, runCommand });
      expect(created.resolvedPath).toBe(`${created.requestedPath}${filenameSuffix}`);
      expect(fs.statSync(created.ownedRoot).mode & 0o777).toBe(0o700);
      expect(actionOutput).toBe(`::add-mask::${created.password}\n`);
      expect(fs.readFileSync(environmentFile, "utf8")).toBe(
        `MATCH_KEYCHAIN_NAME=${created.resolvedPath}\n` +
          `MATCH_KEYCHAIN_PASSWORD=${created.password}\n`,
      );
      const state = Object.fromEntries(
        fs
          .readFileSync(stateFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split(/[=](.*)/su).slice(0, 2)),
      );
      expect(state.resolved_path).toBe(created.resolvedPath);
      await cleanupOwnedKeychain({
        env: {
          ...env,
          STATE_owned_root: state.owned_root,
          STATE_requested_path: state.requested_path,
          STATE_resolved_path: state.resolved_path,
        },
        runCommand,
      });
      expect(fs.existsSync(created.ownedRoot)).toBe(false);
      expect(commands.map(({ args }) => args[4])).toEqual(["create_keychain", "delete_keychain"]);
      expect(commands.at(-1)?.args).toContain(`keychain_path:${created.resolvedPath}`);
    }

    const source = fs.readFileSync(".github/actions/ios-signing-keychain/keychain.mjs", "utf8");
    expect(source.indexOf("maskSecret(password, output)")).toBeLessThan(
      source.indexOf(
        'appendCommandValue(environmentFile, "MATCH_KEYCHAIN_PASSWORD", password, appendFile)',
      ),
    );
    expect(source).toContain("default_keychain: false");
    expect(source).toContain("lock_after_timeout: true");
    expect(source).toContain("timeout: KEYCHAIN_LIFETIME_SECONDS");
    expect(source).not.toContain("skip_set_partition_list");
  });

  it("cleans a partial iOS keychain create and refuses paths outside its ownership", async () => {
    const workspace = tempRoots.make("openclaw-ios-keychain-partial-workspace-");
    fs.mkdirSync(path.join(workspace, "apps/ios"), { recursive: true });
    for (const filenameSuffix of ["", "-db"] as const) {
      const runnerTemp = tempRoots.make(
        `openclaw-ios-keychain-partial-${filenameSuffix ? "database" : "requested"}-`,
      );
      const environmentFile = path.join(runnerTemp, "environment");
      const stateFile = path.join(runnerTemp, "state");
      const env = {
        ...process.env,
        GITHUB_ENV: environmentFile,
        GITHUB_STATE: stateFile,
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runnerTemp,
      };
      const createCommand = async (_command: string, args: string[]) => {
        const requestedPath = args.find((argument) => argument.startsWith("path:"))?.slice(5);
        if (!requestedPath) {
          throw new Error("Missing partial create path");
        }
        fs.writeFileSync(`${requestedPath}${filenameSuffix}`, "partial keychain\n");
        throw new Error("partial create");
      };

      await expect(
        createOwnedKeychain({
          env,
          output: { write: () => true },
          runCommand: createCommand,
        }),
      ).rejects.toThrow("partial create");
      expect(fs.existsSync(environmentFile)).toBe(false);
      const state = Object.fromEntries(
        fs
          .readFileSync(stateFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split(/[=](.*)/su).slice(0, 2)),
      );
      const partialPath = `${state.requested_path}${filenameSuffix}`;
      expect(fs.existsSync(partialPath)).toBe(true);
      await cleanupOwnedKeychain({
        env: {
          ...env,
          STATE_owned_root: state.owned_root,
          STATE_requested_path: state.requested_path,
        },
        runCommand: async (_command: string, args: string[]) => {
          const keychainPath = args
            .find((argument) => argument.startsWith("keychain_path:"))
            ?.slice("keychain_path:".length);
          expect(keychainPath).toBe(partialPath);
          fs.unlinkSync(partialPath);
          return { stderr: "", stdout: "" };
        },
      });
      expect(fs.existsSync(state.owned_root)).toBe(false);
    }

    const runnerTemp = tempRoots.make("openclaw-ios-keychain-guard-runner-");
    const env = {
      ...process.env,
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: runnerTemp,
    };
    const outsidePath = path.join(runnerTemp, "outside.keychain-db");
    fs.writeFileSync(outsidePath, "not owned\n");
    const ownedRoot = fs.mkdtempSync(path.join(runnerTemp, "openclaw-ios-signing-keychain-"));
    const requestedPath = path.join(ownedRoot, "signing.keychain");
    let cleanupCalled = false;
    await expect(
      cleanupOwnedKeychain({
        env: {
          ...env,
          STATE_owned_root: ownedRoot,
          STATE_requested_path: requestedPath,
          STATE_resolved_path: outsidePath,
        },
        runCommand: async () => {
          cleanupCalled = true;
          return { stderr: "", stdout: "" };
        },
      }),
    ).rejects.toThrow("Unexpected owned keychain path");
    expect(cleanupCalled).toBe(false);
    expect(fs.existsSync(outsidePath)).toBe(true);

    const ambiguousRoot = fs.mkdtempSync(path.join(runnerTemp, "openclaw-ios-signing-keychain-"));
    const ambiguousRequestedPath = path.join(ambiguousRoot, "signing.keychain");
    fs.writeFileSync(ambiguousRequestedPath, "requested keychain\n");
    fs.writeFileSync(`${ambiguousRequestedPath}-db`, "database keychain\n");
    await expect(
      cleanupOwnedKeychain({
        env: {
          ...env,
          STATE_owned_root: ambiguousRoot,
          STATE_requested_path: ambiguousRequestedPath,
        },
        runCommand: async () => {
          cleanupCalled = true;
          return { stderr: "", stdout: "" };
        },
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
    for (const keychainFilename of ["signing.keychain", "signing.keychain-db"] as const) {
      const ownedRoot = fs.mkdtempSync(path.join(runnerTemp, "openclaw-ios-signing-keychain-"));
      const keychainPath = path.join(ownedRoot, keychainFilename);
      fs.writeFileSync(keychainPath, "owned keychain\n");
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
        expect(probePath).toBeTruthy();
        expect(fs.readFileSync(probePath as string)).toEqual(fs.readFileSync("/usr/bin/true"));
        if (args.includes("--force")) {
          expect(args).toContain(keychainPath);
        }
        if (args.includes("--display")) {
          return { stderr: "TeamIdentifier=FWJYW4S8P8\n", stdout: "" };
        }
        return { stderr: "", stdout: "" };
      };

      await expect(
        probeOwnedKeychain({
          env: {
            ...process.env,
            GITHUB_WORKSPACE: workspace,
            MATCH_KEYCHAIN_NAME: keychainPath,
            RUNNER_TEMP: runnerTemp,
          },
          runCommand,
        }),
      ).resolves.toEqual({
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

    const wrongTeamRoot = fs.mkdtempSync(path.join(runnerTemp, "openclaw-ios-signing-keychain-"));
    const wrongTeamPath = path.join(wrongTeamRoot, "signing.keychain");
    fs.writeFileSync(wrongTeamPath, "owned keychain\n");
    await expect(
      probeOwnedKeychain({
        env: {
          ...process.env,
          GITHUB_WORKSPACE: workspace,
          MATCH_KEYCHAIN_NAME: wrongTeamPath,
          RUNNER_TEMP: runnerTemp,
        },
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
    const missingRoot = fs.mkdtempSync(path.join(runnerTemp, "openclaw-ios-signing-keychain-"));
    await expect(
      probeOwnedKeychain({
        env: {
          ...process.env,
          GITHUB_WORKSPACE: workspace,
          MATCH_KEYCHAIN_NAME: path.join(missingRoot, "signing.keychain"),
          RUNNER_TEMP: runnerTemp,
        },
        runCommand: rejectUnsafeCommand,
      }),
    ).rejects.toThrow("Owned keychain is missing");
    const symlinkRoot = fs.mkdtempSync(path.join(runnerTemp, "openclaw-ios-signing-keychain-"));
    const symlinkTarget = path.join(runnerTemp, "foreign.keychain");
    fs.writeFileSync(symlinkTarget, "foreign keychain\n");
    fs.symlinkSync(symlinkTarget, path.join(symlinkRoot, "signing.keychain"));
    await expect(
      probeOwnedKeychain({
        env: {
          ...process.env,
          GITHUB_WORKSPACE: workspace,
          MATCH_KEYCHAIN_NAME: path.join(symlinkRoot, "signing.keychain"),
          RUNNER_TEMP: runnerTemp,
        },
        runCommand: rejectUnsafeCommand,
      }),
    ).rejects.toThrow("Owned keychain path is not a regular file");
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
          'const { spawn } = require("node:child_process");',
          'const fs = require("node:fs");',
          `const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], {`,
          '  stdio: ["ignore", process.stdout, process.stderr],',
          "});",
          "fs.writeFileSync(process.env.PID_FILE, `${process.pid}\\n${child.pid}\\n`);",
          'process.on("SIGTERM", () => {});',
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

  it("installs the pinned Watch Rust toolchain before iOS store access", () => {
    const source = fs.readFileSync(".github/workflows/ios-release.yml", "utf8");
    const workflow = parse(source) as {
      jobs: {
        release: {
          steps: Array<{
            if?: string;
            name: string;
            run?: string;
          }>;
        };
      };
    };
    const releaseSteps = workflow.jobs.release.steps;
    const xcodeIndex = releaseSteps.findIndex((step) => step.name === "Select Xcode");
    const rustIndex = releaseSteps.findIndex(
      (step) => step.name === "Install Watch Rust toolchain",
    );
    const storeAccessIndex = releaseSteps.findIndex(
      (step) => step.name === "Validate readonly iOS signing key access",
    );
    const uploadIndex = releaseSteps.findIndex(
      (step) => step.name === "Prepare and upload iOS release",
    );
    const rustStep = releaseSteps[rustIndex];

    expect(xcodeIndex).toBeGreaterThanOrEqual(0);
    expect(rustIndex).toBeGreaterThan(xcodeIndex);
    expect(storeAccessIndex).toBeGreaterThan(rustIndex);
    expect(uploadIndex).toBeGreaterThan(storeAccessIndex);
    expect(rustStep?.if).toBe("hashFiles('apps/shared/OpenClawWatchRTC/Cargo.toml') != ''");
    expect(rustStep?.run).toContain(
      `watch_toolchain="$(awk -F '"' '/^channel =/ { print $2; exit }' apps/shared/OpenClawWatchRTC/rust-toolchain.toml)"`,
    );
    expect(rustStep?.run).toContain('test -n "$watch_toolchain"');
    expect(rustStep?.run).toContain(
      'rustup toolchain install "$watch_toolchain" --profile minimal --component rust-src',
    );
    expect(rustStep?.run).toContain('echo "$HOME/.cargo/bin" >> "$GITHUB_PATH"');
  });
});
