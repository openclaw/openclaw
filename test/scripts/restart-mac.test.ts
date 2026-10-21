import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const script = fs.readFileSync("scripts/restart-mac.sh", "utf8");
const fail = 'fail() { printf "ERROR: %s\\n" "$*" >&2; exit 1; }';
const log = 'log() { printf "%s\\n" "$*"; }';

function makeTempRoot(prefix = "openclaw-restart-mac-test-") {
  return tempDirs.make(prefix);
}

function expectContents(source: string, included: string[], excluded: string[] = []) {
  for (const text of included) {
    expect(source).toContain(text);
  }
  for (const text of excluded) {
    expect(source).not.toContain(text);
  }
}

function expectSuccess(result: ReturnType<typeof runHarness>, stdout: string) {
  expect(result).toMatchObject({ status: 0, stderr: "" });
  expect(result.stdout.trim()).toBe(stdout);
}

function expectBefore(first: string, second: string, source = script) {
  expect(source.indexOf(first)).toBeGreaterThan(-1);
  expect(source.indexOf(second)).toBeGreaterThan(source.indexOf(first));
}

function block(start: string, end: string) {
  const from = script.indexOf(start);
  return script.slice(from, script.indexOf(end, from + start.length));
}

function runHarness(root: string, lines: string[], env = {}, args: string[] = [], bash = "bash") {
  const harnessPath = join(root, "harness.sh");
  fs.writeFileSync(harnessPath, ["#!/usr/bin/env bash", ...lines].join("\n"));
  return spawnSync(bash, [harnessPath, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function fakeTools(root: string, tools: Record<string, string>) {
  const binDir = join(root, "bin");
  fs.mkdirSync(binDir);
  for (const [name, body] of Object.entries(tools)) {
    const file = join(binDir, name);
    fs.writeFileSync(file, body);
    fs.chmodSync(file, 0o755);
  }
  return { PATH: `${binDir}:${process.env.PATH ?? ""}` };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runCleanupFunction(fakePs: string) {
  const root = makeTempRoot();
  const killCallsPath = join(root, "kill-calls.txt");
  const result = runHarness(
    root,
    [
      block("kill_all_openclaw()", "stop_launch_agent()"),
      'ROOT_DIR="/worktree"',
      'APP_BUNDLE=""',
      'APP_EXECUTABLE_RELATIVE_PATH="Contents/MacOS/OpenClaw"',
      'DEBUG_PROCESS_PATTERN="/worktree/apps/macos/.build/debug/OpenClaw"',
      'LOCAL_PROCESS_PATTERN="/worktree/apps/macos/.build-local/debug/OpenClaw"',
      'RELEASE_PROCESS_PATTERN="/worktree/apps/macos/.build/release/OpenClaw"',
      "kill() {",
      '  printf "%s\\n" "$*" >> "$OPENCLAW_TEST_KILL_CALLS"',
      "  return 0",
      "}",
      "kill_all_openclaw",
    ],
    {
      OPENCLAW_TEST_KILL_CALLS: killCallsPath,
      ...fakeTools(root, { ps: fakePs, sleep: "#!/usr/bin/env bash\nexit 0\n" }),
    },
  );
  const killCalls = fs.existsSync(killCallsPath) ? fs.readFileSync(killCallsPath, "utf8") : "";
  return { killCalls, result };
}

function runManagedSupervisorClassifier(records: string[], failEnumeration = false) {
  const root = makeTempRoot("openclaw-restart-mac-supervisor-test-");
  const recordsPath = join(root, "loaded-jobs.txt");
  fs.writeFileSync(recordsPath, records.join("\n"));

  return runHarness(
    root,
    [
      "set -euo pipefail",
      block("print_managed_openclaw_supervisor_label()", "kill_managed_openclaw()"),
      "loaded_launch_jobs() {",
      '  [[ "${OPENCLAW_TEST_FAIL_ENUMERATION:-0}" != "1" ]] || return 1',
      "  cut -d'|' -f1,2 \"$OPENCLAW_TEST_LOADED_JOBS\"",
      "}",
      "launch_job_snapshot() {",
      '  grep "^$1|$2|" "$OPENCLAW_TEST_LOADED_JOBS" |',
      "    awk -F'|' '{ print \"program = \" $3; print \"properties = \" $4 }'",
      "}",
      'TARGET_EXECUTABLE="/worktree/dist/OpenClaw.app/Contents/MacOS/OpenClaw"',
      'INSTALLED_EXECUTABLE="/Applications/OpenClaw.app/Contents/MacOS/OpenClaw"',
      "managed_openclaw_supervisor_labels",
    ],
    {
      OPENCLAW_TEST_FAIL_ENUMERATION: failEnumeration ? "1" : "0",
      OPENCLAW_TEST_LOADED_JOBS: recordsPath,
    },
  );
}

function runRestartArgParser(...args: string[]) {
  return runHarness(
    makeTempRoot(),
    [
      "set -euo pipefail",
      "WAIT_FOR_LOCK=0",
      "NO_SIGN=0",
      "SIGN=0",
      "AUTO_DETECT_SIGNING=1",
      "ATTACH_ONLY=1",
      "BACKGROUND_ONLY=0",
      "TARGET_ONLY=0",
      log,
      fail,
      block('for arg in "$@"; do', 'if [[ "$NO_SIGN" -eq 1 && "$SIGN" -eq 1 ]]'),
      'printf "wait=%s no_sign=%s sign=%s attach_only=%s background_only=%s target_only=%s\\n" "$WAIT_FOR_LOCK" "$NO_SIGN" "$SIGN" "$ATTACH_ONLY" "$BACKGROUND_ONLY" "$TARGET_ONLY"',
    ],
    {},
    args,
  );
}

function runSigningEnvironmentBlock(signIdentity: string) {
  return runHarness(
    makeTempRoot(),
    [
      "set -euo pipefail",
      "NO_SIGN=0",
      "SIGN=1",
      "check_signing_keys() { return 0; }",
      fail,
      block('if [ "$NO_SIGN" -eq 1 ]; then', "# 3) Package and sign"),
      'printf "%s\\n" "${SIGN_IDENTITY-<unset>}"',
    ],
    { SIGN_IDENTITY: signIdentity },
  );
}

function runProfileGuard(profile: string) {
  return runHarness(
    makeTempRoot(),
    [
      "set -euo pipefail",
      fail,
      block('if [[ -n "${OPENCLAW_PROFILE:-}" ]]', "canonicalize_app_bundle"),
      'printf "safe\\n"',
    ],
    { OPENCLAW_PROFILE: profile },
    [],
    "/bin/bash",
  );
}

function runRestartLockHarness(lockDir: string) {
  return runHarness(makeTempRoot(), [
    "set -euo pipefail",
    `LOCK_DIR=${shellQuote(lockDir)}`,
    'LOCK_PID_FILE="${LOCK_DIR}/pid"',
    "LOCK_HELD=0",
    "WAIT_FOR_LOCK=0",
    log,
    block("cleanup()", "check_signing_keys()"),
    "trap cleanup EXIT",
    "acquire_lock",
  ]);
}

function runForeignProcessClassifier(fakePs: string) {
  const root = makeTempRoot();
  return runHarness(
    root,
    [
      block("process_pids_matching()", "stop_launch_agent()"),
      'APP_EXECUTABLE_RELATIVE_PATH="Contents/MacOS/OpenClaw"',
      'TARGET_EXECUTABLE="/Users/steipete/openclaw/dist/OpenClaw.app/Contents/MacOS/OpenClaw"',
      'INSTALLED_EXECUTABLE="/Applications/OpenClaw.app/Contents/MacOS/OpenClaw"',
      "foreign_openclaw_process_pids",
    ],
    fakeTools(root, { ps: fakePs }),
  );
}

describe("scripts/restart-mac.sh", () => {
  it("preserves an explicit signing identity through signed packaging", () => {
    const identity = "Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)";
    const result = runSigningEnvironmentBlock(identity);

    expectSuccess(result, identity);
  });

  it("rejects unknown restart options before side effects", () => {
    const result = runRestartArgParser("--wat");

    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(result.stderr.trim()).toBe("ERROR: Unknown restart option: --wat");
  });

  it("fails closed when loaded launchd jobs cannot be enumerated", () => {
    const result = runManagedSupervisorClassifier([], true);

    expect(result.status).toBe(1);
  });

  it("fails the gateway verification when lsof finds no listener", () => {
    const result = runHarness(
      makeTempRoot(),
      [
        `source ${shellQuote(join(process.cwd(), "scripts/lib/restart-mac-gateway.sh"))}`,
        "verify_gateway_port_listening 18789",
      ],
      fakeTools(makeTempRoot(), { lsof: "#!/usr/bin/env bash\nexit 1\n" }),
    );
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(result.stderr).toContain("No process is listening on gateway port 18789.");
  });

  it("uses a fail-closed gateway port verification helper", () => {
    expectContents(
      script,
      [
        'source "${ROOT_DIR}/scripts/lib/restart-mac-gateway.sh"',
        'run_step "verify gateway port ${GATEWAY_PORT} (unsigned)" verify_gateway_port_listening "${GATEWAY_PORT}"',
      ],
      ["lsof -iTCP:${GATEWAY_PORT} -sTCP:LISTEN | head -n 5 || true"],
    );
  });

  it("avoids login-shell noise and early-exit pipe warnings", () => {
    expectContents(
      script,
      ["/usr/bin/awk -F ' = '"],
      ["bash -lc", `printf '%s\\n' "\${job}" | /usr/bin/awk`],
    );
  });

  it("keeps the default restart log scoped to the current worktree lock", () => {
    expect(script).toContain(
      'LOG_PATH="${OPENCLAW_RESTART_LOG:-${TMPDIR:-/tmp}/openclaw-restart-${LOCK_KEY}.log}"',
    );
    expect(script).not.toContain('LOG_PATH="${OPENCLAW_RESTART_LOG:-/tmp/openclaw-restart.log}"');
  });

  it("rejects named app profiles before global process or launchd cleanup", () => {
    expect(script).toContain('if [[ -n "${OPENCLAW_PROFILE:-}"');
    expect(script).toContain("restart-mac.sh cannot safely target one app profile");
    expect(script.indexOf("cannot safely target one app profile")).toBeLessThan(
      script.indexOf("\nacquire_lock\n"),
    );
    expect(runProfileGuard("work").status).toBe(1);
    expect(runProfileGuard("default").stdout.trim()).toBe("safe");
    expect(runProfileGuard("Default").stdout.trim()).toBe("safe");
  });

  it("does not remove a live restart lock it did not acquire", () => {
    const root = makeTempRoot("openclaw-restart-mac-test-");
    const lockDir = join(root, "openclaw-restart-lock");
    fs.mkdirSync(lockDir);
    fs.writeFileSync(join(lockDir, "pid"), String(process.pid), "utf8");

    const result = runRestartLockHarness(lockDir);

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain(
      `Another restart is running (pid ${process.pid}); re-run with --wait.`,
    );
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(fs.readFileSync(join(lockDir, "pid"), "utf8")).toBe(String(process.pid));
  });

  it("prefers the freshly packaged app unless an explicit app bundle is set", () => {
    const chooseBlock = block("choose_app_bundle()", "choose_app_bundle");

    expect(script).toContain('fail "OPENCLAW_APP_BUNDLE does not exist: ${APP_BUNDLE}"');
    expect(chooseBlock).toContain("canonicalize_app_bundle");
    expect(chooseBlock.indexOf("${ROOT_DIR}/dist/OpenClaw.app")).toBeGreaterThan(-1);
    expect(chooseBlock.indexOf("/Applications/OpenClaw.app")).toBeGreaterThan(-1);
    expect(chooseBlock.indexOf("${ROOT_DIR}/dist/OpenClaw.app")).toBeLessThan(
      chooseBlock.indexOf("/Applications/OpenClaw.app"),
    );
  });

  it("stops launchd supervision before killing app processes", () => {
    expectBefore("stop_launch_agent\n  log", "if ! kill_all_openclaw");
  });

  it("target-only mode refuses foreign app processes without broad cleanup", () => {
    const initialTargetBlock = script.slice(
      script.indexOf('if [[ "$TARGET_ONLY" -eq 1 ]]; then', script.indexOf("# 1)")),
      script.indexOf("else", script.indexOf("# 1)")),
    );
    const switchTargetBlock = script.slice(
      script.indexOf('if [[ "$TARGET_ONLY" -eq 1 ]]; then', script.indexOf("APP_LAUNCH_ARGS")),
      script.indexOf("# 4) Launch"),
    );

    expectContents(
      initialTargetBlock,
      ["foreign_openclaw_process_pids"],
      ["kill_managed_openclaw", "stop_launch_agent", "kill_all_openclaw"],
    );
    expectContents(switchTargetBlock, ["foreign_openclaw_process_pids", "kill_managed_openclaw"]);
    expectContents(script, [
      '[[ "${executable}" == "${TARGET_EXECUTABLE}" ]] && continue',
      'process_pids_for_executable "${TARGET_EXECUTABLE}"',
      "target-only restart deferred",
    ]);
  });

  it("finds persistent launchd supervisors across explicit domains", () => {
    const result = runManagedSupervisorClassifier([
      "gui/501|ai.openclaw.mac.custom|/Applications/OpenClaw.app/Contents/MacOS/OpenClaw|keepalive | runatload",
      "user/501|ai.openclaw.mac.target|/worktree/dist/OpenClaw.app/Contents/MacOS/OpenClaw|keepalive",
      "gui/501|application.ai.openclaw.mac.123|/Applications/OpenClaw.app/Contents/MacOS/OpenClaw|",
      "system|com.example.other|/Applications/Other.app/Contents/MacOS/Other|keepalive",
    ]);

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout.trim().split("\n").toSorted()).toEqual([
      "ai.openclaw.mac.custom",
      "ai.openclaw.mac.target",
    ]);
  });

  it("checks managed launchd supervisors before starting the Swift package build", () => {
    expectBefore(
      'managed_supervisors="$(managed_openclaw_supervisor_labels',
      'run_step "package app"',
    );
    expect(script).toContain("Unable to inspect loaded launchd jobs");
    expect(script).toContain("stop those jobs before a target-only restart");
  });

  it.each([false, true])("preserves plugin assets when reusing a source build: %s", (reuse) => {
    const root = makeTempRoot();
    const result = runHarness(
      root,
      [
        "set -euo pipefail",
        'ROOT_DIR="$PWD"',
        'run_step() { printf "%s\\n" "$1"; }',
        block("# Bundle Gateway-hosted plugin assets.", 'if [ "$AUTO_DETECT_SIGNING"'),
      ],
      { OPENCLAW_MAC_REUSE_BUILD: reuse ? "1" : "0" },
    );
    expectSuccess(result, reuse ? "" : "bundle plugin assets");
  });

  it("keeps the managed app alive until the signed replacement is ready", () => {
    expect(script).toContain('OPENCLAW_PACKAGE_APP_ROOT="${STAGED_APP_BUNDLE}"');
    expectBefore('run_step "package app"', 'run_step "verify packaged app"');
    expectBefore('run_step "package app"', 'log "==> Switching managed installed');
    expectBefore('log "==> Switching managed installed', 'run_step "install packaged app"');
    expectBefore('run_step "install packaged app"', 'run_step "launch app"');
  });

  it("escalates only exact managed app processes when graceful shutdown stalls", () => {
    const managedKillBlock = block("kill_managed_openclaw()", "stop_launch_agent()");
    const broadKillBlock = block("kill_all_openclaw()", "known_openclaw_executables()");

    expectContents(managedKillBlock, ['kill -KILL "${pid}"', "managed_openclaw_process_pids"]);
    expectContents(broadKillBlock, [], ["kill -KILL"]);
  });

  it("treats the canonical installed app as managed but temp bundles as foreign", () => {
    const result = runForeignProcessClassifier(
      [
        "#!/usr/bin/env bash",
        "printf '%s\\n' '  101 /Applications/OpenClaw.app/Contents/MacOS/OpenClaw --attach-only'",
        "printf '%s\\n' '  102 /Users/steipete/openclaw/dist/OpenClaw.app/Contents/MacOS/OpenClaw --attach-only'",
        "printf '%s\\n' '  103 /tmp/agent/OpenClaw.app/Contents/MacOS/OpenClaw --attach-only'",
        "printf '%s\\n' '  104 /bin/sh test.sh /Applications/OpenClaw.app/Contents/MacOS/OpenClaw'",
      ].join("\n"),
    );

    expectSuccess(result, "103");
  });

  it("verifies the launched app through the chosen bundle executable", () => {
    const verifyBlock = script.slice(script.indexOf("# 5) Verify the app is alive."));

    expectContents(
      verifyBlock,
      ['process_pids_matching "${APP_BUNDLE}/${APP_EXECUTABLE_RELATIVE_PATH}"'],
      ["APP_PROCESS_PATTERN", "pgrep"],
    );
  });

  it("forces LaunchServices to start the selected app bundle", () => {
    expect(script).toContain('OPEN_ARGS=(-n "${APP_BUNDLE}")');
    expect(script).toContain('/usr/bin/open "${OPEN_ARGS[@]}"');
    expectBefore("\nchoose_app_bundle\n", 'OPEN_ARGS=(-n "${APP_BUNDLE}")');
  });

  it("normalizes custom app bundle paths before process matching", () => {
    const root = makeTempRoot("openclaw-restart-mac-test-");
    const appBundle = join(root, "dist", "OpenClaw.app");
    fs.mkdirSync(appBundle, { recursive: true });

    const result = runHarness(root, [
      "set -euo pipefail",
      block("canonicalize_app_bundle()", "trap cleanup"),
      `APP_BUNDLE=${shellQuote(`${appBundle}/../OpenClaw.app/`)}`,
      fail,
      "canonicalize_app_bundle",
      'printf "%s\\n" "$APP_BUNDLE"',
    ]);
    expectSuccess(result, fs.realpathSync(appBundle));
  });

  it.each<[string, number, number, string]>([
    ["fails when scoped processes survive every kill attempt", 1, 20, ""],
    [
      "waits beyond the app signal failsafe for scoped processes to exit",
      0,
      11,
      'kill_count="$(wc -l < "$OPENCLAW_TEST_KILL_CALLS" 2>/dev/null || echo 0)"\n[[ "$kill_count" -lt 11 ]] || exit 0',
    ],
    ["does not kill unrelated app bundles", 0, 0, ""],
  ])("%s", (_name, exit, kills, until) => {
    const executable = kills ? "/worktree/dist/OpenClaw.app" : "/tmp/Other/OpenClaw.app";
    const { killCalls, result } = runCleanupFunction(
      [
        "#!/usr/bin/env bash",
        until,
        `printf '%s\\n' '  321 ${executable}/Contents/MacOS/OpenClaw --attach-only'`,
      ].join("\n"),
    );
    expect(result).toMatchObject({ status: exit, stdout: "", stderr: "" });
    if (kills) {
      expect(killCalls.trim().split(/\r?\n/u)).toHaveLength(kills);
    } else {
      expect(killCalls).toBe("");
    }
  });

  it("keeps the restart grace period longer than the app signal failsafe", () => {
    const cleanupBlock = block("kill_all_openclaw()", "stop_launch_agent()");
    const watcher = fs.readFileSync(
      "apps/macos/Sources/OpenClaw/TerminationSignalWatcher.swift",
      "utf8",
    );
    const maxAttempts = Number(cleanupBlock.match(/local max_attempts=(\d+)/u)?.[1]);
    const pollSeconds = Number(cleanupBlock.match(/local poll_seconds=([\d.]+)/u)?.[1]);
    const failsafeSeconds = Number(watcher.match(/signalExitFailsafeSeconds = ([\d.]+)/u)?.[1]);

    expect(maxAttempts * pollSeconds).toBeGreaterThan(failsafeSeconds);
  });
});
