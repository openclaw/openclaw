import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const helperPath = "scripts/lib/restart-mac-gateway.sh";
const restartScriptPath = "scripts/restart-mac.sh";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const script = readFileSync(restartScriptPath, "utf8");
const fail = 'fail() { printf "ERROR: %s\\n" "$*" >&2; exit 1; }';
const log = 'log() { printf "%s\\n" "$*"; }';

function makeTempRoot(prefix = "openclaw-restart-mac-test-") {
  return tempDirs.make(prefix);
}

function block(start: string, end: string) {
  return script.slice(script.indexOf(start), script.indexOf(end));
}

function runHarness(root: string, lines: string[], env = {}, args: string[] = [], bash = "bash") {
  const harnessPath = join(root, "harness.sh");
  writeFileSync(harnessPath, lines.join("\n"));
  return spawnSync(bash, [harnessPath, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function fakeTools(root: string, tools: Record<string, string>) {
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  for (const [name, body] of Object.entries(tools)) {
    const file = join(binDir, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }
  return { PATH: `${binDir}:${process.env.PATH ?? ""}` };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runGatewayPortCheck(fakeLsof: string) {
  const root = makeTempRoot();

  return spawnSync(
    "bash",
    ["-c", `source ${shellQuote(helperPath)}; verify_gateway_port_listening 18789`],
    {
      encoding: "utf8",
      env: { ...process.env, ...fakeTools(root, { lsof: fakeLsof }) },
    },
  );
}

function runCleanupFunction(fakePs: string) {
  const root = makeTempRoot();
  const killCallsPath = join(root, "kill-calls.txt");
  const result = runHarness(
    root,
    [
      "#!/usr/bin/env bash",
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
  const killCalls = existsSync(killCallsPath) ? readFileSync(killCallsPath, "utf8") : "";
  return { killCalls, result };
}

function runManagedSupervisorClassifier(
  records: Array<{ domain: string; label: string; program: string; properties?: string }>,
  options: { failEnumeration?: boolean } = {},
) {
  const root = makeTempRoot("openclaw-restart-mac-supervisor-test-");
  const recordsPath = join(root, "loaded-jobs.txt");
  writeFileSync(
    recordsPath,
    records
      .map(
        (record) => `${record.domain}|${record.label}|${record.program}|${record.properties ?? ""}`,
      )
      .join("\n"),
  );

  return runHarness(
    root,
    [
      "#!/usr/bin/env bash",
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
      OPENCLAW_TEST_FAIL_ENUMERATION: options.failEnumeration ? "1" : "0",
      OPENCLAW_TEST_LOADED_JOBS: recordsPath,
    },
  );
}

function runCanonicalizeAppBundle(appBundle: string) {
  const root = makeTempRoot();
  return runHarness(
    root,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      block("canonicalize_app_bundle()", "trap cleanup"),
      'APP_BUNDLE="$1"',
      fail,
      "canonicalize_app_bundle",
      'printf "%s\\n" "$APP_BUNDLE"',
    ],
    {},
    [appBundle],
  );
}

function runRestartArgParser(...args: string[]) {
  return runHarness(
    makeTempRoot(),
    [
      "#!/usr/bin/env bash",
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
  const start = script.indexOf('if [ "$NO_SIGN" -eq 1 ]; then');
  const signingBlock = script.slice(start, script.indexOf("# 3) Package and sign", start));
  return runHarness(
    makeTempRoot(),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "NO_SIGN=0",
      "SIGN=1",
      "check_signing_keys() { return 0; }",
      fail,
      signingBlock,
      'printf "%s\\n" "${SIGN_IDENTITY-<unset>}"',
    ],
    { SIGN_IDENTITY: signIdentity },
  );
}

function runProfileGuard(profile: string) {
  const start = script.indexOf('if [[ -n "${OPENCLAW_PROFILE:-}" ]]');
  const guardBlock = script.slice(start, script.indexOf("canonicalize_app_bundle", start));
  return runHarness(
    makeTempRoot(),
    ["#!/bin/bash", "set -euo pipefail", fail, guardBlock, 'printf "safe\\n"'],
    { OPENCLAW_PROFILE: profile },
    [],
    "/bin/bash",
  );
}

function runRestartLockHarness(lockDir: string) {
  return runHarness(makeTempRoot(), [
    "#!/usr/bin/env bash",
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
      "#!/usr/bin/env bash",
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

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(identity);
    expect(result.stderr).toBe("");
  });

  it("rejects unknown restart options before side effects", () => {
    const result = runRestartArgParser("--wat");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("ERROR: Unknown restart option: --wat");
  });

  it("fails closed when loaded launchd jobs cannot be enumerated", () => {
    const result = runManagedSupervisorClassifier([], { failEnumeration: true });

    expect(result.status).toBe(1);
  });

  it("fails the gateway verification when lsof finds no listener", () => {
    const result = runGatewayPortCheck("#!/usr/bin/env bash\nexit 1\n");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No process is listening on gateway port 18789.");
    expect(result.stdout).toBe("");
  });

  it("uses a fail-closed gateway port verification helper", () => {
    expect(script).toContain('source "${ROOT_DIR}/scripts/lib/restart-mac-gateway.sh"');
    expect(script).toContain(
      'run_step "verify gateway port ${GATEWAY_PORT} (unsigned)" verify_gateway_port_listening "${GATEWAY_PORT}"',
    );
    expect(script).not.toContain("lsof -iTCP:${GATEWAY_PORT} -sTCP:LISTEN | head -n 5 || true");
  });

  it("avoids login-shell noise and early-exit pipe warnings", () => {
    expect(script).not.toContain("bash -lc");
    expect(script).not.toContain(`printf '%s\\n' "\${job}" | /usr/bin/awk`);
    expect(script).toContain("/usr/bin/awk -F ' = '");
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
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "pid"), String(process.pid), "utf8");

    const result = runRestartLockHarness(lockDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `Another restart is running (pid ${process.pid}); re-run with --wait.`,
    );
    expect(result.stderr).toBe("");
    expect(existsSync(lockDir)).toBe(true);
    expect(readFileSync(join(lockDir, "pid"), "utf8")).toBe(String(process.pid));
  });

  it("prefers the freshly packaged app unless an explicit app bundle is set", () => {
    const chooseBlock = script.slice(
      script.indexOf("choose_app_bundle()"),
      script.indexOf("choose_app_bundle", script.indexOf("choose_app_bundle()") + 1),
    );

    expect(script).toContain('fail "OPENCLAW_APP_BUNDLE does not exist: ${APP_BUNDLE}"');
    expect(chooseBlock).toContain("canonicalize_app_bundle");
    expect(chooseBlock.indexOf("${ROOT_DIR}/dist/OpenClaw.app")).toBeGreaterThan(-1);
    expect(chooseBlock.indexOf("/Applications/OpenClaw.app")).toBeGreaterThan(-1);
    expect(chooseBlock.indexOf("${ROOT_DIR}/dist/OpenClaw.app")).toBeLessThan(
      chooseBlock.indexOf("/Applications/OpenClaw.app"),
    );
  });

  it("stops launchd supervision before killing app processes", () => {
    const stopIndex = script.indexOf("stop_launch_agent\n  log");
    const killIndex = script.indexOf("if ! kill_all_openclaw");

    expect(stopIndex).toBeGreaterThan(-1);
    expect(killIndex).toBeGreaterThan(-1);
    expect(stopIndex).toBeLessThan(killIndex);
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

    expect(initialTargetBlock).toContain("foreign_openclaw_process_pids");
    expect(initialTargetBlock).not.toContain("kill_managed_openclaw");
    expect(initialTargetBlock).not.toContain("stop_launch_agent");
    expect(initialTargetBlock).not.toContain("kill_all_openclaw");
    expect(switchTargetBlock).toContain("foreign_openclaw_process_pids");
    expect(switchTargetBlock).toContain("kill_managed_openclaw");
    expect(script).toContain('[[ "${executable}" == "${TARGET_EXECUTABLE}" ]] && continue');
    expect(script).toContain('process_pids_for_executable "${TARGET_EXECUTABLE}"');
    expect(script).toContain("target-only restart deferred");
  });

  it("finds persistent launchd supervisors across explicit domains", () => {
    const result = runManagedSupervisorClassifier([
      {
        domain: "gui/501",
        label: "ai.openclaw.mac.custom",
        program: "/Applications/OpenClaw.app/Contents/MacOS/OpenClaw",
        properties: "keepalive | runatload",
      },
      {
        domain: "user/501",
        label: "ai.openclaw.mac.target",
        program: "/worktree/dist/OpenClaw.app/Contents/MacOS/OpenClaw",
        properties: "keepalive",
      },
      {
        domain: "gui/501",
        label: "application.ai.openclaw.mac.123",
        program: "/Applications/OpenClaw.app/Contents/MacOS/OpenClaw",
      },
      {
        domain: "system",
        label: "com.example.other",
        program: "/Applications/Other.app/Contents/MacOS/Other",
        properties: "keepalive",
      },
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n").toSorted()).toEqual([
      "ai.openclaw.mac.custom",
      "ai.openclaw.mac.target",
    ]);
    expect(result.stderr).toBe("");
  });

  it("checks managed launchd supervisors before starting the Swift package build", () => {
    const supervisorIndex = script.indexOf(
      'managed_supervisors="$(managed_openclaw_supervisor_labels',
    );
    const packageIndex = script.indexOf('run_step "package app"');

    expect(supervisorIndex).toBeGreaterThan(-1);
    expect(packageIndex).toBeGreaterThan(supervisorIndex);
    expect(script).toContain("Unable to inspect loaded launchd jobs");
    expect(script).toContain("stop those jobs before a target-only restart");
  });

  it("keeps the managed app alive until the signed replacement is ready", () => {
    const packageIndex = script.indexOf('run_step "package app"');
    const verifyIndex = script.indexOf('run_step "verify packaged app"');
    const switchIndex = script.indexOf('log "==> Switching managed installed');
    const installIndex = script.indexOf('run_step "install packaged app"');
    const launchIndex = script.indexOf('run_step "launch app"');

    expect(packageIndex).toBeGreaterThan(-1);
    expect(script).toContain('OPENCLAW_PACKAGE_APP_ROOT="${STAGED_APP_BUNDLE}"');
    expect(verifyIndex).toBeGreaterThan(packageIndex);
    expect(switchIndex).toBeGreaterThan(packageIndex);
    expect(installIndex).toBeGreaterThan(switchIndex);
    expect(launchIndex).toBeGreaterThan(installIndex);
    expect(launchIndex).toBeGreaterThan(switchIndex);
  });

  it("escalates only exact managed app processes when graceful shutdown stalls", () => {
    const managedKillBlock = script.slice(
      script.indexOf("kill_managed_openclaw()"),
      script.indexOf("stop_launch_agent()"),
    );
    const broadKillBlock = script.slice(
      script.indexOf("kill_all_openclaw()"),
      script.indexOf("known_openclaw_executables()"),
    );

    expect(managedKillBlock).toContain('kill -KILL "${pid}"');
    expect(managedKillBlock).toContain("managed_openclaw_process_pids");
    expect(broadKillBlock).not.toContain("kill -KILL");
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

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("103");
    expect(result.stderr).toBe("");
  });

  it("verifies the launched app through the chosen bundle executable", () => {
    const verifyBlock = script.slice(script.indexOf("# 5) Verify the app is alive."));

    expect(verifyBlock).toContain(
      'process_pids_matching "${APP_BUNDLE}/${APP_EXECUTABLE_RELATIVE_PATH}"',
    );
    expect(verifyBlock).not.toContain("APP_PROCESS_PATTERN");
    expect(verifyBlock).not.toContain("pgrep");
  });

  it("forces LaunchServices to start the selected app bundle", () => {
    expect(script).toContain('OPEN_ARGS=(-n "${APP_BUNDLE}")');
    expect(script).toContain('/usr/bin/open "${OPEN_ARGS[@]}"');
    expect(script.indexOf("\nchoose_app_bundle\n")).toBeLessThan(
      script.indexOf('OPEN_ARGS=(-n "${APP_BUNDLE}")'),
    );
  });

  it("normalizes custom app bundle paths before process matching", () => {
    const root = makeTempRoot("openclaw-restart-mac-test-");
    const appBundle = join(root, "dist", "OpenClaw.app");
    mkdirSync(appBundle, { recursive: true });

    const result = runCanonicalizeAppBundle(`${appBundle}/../OpenClaw.app/`);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(realpathSync(appBundle));
    expect(result.stderr).toBe("");
  });

  it("fails restart cleanup when scoped processes survive every kill attempt", () => {
    const { killCalls, result } = runCleanupFunction(
      [
        "#!/usr/bin/env bash",
        "printf '%s\\n' '  321 /worktree/dist/OpenClaw.app/Contents/MacOS/OpenClaw --attach-only'",
      ].join("\n"),
    );

    expect(result.status).toBe(1);
    expect(killCalls.trim().split(/\r?\n/u)).toHaveLength(20);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("waits beyond the app signal failsafe for scoped processes to exit", () => {
    const { killCalls, result } = runCleanupFunction(
      [
        "#!/usr/bin/env bash",
        'kill_count="$(wc -l < "$OPENCLAW_TEST_KILL_CALLS" 2>/dev/null || echo 0)"',
        'if [[ "$kill_count" -lt 11 ]]; then',
        "  printf '%s\\n' '  321 /worktree/dist/OpenClaw.app/Contents/MacOS/OpenClaw --attach-only'",
        "fi",
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    expect(killCalls.trim().split(/\r?\n/u)).toHaveLength(11);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("keeps the restart grace period longer than the app signal failsafe", () => {
    const cleanupBlock = script.slice(
      script.indexOf("kill_all_openclaw()"),
      script.indexOf("stop_launch_agent()"),
    );
    const watcher = readFileSync(
      "apps/macos/Sources/OpenClaw/TerminationSignalWatcher.swift",
      "utf8",
    );
    const maxAttempts = Number(cleanupBlock.match(/local max_attempts=(\d+)/u)?.[1]);
    const pollSeconds = Number(cleanupBlock.match(/local poll_seconds=([\d.]+)/u)?.[1]);
    const failsafeSeconds = Number(watcher.match(/signalExitFailsafeSeconds = ([\d.]+)/u)?.[1]);

    expect(maxAttempts * pollSeconds).toBeGreaterThan(failsafeSeconds);
  });

  it("does not kill unrelated OpenClaw app bundles", () => {
    const { killCalls, result } = runCleanupFunction(
      [
        "#!/usr/bin/env bash",
        "printf '%s\\n' '  654 /tmp/Other/OpenClaw.app/Contents/MacOS/OpenClaw'",
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    expect(killCalls).toBe("");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
