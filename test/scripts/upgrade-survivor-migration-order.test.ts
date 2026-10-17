import { execFileSync } from "node:child_process";
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
import { readJson, runProcess, writeJson } from "./upgrade-survivor-shard.test-support.js";

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
  const result = runProcess(
    "bash",
    [runner],
    {
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
    15_000,
  );
  return {
    result,
    events: readFileSync(join(home, "events"), "utf8").trim().split("\n"),
    migrated: existsSync(join(home, "migrated")),
    summary: readJson(summary),
  };
}

describe.skipIf(process.platform === "win32")("survivor first-hop observation", () => {
  it("rejects missing first-hop migration before manual repair", () => {
    const { result, events, migrated, summary } = runFirstHop("base", false);
    expect(result.status, result.stderr).toBe(42);
    expect(events).toEqual(["update", "observe"]);
    expect(migrated).toBe(false);
    expect(summary).toMatchObject({
      status: "failed",
      failure: { phase: "assert-automatic-migration" },
    });
  });

  it("observes first-hop migration before Doctor and consent", () => {
    const { result, events, summary } = runFirstHop("base", true);
    expect(result.status, result.stderr).toBe(0);
    expect(events).toEqual(["update", "observe", "doctor", "observe", "consent"]);
    expect(summary.status).toBe("passed");
  });

  it.each([false, true])(
    "requires published refusal before Workshop repair: %s",
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
type WorkshopFixture = ReturnType<typeof workshopFixture>;

function workshopFixture() {
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
    writeJson(join(directory, "package.json"), { name: "openclaw", version: "2026.9.4" });
    writeJson(join(directory, "dist", "build-info.json"), {
      buildId: directory === packageRoot ? "baseline" : "candidate",
    });
  }
  const baseline: WorkshopIdentity = captureWorkshopBaseline(packageRoot, artifacts);
  const tarball = join(root, "candidate.tgz");
  execFileSync("tar", ["-czf", tarball, "package"], { cwd: root });
  const candidate: WorkshopIdentity = captureWorkshopCandidate(tarball, artifacts, "2026.9.4");
  const filename = join(state, "state", "openclaw.sqlite");
  const initial = new DatabaseSync(filename);
  initial.exec(`${publishedWorkshopSchema}
    CREATE TABLE unrelated_records (value TEXT); INSERT INTO unrelated_records VALUES ('preserved');`);
  initial.close();
  const seeded = seedWorkshopIndex(state, artifacts, "baseline");
  writeJson(join(artifacts, "update.json"), {
    ok: false,
    error: {
      type: "cli_error",
      message: `SQLite integrity_check failed: Page ${seeded.rootpage}: never used`,
    },
  });
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
  {
    malformedAtStart = false,
    updateInProgress = false,
    exitCode = 0,
    legacyAtStart,
    duringProcess,
    doctorWarnings,
  }: {
    malformedAtStart?: boolean;
    updateInProgress?: boolean;
    exitCode?: number;
    legacyAtStart?: WorkshopState;
    duringProcess?: () => WorkshopState;
    doctorWarnings?: string[];
  } = {},
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
  writeJson(join(observations, `workshop-process-${pid}.json`), witness);
  const legacyAtExit = duringProcess?.();
  writeJson(join(observations, `workshop-process-${pid}.json`), {
    ...witness,
    exitCode,
    ...(legacyAtExit ? { legacyAtExit } : {}),
    ...(doctorWarnings ? { doctorResultAtExit: { status: "ok", warnings: doctorWarnings } } : {}),
  });
  writeJson(join(observations, "diagnostics", `process-${pid}-exited.json`), {
    role,
    packageVersion: identity.version,
    pid,
    parentPid: witness.parentPid,
    exitCode,
  });
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
  fixture: Pick<WorkshopFixture, "state" | "filename">,
  seeded: LegacySeed,
) {
  const proposals = join(fixture.state, "skill-workshop", "proposals");
  const exportRoot = join(
    fixture.state,
    "agents/main/agent/workshop-skills/.archive/.retired-proposals",
  );
  for (const id of seeded.after.exports) {
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

it.each(["intact", "baseline-consumed", "retirement-warning"])(
  "separates Workshop refusal, retirement, and repair: %s",
  (outcome) => {
    const { state, artifacts, packageRoot, candidateRoot, baseline, candidate, filename } =
      workshopFixture();
    const first = join(artifacts, "first-update");
    recordProcess(first, 101, "update", baseline, {
      malformedAtStart: true,
      exitCode: 1,
    });
    assertWorkshopUpdateRefusal(state, artifacts, first, packageRoot, 1);
    simulateWorkshopRepair(filename);
    const baselineDoctor = join(artifacts, "baseline-doctor");
    recordProcess(baselineDoctor, 102, "doctor", baseline, { malformedAtStart: true });
    assertWorkshopDoctorRepair(state, artifacts, baselineDoctor, "baseline");
    const seeded: LegacySeed = seedWorkshopLegacyProposals(state, artifacts);
    expect(seeded.after.exports).toEqual([
      "survivor-legacy-json-20260729",
      "survivor-pending-20260729",
      "survivor-quarantined-20260729",
    ]);
    cpSync(candidateRoot, packageRoot, { recursive: true });
    const upgraded = join(artifacts, "recovered-upgrade");
    recordProcess(upgraded, 103, "update", baseline, { legacyAtStart: seeded.before });
    if (outcome === "baseline-consumed") {
      simulateWorkshopRetirement({ state, filename }, seeded);
    }
    recordProcess(upgraded, 104, "doctor", candidate, {
      updateInProgress: true,
      legacyAtStart: captureWorkshopLegacyState(state, seeded),
      duringProcess: () => {
        if (outcome === "baseline-consumed") {
          return captureWorkshopLegacyState(state, seeded);
        }
        simulateWorkshopRetirement({ state, filename }, seeded);
        return captureWorkshopLegacyState(state, seeded);
      },
      doctorWarnings:
        outcome === "retirement-warning"
          ? ["Could not export Skill Workshop proposal survivor-pending-20260729: denied"]
          : [],
    });
    const verifyUpgrade = () =>
      assertWorkshopRecoveredUpgrade(state, artifacts, upgraded, packageRoot);
    if (outcome !== "intact") {
      expect(verifyUpgrade).toThrow(
        outcome === "baseline-consumed" ? /did not receive the original/ : /retirement warning/,
      );
      return;
    }
    verifyUpgrade();
    seedWorkshopIndex(state, artifacts, "candidate");
    const candidateDoctor = join(artifacts, "candidate-doctor");
    recordProcess(candidateDoctor, 105, "doctor", candidate, {
      malformedAtStart: true,
      duringProcess: () => {
        simulateWorkshopRepair(filename);
        dropRetiredTables(filename);
        writeFileSync(
          join(artifacts, "doctor.log"),
          "\u001b[32m│  Retired the Skill Workshop\n│  proposal tables.\n│\u001b[0m\n",
        );
        return captureWorkshopLegacyState(state, seeded);
      },
    });
    assertWorkshopDoctorRepair(state, artifacts, candidateDoctor, "candidate");
    expect(completeWorkshopRecovery(state, artifacts)).toMatchObject({
      firstAttempt: { status: "refused-before-candidate", automaticRepair: false },
      baselineDoctor: { status: "explicit-doctor-repaired" },
      upgrade: { status: "upgraded-after-explicit-repair" },
      candidateDoctor: { status: "explicit-doctor-repaired" },
    });
  },
);
