import { afterEach, describe, expect, it } from "vitest";
import { UPDATE_RUN_PHASES } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPackageUpdateDoctorCompletion } from "../cli/update-cli/update-command-doctor-completion.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import type { UpdateDatabaseBackup } from "./update-database-backup.js";
import { createUpdateDoctorSectionTiming } from "./update-doctor-section-timing.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  listUpdateRuns,
  recordUpdateRunDiagnostic,
  recordUpdateRunStep,
} from "./update-run-ledger.js";
import { toPublicUpdateRun } from "./update-run-record.js";
import { renderUpdateRunReport } from "./update-run-report.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";
import { updateRunLedgerSchema } from "./update-run-write.js";
import type { UpdateStepResult } from "./update-step-result.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

function isolatedOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-update-compaction-") } };
}
const names = (prefix: string, suffixes: string) =>
  suffixes.split(",").map((suffix) => prefix + suffix);
function timedStep(step: string, status: "completed" | "failed" = "completed") {
  return { step, status, startedAtMs: 1_000, endedAtMs: 2_000 };
}

describe("update run ledger compaction", () => {
  it.each([
    { name: "step count", count: 130, detail: undefined },
    { name: "diagnostic bytes", count: 30, detail: "diagnostic ".repeat(80) },
    { name: "retained phase bytes", count: 0, detail: "🦞".repeat(512), missingWrites: true },
  ])(
    "retains evidence across the $name bound and reopen",
    async ({ count, detail, missingWrites }) => {
      const options = isolatedOptions();
      const run = createUpdateRun({ trigger: "chat" }, options);
      const write = (step: Parameters<typeof recordUpdateRunStep>[1]) =>
        recordUpdateRunStep(run.runId, step, options);
      const backup: UpdateDatabaseBackup = {
        directory: `${options.env.OPENCLAW_STATE_DIR}/backup`,
        databases: [],
        missingPaths: [],
        sourcePaths: ["database.sqlite"],
        sourceGenerations: { "database.sqlite": "before" },
        warnings: [],
        ...(missingWrites
          ? { restoreRefusal: "databases changed after snapshot capture; the writer is unknown" }
          : {}),
      };
      const results: UpdateStepResult[] = [];
      const completeDoctor = createPackageUpdateDoctorCompletion({
        root: options.env.OPENCLAW_STATE_DIR,
        context: { changes: [], databaseBackup: backup },
        results,
        progress: {
          onStepComplete: (step) => {
            for (const entry of updateRunStepsFromResultStep(step)) {
              write(entry);
            }
          },
        },
        sectionTiming: createUpdateDoctorSectionTiming({}),
        assertCurrent: () => {},
        doctorProgressInfo: { name: "openclaw doctor", command: "doctor", index: 0, total: 0 },
      });
      await completeDoctor(
        {
          name: "openclaw doctor",
          command: "doctor",
          cwd: backup.directory,
          durationMs: 1,
          exitCode: 0,
        },
        {
          status: "ok",
          warnings: ["Unrelated Doctor warning"],
          databaseWrites: missingWrites
            ? undefined
            : {
                unchanged: false,
                fromGenerations: { "database.sqlite": "foreign-write" },
                generations: { "database.sqlite": "after" },
              },
        },
      );
      expect(backup.restoreRefusal).toBe(
        "databases changed after snapshot capture; the writer is unknown",
      );
      const evidence = [
        "candidate-admission",
        ...names("warning:", "update-admission-unsupported-target,update-admission-fallback"),
        ...names("warning:", "managed-service-membership,finalize:plugins:deadline"),
        ...names("", "global update,global update (omit optional)"),
        "candidate-doctor-lint",
        ...names("candidate-", "state-snapshot,doctor,gateway-startup,state-cleanup"),
        "post-stop-checks",
        ...names("git-", "checkout,runtime-activation"),
        ...names("", "openclaw doctor,pre-plugin doctor,post-plugin doctor"),
        "updater-runtime-retention",
        "diagnostic:updater-runtime-retention",
        ...names("managed-service-", "executor-check,install,restart"),
        ...names("", "update-driver-handoff,diagnostic:update-driver-handoff"),
      ].map((step) => {
        const failed = step.startsWith("global update") || step === "candidate-doctor-lint";
        return timedStep(step, failed ? "failed" : "completed");
      });
      const refusal = {
        reason: "refused",
        message: "Repair is pending.",
        keys: Array.from({ length: 32 }, (_, index) => `${index}:${"k".repeat(1_020)}`),
      };
      for (const step of evidence) {
        write({
          ...step,
          detail,
          ...(step.step === "openclaw doctor" ? { configWriteRefusal: refusal } : {}),
        });
      }
      const notices = [
        ...names("notice:", "ack,activating,verifying"),
        "previous generation restoration",
        ...names("finalize:", "doctor,future-phase"),
        // Candidate Doctor's predecessor-stop receipt: identity lives in the key.
        "finalize:predecessor-stop:1758600000000:1000:631:0123456789abcdef",
        "post-update verification",
      ];
      for (const step of [...UPDATE_RUN_PHASES, ...notices]) {
        write({ step, status: "completed", detail });
      }
      for (let index = 0; index < count; index++) {
        write({ step: `warning:diagnostic-${index}`, status: "completed", detail });
      }
      finishUpdateRun(run.runId, { status: "succeeded" }, options);
      closeOpenClawStateDatabaseForTest();
      const persisted = getUpdateRun(run.runId, options)!;
      const published = toPublicUpdateRun(persisted);
      const report = renderUpdateRunReport(published);
      expect(published.status).toBe("succeeded");
      expect(report.headline).toMatch(/warnings? needs? attention/);
      expect(report.markdown).toContain(
        "Automatic database restoration unavailable: databases changed after snapshot capture; the writer is unknown.",
      );
      expect(report.markdown).toContain("Snapshots retained at $OPENCLAW_STATE_DIR/backup.");
      expect(report.markdown).not.toContain(options.env.OPENCLAW_STATE_DIR);
      expect(
        published.steps.filter((step) => step.step === "warning:database migration writes"),
      ).toHaveLength(1);
      expect(results).toContainEqual(
        expect.objectContaining({
          name: "database migration writes",
          warnings: expect.arrayContaining([
            expect.stringContaining("Automatic database restoration unavailable:"),
          ]),
        }),
      );
      for (const expected of evidence) {
        expect(persisted.steps.filter((step) => step.step === expected.step)).toEqual([
          expect.objectContaining(expected),
        ]);
      }
      const retainedRefusal = persisted.steps.find(
        (step) => step.step === "openclaw doctor",
      )?.configWriteRefusal;
      expect(retainedRefusal).toMatchObject({ reason: "refused", message: "Repair is pending." });
      expect(retainedRefusal?.keys).toHaveLength(32);
      expect(retainedRefusal?.keys.every((key) => key.length < 1_020)).toBe(true);
      expect(persisted.steps.map((step) => step.step)).toEqual(
        expect.arrayContaining([...UPDATE_RUN_PHASES, ...notices]),
      );
      expect(persisted.steps.length).toBeLessThanOrEqual(128);
      expect(Buffer.byteLength(JSON.stringify(persisted.steps))).toBeLessThanOrEqual(16 * 1024);
    },
  );

  it("reads and compacts pre-timing rows without adding timing steps", () => {
    const options = isolatedOptions();
    const runId = "00000000-0000-4000-8000-000000000098";
    const version = "2026.9.8";
    // v2026.9.8 fixture: bypass today's writer so it cannot add the new timing steps.
    const steps = [
      ..."requested,staging,validating,repairing,activating,restarting,verifying,finished".split(
        ",",
      ),
      "candidate-admission",
      "global update",
      ...names("notice:", "ack,activating,verifying"),
      "post-update verification",
      "finalize:doctor",
    ].map((step) => Object.assign(timedStep(step), { detail: "legacy diagnostic ".repeat(50) }));
    const requester = { channel: "discord", senderId: "legacy-operator" };
    const oldRecord = {
      runId,
      createdAtMs: 1_000,
      updatedAtMs: 3_000,
      trigger: "cli",
      phase: "finished",
      status: "succeeded",
      reason: null,
      origin: { requester, sessionKey: "agent:main:discord:channel:legacy" },
      target: { kind: "package", channel: "stable", version },
      before: { version: "2026.9.7" },
      after: { version },
      steps,
      verification: { booted: true, versionMatch: true, runningVersion: version },
      repair: [],
      confirmedAtMs: 2_500,
      finishedAtMs: 3_000,
      downtimeMs: 500,
    };
    const database = openOpenClawStateDatabase(options);
    database.db.exec(updateRunLedgerSchema);
    // Record insertion order matches the explicit column order below.
    database.db
      .prepare(
        `INSERT INTO update_runs (
          run_id, created_at_ms, updated_at_ms, trigger, phase, status, reason,
          origin_json, target_json, before_json, after_json, steps_json,
          verification_json, repair_json, confirmed_at_ms, finished_at_ms, downtime_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ...Object.values(oldRecord).map((value) =>
          value !== null && typeof value === "object" ? JSON.stringify(value) : value,
        ),
      );
    closeOpenClawStateDatabaseForTest();
    expect(getUpdateRun(runId, options)).toEqual(oldRecord);
    expect(listUpdateRuns({}, options)).toEqual([oldRecord]);
    expect(Buffer.byteLength(JSON.stringify(steps))).toBeLessThanOrEqual(16 * 1024);

    for (const step of ["finalize:exit", "finalize:cleanup", "finalize:complete"]) {
      recordUpdateRunDiagnostic(runId, "d".repeat(1024), options, step);
    }
    closeOpenClawStateDatabaseForTest();

    const persisted = getUpdateRun(runId, options)!;
    const { steps: oldSteps, updatedAtMs, ...coreFacts } = oldRecord;
    expect(persisted).toMatchObject(coreFacts);
    expect(persisted.updatedAtMs).toBeGreaterThan(updatedAtMs);
    const oldTimings = oldSteps.map(
      ({ detail: _detail, ...timingAndIdentity }) => timingAndIdentity,
    );
    expect(persisted.steps).toEqual(expect.arrayContaining(oldTimings));
    expect(persisted.steps.some((step) => step.detail === steps[0]!.detail)).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(persisted.steps))).toBeLessThanOrEqual(16 * 1024);
    expect(listUpdateRuns({}, options)).toEqual([persisted]);
  });
});
