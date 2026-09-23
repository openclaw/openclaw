import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertWorkshopDoctorRepair,
  assertWorkshopRecoveredUpgrade,
  assertWorkshopUpdateRefusal,
  captureWorkshopBaseline,
  captureWorkshopCandidate,
  completeWorkshopRecovery,
  seedWorkshopIndex,
} from "../../scripts/e2e/lib/upgrade-survivor/workshop-doctor-recovery.mjs";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const testNodeExecPath = resolveTestNodeExecPath();
const runner = resolve("scripts/e2e/lib/upgrade-survivor/run.sh");

function runFirstHop(scenario: string, automatic: boolean) {
  const home = tempDirs.make("survivor-migration-order-");
  const state = join(home, "state");
  mkdirSync(state);
  const prelude = join(home, "bash-env");
  // BASH_ENV replaces expensive phase bodies, leaving the real runner's ordering,
  // errexit, diagnostics and final summary in charge of the outcome.
  writeFileSync(
    prelude,
    `install_fixture_phases() {
  trap - DEBUG
  phase() {
    CURRENT_PHASE="$1"
    shift
    case "$CURRENT_PHASE" in
      install-baseline) normalize_baseline ;;
      prepare-workshop-baseline) printf 'baseline-doctor\\n' >>"$HOME/events" ;;
      capture-workshop-candidate) printf 'candidate-identity\\n' >>"$HOME/events" ;;
      seed-workshop-baseline-index|seed-workshop-candidate-index) printf 'seed\\n' >>"$HOME/events" ;;
      update-candidate|update-workshop-recovered-state)
        printf 'update\\n' >>"$HOME/events"
        if [ "$FIXTURE_AUTOMATIC" = 1 ]; then touch "$HOME/migrated"; fi
        ;;
      repair-workshop-baseline|repair-workshop-candidate) printf 'explicit-doctor\\n' >>"$HOME/events" ;;
      assert-workshop-published-refusal)
        printf 'refusal\\n' >>"$HOME/events"
        if [ "$FIXTURE_AUTOMATIC" = 1 ]; then return 42; fi
        ;;
      assert-workshop-baseline-repair|assert-workshop-candidate-repair|assert-workshop-recovered-upgrade)
        printf 'verify\\n' >>"$HOME/events"
        ;;
      doctor)
        printf 'doctor\\n' >>"$HOME/events"
        touch "$HOME/migrated"
        ;;
      assert-automatic-migration|assert-survival)
        printf 'observe\\n' >>"$HOME/events"
        if [ ! -f "$HOME/migrated" ]; then
          echo 'first-hop migration missing' >&2
          return 42
        fi
        ;;
      fixture-plugin-consent) printf 'consent\\n' >>"$HOME/events" ;;
    esac
  }
}
trap 'case "$BASH_COMMAND" in "phase "*) install_fixture_phases ;; esac' DEBUG
`,
  );
  const summary = join(home, "artifacts", "summary.json");
  const result = spawnSync("bash", [runner], {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      PATH: `${dirname(testNodeExecPath)}:/usr/bin:/bin`,
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_HOME: home,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: join(state, "openclaw.json"),
      OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: join(home, "runtime"),
      OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: summary,
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE:
        scenario === "workshop-doctor-recovery" ? "openclaw@2026.9.4" : "openclaw@2026.7.1-2",
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: scenario,
      BASH_ENV: prelude,
      FIXTURE_AUTOMATIC: automatic ? "1" : "0",
    },
  });
  return {
    result,
    events: readFileSync(join(home, "events"), "utf8").trim().split("\n"),
    migrated: existsSync(join(home, "migrated")),
    summary: JSON.parse(readFileSync(summary, "utf8")),
  };
}

describe.skipIf(process.platform === "win32")("survivor first-hop observation", () => {
  it.each(["base", "configured-plugin-installs", "sqlite-volume"])(
    "rejects missing automatic migration before manual Doctor can repair %s",
    (scenario) => {
      const { result, events, migrated, summary } = runFirstHop(scenario, false);
      expect(result.status, result.stderr).toBe(42);
      expect(events).toEqual(["update", "observe"]);
      expect(migrated).toBe(false);
      expect(summary).toMatchObject({
        status: "failed",
        failure: { phase: "assert-automatic-migration" },
      });
    },
  );

  it("observes automatic migration before allowing manual Doctor and explicit consent", () => {
    const { result, events, summary } = runFirstHop("base", true);
    expect(result.status, result.stderr).toBe(0);
    expect(events).toEqual(["update", "observe", "doctor", "observe", "consent"]);
    expect(summary.status).toBe("passed");
  });

  it.each([false, true])(
    "keeps published refusal before explicit Workshop recovery (unexpected success=%s)",
    (unexpectedSuccess) => {
      const { result, events, summary } = runFirstHop(
        "workshop-doctor-recovery",
        unexpectedSuccess,
      );
      expect(result.status, result.stderr).toBe(unexpectedSuccess ? 42 : 0);
      expect(events).toEqual([
        "baseline-doctor",
        "candidate-identity",
        "seed",
        "refusal",
        ...(unexpectedSuccess
          ? []
          : ["explicit-doctor", "verify", "update", "verify", "seed", "explicit-doctor", "verify"]),
      ]);
      expect(summary.status).toBe(unexpectedSuccess ? "failed" : "passed");
      expect(summary.updateRecovery).toBeNull();
      expect(summary.firstHopPostCore.availability).toBe("unavailable");
      if (unexpectedSuccess) {
        expect(summary.failure.phase).toBe("assert-workshop-published-refusal");
      }
    },
  );
});

