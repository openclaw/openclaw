import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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

function makeScreenshotFixture() {
  const root = tempDirs.make("openclaw android screenshots ");
  for (const directory of ["scripts", "home", "tmp", "bin", "state"]) {
    mkdirSync(path.join(root, directory));
  }
  copyFileSync(SCRIPT, path.join(root, SCRIPT));
  const env: NodeJS.ProcessEnv = {
    PATH: `${path.join(root, "bin")}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    HOME: path.join(root, "home"),
    TMPDIR: path.join(root, "tmp"),
    LANG: "C",
    LC_ALL: "C",
  };
  return { root, env };
}

function runAndroidScreenshots(args: string[], env: NodeJS.ProcessEnv = {}) {
  const fixture = makeScreenshotFixture();
  return spawnSync("/bin/bash", [path.join(fixture.root, SCRIPT), ...args], {
    cwd: fixture.root,
    encoding: "utf8",
    env: { ...fixture.env, ...env },
  });
}

function runLinuxSipsAdapter(args: string[]) {
  return spawnSync("bash", [LINUX_SIPS_ADAPTER, ...args], {
    encoding: "utf8",
    env: process.env,
  });
}

type EmulatorScenario = "exit" | "no-adb" | "boot-timeout" | "capture" | "existing";

function runEmulatorFixture(
  scenario: EmulatorScenario,
  options: { args?: string[]; timeoutSeconds?: number; startupLog?: string } = {},
) {
  const { root, env } = makeScreenshotFixture();
  const bin = path.join(root, "bin");
  const state = path.join(root, "state");
  writeFileSync(path.join(state, "events"), "");
  writeFileSync(path.join(state, "startup.log"), options.startupLog ?? "fixture startup excerpt\n");
  const tool = (name: string, body: string) => {
    const filename = path.join(bin, name);
    writeFileSync(filename, `#!/bin/bash\nset -eu\n${body}\n`);
    chmodSync(filename, 0o755);
    return filename;
  };

  // Source the complete, unmodified entrypoint with its own $0 and arguments.
  // The outer shell owns its emulator child even after --keep-emulator returns.
  // Observe production cleanup BEFORE the harness stops/joins any surviving child;
  // otherwise the harness could hide a missing production wait during all-mode.
  const owner = tool(
    "bash",
    String.raw`exec /bin/bash -c '
EMULATOR_PID=""
FORM_FACTOR=""
fixture_existing_pid=""
fixture_finish() {
  local status="$1" pid="" label=""
  builtin trap - EXIT
  if [[ -n "$EMULATOR_PID" ]]; then
    pid="$EMULATOR_PID"
    label="$FORM_FACTOR"
  elif [[ -n "$fixture_existing_pid" ]]; then
    pid="$fixture_existing_pid"
    label="existing"
  fi
  if [[ -n "$pid" ]]; then
    if kill -0 "$pid" 2>/dev/null; then
      printf "entrypoint %s emulator=running\n" "$label" >>"$FIXTURE_STATE/events"
      printf "harness-stop %s\n" "$label" >>"$FIXTURE_STATE/events"
      kill "$pid" 2>/dev/null || true
    else
      printf "entrypoint %s emulator=exited\n" "$label" >>"$FIXTURE_STATE/events"
    fi
    wait "$pid" 2>/dev/null || true
    printf "joined %s\n" "$label" >>"$FIXTURE_STATE/events"
  fi
  exit "$status"
}
trap() {
  if [[ "$#" == 2 && "$2" == EXIT && "$1" != - ]]; then
    builtin trap "fixture_status=\$?; $1; fixture_finish \"\$fixture_status\"" EXIT
  else
    builtin trap "$@"
  fi
}
builtin trap "fixture_finish \$?" EXIT
builtin trap "exit 124" TERM INT
if [[ "$FIXTURE_SCENARIO" == existing ]]; then
  "$ANDROID_EMULATOR" -avd Existing_Emulator >"$FIXTURE_STATE/existing.log" 2>&1 &
  fixture_existing_pid="$!"
  deadline=$((SECONDS + 5))
  while [[ ! -f "$FIXTURE_STATE/phone.device" ]]; do
    if (( SECONDS >= deadline )); then exit 96; fi
    /bin/sleep 0.01
  done
fi
source "$0" "$@"
' "$@"`,
  );

  const emulator = tool(
    "emulator",
    String.raw`if [[ "$1" == -list-avds ]]; then
  touch "$FIXTURE_STATE/launch-pending"
  printf '%s\n' OpenClaw_Screenshots_API36 OpenClaw_Wear_Screenshots_API34
  exit 0
fi
[[ "$1" == -avd ]] || exit 97
avd="$2"
form=phone
[[ "$avd" != *Wear* ]] || form=wear
printf 'boot %s\n' "$form" >>"$FIXTURE_STATE/events"
if [[ "$form" == wear && -f "$FIXTURE_STATE/phone.pid" ]]; then
  if kill -0 "$(cat "$FIXTURE_STATE/phone.pid")" 2>/dev/null; then
    printf 'overlap phone wear\n' >>"$FIXTURE_STATE/events"
    exit 98
  fi
fi
printf '%s\n' "$$" >"$FIXTURE_STATE/$form.pid"
printf '%s\n' "$avd" >"$FIXTURE_STATE/$form.avd"
cat "$FIXTURE_STATE/startup.log" >&2
if [[ "$FIXTURE_SCENARIO" == exit ]]; then
  rm -f "$FIXTURE_STATE/launch-pending"
  exit 42
fi
/bin/sleep 60 &
sleeper="$!"
printf '%s\n' "$sleeper" >"$FIXTURE_STATE/$form.sleeper.pid"
stop() {
  trap "" TERM INT
  kill "$sleeper" 2>/dev/null || true
  wait "$sleeper" 2>/dev/null || true
  # ADB disappearance deliberately precedes process exit, as with a real emulator.
  # This exposes cleanup that waits for ADB disappearance but never joins its child.
  /bin/sleep 0.2
  rm -f "$FIXTURE_STATE/$form.device"
  printf 'stopped %s\n' "$form" >>"$FIXTURE_STATE/events"
  exit 0
}
trap stop TERM INT
if [[ "$FIXTURE_SCENARIO" != no-adb ]]; then
  touch "$FIXTURE_STATE/$form.device"
fi
rm -f "$FIXTURE_STATE/launch-pending"
wait "$sleeper"`,
  );

  const adb = tool(
    "adb",
    String.raw`printf 'adb %s\n' "$*" >>"$FIXTURE_STATE/events"
if [[ "$1" == devices ]]; then
  # Synchronize fake launch visibility instead of spending a readiness poll on a scheduling race.
  deadline=$((SECONDS + 5))
  while [[ -f "$FIXTURE_STATE/launch-pending" ]]; do
    if (( SECONDS >= deadline )); then exit 96; fi
    /bin/sleep 0.01
  done
  printf 'List of devices attached\n'
  if [[ -f "$FIXTURE_STATE/phone.device" ]]; then printf 'emulator-5554\tdevice\n'; fi
  if [[ -f "$FIXTURE_STATE/wear.device" ]]; then printf 'emulator-5556\tdevice\n'; fi
  exit 0
fi
[[ "$1" == -s ]] || exit 97
form=phone
[[ "$2" != emulator-5556 ]] || form=wear
shift 2
case "$*" in
  'emu avd name') cat "$FIXTURE_STATE/$form.avd"; printf 'OK\n' ;;
  'emu kill')
    rm -f "$FIXTURE_STATE/$form.device"
    kill "$(cat "$FIXTURE_STATE/$form.pid")"
    ;;
  wait-for-device) ;;
  'shell getprop sys.boot_completed')
    if [[ "$FIXTURE_SCENARIO" == boot-timeout ]]; then printf '0\n'; else printf '1\n'; fi
    ;;
  'shell getprop ro.kernel.qemu') printf '1\n' ;;
  'shell getprop persist.sys.timezone') printf 'America/Los_Angeles\n' ;;
  'shell cmd time_zone_detector is_auto_detection_enabled') printf 'true\n' ;;
  'shell wm size')
    if [[ "$form" == wear ]]; then printf 'Physical size: 454x454\n'; else printf 'Physical size: 1440x2560\n'; fi
    ;;
  'shell wm density') printf 'Physical density: 320\n' ;;
  'shell am start '*)
    for scene in "$@"; do :; done
    printf '%s\n' "$scene" >"$FIXTURE_STATE/$form.scene"
    printf 'Status: ok\n'
    ;;
  'exec-out uiautomator dump /dev/tty')
    case "$(cat "$FIXTURE_STATE/$form.scene")" in
      home) printf 'Overview\n' ;;
      chat) printf 'The Android release is close. Release planning\n' ;;
      settings) printf 'OpenClaw mobile\n' ;;
      gateway) printf 'Connection between this phone and OpenClaw.\n' ;;
      voice-wake) printf 'Wake listener\n' ;;
      voice) printf 'Dictate\n' ;;
      controls) printf 'Gateway connected\n' ;;
      *) exit 97 ;;
    esac
    ;;
  'exec-out screencap -p') printf 'capture:%s:%s\n' "$form" "$(cat "$FIXTURE_STATE/$form.scene")" ;;
  'shell cmd time_zone_detector set_auto_detection_enabled '*|'shell cmd alarm set-timezone '*|\
  'shell settings put '*|'shell svc power stayon '*|'shell input keyevent '*|\
  'shell wm dismiss-keyguard'|'shell wm size '*|'shell wm density '*|\
  'shell pm clear '*|'shell pm grant '*|'shell am force-stop '*|'logcat -c') ;;
  'logcat -d') printf 'fixture logcat\n' ;;
  *) printf 'unexpected adb invocation: %s\n' "$*" >&2; exit 97 ;;
esac`,
  );
  const sips = tool(
    "sips",
    String.raw`[[ "$#" == 9 && "$1 $2 $3 $4 $5 $6 $8" == '-s format jpeg -s formatOptions best --out' ]] || exit 97
cp "$7" "$9"`,
  );
  tool(
    "file",
    String.raw`size=1440x2560
[[ "$1" != *wearScreenshots* ]] || size=454x454
printf '%s: JPEG image data, %s\n' "$1" "$size"`,
  );
  tool(
    "git",
    String.raw`[[ "$1" == -C && "$3 $4" == 'rev-parse HEAD' ]] || exit 97
printf '%s\n' 0df774991941e70d70b829a546ae24753d39e35e`,
  );

  const started = performance.now();
  const result = spawnSync(
    owner,
    [
      path.join(root, SCRIPT),
      ...(options.args ?? ["--form-factor", "phone"]),
      "--skip-build",
      "--skip-install",
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...env,
        ADB: adb,
        ANDROID_EMULATOR: emulator,
        SIPS: sips,
        ANDROID_SCREENSHOT_EMULATOR_TIMEOUT_SECONDS: String(options.timeoutSeconds ?? 3),
        ANDROID_SCREENSHOT_DEVICE_TIMEOUT_SECONDS: "3",
        ANDROID_SCREENSHOT_SCENE_TIMEOUT_SECONDS: "3",
        ANDROID_SCREENSHOT_SETTLE_SECONDS: "0",
        FIXTURE_STATE: state,
        FIXTURE_SCENARIO: scenario,
      },
    },
  );
  for (const filename of readdirSync(state).filter((name) => name.endsWith(".pid"))) {
    const pid = Number(readFileSync(path.join(state, filename), "utf8").trim());
    expect(() => process.kill(pid, 0), `Fixture child ${filename} must be joined`).toThrow();
  }
  return {
    ...result,
    root,
    elapsedMs: performance.now() - started,
    events: readFileSync(path.join(state, "events"), "utf8"),
  };
}

