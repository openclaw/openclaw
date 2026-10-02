import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const selectedSha = "a".repeat(40);
const baselineSha = "c".repeat(40);
const version = "2026.9.7";
type Change =
  | "valid"
  | "stale"
  | "tarball-changed"
  | "tarball-missing"
  | "entrypoint-missing"
  | "wrong-source"
  | "baseline-corrupt"
  | "missing-baseline"
  | "same-source"
  | "historical-baseline";
type Scenario = "base" | "sqlite-volume" | "projects-doctor" | "workshop-doctor-recovery";

function runCandidateFlow(scenario: Scenario, change: Change) {
  const audited = scenario === "projects-doctor" || scenario === "workshop-doctor-recovery";
  const baselineVersion = audited
    ? "2026.9.4"
    : change === "historical-baseline"
      ? "2026.6.1"
      : version;
  const root = tempDirs.make("upgrade-survivor-candidate-identity-");
  const candidate = path.join(root, "candidate", "package");
  const baseline = path.join(root, "baseline", "package");
  const installed = path.join(root, "installed");
  const artifacts = path.join(root, "artifacts");
  const runtime = path.join(root, "runtime");
  const events = path.join(root, "events");
  const tarball = path.join(root, "candidate.tgz");
  const baselineTarball = path.join(root, "baseline.tgz");
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
  cpSync(candidate, baseline, { recursive: true });
  writeFileSync(
    path.join(baseline, "package.json"),
    JSON.stringify({ name: "openclaw", version: baselineVersion }),
  );
  writeFileSync(
    path.join(baseline, "dist/build-info.json"),
    JSON.stringify({
      version: baselineVersion,
      commit:
        change === "historical-baseline"
          ? null
          : change === "same-source"
            ? selectedSha
            : baselineSha,
    }),
  );
  writeFileSync(path.join(baseline, "dist/entry.mjs"), "export const payload = 'baseline';\n");
  cpSync(baseline, installed, { recursive: true });
  writeFileSync(events, "");
  execFileSync("tar", ["-czf", tarball, "-C", path.dirname(candidate), "package"]);
  execFileSync("tar", ["-czf", baselineTarball, "-C", path.dirname(baseline), "package"]);
  const integrity = `sha512-${createHash("sha512").update(readFileSync(baselineTarball)).digest("base64")}`;
  if (change === "baseline-corrupt") {
    writeFileSync(
      baselineTarball,
      Buffer.concat([readFileSync(baselineTarball), Buffer.from("changed")]),
    );
  }
  // Only the registry transport is synthetic; the producer must verify and record
  // the actual installed package against these independent published bytes.
  writeFileSync(
    path.join(root, "registry.mjs"),
    `
import fs from 'node:fs';
globalThis.fetch = async (url) => {
  const tarball = 'https://registry.npmjs.org/openclaw/-/openclaw-${baselineVersion}.tgz';
  if (url === 'https://registry.npmjs.org/openclaw/${baselineVersion}') {
    return Response.json({name:'openclaw',version:${JSON.stringify(baselineVersion)},dist:{tarball,integrity:${JSON.stringify(integrity)}}});
  }
  if (url === tarball) return new Response(fs.readFileSync(${JSON.stringify(baselineTarball)}));
  throw new Error('Unexpected registry request: ' + url);
};
`,
  );

  const source = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
  const baselineStart = source.indexOf("phase install-baseline install_baseline\n");
  const baselineEnd = source.indexOf("phase initialize-state initialize_state\n", baselineStart);
  const start = audited
    ? source.indexOf(
        scenario === "projects-doctor"
          ? "  phase worker-candidate-identity prepare_worker_cell_package\n"
          : "  phase capture-workshop-candidate-package ",
      )
    : baselineStart;
  const following =
    scenario === "projects-doctor"
      ? "  phase update-worker-candidate "
      : scenario === "workshop-doctor-recovery"
        ? "  phase seed-physical-baseline-index "
        : "run_missing_load_path_fixture post-update\n";
  const end = source.indexOf(following, start);
  const helperStart = source.indexOf("prepare_worker_cell_package() {\n");
  const helperEnd = source.indexOf("\nassert_worker_cell_update() {", helperStart);
  if (
    baselineStart < 0 ||
    baselineEnd < baselineStart ||
    start < 0 ||
    end < start ||
    helperStart < 0 ||
    helperEnd < helperStart
  ) {
    throw new Error("Survivor candidate flow boundaries are unavailable");
  }
  const flow = audited
    ? source.slice(baselineStart, baselineEnd) + source.slice(start, end)
    : source.slice(start, end + following.length);
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
candidate_version=${version}
candidate_install_mode=updater
baseline_version=${baselineVersion}
baseline_spec=openclaw@${baselineVersion}
WORKER_CELL=${scenario === "projects-doctor" ? "1" : "0"}
native_assignment_enabled=0
UPDATE_RESTART_MODE=manual
export OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT="$ARTIFACT_ROOT"
export OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT="$RUNTIME_ROOT"
node() { "$UNIT_NODE" --import "$UNIT_ROOT/registry.mjs" "$@"; }
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
        "$UNIT_NODE" --import "$UNIT_ROOT/registry.mjs" "$@"
        if [ "$1" = scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs ] && [ "$2" = baseline ] && [ "$UNIT_CHANGE" = historical-baseline ]; then
          "$UNIT_NODE" --import "$UNIT_ROOT/registry.mjs" "$@"
        fi
        if [ "$2" = baseline ] && [ "$UNIT_CHANGE" = missing-baseline ]; then
          rm "$ARTIFACT_ROOT/baseline-package-identity.json"
        fi
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

    it("recaptures an admitted historical baseline without requiring modern commit metadata", () => {
      const observed = runCandidateFlow("base", "historical-baseline");
      expect(observed.result.status, observed.result.stdout + observed.result.stderr).toBe(0);
      const baseline = JSON.parse(
        readFileSync(path.join(observed.artifacts, "baseline-package-identity.json"), "utf8"),
      );
      expect(baseline).toMatchObject({ version: "2026.6.1", buildInfo: { commit: null } });
      expect(observed.events).toEqual(["updater", "following-phase"]);
    });

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
      { change: "baseline-corrupt", error: "Published baseline integrity mismatch", events: [] },
      { change: "same-source", error: "Candidate still contains published bytes", events: [] },
    ] as const)("refuses $change at the actual candidate boundary", ({ change, error, events }) => {
      const observed = runCandidateFlow("base", change);
      expect(observed.result.status).not.toBe(0);
      expect(observed.result.stderr).toContain(error);
      expect(observed.events).toEqual(events);
      expect(existsSync(path.join(observed.artifacts, "installed-package-identity.json"))).toBe(
        false,
      );
    });

    it.each(["projects-doctor", "workshop-doctor-recovery"] as const)(
      "%s requires the produced baseline and refuses published candidate bytes",
      (scenario) => {
        const valid = runCandidateFlow(scenario, "valid");
        expect(valid.result.status, valid.result.stdout + valid.result.stderr).toBe(0);
        expect(existsSync(path.join(valid.artifacts, "candidate-package-identity.json"))).toBe(
          true,
        );

        for (const [change, error] of [
          ["same-source", "Candidate still contains published bytes"],
          ["missing-baseline", "ENOENT"],
        ] as const) {
          const refused = runCandidateFlow(scenario, change);
          expect(refused.result.status).not.toBe(0);
          expect(refused.result.stderr).toContain(error);
          expect(refused.events).toEqual([]);
          expect(existsSync(path.join(refused.artifacts, "candidate-package-identity.json"))).toBe(
            false,
          );
        }
      },
    );
  },
);
