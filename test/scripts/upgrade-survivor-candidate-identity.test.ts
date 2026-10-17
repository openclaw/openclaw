import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const selectedSha = "a".repeat(40);
const version = "2026.9.6";
function identityExists(artifacts: string, kind: "candidate" | "installed") {
  return existsSync(path.join(artifacts, `${kind}-package-identity.json`));
}

function expectRefused(
  scenario: Scenario,
  change: Change,
  error: string,
  events: readonly string[],
  kind: "candidate" | "installed" = "installed",
) {
  const observed = runCandidateFlow(scenario, change);
  expect(observed.result.status).not.toBe(0);
  expect(observed.result.stderr).toContain(error);
  expect(observed.events).toEqual(events);
  expect(identityExists(observed.artifacts, kind)).toBe(false);
}
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
  const runtime = path.join(root, "runtime");
  const events = path.join(root, "events");
  const tarball = path.join(root, "candidate.tgz");
  mkdirSync(path.join(candidate, "dist"), { recursive: true });
  mkdirSync(artifacts);
  mkdirSync(runtime);
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
  // Execute the registered scenario flow and real identity CLI; only installation
  // and unrelated fixture phases are replaced by this small package fixture.
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      `set -eu
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
  if [ "$1" = post-update ]; then
    printf 'following-phase\\n' >> "$UNIT_ROOT/events"
  fi
}
update_candidate_for_install_mode() {
  printf 'updater\\n' >> "$UNIT_ROOT/events"
  if [ "$UNIT_CHANGE" != stale ]; then
    cp -R "$UNIT_ROOT/candidate/package/." "$UNIT_ROOT/installed/"
  fi
  if [ "$UNIT_CHANGE" = tarball-changed ]; then
    printf '\\n' >> "$CANDIDATE_SPEC"
  fi
  if [ "$UNIT_CHANGE" = tarball-missing ]; then
    rm "$CANDIDATE_SPEC"
  fi
  if [ "$UNIT_CHANGE" = entrypoint-missing ]; then
    rm "$UNIT_ROOT/installed/openclaw.mjs"
  fi
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
`,
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        UNIT_ROOT: root,
        UNIT_NODE: resolveTestNodeExecPath(),
        UNIT_SCENARIO: scenario,
        UNIT_CHANGE: change,
        OPENCLAW_DOCKER_E2E_SELECTED_SHA: change === "wrong-source" ? "b".repeat(40) : selectedSha,
      },
    },
  );
  return {
    result,
    artifacts,
    events: readFileSync(events, "utf8").trim().split("\n").filter(Boolean),
  };
}

describe.skipIf(process.platform === "win32")(
  "published survivor candidate identity admission",
  () => {
    it.each(["base", "sqlite-volume"] as const)(
      "%s accepts the exact tarball payload and rejects stale same-version installed bytes",
      (scenario) => {
        expectRefused(
          scenario,
          "stale",
          "Installed application payload differs from the frozen tarball",
          ["updater"],
        );

        const valid = runCandidateFlow(scenario, "valid");
        expect(valid.result.status, valid.result.stdout + valid.result.stderr).toBe(0);
        expect(valid.events).toEqual(["updater", "following-phase"]);
        const installed = JSON.parse(
          readFileSync(path.join(valid.artifacts, "installed-package-identity.json"), "utf8"),
        );
        expect(installed).toMatchObject({ version, buildInfo: { commit: selectedSha } });
      },
    );

    it.each([
      {
        change: "wrong-source",
        error: "Candidate build commit must equal the selected source SHA",
        events: [],
      },
      { change: "tarball-changed", error: "Candidate tarball changed", events: ["updater"] },
      { change: "tarball-missing", error: "Candidate tarball changed", events: ["updater"] },
      {
        change: "entrypoint-missing",
        error: "Installed application payload differs from the frozen tarball",
        events: ["updater"],
      },
    ] as const)("refuses $change at the actual candidate boundary", ({ change, error, events }) => {
      expectRefused("base", change, error, events);
    });

    it.each(["projects-doctor", "workshop-doctor-recovery"] as const)(
      "%s requires its audited baseline and refuses published candidate bytes",
      (scenario) => {
        const valid = runCandidateFlow(scenario, "valid");
        expect(valid.result.status, valid.result.stdout + valid.result.stderr).toBe(0);
        expect(identityExists(valid.artifacts, "candidate")).toBe(true);

        for (const [change, error] of [
          ["published", "Candidate still contains published bytes"],
          ["missing-baseline", "ENOENT"],
        ] as const) {
          expectRefused(scenario, change, error, [], "candidate");
        }
      },
    );
  },
);
