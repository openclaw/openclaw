import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { expectStatus, readJson } from "./upgrade-survivor-io.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const source = readFileSync(resolve("scripts/e2e/lib/upgrade-survivor/run.sh"), "utf8");
const section = (from: string, to: string) =>
  source.slice(source.indexOf(`${from}() {`), source.indexOf(`${to}() {`));
const lifecycle = section("on_error", "companion_survivor_scenario");
const update = section("is_extended_stable_release_version", "assert_sibling_published_refusal");

function runFixture(
  fault: string,
  script: string,
  args: string[] = [],
  timeout = 5_000,
  bash = "bash",
) {
  const root = dirs.make("survivor-recovery-phase-");
  const result = spawnSync(
    bash,
    ["-c", `set -euo pipefail\nexec 3>&1\n${script}`, "fixture", root, fault, ...args],
    {
      env: { PATH: process.env.PATH, HOME: root },
      encoding: "utf8",
      timeout,
    },
  );
  return { root, result };
}

it.skipIf(process.platform === "win32").each([
  { fault: "future-tarball", phase: "prepare-restart-package", code: 124 },
  { fault: "future-runtime-tarball", phase: "prepare-restart-runtime", code: 137 },
  { fault: "none", phase: "", code: 0 },
])("preserves restart fixture timeout diagnostics ($fault)", ({ fault, phase, code }) => {
  const prepare = section("prepare_restart_fixture", "repair_update_restart_auth");
  const { root, result } = runFixture(
    fault,
    `source scripts/lib/openclaw-e2e-instance.sh
ARTIFACT_ROOT="$1"
RUNTIME_ROOT="$1"
FAULT="$2"
FAULT_STATUS="$3"
SCENARIO=base
COMMAND_TIMEOUT=1500s
candidate_tarball=candidate.tgz
candidate_version=2026.10.2
OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR=registry
NPM_CONFIG_REGISTRY=registry
CURRENT_PHASE=""
FAILURE_PHASE=""
FAILURE_MESSAGE=""
FAILURE_SIGNAL=""
last_update_observation_root=""
SUMMARY_JSON="$1/summary.json"
run_completed=0
json_event() { :; }
cleanup() { :; }
write_summary() { :; }
prepare_candidate_tarball() { :; }
openclaw_prepublish_plugin_registry_start() { :; }
timeout() {
  [ "$1" != --kill-after=1s ] || return 0
  shift
  printf 'budget\\t%s\\t%s\\n' "$1" "$4" >&3
  shift
  [ "$3" != "$FAULT" ] || return "$FAULT_STATUS"
  "$@"
}
node() {
  case "$1" in
    scripts/e2e/lib/update-first-hop-package-fixtures.mjs)
      printf '{"targetVersion":"2026.10.3"}\\n' ;;
    -p) printf '2026.10.3' ;;
    -) cat >/dev/null; printf 'runtime.tgz' ;;
    scripts/e2e/lib/upgrade-survivor/diagnostics.mjs)
      printf 'capture\\t%s\\t%s\\n' "$4" "$5" >&3 ;;
    *) return 91 ;;
  esac
}
${lifecycle}
${prepare}
phase prepare-restart-fixture prepare_restart_fixture || exit "$?"
run_completed=1
`,
    [String(code)],
    5_000,
    "/bin/bash",
  );
  expectStatus(result, code);
  const lines = result.stdout.split("\n");
  expect(lines.filter((line) => line.startsWith("budget\t"))).toEqual([
    "budget\t1500s\tfuture-tarball",
    ...(fault === "future-tarball" ? [] : ["budget\t1500s\tfuture-runtime-tarball"]),
  ]);
  if (code !== 0) {
    expect(lines).toContain(`capture\t${phase}\t${code}`);
  } else {
    for (const file of ["restart-fixture.json", "restart-runtime-fixture.json"]) {
      expect(readJson(join(root, file))).toEqual({
        targetVersion: "2026.10.3",
      });
    }
  }
});

