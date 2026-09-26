import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
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
  assertWorkshopLegacyImported,
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

function workshopFixture() {
  // Keep the complete actionable warning inside Doctor's existing 500-character IPC bound.
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
  legacyAtStart?: ReturnType<typeof captureWorkshopLegacyState>,
  duringProcess?: () => ReturnType<typeof captureWorkshopLegacyState>,
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

function simulateWorkshopLegacyImport(
  fixture: ReturnType<typeof workshopFixture>,
  seeded: ReturnType<typeof seedWorkshopLegacyProposals>,
) {
  const recovered = seeded.bundles.find((bundle) => bundle.recover)!;
  const appliedAt = "2026-09-22T00:00:00.000Z";
  const record = {
    ...recovered.record,
    status: "applied",
    updatedAt: appliedAt,
    appliedAt,
    target: {
      ...recovered.record.target,
      skillDir: join(fixture.state, recovered.destination),
      skillFile: join(fixture.state, recovered.destination, "SKILL.md"),
      source: "openclaw-workshop",
    },
  };
  mkdirSync(dirname(record.target.skillDir), { recursive: true });
  renameSync(recovered.record.target.skillDir, record.target.skillDir);
  for (const name of ["proposal.json", "rollback.json"]) {
    rmSync(join(fixture.state, recovered.directory, name));
  }
  rmSync(join(fixture.state, "skill-workshop", "proposals.json"));
  const database = new DatabaseSync(fixture.filename);
  database.exec(`
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
      sequence INTEGER PRIMARY KEY, event_id TEXT, proposal_id TEXT, event_type TEXT,
      proposed_version TEXT, occurred_at TEXT, actor_json TEXT, payload_json TEXT, revision_hash TEXT
    );
  `);
  database
    .prepare(
      "INSERT INTO skill_workshop_proposals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      record.id,
      JSON.stringify(record),
      "main",
      record.kind,
      "applied",
      record.createdAt,
      appliedAt,
      record.draftHash,
      record.origin.agentId,
      null,
      record.origin.runId,
      null,
      appliedAt,
      null,
      null,
      null,
      null,
    );
  database
    .prepare("INSERT INTO skill_workshop_proposal_rollbacks VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(
      record.id,
      recovered.rollback!.writtenAt,
      recovered.rollback!.targetSkillFile,
      "create",
      null,
      null,
      JSON.stringify(recovered.rollback!.supportFiles),
    );
  const revisionHash = createHash("sha256")
    .update(
      JSON.stringify({
        proposedVersion: record.proposedVersion,
        contentSha256: record.draftHash,
        supportFiles: record.supportFiles.map((file) => ({
          path: file.path,
          sha256: file.hash,
          sizeBytes: file.sizeBytes,
        })),
      }),
    )
    .digest("hex");
  database
    .prepare("INSERT INTO skill_workshop_proposal_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      1,
      "recovered-event",
      record.id,
      "applied",
      "v1",
      appliedAt,
      JSON.stringify({ type: "system" }),
      JSON.stringify([1, { recovered: true }, null]),
      revisionHash,
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

  it.each([
    "intact",
    "baseline-consumed",
    "missing-import",
    "late-parent-import",
    "retained-bytes-changed",
    "rollback-changed",
    "duplicate-event",
    "event-envelope-version",
    "event-recovery-payload",
    "event-evaluation",
    "second-doctor-changed",
    "row-kind",
    "row-created_at",
    "row-origin_agent_id",
    "row-origin_session_key",
    "row-origin_run_id",
    "row-origin_message_id",
    "missing-warning",
    "truncated-warning",
    "missing-repeat-warning",
  ])("keeps published refusal, candidate import, and repeat recovery distinct: %s", (outcome) => {
    const fixture = workshopFixture();
    const first = join(fixture.artifacts, "first-update");
    recordProcess(first, 101, "update", fixture.baseline, true, false, 1);
    assertWorkshopUpdateRefusal(fixture.state, fixture.artifacts, first, fixture.packageRoot, 1);
    simulateWorkshopRepair(fixture.filename);
    const baselineDoctor = join(fixture.artifacts, "baseline-doctor");
    recordProcess(baselineDoctor, 102, "doctor", fixture.baseline, true, false, 0);
    assertWorkshopDoctorRepair(fixture.state, fixture.artifacts, baselineDoctor, "baseline");
    const seeded = seedWorkshopLegacyProposals(fixture.state, fixture.artifacts);
    cpSync(fixture.candidateRoot, fixture.packageRoot, { recursive: true });
    const upgraded = join(fixture.artifacts, "recovered-upgrade");
    recordProcess(upgraded, 103, "update", fixture.baseline, false, false, 0, true, seeded.before);
    if (outcome === "baseline-consumed") {
      simulateWorkshopLegacyImport(fixture, seeded);
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
        if (!["baseline-consumed", "missing-import", "late-parent-import"].includes(outcome)) {
          simulateWorkshopLegacyImport(fixture, seeded);
        }
        if (outcome === "retained-bytes-changed") {
          const retained = seeded.bundles.find((bundle) => !bundle.recover)!;
          writeFileSync(join(fixture.state, retained.directory, "PROPOSAL.md"), "changed");
        }
        if (outcome === "rollback-changed" || outcome === "duplicate-event") {
          const database = new DatabaseSync(fixture.filename);
          database.exec(
            outcome === "rollback-changed"
              ? "UPDATE skill_workshop_proposal_rollbacks SET support_files_json = '[]'"
              : "INSERT INTO skill_workshop_proposal_events SELECT 2, 'duplicate', proposal_id, event_type, proposed_version, occurred_at, actor_json, payload_json, revision_hash FROM skill_workshop_proposal_events",
          );
          database.close();
        }
        if (outcome.startsWith("event-")) {
          const stored = [
            outcome === "event-envelope-version" ? 2 : 1,
            { recovered: outcome !== "event-recovery-payload" },
            outcome === "event-evaluation" ? {} : null,
          ];
          const database = new DatabaseSync(fixture.filename);
          database
            .prepare("UPDATE skill_workshop_proposal_events SET payload_json = ?")
            .run(JSON.stringify(stored));
          database.close();
        }
        if (outcome.startsWith("row-")) {
          const database = new DatabaseSync(fixture.filename);
          database.exec(`UPDATE skill_workshop_proposals SET ${outcome.slice(4)} = 'changed'`);
          database.close();
        }
        return captureWorkshopLegacyState(fixture.state, seeded);
      },
      outcome === "missing-warning"
        ? []
        : [
            outcome === "truncated-warning"
              ? seeded.retainedWarning.slice(0, -40)
              : seeded.retainedWarning,
          ],
    );
    if (outcome === "late-parent-import") {
      simulateWorkshopLegacyImport(fixture, seeded);
      expect(() =>
        assertWorkshopLegacyImported(
          fixture.state,
          seeded,
          captureWorkshopLegacyState(fixture.state, seeded),
        ),
      ).not.toThrow();
    }
    const verifyUpgrade = () =>
      assertWorkshopRecoveredUpgrade(
        fixture.state,
        fixture.artifacts,
        upgraded,
        fixture.packageRoot,
      );
    if (!["intact", "second-doctor-changed", "missing-repeat-warning"].includes(outcome)) {
      expect(verifyUpgrade).toThrow(
        outcome === "baseline-consumed"
          ? /Candidate Doctor did not receive original/
          : outcome === "rollback-changed"
            ? /Imported rollback payload changed/
            : outcome === "duplicate-event"
              ? /exactly one applied event/
              : outcome.startsWith("event-")
                ? /Recovered Workshop event payload changed/
                : outcome.startsWith("row-")
                  ? /Authoritative Workshop proposal columns/
                  : ["missing-warning", "truncated-warning"].includes(outcome)
                    ? /Missing complete recoverable Workshop manual-review warning/
                    : /artifact bytes/,
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
        if (outcome === "second-doctor-changed") {
          const database = new DatabaseSync(fixture.filename);
          database.exec("UPDATE skill_workshop_proposal_events SET event_id = 'rewritten'");
          database.close();
        }
        writeFileSync(
          join(fixture.artifacts, "doctor.log"),
          outcome === "missing-repeat-warning"
            ? "Doctor complete.\n"
            : `\u001b[32m│  ${seeded.retainedWarning.split(" ").join("\n│  ")}\n│\u001b[0m\n`,
        );
        return captureWorkshopLegacyState(fixture.state, seeded);
      },
    );
    if (outcome === "second-doctor-changed" || outcome === "missing-repeat-warning") {
      expect(() =>
        assertWorkshopDoctorRepair(fixture.state, fixture.artifacts, candidateDoctor, "candidate"),
      ).toThrow(
        outcome === "second-doctor-changed"
          ? /Second candidate Doctor changed/
          : /Missing complete recoverable Workshop manual-review warning/,
      );
      return;
    }
    assertWorkshopDoctorRepair(fixture.state, fixture.artifacts, candidateDoctor, "candidate");
    expect(completeWorkshopRecovery(fixture.state, fixture.artifacts)).toMatchObject({
      firstAttempt: { status: "refused-before-candidate", automaticRepair: false },
      baselineDoctor: { status: "explicit-doctor-repaired" },
      upgrade: { status: "upgraded-after-explicit-repair" },
      candidateDoctor: { status: "explicit-doctor-repaired" },
    });
  });
});
