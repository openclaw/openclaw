import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { publishDiagnostics } from "../../scripts/e2e/lib/upgrade-survivor/diagnostics.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const source = readFileSync(resolve("scripts/e2e/lib/upgrade-survivor/run.sh"), "utf8");
const lifecycle = source.slice(
  source.indexOf("on_error() {"),
  source.indexOf("companion_survivor_scenario() {"),
);
const update = source.slice(
  source.indexOf("update_candidate() {"),
  source.indexOf("assert_sibling_published_refusal() {"),
);
const outer = "recovery-update-restart";

it.skipIf(process.platform === "win32").each([
  { fault: "command", code: 17, stage: "command", checks: [] },
  { fault: "command-one", code: 1, stage: "command", checks: [] },
  { fault: "assertion", code: 1, stage: "result-assertion", checks: ["assertion"] },
  {
    fault: "replacement",
    code: 1,
    stage: "service-replacement",
    checks: ["assertion", "replacement"],
  },
  { fault: "version", code: 1, stage: "version-match", checks: ["assertion", "replacement"] },
  { fault: "success", code: 0, stage: "", checks: ["assertion", "replacement"] },
  { fault: "signal-command", code: 143, stage: "command", checks: [] },
  { fault: "signal-assertion", code: 143, stage: "result-assertion", checks: ["assertion"] },
  {
    fault: "signal-replacement",
    code: 143,
    stage: "service-replacement",
    checks: ["assertion", "replacement"],
  },
  { fault: "initial-command", code: 17, stage: "", checks: [] },
])(
  "preserves recovery outcome and capture ordering for $fault",
  ({ fault, code, stage, checks }) => {
    const root = dirs.make("survivor-recovery-phase-");
    const initial = fault === "initial-command";
    const phase = initial ? "update-candidate" : outer;
    const expectedPhase = stage ? `recovery-update-${stage}` : phase;
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
exec 3>&1
ARTIFACT_ROOT="$1"
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
  [ "$1" = 42 ] && [ "$2" = 0 ] || return 92
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
        "fixture",
        root,
        fault,
        phase,
        initial ? "0" : "1",
      ],
      {
        env: { PATH: process.env.PATH, HOME: root },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.status, result.stderr).toBe(code);
    const lines = result.stdout.split("\n");
    expect(lines.filter((line) => line.startsWith("check\t"))).toEqual(
      checks.map((check) => `check\t${check}`),
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

    // Existing publisher/schema: only the phase value changes, never the wire shape.
    mkdirSync(join(root, "diagnostics"));
    const raw = { phase: expectedPhase, exitStatus: code, signal: signal || null };
    writeFileSync(join(root, "diagnostics/raw.json"), JSON.stringify(raw));
    const destination = join(root, "public");
    expect(publishDiagnostics(root, destination, (text: string) => text)).toEqual(raw);
    const published = readFileSync(join(destination, "failure.json"), "utf8");
    writeFileSync(join(root, "diagnostics/raw.json"), JSON.stringify({ ...raw, phase }));
    const control = join(root, "control");
    publishDiagnostics(root, control, (text: string) => text);
    expect(published.replace(expectedPhase, phase)).toBe(
      readFileSync(join(control, "failure.json"), "utf8"),
    );
  },
);