it.skipIf(process.platform === "win32").each([
  { fault: "none", code: 0 },
  { fault: "stop", code: 17 },
  { fault: "still-active", code: 1 },
  { fault: "listener", code: 1 },
])("stops a Doctor-started service before recovery preparation ($fault)", ({ fault, code }) => {
  const repair = section("repair_update_restart_auth", "assert_managed_membership_warning");
  const { result } = runFixture(
    fault,
    `source scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh
ARTIFACT_ROOT="$1"
OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG="$1/gateway.log"
FAULT="$2"
SCENARIO=base
UPDATE_RESTART_MODE=auto-auth
OPENCLAW_FROZEN_UPGRADE_SURVIVOR_MEMBERSHIP_MODE=absent
COMMAND_TIMEOUT=30
restart_fixture_package=synthetic.tgz
restart_fixture_version=2026.9.7
update_repair_required=0
active=1
phase() { shift; "$@"; }
systemctl() {
  case "$2" in
    stop)
      printf 'stop\n' >&3
      [ "$FAULT" != stop ] || return 17
      [ "$FAULT" = still-active ] || active=0 ;;
    is-active) [ "$active" = 1 ] && return 0; return 3 ;;
    *) return 99 ;;
  esac
}
openclaw_e2e_maybe_timeout() { shift; "$@"; }
openclaw_e2e_probe_tcp() { [ "$FAULT" = listener ]; }
openclaw_e2e_print_log() { cat "$1"; }
prepare_restart_inference() { printf 'inference\n'; }
prepare_restart_fixture() { printf 'fixture\n'; }
install_update_restart_systemctl_shim() { printf 'manager\n'; }
run_update_restart_probe_gateway() {
  assert_update_restart_probe_inactive || return "$?"
  printf 'prepared\n'
}
check_gateway_status() { printf 'auth\n'; }
update_candidate() { printf 'update\n'; }
assert_managed_membership_warning() { :; }
node() { :; }
assert_survival() { :; }
${repair}
repair_update_restart_auth
`,
  );
  expectStatus(result, code);
  expect(result.stdout.trim().split("\n")).toEqual(
    code === 0
      ? ["stop", "inference", "fixture", "manager", "prepared", "auth", "update"]
      : ["stop"],
  );
  if (code !== 0) {
    expect(result.stderr).toContain("gateway service shutdown could not be verified");
  }
});

