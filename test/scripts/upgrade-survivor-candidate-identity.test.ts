import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { packToArchive } from "../../src/plugins/test-helpers/archive-fixtures.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { readJson, runProcess, writeJson } from "./upgrade-survivor-shard.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const selectedSha = "a".repeat(40);
const version = "2026.10.9";
type Change =
  | "valid"
  | "deferred-doctor"
  | "stale"
  | "tarball-changed"
  | "tarball-missing"
  | "entrypoint-missing"
  | "wrong-source"
  | "published"
  | "missing-baseline";
type Scenario =
  | "base"
  | "sqlite-volume"
  | "legacy-operator-state"
  | "projects-doctor"
  | "workshop-doctor-recovery";

type IdentityCase = [scenario: Scenario, change: Change, error?: string, events?: string[]];
const payloadMismatch = "Installed application payload differs from the frozen tarball";
it.skipIf(process.platform === "win32").each<IdentityCase>([
  ["base", "stale", payloadMismatch, ["updater"]],
  ["base", "valid", undefined, ["updater", "following-phase"]],
  ["sqlite-volume", "valid", undefined, ["updater", "following-phase"]],
  ["legacy-operator-state", "stale", payloadMismatch, ["updater"]],
  ["legacy-operator-state", "valid", undefined, ["updater", "following-phase"]],
  [
    "legacy-operator-state",
    "wrong-source",
    "Candidate build commit must equal the selected source SHA",
    [],
  ],
  [
    "legacy-operator-state",
    "deferred-doctor",
    undefined,
    ["updater", "deferred-doctor", "following-phase"],
  ],
  ["base", "wrong-source", "Candidate build commit must equal the selected source SHA", []],
  ["base", "tarball-changed", "Candidate tarball changed", ["updater"]],
  ["base", "tarball-missing", "Candidate tarball changed", ["updater"]],
  ["base", "entrypoint-missing", payloadMismatch, ["updater"]],
  ...(["projects-doctor", "workshop-doctor-recovery"] as const).flatMap<IdentityCase>(
    (scenario) => [
      [scenario, "valid"],
      [scenario, "published", "Candidate still contains published bytes", []],
    ],
  ),
  ["projects-doctor", "missing-baseline", "ENOENT", []],
])("%s candidate identity with %s bytes", async (scenario, change, error, events) => {
  const root = tempDirs.make("upgrade-survivor-candidate-identity-");
  const candidate = path.join(root, "candidate", "package");
  const installed = path.join(root, "installed");
  const artifacts = path.join(root, "artifacts");
  mkdirSync(path.join(candidate, "dist"), { recursive: true });
  mkdirSync(artifacts);
  mkdirSync(path.join(root, "runtime"));
  writeJson(path.join(candidate, "package.json"), { name: "openclaw", version });
  writeFileSync(path.join(candidate, "openclaw.mjs"), "export {};\n");
  writeJson(path.join(candidate, "dist/build-info.json"), { version, commit: selectedSha });
  writeFileSync(path.join(candidate, "dist/entry.mjs"), "export const payload = 'candidate';\n");
  cpSync(candidate, installed, { recursive: true });
  writeFileSync(path.join(installed, "dist/entry.mjs"), "export const payload = 'stale';\n");
  await packToArchive({ pkgDir: candidate, outDir: root, outName: "candidate.tgz" });

  const source = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
  const audited = scenario === "projects-doctor" || scenario === "workshop-doctor-recovery";
  if (audited && change !== "missing-baseline") {
    writeJson(path.join(artifacts, "baseline-package-identity.json"), {
      buildInfo: { commit: change === "published" ? selectedSha : "c".repeat(40) },
    });
  }
  const [startMarker, following] =
    scenario === "projects-doctor"
      ? [
          "  phase worker-candidate-identity prepare_worker_cell_package\n",
          "  phase update-worker-candidate ",
        ]
      : scenario === "workshop-doctor-recovery"
        ? ["  phase capture-workshop-candidate-package ", "  phase seed-physical-baseline-index "]
        : [
            "phase resolve-candidate resolve_candidate_version\n",
            "run_missing_load_path_fixture post-update\n",
          ];
  const section = (from: string, to: string) => {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start);
    if (start < 0 || end < start) {
      throw new Error("Survivor candidate flow boundaries are unavailable");
    }
    return source.slice(start, end);
  };
  // Execute the registered flow and real identity CLI with fixture install/unrelated phases.
  const script = `set -eu
SCENARIO="$UNIT_SCENARIO"
CANDIDATE_KIND=tarball
CANDIDATE_SPEC="$UNIT_ROOT/candidate.tgz"
ARTIFACT_ROOT="$UNIT_ROOT/artifacts"
UPDATE_JSON="$ARTIFACT_ROOT/update.json"
UPDATE_ERR="$ARTIFACT_ROOT/update.err"
baseline_version="$UNIT_BASELINE_VERSION"
UPDATE_RESTART_MODE=manual
native_assignment_enabled=0
plugin_registry_pid=0
export OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT="$ARTIFACT_ROOT"
export OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT="$UNIT_ROOT/runtime"
node() { "$UNIT_NODE" "$@"; }
${section("prepare_worker_cell_package() {\n", "\nassert_worker_cell_update() {")}
package_root() { printf '%s\\n' "$UNIT_ROOT/installed"; }
companion_survivor_scenario() { return 1; }
run_plugin_fixture_phase() { :; }
openclaw_e2e_stop_process() { :; }
run_missing_load_path_fixture() {
  [ "$1" != post-update ] || printf 'following-phase\\n'
}
update_candidate_for_install_mode() {
  printf 'updater\\n'
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
    observe_deferred_schema_doctor)
      [ ! -e "$ARTIFACT_ROOT/installed-package-identity.json" ]
      printf 'deferred-doctor\\n' ;;
    *) : ;;
  esac
}
${section(startMarker, following)}${audited ? "" : following}
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
      UNIT_BASELINE_VERSION: change === "deferred-doctor" ? "2026.9.2" : version,
      OPENCLAW_DOCKER_E2E_SELECTED_SHA: change === "wrong-source" ? "b".repeat(40) : selectedSha,
    },
    10_000,
  );
  const identity = path.join(
    artifacts,
    `${audited ? "candidate" : "installed"}-package-identity.json`,
  );
  if (error) {
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(error);
    expect(existsSync(identity)).toBe(false);
  } else {
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(existsSync(identity)).toBe(true);
    if (!audited) {
      expect(readJson(identity)).toMatchObject({
        version,
        buildInfo: { commit: selectedSha },
      });
    }
  }
  if (events) {
    expect(result.stdout.trim().split("\n").filter(Boolean)).toEqual(events);
  }
});
