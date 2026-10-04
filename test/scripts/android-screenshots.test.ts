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
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = "scripts/android-screenshots.sh";
const LINUX_SIPS_ADAPTER = "scripts/android-sips-linux.sh";
const IMAGEMAGICK_CONVERT = "/usr/bin/convert";
const IMAGEMAGICK_IDENTIFY = "/usr/bin/identify";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runAndroidScreenshots(args: string[], env: NodeJS.ProcessEnv = {}, script = SCRIPT) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function copyScreenshotScript(root: string): string {
  const script = path.join(root, SCRIPT);
  mkdirSync(path.dirname(script), { recursive: true });
  copyFileSync(SCRIPT, script);
  return script;
}

function runLinuxSipsAdapter(args: string[]) {
  return spawnSync("bash", [LINUX_SIPS_ADAPTER, ...args], {
    encoding: "utf8",
    env: process.env,
  });
}

describe("android screenshots script", () => {
  it("dry-runs with a normalized locale output path", () => {
    const result = runAndroidScreenshots(["--dry-run", "--locale", "pt-BR"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "apps/android/fastlane/metadata/android/pt-BR/images/phoneScreenshots",
    );
    expect(result.stdout).toContain(
      "apps/android/fastlane/metadata/android/pt-BR/images/wearScreenshots",
    );
    expect(result.stdout).toContain(".artifacts/android-screenshots/latest/phone");
    expect(result.stdout).toContain(".artifacts/android-screenshots/latest/wear");
    expect(result.stdout).toContain("Android screenshot size: 1440x2560");
    expect(result.stdout).toContain("Android screenshot size: 454x454");
    expect(result.stdout).toContain("Screenshot AVD: OpenClaw_Screenshots_API36");
    expect(result.stdout).toContain("Screenshot AVD: OpenClaw_Wear_Screenshots_API34");
    expect(result.stdout).toContain("Screenshot device profile: pixel_2");
    expect(result.stdout).toContain("Screenshot device profile: wearos_large_round");
    expect(result.stdout).toContain("Scenes: home chat settings gateway voice-wake");
    expect(result.stdout).toContain("Scenes: chat voice controls");
    expect(result.stdout).not.toContain("connect chat voice screen settings");
    expect(result.stdout).toContain("Dry run complete.");
  });

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
    const root = tempDirs.make("openclaw-android-screenshot-adb-");
    const script = copyScreenshotScript(root);
    const adb = path.join(root, "adb");
    writeFileSync(
      adb,
      `#!/usr/bin/env bash
if [[ "$1" == "devices" ]]; then
  printf 'List of devices attached\\nphysical-serial\\tdevice\\n'
  exit 0
fi
if [[ "$1" == "-s" && "$2" == "physical-serial" && "$3" == "emu" && "$4" == "avd" && "$5" == "name" ]]; then
  exit 1
fi
if [[ "$1" == "-s" && "$2" == "physical-serial" && "$3" == "shell" && "$4" == "getprop" && "$5" == "ro.kernel.qemu" ]]; then
  printf '0\\n'
  exit 0
fi
printf 'unexpected adb invocation: %s\\n' "$*" >&2
exit 97
`,
      "utf8",
    );
    chmodSync(adb, 0o755);

    const result = runAndroidScreenshots(
      ["--form-factor", "phone", "--skip-build", "--skip-install"],
      { ADB: adb },
      script,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Android screenshot capture requires an emulator; 'physical-serial' is not an emulator.",
    );
    expect(result.stderr).toContain("Pass --avd <name> or --device <emulator-serial>.");
    expect(result.stderr).not.toContain("Connected emulator 'unknown'");
    expect(result.stderr).not.toContain("unexpected adb invocation");
  });

  it("retains emulator diagnostics and the failing status when startup stops before screenshots", () => {
    const root = tempDirs.make("openclaw-android-screenshot-startup-");
    const script = copyScreenshotScript(root);
    const readyPipe = path.join(root, "emulator-ready");
    const fifo = spawnSync("mkfifo", [readyPipe], { encoding: "utf8" });
    expect(fifo.status, fifo.stderr).toBe(0);
    const adb = path.join(root, "adb");
    const emulator = path.join(root, "emulator");
    writeFileSync(
      adb,
      `#!/bin/bash
set -euo pipefail
if [[ "$1" == "devices" ]]; then
  printf 'List of devices attached\\n'
  if [[ ! -e "$FIXTURE_ADB_DISCOVERED" ]]; then
    touch "$FIXTURE_ADB_DISCOVERED"
    exit 0
  fi
  read -r ready < "$FIXTURE_EMULATOR_READY"
  printf 'emulator-5554\\tdevice\\n'
  exit 0
fi
if [[ "$*" == '-s emulator-5554 wait-for-device' ]]; then
  echo 'Synthetic ADB startup failure' >&2
  exit 42
fi
printf 'unexpected adb invocation: %s\\n' "$*" >&2
exit 97
`,
    );
    writeFileSync(
      emulator,
      `#!/bin/bash
set -euo pipefail
if [[ "$1" == "-list-avds" ]]; then
  printf 'OpenClaw_Wear_Screenshots_API34\\n'
  exit 0
fi
printf 'Synthetic Wear emulator startup diagnostic\\n' >&2
printf 'ready\\n' > "$FIXTURE_EMULATOR_READY"
`,
    );
    chmodSync(adb, 0o755);
    chmodSync(emulator, 0o755);
    const result = runAndroidScreenshots(
      ["--form-factor", "wear", "--skip-build", "--skip-install"],
      {
        ADB: adb,
        ANDROID_EMULATOR: emulator,
        ANDROID_WEAR_SCREENSHOT_DEVICE: "",
        ANDROID_WEAR_SCREENSHOT_AVD: "OpenClaw_Wear_Screenshots_API34",
        FIXTURE_ADB_DISCOVERED: path.join(root, "adb-discovered"),
        FIXTURE_EMULATOR_READY: readyPipe,
      },
      script,
    );
    expect(result.status, result.stderr).toBe(42);
    expect(result.stderr).toContain("Synthetic ADB startup failure");
    expect(result.stderr).not.toContain("unexpected adb invocation");
    const artifacts = path.join(root, ".artifacts/android-screenshots/latest/wear");
    expect(readFileSync(path.join(artifacts, "emulator.log"), "utf8")).toBe(
      "Synthetic Wear emulator startup diagnostic\n",
    );
    expect(readFileSync(path.join(artifacts, "emulator-args.txt"), "utf8")).toContain(
      "-avd OpenClaw_Wear_Screenshots_API34 -no-window -no-audio -no-boot-anim",
    );
    expect(readFileSync(path.join(artifacts, "process-status.txt"), "utf8")).toContain(
      "exit_status=42\nform_factor=wear\navd=OpenClaw_Wear_Screenshots_API34\n",
    );
  });

  it.each(["../escape", "en/US", ".hidden", "en..US", ""])(
    "rejects locale path escapes before dry-run output: %j",
    (locale) => {
      const result = runAndroidScreenshots(["--dry-run", "--locale", locale]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Invalid Android screenshot locale");
      expect(result.stderr).toContain("path separators and dot segments are not allowed");
      expect(result.stdout).not.toContain("Android screenshot output:");
    },
  );

  it("rejects screenshot dimensions outside Google Play's aspect-ratio limit", () => {
    const result = runAndroidScreenshots(["--dry-run"], {
      ANDROID_SCREENSHOT_SIZE: "1080x2424",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not meet Google Play dimension and aspect-ratio limits");
  });

  it("requires a form factor when selecting one emulator explicitly", () => {
    const result = runAndroidScreenshots(["--dry-run", "--avd", "custom"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "--device and --avd require --form-factor phone or --form-factor wear",
    );
  });

  it("requires one form factor when retaining an emulator", () => {
    const result = runAndroidScreenshots(["--dry-run", "--keep-emulator"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "--keep-emulator requires --form-factor phone or --form-factor wear",
    );
  });

  it("rejects unsupported Linux SIPS arguments", () => {
    const wrongArguments = runLinuxSipsAdapter(["--help"]);
    expect(wrongArguments.status).toBe(2);
    expect(wrongArguments.stderr).toContain("unsupported arguments");
  });

  it.runIf(existsSync(IMAGEMAGICK_CONVERT) && existsSync(IMAGEMAGICK_IDENTIFY))(
    "converts real phone and Wear PNGs to full-size true-color sRGB JPEGs",
    () => {
      const root = tempDirs.make("openclaw android sips real ");
      const malformedInput = path.join(root, "malformed input.png");
      const malformedOutput = path.join(root, "malformed output.jpg");
      writeFileSync(malformedInput, "not an image", "utf8");
      const malformed = runLinuxSipsAdapter([
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        "best",
        malformedInput,
        "--out",
        malformedOutput,
      ]);
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
        const fixture = spawnSync(
          IMAGEMAGICK_CONVERT,
          [
            "(",
            "-size",
            dimensions,
            grayscale ? "gradient:#000000-#ffffff" : "gradient:#000000-#ff0000",
            ")",
            "(",
            "-size",
            `${height}x${width}`,
            grayscale ? "gradient:#000000-#ffffff" : "gradient:#000000-#00ff00",
            "-transpose",
            ")",
            "-compose",
            "plus",
            "-composite",
            "-alpha",
            "set",
            "-channel",
            "A",
            "-evaluate",
            "set",
            "60%",
            "+channel",
            input,
          ],
          { encoding: "utf8" },
        );
        expect(fixture.status, fixture.stderr).toBe(0);

        const result = runLinuxSipsAdapter([
          "-s",
          "format",
          "jpeg",
          "-s",
          "formatOptions",
          "best",
          input,
          "--out",
          output,
        ]);
        expect(result.status, result.stderr).toBe(0);

        const description = spawnSync(
          IMAGEMAGICK_IDENTIFY,
          ["+ping", "-format", "%m|%wx%h|%[colorspace]|%z|%[channels]|%Q", output],
          { encoding: "utf8" },
        );
        expect(description.status, description.stderr).toBe(0);
        const [format, size, colorspace, depth, channels, quality] = description.stdout.split("|");
        if (!colorspace || !channels) {
          throw new Error("Expected JPEG colorspace and channel metadata");
        }
        expect(format).toBe("JPEG");
        expect(size).toBe(dimensions);
        expect(colorspace.toLowerCase()).toBe("srgb");
        expect(depth).toBe("8");
        expect(channels.toLowerCase()).toMatch(/^srgb(?:[ \t]+3\.0)?$/);
        expect(Number(quality)).toBeGreaterThanOrEqual(90);
        const encoding = spawnSync("/usr/bin/file", [output], { encoding: "utf8" });
        expect(encoding.status, encoding.stderr).toBe(0);
        expect(encoding.stdout).toContain("precision 8");
        expect(encoding.stdout).toContain("components 3");
      }
    },
  );
});