const workshopIndex = "idx_skill_workshop_collection_reviews_workspace_time";

function workshopFixture() {
  const root = tempDirs.make("survivor-workshop-evidence-");
  const state = join(root, "state");
  const artifacts = join(root, "artifacts");
  const packageRoot = join(root, "installed");
  const candidateRoot = join(root, "package");
  for (const directory of [
    join(state, "state"),
    artifacts,
    join(packageRoot, "dist"),
    join(candidateRoot, "dist"),
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  for (const directory of [packageRoot, candidateRoot]) {
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.9.4" }),
    );
    writeFileSync(
      join(directory, "dist", "build-info.json"),
      JSON.stringify({ buildId: directory === packageRoot ? "baseline" : "candidate" }),
    );
  }
  const baseline = captureWorkshopBaseline(packageRoot, artifacts);
  const tarball = join(root, "candidate.tgz");
  execFileSync("tar", ["-czf", tarball, "package"], { cwd: root });
  const candidate = captureWorkshopCandidate(tarball, artifacts, "2026.9.4");
  const filename = join(state, "state", "openclaw.sqlite");
  const initial = new DatabaseSync(filename);
  initial.exec(`CREATE TABLE skill_workshop_collection_reviews (
    review_id TEXT PRIMARY KEY, owner_agent_id TEXT, backup_id TEXT, create_time INTEGER,
    kept_names_json TEXT, written_names_json TEXT, dropped_json TEXT
  ); CREATE TABLE unrelated_records (value TEXT); INSERT INTO unrelated_records VALUES ('preserved');`);
  initial.close();
  const seeded = seedWorkshopIndex(state, artifacts, "baseline");
  writeFileSync(
    join(artifacts, "update.json"),
    JSON.stringify({
      ok: false,
      error: {
        type: "cli_error",
        message: `SQLite integrity_check failed: Page ${seeded.rootpage}: never used`,
      },
    }),
  );
  return { state, artifacts, packageRoot, candidateRoot, baseline, candidate, filename };
}

type WorkshopIdentity = { version: string; buildInfoSha256: string };
function recordProcess(
  observations: string,
  pid: number,
  role: "update" | "doctor",
  identity: WorkshopIdentity,
  malformedAtStart: boolean,
  updateInProgress: boolean,
  exitCode: number,
  nativeReceipt = true,
) {
  mkdirSync(join(observations, "diagnostics"), { recursive: true });
  const witness = {
    role,
    identity,
    malformedAtStart,
    updateInProgress,
    exitCode,
    pid,
    parentPid: 100,
  };
  writeFileSync(join(observations, `workshop-process-${pid}.json`), JSON.stringify(witness));
  if (nativeReceipt) {
    writeFileSync(
      join(observations, "diagnostics", `process-${pid}-exited.json`),
      JSON.stringify({
        role,
        packageVersion: identity.version,
        pid,
        parentPid: witness.parentPid,
        exitCode,
      }),
    );
  }
}

// Simulate command outcomes to test evidence rejection; real repair belongs to the Docker proof.
function simulateWorkshopRepair(filename: string) {
  const database = new DatabaseSync(filename);
  database.enableDefensive?.(false);
  database.exec("PRAGMA writable_schema = ON;");
  database
    .prepare("UPDATE sqlite_schema SET sql = ? WHERE name = ?")
    .run(
      `CREATE INDEX ${workshopIndex} ON skill_workshop_collection_reviews(review_id, create_time DESC)`,
      workshopIndex,
    );
  const version = database.prepare("PRAGMA schema_version").get()?.schema_version;
  database.exec(
    `PRAGMA writable_schema = OFF; PRAGMA schema_version = ${Number(version) + 1}; DROP INDEX ${workshopIndex};`,
  );
  database.close();
}

describe("Workshop Doctor recovery evidence", () => {
  it.each(["refused", "unexpected-success", "unrelated-data-changed", "installed-build-changed"])(
    "validates the published updater's %s outcome without accepting repair",
    (outcome) => {
      const fixture = workshopFixture();
      const observations = join(fixture.artifacts, "first-update");
      recordProcess(
        observations,
        101,
        "update",
        fixture.baseline,
        true,
        false,
        outcome === "unexpected-success" ? 0 : 1,
      );
      if (outcome === "unrelated-data-changed") {
        const database = new DatabaseSync(fixture.filename);
        database.enableDefensive?.(false);
        database.exec(
          "PRAGMA writable_schema = ON; UPDATE unrelated_records SET value = 'changed';",
        );
        database.close();
      }
      if (outcome === "installed-build-changed") {
        cpSync(fixture.candidateRoot, fixture.packageRoot, { recursive: true });
      }
      const verify = () =>
        assertWorkshopUpdateRefusal(
          fixture.state,
          fixture.artifacts,
          observations,
          fixture.packageRoot,
          outcome === "unexpected-success" ? 0 : 1,
        );
      if (outcome === "refused") {
        expect(verify()).toMatchObject({
          status: "refused-before-candidate",
          automaticRepair: false,
        });
      } else {
        expect(verify).toThrow(
          outcome === "unexpected-success"
            ? /must refuse/
            : outcome === "unrelated-data-changed"
              ? /changed state/
              : /changed installed build/,
        );
      }
    },
  );

  it.each([
    "intact",
    "review-changed",
    "already-repaired",
    "missing-receipt",
    "same-version-wrong-build",
    "update-marker",
  ])("requires explicit candidate Doctor evidence: %s", (outcome) => {
    const fixture = workshopFixture();
    simulateWorkshopRepair(fixture.filename);
    if (outcome === "review-changed") {
      const database = new DatabaseSync(fixture.filename);
      database.exec("UPDATE skill_workshop_collection_reviews SET backup_id = 'wrong-backup';");
      database.close();
    }
    const observations = join(fixture.artifacts, "candidate-doctor");
    recordProcess(
      observations,
      102,
      "doctor",
      outcome === "same-version-wrong-build" ? fixture.baseline : fixture.candidate,
      outcome !== "already-repaired",
      outcome === "update-marker",
      0,
      outcome !== "missing-receipt",
    );
    const verify = () =>
      assertWorkshopDoctorRepair(fixture.state, fixture.artifacts, observations, "candidate");
    if (outcome === "intact") {
      expect(verify()).toMatchObject({ status: "explicit-doctor-repaired" });
    } else {
      expect(verify).toThrow(
        outcome === "review-changed" ? /retained Workshop review/ : /Missing matching doctor/,
      );
    }
  });

  it("keeps the refused first attempt distinct from both repairs and the recovered upgrade", () => {
    const fixture = workshopFixture();
    const first = join(fixture.artifacts, "first-update");
    recordProcess(first, 101, "update", fixture.baseline, true, false, 1);
    assertWorkshopUpdateRefusal(fixture.state, fixture.artifacts, first, fixture.packageRoot, 1);
    simulateWorkshopRepair(fixture.filename);
    const baselineDoctor = join(fixture.artifacts, "baseline-doctor");
    recordProcess(baselineDoctor, 102, "doctor", fixture.baseline, true, false, 0);
    assertWorkshopDoctorRepair(fixture.state, fixture.artifacts, baselineDoctor, "baseline");
    cpSync(fixture.candidateRoot, fixture.packageRoot, { recursive: true });
    const upgraded = join(fixture.artifacts, "recovered-upgrade");
    recordProcess(upgraded, 103, "update", fixture.baseline, false, false, 0);
    recordProcess(upgraded, 104, "doctor", fixture.candidate, false, true, 0);
    assertWorkshopRecoveredUpgrade(fixture.state, fixture.artifacts, upgraded, fixture.packageRoot);
    seedWorkshopIndex(fixture.state, fixture.artifacts, "candidate");
    const candidateDoctor = join(fixture.artifacts, "candidate-doctor");
    simulateWorkshopRepair(fixture.filename);
    recordProcess(candidateDoctor, 105, "doctor", fixture.candidate, true, false, 0);
    assertWorkshopDoctorRepair(fixture.state, fixture.artifacts, candidateDoctor, "candidate");
    expect(completeWorkshopRecovery(fixture.state, fixture.artifacts)).toMatchObject({
      firstAttempt: { status: "refused-before-candidate", automaticRepair: false },
      baselineDoctor: { status: "explicit-doctor-repaired" },
      upgrade: { status: "upgraded-after-explicit-repair" },
      candidateDoctor: { status: "explicit-doctor-repaired" },
    });
  });
});