function expectCapturedScenes(root: string, form: "phone" | "wear", scenes: string[]) {
  const output = path.join(
    root,
    "apps/android/fastlane/metadata/android/en-US/images",
    `${form}Screenshots`,
  );
  const artifacts = path.join(root, ".artifacts/android-screenshots/latest", form);
  expect(readdirSync(output).toSorted()).toEqual(
    scenes.map((scene) => `openclaw-${scene}.jpg`).toSorted(),
  );
  for (const scene of scenes) {
    const filename = `openclaw-${scene}.jpg`;
    expect(readFileSync(path.join(output, filename), "utf8")).toBe(`capture:${form}:${scene}\n`);
    expect(readFileSync(path.join(artifacts, "screenshots", filename), "utf8")).toBe(
      `capture:${form}:${scene}\n`,
    );
  }
  expect(readFileSync(path.join(artifacts, "manifest.txt"), "utf8")).toContain(
    `form_factor=${form}\n`,
  );
}

describe("android screenshots script", () => {
  it("reports an emulator exit status of 42 before the readiness deadline", () => {
    const result = runEmulatorFixture("exit", { timeoutSeconds: 8 });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("liveness=exited exit_status=42");
    expect(result.stderr).toContain("[android-emulator] fixture startup excerpt");
    expect(result.stdout).not.toContain("fixture startup excerpt");
    expect(result.elapsedMs).toBeLessThan(6_000);
    expect(result.events).toContain("entrypoint phone emulator=exited\njoined phone\n");
    expect(result.events).not.toContain("harness-stop");
    expect(readdirSync(path.join(result.root, "tmp"))).toEqual([]);
  }, 15_000);

  it("preserves the configured readiness timeout for a live emulator missing from ADB", () => {
    const result = runEmulatorFixture("no-adb", { timeoutSeconds: 3 });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Timed out waiting for exactly one Android emulator device.");
    expect(result.stderr).toContain("liveness=running exit_status=unavailable");
    expect(result.stderr).toContain("[android-emulator] fixture startup excerpt");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(2_000);
    expect(result.elapsedMs).toBeLessThan(8_000);
    expect(result.events).toContain(
      "stopped phone\nentrypoint phone emulator=exited\njoined phone\n",
    );
    expect(result.events).not.toContain("harness-stop");
    expect(readdirSync(path.join(result.root, "tmp"))).toEqual([]);
  }, 15_000);

  it("includes startup output on boot-completion timeout without changing exit status 1", () => {
    const result = runEmulatorFixture("boot-timeout", { timeoutSeconds: 2 });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(
      "Timed out waiting for Android emulator boot completion on emulator-5554.",
    );
    expect(result.stderr).toContain("[android-emulator] fixture startup excerpt");
    expect(result.events).not.toContain("emu kill");
    expect(result.events).toContain(
      "stopped phone\nentrypoint phone emulator=exited\njoined phone\n",
    );
    expect(result.events).not.toContain("harness-stop");
    expect(readdirSync(path.join(result.root, "tmp"))).toEqual([]);
  }, 15_000);

  it("bounds and prefixes noisy startup logs without terminal controls or executable CI commands", () => {
    const startupLog = [
      "discarded-before-byte-limit",
      "x".repeat(9_000),
      ...Array.from({ length: 50 }, (_, i) => `noise-line-${String(i).padStart(2, "0")}`),
      "\u001b[31m::error::startup-injection\u001b[0m\r\u0000\u0008\u0007",
      "##[error]legacy-injection",
      `long-line:${"y".repeat(1_600)}`,
      "last-startup-line",
      "",
    ].join("\n");
    const result = runEmulatorFixture("exit", { startupLog, timeoutSeconds: 8 });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    const prefix = "[android-emulator] ";
    // The bound applies to log content, not the separately prefixed status/header.
    const excerpt = result.stderr
      .split("\n")
      .filter(
        (line) =>
          line.startsWith(prefix) &&
          !line.startsWith(`${prefix}liveness=`) &&
          !line.startsWith(`${prefix}startup log excerpt`),
      );
    expect(excerpt.length).toBeGreaterThan(0);
    expect(excerpt.length).toBeLessThanOrEqual(40);
    expect(excerpt).toContain(`${prefix}last-startup-line`);
    expect(excerpt.some((line) => line.includes(": : error: : startup-injection"))).toBe(true);
    expect(excerpt.some((line) => line.includes("# #[error]legacy-injection"))).toBe(true);
    expect(excerpt.every((line) => !line.includes("::") && !line.includes("##["))).toBe(true);
    expect(excerpt.some((line) => line.startsWith(`${prefix}long-line:`))).toBe(true);
    for (const line of excerpt) {
      expect(line.length).toBeLessThanOrEqual(prefix.length + 512);
    }
    expect(result.stderr).not.toContain("discarded-before-byte-limit");
    expect(result.stderr).not.toContain("noise-line-00");
    expect(result.stderr).not.toContain("x".repeat(512));
    expect(result.stderr.length).toBeLessThan(22_000);
    for (const character of result.stderr) {
      const code = character.charCodeAt(0);
      expect(code === 10 || (code >= 32 && code !== 127)).toBe(true);
    }
    expect(result.stderr.split("\n").some((line) => line.startsWith("::"))).toBe(false);
    expect(result.stdout).not.toContain("startup-injection");
  }, 15_000);

  it("never prints credential fragments cut by the startup log byte limit", () => {
    const secret = "opaque-hidden-value".repeat(500);
    const result = runEmulatorFixture("exit", {
      timeoutSeconds: 8,
      startupLog: `password=${secret}\nAPI_KEY=fixture-secret-value\nlast-safe-startup-line\n`,
    });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("[android-emulator] last-safe-startup-line");
    expect(result.stderr).toContain("[android-emulator] [redacted sensitive log line]");
    expect(result.stderr).not.toContain("opaque-hidden-value");
    expect(result.stderr).not.toContain("fixture-secret-value");
  }, 15_000);

  it("captures every phone scene and joins the owned emulator on success", () => {
    const result = runEmulatorFixture("capture");

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expectCapturedScenes(result.root, "phone", [
      "home",
      "chat",
      "settings",
      "gateway",
      "voice-wake",
    ]);
    expect(result.events).toContain("adb -s emulator-5554 emu kill\n");
    expect(result.events).toContain("entrypoint phone emulator=exited\njoined phone\n");
    expect(result.events).not.toContain("harness-stop");
    expect(result.stderr).not.toContain("[android-emulator]");
  }, 15_000);

  it("never kills an explicitly selected pre-existing emulator", () => {
    const result = runEmulatorFixture("existing", {
      args: ["--form-factor", "phone", "--device", "emulator-5554"],
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expectCapturedScenes(result.root, "phone", [
      "home",
      "chat",
      "settings",
      "gateway",
      "voice-wake",
    ]);
    expect(result.events).not.toContain("emu kill");
    expect(result.events).toContain(
      "entrypoint existing emulator=running\nharness-stop existing\n",
    );
    expect(result.events).toContain("stopped phone\njoined existing\n");
  }, 15_000);

  it("keeps its owned emulator alive until the outer fixture owner stops and joins it", () => {
    const result = runEmulatorFixture("capture", {
      args: ["--form-factor", "phone", "--keep-emulator"],
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.events).not.toContain("emu kill");
    expect(result.events).toContain("entrypoint phone emulator=running\nharness-stop phone\n");
    expect(result.events).toContain("stopped phone\njoined phone\n");
  }, 15_000);

  it("joins the phone emulator before launching Wear in all-form-factors mode", () => {
    const result = runEmulatorFixture("capture", { args: ["--form-factor", "all"] });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expectCapturedScenes(result.root, "phone", [
      "home",
      "chat",
      "settings",
      "gateway",
      "voice-wake",
    ]);
    expectCapturedScenes(result.root, "wear", ["chat", "voice", "controls"]);
    expect(result.events).toContain("entrypoint phone emulator=exited\njoined phone\n");
    expect(result.events).toContain("entrypoint wear emulator=exited\njoined wear\n");
    expect(result.events).not.toContain("harness-stop");
    expect(result.events).not.toContain("overlap phone wear");
    expect(result.events.indexOf("joined phone\n")).toBeLessThan(
      result.events.indexOf("boot wear\n"),
    );
  }, 15_000);

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
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Android screenshot capture requires an emulator; 'physical-serial' is not an emulator.",
    );
    expect(result.stderr).toContain("Pass --avd <name> or --device <emulator-serial>.");
    expect(result.stderr).not.toContain("Connected emulator 'unknown'");
    expect(result.stderr).not.toContain("unexpected adb invocation");
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

      for (const dimensions of ["1440x2560", "454x454"]) {
        const input = path.join(root, `input ${dimensions}.png`);
        const output = path.join(root, `output ${dimensions}.jpg`);
        const [width, height] = dimensions.split("x");
        const fixture = spawnSync(
          IMAGEMAGICK_CONVERT,
          [
            "(",
            "-size",
            dimensions,
            "gradient:#000000-#ff0000",
            ")",
            "(",
            "-size",
            `${height}x${width}`,
            "gradient:#000000-#00ff00",
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
          ["+ping", "-format", "%m|%wx%h|%[colorspace]|%[type]|%[channels]|%Q", output],
          { encoding: "utf8" },
        );
        expect(description.status, description.stderr).toBe(0);
        const [format, size, colorspace, type, channels, quality] = description.stdout.split("|");
        if (!colorspace || !channels) {
          throw new Error("Expected JPEG colorspace and channel metadata");
        }
        expect(format).toBe("JPEG");
        expect(size).toBe(dimensions);
        expect(colorspace.toLowerCase()).toBe("srgb");
        expect(type).toBe("TrueColor");
        expect(channels.toLowerCase()).not.toContain("a");
        expect(Number(quality)).toBeGreaterThanOrEqual(90);
      }
    },
  );
});
