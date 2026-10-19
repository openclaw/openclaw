import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = "scripts/android-screenshots.sh";
const LINUX_SIPS_ADAPTER = "scripts/android-sips-linux.sh";
const IMAGEMAGICK_CONVERT = "/usr/bin/convert";
const IMAGEMAGICK_IDENTIFY = "/usr/bin/identify";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const command = (file: string, args: string[]) => spawnSync(file, args, { encoding: "utf8" });

const runAndroidScreenshots = (args: string[], env: NodeJS.ProcessEnv = {}, script = SCRIPT) =>
  spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

function convertJpeg(input: string, output: string) {
  const options = "-s format jpeg -s formatOptions best".split(" ");
  return command("bash", [LINUX_SIPS_ADAPTER, ...options, input, "--out", output]);
}

function executable(root: string, name: string, source: string) {
  const file = path.join(root, name);
  writeFileSync(file, `#!/bin/bash\nset -euo pipefail\n${source}`, { mode: 0o755 });
  return file;
}

function captureFixture(formFactor: "phone" | "wear") {
  const root = tempDirs.make("openclaw-android-screenshot-");
  const script = path.join(root, SCRIPT);
  mkdirSync(path.dirname(script), { recursive: true });
  copyFileSync(SCRIPT, script);
  const args = ["--form-factor", formFactor, "--skip-build", "--skip-install"];
  return {
    root,
    run: (env: NodeJS.ProcessEnv) => runAndroidScreenshots(args, env, script),
  };
}

