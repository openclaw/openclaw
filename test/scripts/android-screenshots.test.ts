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

it("captures the visible phone diagram after rendering when the latest reply prose is offscreen", () => {
  const { root, run } = captureFixture("phone");
  const adb = executable(
    root,
    "adb",
    `case "$*" in
  devices) printf 'List of devices attached\\nemulator-5554\\tdevice\\n' ;;
  '-s emulator-5554 emu avd name') echo OpenClaw_Screenshots_API36 ;;
  '-s emulator-5554 shell getprop ro.kernel.qemu') echo 1 ;;
  '-s emulator-5554 shell cmd time_zone_detector is_auto_detection_enabled') echo true ;;
  '-s emulator-5554 shell getprop persist.sys.timezone') echo UTC ;;
  '-s emulator-5554 shell wm size') echo 'Physical size: 1440x2560' ;;
  '-s emulator-5554 shell wm density') echo 'Physical density: 560' ;;
  *'shell am start -W '*) echo "\${!#}" > "$FIXTURE_ROOT/scene" ;;
  '-s emulator-5554 exec-out uiautomator dump /dev/tty')
    scene=$(cat "$FIXTURE_ROOT/scene")
    case "$scene" in
      home) echo '<node text="Overview" />' ;;
      chat)
        count=$(cat "$FIXTURE_ROOT/chat-dumps" 2>/dev/null || echo 0)
        count=$((count + 1))
        echo "$count" > "$FIXTURE_ROOT/chat-dumps"
        case "$count" in
          1) echo '<node text="The Android release is close. Rendering diagram…" />' ;;
          2) echo '<node text="The Android release is close. Mermaid diagram flowchart TD" />' ;;
          *) echo '<node text="" content-desc="Mermaid diagram" bounds="[98,175][1342,1492]" />' ;;
        esac
        ;;
      settings) echo '<node text="Device name and identity" />' ;;
      gateway) echo '<node text="Connection between this phone and OpenClaw." />' ;;
      voice-wake) echo '<node text="Wake listener" />' ;;
    esac
    ;;
  '-s emulator-5554 exec-out screencap -p')
    scene=$(cat "$FIXTURE_ROOT/scene")
    if [[ "$scene" == chat ]]; then
      cat "$FIXTURE_ROOT/chat-dumps" > "$FIXTURE_ROOT/chat-captured-at-dump"
    fi
    echo 'synthetic screenshot bytes'
    ;;
  '-s emulator-5554 shell '*|'-s emulator-5554 logcat '*) ;;
  *) printf 'unexpected adb invocation: %s\\n' "$*" >&2; exit 97 ;;
esac
`,
  );
  const sips = executable(root, "sips", 'cp "$7" "$9"\n');
  executable(root, "file", "echo 'JPEG image data, 1440x2560'\n");
  executable(
    root,
    "git",
    `[[ "$*" == "-C $FIXTURE_ROOT rev-parse HEAD" ]] || exit 97
printf '%s\\n' '${"a".repeat(40)}'
`,
  );
  // Readiness polling is exercised without spending real time between fixed UI states.
  executable(root, "sleep", "exit 0\n");
  const result = run({
    ADB: adb,
    SIPS: sips,
    PATH: `${root}:${process.env.PATH}`,
    FIXTURE_ROOT: root,
    ANDROID_SCREENSHOT_DEVICE: "",
    ANDROID_SCREENSHOT_AVD: "OpenClaw_Screenshots_API36",
    ANDROID_SCREENSHOT_SCENE_TIMEOUT_SECONDS: "2",
  });

  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(path.join(root, "chat-captured-at-dump"), "utf8")).toBe("3\n");
  const artifacts = path.join(root, ".artifacts/android-screenshots/latest/phone");
  const chatDump = readFileSync(path.join(artifacts, "ui-dumps/openclaw-chat.xml"), "utf8");
  expect(chatDump).toContain('content-desc="Mermaid diagram"');
  expect(chatDump).not.toContain("The Android release is close.");
  for (const scene of ["home", "chat", "settings", "gateway", "voice-wake"]) {
    expect(existsSync(path.join(artifacts, `screenshots/openclaw-${scene}.jpg`))).toBe(true);
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

it.each(["phone", "wear"] as const)(
  "does not start device discovery when the %s screenshot build fails",
  (formFactor) => {
    const { root } = captureFixture(formFactor);
    const androidDir = path.join(root, "apps/android");
    mkdirSync(androidDir, { recursive: true });
    executable(androidDir, "gradlew", "echo 'Synthetic screenshot build failure' >&2\nexit 42\n");
    const deviceAccess = path.join(root, "device-access");
    const adb = executable(
      root,
      "adb",
      `touch "$FIXTURE_DEVICE_ACCESS"\necho 'Device discovery preceded compilation' >&2\nexit 43\n`,
    );

    const result = runAndroidScreenshots(
      ["--form-factor", formFactor, "--skip-install"],
      { ADB: adb, FIXTURE_DEVICE_ACCESS: deviceAccess },
      path.join(root, SCRIPT),
    );

    expect(result.status, result.stderr).toBe(42);
    expect(existsSync(deviceAccess)).toBe(false);
  },
);

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

it("retains system failure evidence before emulator teardown without replacing the capture error", () => {
  const { root, run } = captureFixture("phone");
  const helper = "scripts/lib/android-screenshot-diagnostics.sh";
  mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
  copyFileSync(helper, path.join(root, helper));
  const readyPipe = path.join(root, "emulator-ready");
  expect(command("mkfifo", [readyPipe]).status).toBe(0);
  executable(
    root,
    "uname",
    `case "$1" in
  -s) printf 'Linux\\n' ;;
  -m) printf 'x86_64\\n' ;;
  *) printf 'Linux fixture\\n' ;;
esac
`,
  );
  executable(
    root,
    "timeout",
    `while [[ "$1" == --* ]]; do shift; done
shift
exec "$@"
`,
  );
  const adb = executable(
    root,
    "adb",
    `case "$*" in
  devices)
    printf 'List of devices attached\\n'
    [[ ! -e "$FIXTURE_ROOT/stopped" ]] || exit 0
    [[ -e "$FIXTURE_ROOT/discovered" ]] || { touch "$FIXTURE_ROOT/discovered"; exit 0; }
    if [[ ! -e "$FIXTURE_ROOT/online" ]]; then
      read -r ready < "$FIXTURE_ROOT/emulator-ready"
      touch "$FIXTURE_ROOT/online"
    fi
    printf 'emulator-5554\\tdevice\\n'
    ;;
  '-s emulator-5554 wait-for-device') ;;
  '-s emulator-5554 emu kill')
    grep -Fq 'SystemUI ANR fixture' "$FIXTURE_ROOT/.artifacts/android-screenshots/latest/phone/diagnostics/last-anr.txt"
    printf 'ANR evidence existed before teardown\\n' > "$FIXTURE_ROOT/teardown-proof"
    touch "$FIXTURE_ROOT/stopped"
    ;;
  '-s emulator-5554 shell getprop sys.boot_completed'|'-s emulator-5554 shell getprop ro.kernel.qemu') printf '1\\n' ;;
  '-s emulator-5554 shell cmd time_zone_detector is_auto_detection_enabled') printf 'true\\n' ;;
  '-s emulator-5554 shell getprop persist.sys.timezone') printf 'UTC\\n' ;;
  '-s emulator-5554 shell wm size') printf 'Physical size: 1080x1920\\n' ;;
  '-s emulator-5554 shell wm density') printf 'Physical density: 420\\n' ;;
  '-s emulator-5554 shell am start -W '*) echo 'Synthetic screenshot launch failure' >&2; exit 42 ;;
  '-s emulator-5554 logcat '*) printf 'SystemUI system event fixture\\n' ;;
  '-s emulator-5554 shell dumpsys activity lastanr') printf 'SystemUI ANR fixture\\n' ;;
  '-s emulator-5554 shell dumpsys activity exit-info com.android.systemui') echo 'Synthetic diagnostic probe unavailable' >&2; exit 19 ;;
  '-s emulator-5554 shell dumpsys '*|'-s emulator-5554 shell for key '*|'-s emulator-5554 shell cat /proc/meminfo;'*) printf 'Synthetic system counters\\n' ;;
  '-s emulator-5554 shell pidof com.android.systemui') ;;
  '-s emulator-5554 shell input '*|'-s emulator-5554 shell cmd '*|'-s emulator-5554 shell settings '*|'-s emulator-5554 shell svc '*|'-s emulator-5554 shell wm '*|'-s emulator-5554 shell pm '*|'-s emulator-5554 shell am force-stop '*) ;;
  *) printf 'unexpected adb invocation: %s\\n' "$*" >&2; exit 97 ;;
esac
`,
  );
  const emulator = executable(
    root,
    "emulator",
    `case "$*" in
  -list-avds) printf 'OpenClaw_Screenshots_API36\\n' ;;
  '-no-window -version') printf 'Synthetic emulator version\\n' ;;
  *) printf 'ready\\n' > "$FIXTURE_ROOT/emulator-ready" ;;
esac
`,
  );
  const result = run({
    ADB: adb,
    ANDROID_EMULATOR: emulator,
    ANDROID_SCREENSHOT_DEVICE: "",
    ANDROID_SCREENSHOT_AVD: "OpenClaw_Screenshots_API36",
    ANDROID_SCREENSHOT_DIAGNOSTICS: "1",
    FIXTURE_ROOT: root,
    PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  expect(result.status, result.stderr).toBe(42);
  const artifacts = path.join(root, ".artifacts/android-screenshots/latest/phone");
  for (const [file, contents] of [
    ["diagnostics/system-events.log", "SystemUI system event fixture"],
    ["diagnostics/last-anr.txt", "SystemUI ANR fixture"],
    ["diagnostics/systemui-exit-info.txt", "probe_exit_status=19"],
  ] as const) {
    expect(readFileSync(path.join(artifacts, file), "utf8")).toContain(contents);
  }
  expect(existsSync(path.join(root, "teardown-proof"))).toBe(true);
  expect(readFileSync(path.join(artifacts, "process-status.txt"), "utf8")).toContain(
    "exit_status=42\n",
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
      ["454x454", true],
    ] as const) {
      const input = path.join(root, `input ${dimensions}.png`);
      const output = path.join(root, `output ${dimensions}.jpg`);
      const fixture = command(IMAGEMAGICK_CONVERT, [
        "-size",
        dimensions,
        `gradient:#000000-${grayscale ? "#ffffff" : "#ff0000"}`,
        ..."-alpha set -channel A -evaluate set 60% +channel".split(" "),
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
