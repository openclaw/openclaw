import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const selectedSha = "a".repeat(40);
const version = "2026.9.6";
type Change = "valid" | "stale" | "tarball-changed" | "wrong-source";

function runCandidateFlow(scenario: "base" | "sqlite-volume", change: Change) {
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
  writeFileSync(
    path.join(candidate, "package.json"),
    JSON.stringify({ name: "openclaw", version }),
  );
  writeFileSync(path.join(candidate, "openclaw.mjs"), "export {};\n");
  writeFileSync(
    path.join(candidate, "dist/build-info.json"),
    JSON.stringify({ version, commit: selectedSha }),
  );
  writeFileSync(path.join(candidate, "dist/entry.mjs"), "export const payload = 'candidate';\n");
  cpSync(candidate, installed, { recursive: true });
  writeFileSync(path.join(installed, "dist/entry.mjs"), "export const payload = 'stale';\n");
  writeFileSync(events, "");
  execFileSync("tar", ["-czf", tarball, "-C", path.dirname(candidate), "package"]);

  const source = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
  const start = source.indexOf("phase resolve-candidate resolve_candidate_version\n");
  const following = "run_missing_load_path_fixture post-update\n";
  const end = source.indexOf(following, start);
  if (start < 0 || end < start) {
    throw new Error("Survivor candidate flow boundaries are unavailable");
  }
  const flow = source.slice(start, end + following.length);
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
UPDATE_RESTART_MODE=manual
export OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT="$ARTIFACT_ROOT"
export OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT="$RUNTIME_ROOT"
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
}
phase() {
  shift
  case "$1" in
    node)
      if [ "$2" = scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs ]; then
        shift
        "$UNIT_NODE" "$@"
      fi ;;
    update_candidate_for_install_mode) "$@" ;;
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
        const stale = runCandidateFlow(scenario, "stale");
        expect(stale.result.status).not.toBe(0);
        expect(stale.result.stderr).toContain(
          "Installed application payload differs from the frozen tarball",
        );
        expect(stale.events).toEqual(["updater"]);
        expect(existsSync(path.join(stale.artifacts, "installed-package-identity.json"))).toBe(
          false,
        );

        const valid = runCandidateFlow(scenario, "valid");
        expect(valid.result.status, valid.result.stdout + valid.result.stderr).toBe(0);
        expect(valid.events).toEqual(["updater", "following-phase"]);
        const installed = JSON.parse(
          readFileSync(path.join(valid.artifacts, "installed-package-identity.json"), "utf8"),
        );
        expect(installed.version).toBe(version);
        expect(installed.buildInfo.commit).toBe(selectedSha);
      },
    );

    it.each([
      {
        change: "wrong-source",
        error: "Candidate build commit must equal the selected source SHA",
        events: [],
      },
      { change: "tarball-changed", error: "Candidate tarball changed", events: ["updater"] },
    ] as const)("refuses $change at the actual candidate boundary", ({ change, error, events }) => {
      const observed = runCandidateFlow("base", change);
      expect(observed.result.status).not.toBe(0);
      expect(observed.result.stderr).toContain(error);
      expect(observed.events).toEqual(events);
      expect(existsSync(path.join(observed.artifacts, "installed-package-identity.json"))).toBe(
        false,
      );
    });
  },
);