it("keeps artifact cleanup inside the repository-owned evidence directory", () => {
  const result = runAndroidScreenshots(["--dry-run"], {
    ANDROID_SCREENSHOT_ARTIFACT_DIR: process.env.HOME,
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain(".artifacts/android-screenshots/latest");
  expect(result.stdout).not.toContain(`Android screenshot artifacts: ${process.env.HOME}\n`);
});

it("keeps fixture readiness and device restoration aligned", () => {
  const script = readFileSync(SCRIPT, "utf8");
  const fixture = readFileSync(
    "apps/android/app/src/main/java/ai/openclaw/app/AndroidScreenshotFixture.kt",
    "utf8",
  );
  const chatReady = "The Android release is close.";

  expect(fixture).toContain(chatReady);
  expect(script).toContain(`chat) printf '%s\\n' "${chatReady}"`);
  for (const marker of [
    'shell wm density "$ORIGINAL_WM_DENSITY"',
    "shell wm density reset",
    'shell cmd alarm set-timezone "$ORIGINAL_TIME_ZONE"',
    'shell cmd time_zone_detector set_auto_detection_enabled "$ORIGINAL_AUTO_TIME_ZONE"',
    "com.google.android.wearable.sysui:id/charging_container",
    "shell input keyevent 4",
  ]) {
    expect(script).toContain(marker);
  }
});

it("rejects a physical device selected during screenshot discovery", () => {
  const { root, run } = captureFixture("phone");
  const adb = executable(
    root,
    "adb",
    `case "$*" in
  devices) printf 'List of devices attached\\nphysical-serial\\tdevice\\n'; exit 0 ;;
  '-s physical-serial emu avd name') exit 1 ;;
  '-s physical-serial shell getprop ro.kernel.qemu') printf '0\\n'; exit 0 ;;
esac
printf 'unexpected adb invocation: %s\\n' "$*" >&2
exit 97
`,
  );

  const result = run({ ADB: adb });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "Android screenshot capture requires an emulator; 'physical-serial' is not an emulator.",
  );
  expect(result.stderr).toContain("Pass --avd <name> or --device <emulator-serial>.");
  expect(result.stderr).not.toContain("Connected emulator 'unknown'");
  expect(result.stderr).not.toContain("unexpected adb invocation");
});

it("retains emulator diagnostics and the failing status when startup stops before screenshots", () => {
  const { root, run } = captureFixture("wear");
  const readyPipe = path.join(root, "emulator-ready");
  expect(command("mkfifo", [readyPipe]).status).toBe(0);
  const adb = executable(
    root,
    "adb",
    `if [[ "$1" == "devices" ]]; then
  printf 'List of devices attached\\n'
  [[ -e "$FIXTURE_ADB_DISCOVERED" ]] || { touch "$FIXTURE_ADB_DISCOVERED"; exit 0; }
  read -r ready < "$FIXTURE_EMULATOR_READY"
  printf 'emulator-5554\\tdevice\\n'
  exit 0
fi
[[ "$*" != '-s emulator-5554 wait-for-device' ]] || { echo 'Synthetic ADB startup failure' >&2; exit 42; }
printf 'unexpected adb invocation: %s\\n' "$*" >&2
exit 97
`,
  );
  const emulator = executable(
    root,
    "emulator",
    `if [[ "$1" == "-list-avds" ]]; then printf 'OpenClaw_Wear_Screenshots_API34\\n'; exit 0; fi
printf 'Synthetic Wear emulator startup diagnostic\\n' >&2
printf 'ready\\n' > "$FIXTURE_EMULATOR_READY"
`,
  );
  const result = run({
    ADB: adb,
    ANDROID_EMULATOR: emulator,
    ANDROID_WEAR_SCREENSHOT_DEVICE: "",
    ANDROID_WEAR_SCREENSHOT_AVD: "OpenClaw_Wear_Screenshots_API34",
    FIXTURE_ADB_DISCOVERED: path.join(root, "adb-discovered"),
    FIXTURE_EMULATOR_READY: readyPipe,
  });
  expect(result.status, result.stderr).toBe(42);
  expect(result.stderr).toContain("Synthetic ADB startup failure");
  expect(result.stderr).not.toContain("unexpected adb invocation");
  const artifacts = path.join(root, ".artifacts/android-screenshots/latest/wear");
  const artifact = (name: string) => readFileSync(path.join(artifacts, name), "utf8");
  expect(artifact("emulator.log")).toBe("Synthetic Wear emulator startup diagnostic\n");
  expect(artifact("emulator-args.txt")).toContain(
    "-avd OpenClaw_Wear_Screenshots_API34 -no-window -no-audio -no-boot-anim",
  );
  expect(artifact("process-status.txt")).toContain(
    "exit_status=42\nform_factor=wear\navd=OpenClaw_Wear_Screenshots_API34\n",
  );
});

it("rejects locale path escapes before dry-run output", () => {
  const result = runAndroidScreenshots(["--dry-run", "--locale", "../escape"]);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Invalid Android screenshot locale");
  expect(result.stderr).toContain("path separators and dot segments are not allowed");
  expect(result.stdout).not.toContain("Android screenshot output:");
});

it.runIf(existsSync(IMAGEMAGICK_CONVERT) && existsSync(IMAGEMAGICK_IDENTIFY))(
  "converts real phone and Wear PNGs to full-size true-color sRGB JPEGs",
  () => {
    const root = tempDirs.make("openclaw android sips real ");
    const malformedInput = path.join(root, "malformed input.png");
    const malformedOutput = path.join(root, "malformed output.jpg");
    writeFileSync(malformedInput, "not an image", "utf8");
    const malformed = convertJpeg(malformedInput, malformedOutput);
    expect(malformed.status).not.toBe(0);
    expect(malformed.stderr).toContain("input is not a readable image");
    expect(existsSync(malformedOutput)).toBe(false);

    for (const [dimensions, grayscale] of [
      ["1440x2560", false],
      ["454x454", false],
      ["32x32", true],
    ] as const) {
      const input = path.join(root, `input ${dimensions}.png`);
      const output = path.join(root, `output ${dimensions}.jpg`);
      const [width, height] = dimensions.split("x");
      const gradient = (size: string, color: string) => {
        const endColor = grayscale ? "#ffffff" : color;
        return ["(", "-size", size, `gradient:#000000-${endColor}`];
      };
      const fixture = command(IMAGEMAGICK_CONVERT, [
        ...gradient(dimensions, "#ff0000"),
        ")",
        ...gradient(`${height}x${width}`, "#00ff00"),
        ..."-transpose ) -compose plus -composite -alpha set -channel A -evaluate set 60% +channel".split(
          " ",
        ),
        input,
      ]);
      expect(fixture.status, fixture.stderr).toBe(0);

      const result = convertJpeg(input, output);
      expect(result.status, result.stderr).toBe(0);

      const description = command(IMAGEMAGICK_IDENTIFY, [
        "+ping",
        "-format",
        "%m|%wx%h|%[colorspace]|%z|%[channels]|%Q",
        output,
      ]);
      expect(description.status, description.stderr).toBe(0);
      const [format, size, colorspace, depth, channels, quality] = description.stdout.split("|");
      expect([format, size, colorspace?.toLowerCase(), depth, channels?.toLowerCase()]).toEqual([
        "JPEG",
        dimensions,
        "srgb",
        "8",
        expect.stringMatching(/^srgb(?:[ \t]+3\.0)?$/),
      ]);
      expect(Number(quality)).toBeGreaterThanOrEqual(90);
      const encoding = command("/usr/bin/file", [output]);
      expect(encoding.status, encoding.stderr).toBe(0);
      expect(encoding.stdout).toContain("precision 8");
      expect(encoding.stdout).toContain("components 3");
    }
  },
);
