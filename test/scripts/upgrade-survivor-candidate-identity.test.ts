import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { readJson, runProcess, writeJson } from "./upgrade-survivor-shard.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const selectedSha = "a".repeat(40);
const version = "2026.9.6";
type Change =
  | "valid"
  | "stale"
  | "tarball-changed"
  | "tarball-missing"
  | "entrypoint-missing"
  | "wrong-source"
  | "published"
  | "missing-baseline";
type Scenario = "base" | "sqlite-volume" | "projects-doctor" | "workshop-doctor-recovery";

function runCandidateFlow(scenario: Scenario, change: Change) {
  const root = tempDirs.make("upgrade-survivor-candidate-identity-");
  const candidate = path.join(root, "candidate", "package");
  const installed = path.join(root, "installed");
  const artifacts = path.join(root, "artifacts");
  const events = path.join(root, "events");
  const tarball = path.join(root, "candidate.tgz");
  mkdirSync(path.join(candidate, "dist"), { recursive: true });
  mkdirSync(artifacts);
  mkdirSync(path.join(root, "runtime"));
  writeJson(path.join(candidate, "package.json"), { name: "openclaw", version });
  writeFileSync(path.join(candidate, "openclaw.mjs"), "export {};\n");
  writeJson(path.join(candidate, "dist/build-info.json"), { version, commit: selectedSha });
  writeFileSync(path.join(candidate, "dist/entry.mjs"), "export const payload = 'candidate';\n");
  cpSync(candidate, installed, { recursive: true });
  writeFileSync(path.join(installed, "dist/entry.mjs"), "export const payload = 'stale';\n");
  writeFileSync(events, "");
  execFileSync("tar", ["-czf", tarball, "-C", path.dirname(candidate), "package"]);

  const source = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
  const audited = scenario === "projects-doctor" || scenario === "workshop-doctor-recovery";
  if (audited && change !== "missing-baseline") {
    writeJson(path.join(artifacts, "baseline-package-identity.json"), {
      buildInfo: { commit: change === "published" ? selectedSha : "c".repeat(40) },
    });
  }
  const startMarker =
    scenario === "projects-doctor"
      ? "  phase worker-candidate-identity prepare_worker_cell_package\n"
      : scenario === "workshop-doctor-recovery"
        ? "  phase capture-workshop-candidate-package "
        : "phase resolve-candidate resolve_candidate_version\n";
  const following =
    scenario === "projects-doctor"
      ? "  phase update-worker-candidate "
      : scenario === "workshop-doctor-recovery"
        ? "  phase seed-physical-baseline-index "
        : "run_missing_load_path_fixture post-update\n";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(following, start);
  const helperStart = source.indexOf("prepare_worker_cell_package() {\n");
  const helperEnd = source.indexOf("\nassert_worker_cell_update() {", helperStart);
  if (start < 0 || end < start || helperStart < 0 || helperEnd < helperStart) {
    throw new Error("Survivor candidate flow boundaries are unavailable");
  }
  const flow = source.slice(start, audited ? end : end + following.length);
  // Execute the registered flow and real identity CLI with fixture install/unrelated phases.
  const script = `set -eu
SCENARIO="$UNIT_SCENARIO"
CANDIDATE_KIND=tarball
CANDIDATE_SPEC="$UNIT_ROOT/candidate.tgz"
ARTIFACT_ROOT="$UNIT_ROOT/artifacts"
RUNTIME_ROOT="$UNIT_ROOT/runtime"
candidate_version=2026.9.6
candidate_install_mode=updater
baseline_version=2026.9.6
native_assignment_enabled=0
UPDATE_RESTART_MODE=manual
export OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT="$ARTIFACT_ROOT"
export OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT="$RUNTIME_ROOT"
node() { "$UNIT_NODE" "$@"; }
${source.slice(helperStart, helperEnd)}
package_root() { printf '%s\\n' "$UNIT_ROOT/installed"; }
companion_survivor_scenario() { return 1; }
run_plugin_fixture_phase() { :; }
run_missing_load_path_fixture() {
  [ "$1" != post-update ] || printf 'following-phase\\n' >> "$UNIT_ROOT/events"
}
update_candidate_for_install_mode() {
  printf 'updater\\n' >> "$UNIT_ROOT/events"
  [ "$UNIT_CHANGE" = stale ] || cp -R "$UNIT_ROOT/candidate/package/." "$UNIT_ROOT/installed/"
  case "$UNIT_CHANGE" in
    tarball-changed) printf '\\n' >> "$CANDIDATE_SPEC" ;;
    tarball-missing) rm "$CANDIDATE_SPEC" ;;
    entrypoint-missing) rm "$UNIT_ROOT/installed/openclaw.mjs" ;;
  esac
}
phase() {
  shift
  case "$1" in
    node)
      if [ "$2" = scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs ]; then
        shift
        "$UNIT_NODE" "$@"
      fi ;;
    update_candidate_for_install_mode|prepare_worker_cell_package) "$@" ;;
    *) : ;;
  esac
}
${flow}
`;
  const result = runProcess(
    "/bin/bash",
    ["-c", script],
    {
      ...process.env,
      UNIT_ROOT: root,
      UNIT_NODE: resolveTestNodeExecPath(),
      UNIT_SCENARIO: scenario,
      UNIT_CHANGE: change,
      OPENCLAW_DOCKER_E2E_SELECTED_SHA: change === "wrong-source" ? "b".repeat(40) : selectedSha,
    },
    10_000,
  );
  return {
    result,
    artifacts,
    events: readFileSync(events, "utf8").trim().split("\n").filter(Boolean),
  };
}

type IdentityCase = [scenario: Scenario, change: Change, error?: string, events?: string[]];
const payloadMismatch = "Installed application payload differs from the frozen tarball";
it.skipIf(process.platform === "win32").each<IdentityCase>([
  ...(["base", "sqlite-volume"] as const).flatMap<IdentityCase>((scenario) => [
    [scenario, "stale", payloadMismatch, ["updater"]],
    [scenario, "valid", undefined, ["updater", "following-phase"]],
  ]),
  ["base", "wrong-source", "Candidate build commit must equal the selected source SHA", []],
  ["base", "tarball-changed", "Candidate tarball changed", ["updater"]],
  ["base", "tarball-missing", "Candidate tarball changed", ["updater"]],
  ["base", "entrypoint-missing", payloadMismatch, ["updater"]],
  ...(["projects-doctor", "workshop-doctor-recovery"] as const).flatMap<IdentityCase>(
    (scenario) => [
      [scenario, "valid"],
      [scenario, "published", "Candidate still contains published bytes", []],
      [scenario, "missing-baseline", "ENOENT", []],
    ],
  ),
])("%s candidate identity with %s bytes", (scenario, change, error, events) => {
  const observed = runCandidateFlow(scenario, change);
  const kind = scenario === "base" || scenario === "sqlite-volume" ? "installed" : "candidate";
  const identity = path.join(observed.artifacts, `${kind}-package-identity.json`);
  if (error) {
    expect(observed.result.status).not.toBe(0);
    expect(observed.result.stderr).toContain(error);
    expect(existsSync(identity)).toBe(false);
  } else {
    expect(observed.result.status, observed.result.stdout + observed.result.stderr).toBe(0);
    expect(existsSync(identity)).toBe(true);
    if (kind === "installed") {
      expect(readJson(identity)).toMatchObject({
        version,
        buildInfo: { commit: selectedSha },
      });
    }
  }
  if (events) {
    expect(observed.events).toEqual(events);
  }
});