it.skipIf(process.platform === "win32").each([
  ["command", 17, "command", 0],
  ["command-one", 1, "command", 0],
  ["assertion", 1, "result-assertion", 1],
  ["replacement", 1, "service-replacement", 2],
  ["version", 1, "version-match", 2],
  ["success", 0, "", 2],
  ["signal-command", 143, "command", 0],
  ["signal-assertion", 143, "result-assertion", 1],
  ["signal-replacement", 143, "service-replacement", 2],
  ["initial-command", 17, "", 0],
] as const)(
  "preserves recovery outcome and capture ordering for %s",
  (fault, code, stage, checkCount) => {
    const initial = fault === "initial-command";
    const phase = initial ? "update-candidate" : "recovery-update-restart";
    const expectedPhase = stage ? `recovery-update-${stage}` : phase;
    const { root, result } = runFixture(
      fault,
      `ARTIFACT_ROOT="$1"
SUMMARY_JSON="$1/summary.json"
FAULT="$2"
SCENARIO=base
UPDATE_RESTART_MODE=auto-auth
ROOT_MANAGED_VPS=0
COMMAND_TIMEOUT=unchanged
candidate_version=2026.9.7
baseline_version=2026.9.6
baseline_spec=openclaw@2026.9.6
CANDIDATE_KIND=tarball
UPDATE_JSON="$1/update.json"
UPDATE_ERR="$1/update.err"
POST_UPDATE_VALIDATE_JSON="$1/validate.json"
POST_UPDATE_VALIDATE_ERR="$1/validate.err"
SYSTEMCTL_SHIM_PID_FILE="$1/pid"
SYSTEMCTL_SHIM_LOG="$1/systemctl.log"
printf '42\n' > "$SYSTEMCTL_SHIM_PID_FILE"
: > "$SYSTEMCTL_SHIM_LOG"
initial_update_observation_root=initial-observation
last_update_observation_root=""
FAILURE_PHASE=""
FAILURE_MESSAGE=""
FAILURE_SIGNAL=""
CURRENT_PHASE=""
run_completed=0
update_repair_required=0
json_event() { printf 'event\t%s\t%s\n' "$1" "$2" >&3; }
cleanup() { printf 'cleanup\n' >&3; }
write_summary() { printf 'summary\t%s\t%s\t%s\n' "$1" "$FAILURE_PHASE" "$FAILURE_SIGNAL" >&3; }
openclaw_e2e_print_log() { :; }
read_installed_version() {
  if [ "$FAULT" = version ]; then printf 'wrong'; else printf '2026.9.7'; fi
}
openclaw_e2e_maybe_timeout() {
  if [ "$2" = openclaw ]; then printf 'validate\n' >&3; return 0; fi
  printf 'command\n' >&3
  case "$FAULT" in
    command|initial-command) return 17 ;;
    command-one) return 1 ;;
    signal-command) kill -TERM $$ ;;
  esac
}
node() {
  if [ "$1" = -e ]; then printf '1000'; return 0; fi
  case "$2" in
    assert-successful-update-json)
      printf 'check\tassertion\n' >&3
      [ "$5" = "$last_update_observation_root" ] || return 92
      [ "$5" != "$initial_update_observation_root" ] || return 92
      [ "$3" = "$ARTIFACT_ROOT/recovery-update.json" ] || return 92
      if [ "$FAULT" = signal-assertion ]; then kill -TERM $$; fi
      [ "$FAULT" != assertion ] ;;
    capture)
      printf 'capture\t%s\t%s\t%s\t%s\n' "$4" "$5" "$6" "$7" >&3 ;;
    *) return 91 ;;
  esac
}
assert_update_restart_service_replaced() {
  printf 'check\treplacement\n' >&3
  [ "$1" = 42 ] && [ "$2" -eq 0 ] || return 92
  if [ "$FAULT" = signal-replacement ]; then kill -TERM $$; fi
  [ "$FAULT" != replacement ]
}
${lifecycle}
${update}
update_and_observe() {
  update_candidate "$@" || return "$?"
  printf 'restored\t%s\n' "$CURRENT_PHASE" >&3
}
phase "$3" update_and_observe "$4" file:synthetic 2026.9.7 || exit "$?"
printf 'returned\t%s\n' "$CURRENT_PHASE" >&3
run_completed=1
`,
      [phase, initial ? "0" : "1"],
      10_000,
    );
    expectStatus(result, code);
    const lines = result.stdout.split("\n");
    expect(lines.filter((line) => line.startsWith("check\t"))).toEqual(
      ["assertion", "replacement"].slice(0, checkCount).map((check) => `check\t${check}`),
    );
    expect(lines.filter((line) => line.startsWith("event\t"))).toEqual([
      `event\t${phase}\tstarted`,
      ...(code === 0 ? [`event\t${phase}\tpassed`] : []),
    ]);
    expect(lines.filter((line) => line === "cleanup")).toHaveLength(1);
    if (code === 0) {
      expect(lines).toContain(`restored\t${phase}`);
      expect(lines).toContain("returned\t");
      expect(lines).toContain("summary\tpassed\t\t");
      expect(lines.some((line) => line.startsWith("capture\t"))).toBe(false);
      return;
    }
    const signal = fault.startsWith("signal-") ? "SIGTERM" : "";
    const capture = lines.find((line) => line.startsWith("capture\t"));
    expect(capture).toBeDefined();
    const fields = capture!.split("\t");
    expect(fields.slice(0, 4)).toEqual(["capture", expectedPhase, String(code), signal]);
    expect(fields[4]?.startsWith(root + "/update-observation.")).toBe(true);
    expect(lines.indexOf(capture!)).toBeLessThan(lines.indexOf("cleanup"));
    expect(lines).toContain(`summary\tfailed\t${expectedPhase}\t${signal}`);
    expect(lines.includes("validate")).toBe(
      fault === "command" || fault === "command-one" || fault === "assertion" || initial,
    );
  },
);
