import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import {
  captureWorkshopLegacyState,
  seedWorkshopLegacyProposals,
} from "../../scripts/e2e/lib/upgrade-survivor/workshop-legacy-proposals.mjs";
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
      capture-workshop-published-package) printf 'published-package\\n' >>"$HOME/events" ;;
      capture-workshop-candidate-package) printf 'candidate-package\\n' >>"$HOME/events" ;;
      assert-workshop-installed-package) printf 'installed-package\\n' >>"$HOME/events" ;;
      seed-workshop-baseline-index|seed-workshop-candidate-index) printf 'seed\\n' >>"$HOME/events" ;;
      seed-workshop-legacy-proposals) printf 'legacy-seed\\n' >>"$HOME/events" ;;
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
  it.each(["base"])(
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
        "published-package",
        "candidate-identity",
        "candidate-package",
        "seed",
        "refusal",
        ...(unexpectedSuccess
          ? []
          : [
              "explicit-doctor",
              "verify",
              "legacy-seed",
              "update",
              "installed-package",
              "verify",
              "seed",
              "explicit-doctor",
              "verify",
            ]),
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

// Published 2026.9.4 proposal storage that the candidate Doctor retires.
const publishedWorkshopSchema = `
  CREATE TABLE skill_workshop_collection_reviews (
    review_id TEXT PRIMARY KEY, owner_agent_id TEXT, backup_id TEXT, create_time INTEGER,
    kept_names_json TEXT, written_names_json TEXT, dropped_json TEXT
  );
  CREATE TABLE skill_workshop_proposals (
    proposal_id TEXT PRIMARY KEY, record_json TEXT, owner_agent_id TEXT, kind TEXT, status TEXT,
    created_at TEXT, updated_at TEXT, draft_hash TEXT, origin_agent_id TEXT, origin_session_key TEXT,
    origin_run_id TEXT, origin_message_id TEXT, applied_at TEXT, rejected_at TEXT,
    quarantined_at TEXT, stale_at TEXT, status_reason TEXT
  );
  CREATE TABLE skill_workshop_proposal_rollbacks (
    proposal_id TEXT PRIMARY KEY, written_at TEXT, target_skill_file TEXT, action TEXT,
    previous_content_hash TEXT, previous_content TEXT, support_files_json TEXT
  );
  CREATE TABLE skill_workshop_proposal_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, proposal_id TEXT,
    proposed_version TEXT, revision_hash TEXT, event_type TEXT, occurred_at TEXT,
    actor_json TEXT, correlation_id TEXT, payload_json TEXT
  );
`;
const retiredTables = [
  "skill_workshop_proposal_events",
  "skill_workshop_proposal_rollbacks",
  "skill_workshop_collection_reviews",
  "skill_workshop_proposals",
];

type WorkshopIdentity = { version: string; buildInfoSha256: string };
type WorkshopFixture = {
  state: string;
  artifacts: string;
  packageRoot: string;
  candidateRoot: string;
  baseline: WorkshopIdentity;
  candidate: WorkshopIdentity;
  filename: string;
};

function workshopFixture(): WorkshopFixture {
  const root = tempDirs.make("ws-");
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
  initial.exec(`${publishedWorkshopSchema}
    CREATE TABLE unrelated_records (value TEXT); INSERT INTO unrelated_records VALUES ('preserved');`);
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

type WorkshopState = {
  files: Record<string, string | null>;
  exports: string[] | null;
  proposalsDir: boolean;
  tables: Record<string, number>;
};
type LegacySeed = {
  paths: string[];
  before: WorkshopState;
  after: WorkshopState & { exports: string[] };
};
function recordProcess(
  observations: string,
  pid: number,
  role: "update" | "doctor",
  identity: WorkshopIdentity,
  malformedAtStart: boolean,
  updateInProgress: boolean,
  exitCode: number,
  nativeReceipt = true,
  legacyAtStart?: WorkshopState,
  duringProcess?: () => WorkshopState,
  doctorWarnings?: string[],
) {
  mkdirSync(join(observations, "diagnostics"), { recursive: true });
  const witness = {
    role,
    identity,
    malformedAtStart,
    updateInProgress,
    pid,
    parentPid: 100,
    ...(legacyAtStart ? { legacyAtStart } : {}),
  };
  writeFileSync(join(observations, `workshop-process-${pid}.json`), JSON.stringify(witness));
  const legacyAtExit = duringProcess?.();
  writeFileSync(
    join(observations, `workshop-process-${pid}.json`),
    JSON.stringify({
      ...witness,
      exitCode,
      ...(legacyAtExit ? { legacyAtExit } : {}),
      ...(doctorWarnings ? { doctorResultAtExit: { status: "ok", warnings: doctorWarnings } } : {}),
    }),
  );
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

function dropRetiredTables(filename: string) {
  const database = new DatabaseSync(filename);
  database.exec(retiredTables.map((table) => `DROP TABLE IF EXISTS ${table};`).join(" "));
  database.close();
}

/** Simulates the candidate Doctor: export pending/quarantined drafts, drop tables, remove files. */
function simulateWorkshopRetirement(
  fixture: WorkshopFixture,
  seeded: LegacySeed,
  exportedIds: readonly string[] = seeded.after.exports,
) {
  const proposals = join(fixture.state, "skill-workshop", "proposals");
  const exportRoot = join(
    fixture.state,
    "agents/main/agent/workshop-skills/.archive/.retired-proposals",
  );
  for (const id of exportedIds) {
    const draft = readdirSync(join(proposals, id), { recursive: true, encoding: "utf8" }).find(
      (entry) => entry.endsWith("PROPOSAL.md"),
    )!;
    const bundle = dirname(join(proposals, id, draft));
    mkdirSync(join(exportRoot, id), { recursive: true });
    cpSync(join(bundle, "PROPOSAL.md"), join(exportRoot, id, "SKILL.md"));
    if (existsSync(join(bundle, "references"))) {
      cpSync(join(bundle, "references"), join(exportRoot, id, "references"), { recursive: true });
    }
  }
  rmSync(proposals, { recursive: true });
  rmSync(join(fixture.state, "skill-workshop", "proposals.json"));
  dropRetiredTables(fixture.filename);
}

describe("Workshop Doctor recovery evidence", () => {
  it.each(["intact", "baseline-consumed", "retirement-warning"])(
    "keeps published refusal, candidate retirement, and repair distinct: %s",
    (outcome) => {
      const fixture = workshopFixture();
      const first = join(fixture.artifacts, "first-update");
      recordProcess(first, 101, "update", fixture.baseline, true, false, 1);
      assertWorkshopUpdateRefusal(fixture.state, fixture.artifacts, first, fixture.packageRoot, 1);
      simulateWorkshopRepair(fixture.filename);
      const baselineDoctor = join(fixture.artifacts, "baseline-doctor");
      recordProcess(baselineDoctor, 102, "doctor", fixture.baseline, true, false, 0);
      assertWorkshopDoctorRepair(fixture.state, fixture.artifacts, baselineDoctor, "baseline");
      const seeded: LegacySeed = seedWorkshopLegacyProposals(fixture.state, fixture.artifacts);
      expect(seeded.after.exports).toEqual([
        "survivor-legacy-json-20260729",
        "survivor-pending-20260729",
        "survivor-quarantined-20260729",
      ]);
      cpSync(fixture.candidateRoot, fixture.packageRoot, { recursive: true });
      const upgraded = join(fixture.artifacts, "recovered-upgrade");
      recordProcess(
        upgraded,
        103,
        "update",
        fixture.baseline,
        false,
        false,
        0,
        true,
        seeded.before,
      );
      if (outcome === "baseline-consumed") {
        simulateWorkshopRetirement(fixture, seeded);
      }
      recordProcess(
        upgraded,
        104,
        "doctor",
        fixture.candidate,
        false,
        true,
        0,
        true,
        captureWorkshopLegacyState(fixture.state, seeded),
        () => {
          if (outcome === "baseline-consumed") {
            return captureWorkshopLegacyState(fixture.state, seeded);
          }
          const exported =
            outcome === "missing-export"
              ? seeded.after.exports.slice(1)
              : outcome === "exported-applied"
                ? [...seeded.after.exports, "survivor-applied-20260729"]
                : seeded.after.exports;
          simulateWorkshopRetirement(fixture, seeded, exported);
          if (outcome === "tables-kept") {
            const database = new DatabaseSync(fixture.filename);
            database.exec("CREATE TABLE skill_workshop_proposals (proposal_id TEXT)");
            database.close();
          }
          if (outcome === "files-kept") {
            mkdirSync(join(fixture.state, "skill-workshop", "proposals"));
          }
          if (outcome === "live-skill-changed") {
            writeFileSync(
              join(fixture.state, "agents/main/agent/workshop-skills/survivor-applied/SKILL.md"),
              "changed",
            );
          }
          return captureWorkshopLegacyState(fixture.state, seeded);
        },
        outcome === "retirement-warning"
          ? ["Could not export Skill Workshop proposal survivor-pending-20260729: denied"]
          : [],
      );
      const verifyUpgrade = () =>
        assertWorkshopRecoveredUpgrade(
          fixture.state,
          fixture.artifacts,
          upgraded,
          fixture.packageRoot,
        );
      if (!outcome.startsWith("candidate-") && outcome !== "intact") {
        expect(verifyUpgrade).toThrow(
          {
            "baseline-consumed": /did not receive the original/,
            "missing-export": /export exactly the pending and quarantined/,
            "exported-applied": /export exactly the pending and quarantined/,
            "live-skill-changed": /live Workshop skill bytes/,
            "tables-kept": /retired Workshop tables/,
            "files-kept": /retired proposal files/,
            "retirement-warning": /retirement warning/,
          }[outcome],
        );
        return;
      }
      verifyUpgrade();
      seedWorkshopIndex(fixture.state, fixture.artifacts, "candidate");
      const candidateDoctor = join(fixture.artifacts, "candidate-doctor");
      recordProcess(
        candidateDoctor,
        105,
        "doctor",
        fixture.candidate,
        true,
        false,
        0,
        true,
        undefined,
        () => {
          simulateWorkshopRepair(fixture.filename);
          if (outcome !== "candidate-table-kept") {
            dropRetiredTables(fixture.filename);
          }
          writeFileSync(
            join(fixture.artifacts, "doctor.log"),
            outcome === "candidate-not-retired"
              ? "Doctor complete.\n"
              : `\u001b[32m│  Retired the Skill Workshop\n│  proposal tables.\n│\u001b[0m\n${
                  outcome === "candidate-reexported" ? "Exported 1 pending draft.\n" : ""
                }`,
          );
          return captureWorkshopLegacyState(fixture.state, seeded);
        },
      );
      const verifyCandidate = () =>
        assertWorkshopDoctorRepair(fixture.state, fixture.artifacts, candidateDoctor, "candidate");
      if (outcome !== "intact") {
        expect(verifyCandidate).toThrow(
          outcome === "candidate-table-kept"
            ? /retired Workshop tables/
            : outcome === "candidate-reexported"
              ? /re-exported/
              : /did not retire the restored/,
        );
        return;
      }
      verifyCandidate();
      expect(completeWorkshopRecovery(fixture.state, fixture.artifacts)).toMatchObject({
        firstAttempt: { status: "refused-before-candidate", automaticRepair: false },
        baselineDoctor: { status: "explicit-doctor-repaired" },
        upgrade: { status: "upgraded-after-explicit-repair" },
        candidateDoctor: { status: "explicit-doctor-repaired" },
      });
    },
  );
});
