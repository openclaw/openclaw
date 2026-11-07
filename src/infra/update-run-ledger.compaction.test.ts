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

describe("update run ledger compaction", () => {
  it.each([
    { name: "step count", count: 130, detail: undefined },
    { name: "diagnostic bytes", count: 30, detail: "diagnostic ".repeat(80) },
    { name: "retained phase bytes", count: 0, detail: "🦞".repeat(512) },
  ])(
    "retains admission warnings, failure steps, notice custody, and finalization history across the $name bound and database reopen",
    ({ count, detail }) => {
      const options = isolatedOptions();
      const run = createUpdateRun({ trigger: "chat" }, options);
      const evidence = [
        "candidate-admission",
        "warning:update-admission-unsupported-target",
        "warning:update-admission-fallback",
        "warning:managed-service-membership",
        "warning:finalize:plugins:deadline",
        "global update",
        "global update (omit optional)",
        "candidate-doctor-lint",
        // Phase timing explains the validating and activation windows.
        "candidate-state-snapshot",
        "candidate-doctor",
        "candidate-gateway-startup",
        "candidate-state-cleanup",
        "post-stop-checks",
        "git-checkout",
        "git-runtime-activation",
        "openclaw doctor",
        "pre-plugin doctor",
        "post-plugin doctor",
        "updater-runtime-retention",
        "diagnostic:updater-runtime-retention",
        "managed-service-executor-check",
        "managed-service-install",
        "managed-service-restart",
        "managed-service update handoff",
        "service-stop",
        "service-start",
        "service-running",
        "update-driver-handoff",
        "diagnostic:update-driver-handoff",
      ].map((step) => ({
        step,
        status:
          step.startsWith("global update") || step === "candidate-doctor-lint"
            ? ("failed" as const)
            : ("completed" as const),
        startedAtMs: 1_000,
        endedAtMs: 2_000,
      }));
      for (const step of evidence) {
        recordUpdateRunStep(
          run.runId,
          {
            ...step,
            detail,
            ...(step.step === "openclaw doctor"
              ? {
                  configWriteRefusal: {
                    reason: "refused",
                    message: "Repair is pending.",
                    keys: Array.from({ length: 32 }, (_, index) => `${index}:${"k".repeat(1_020)}`),
                  },
                }
              : {}),
          },
          options,
        );
      }
      const notices = [
        "notice:ack",
        "notice:activating",
        "notice:verifying",
        "previous generation restoration",
        "finalize:doctor",
        "finalize:future-phase",
        // Candidate Doctor's predecessor-stop receipt: identity lives in the key.
        "finalize:predecessor-stop:1758600000000:1000:631:0123456789abcdef",
        "post-update verification",
      ];
      for (const step of [...UPDATE_RUN_PHASES, ...notices]) {
        recordUpdateRunStep(run.runId, { step, status: "completed", detail }, options);
      }
      for (let index = 0; index < count; index++) {
        recordUpdateRunStep(
          run.runId,
          { step: `warning:diagnostic-${index}`, status: "completed", detail },
          options,
        );
      }
      closeOpenClawStateDatabaseForTest();
      const persisted = getUpdateRun(run.runId, options)!;
      for (const expected of evidence) {
        expect(persisted.steps.filter((step) => step.step === expected.step)).toEqual([
          expect.objectContaining(expected),
        ]);
      }
      const refusal = persisted.steps.find(
        (step) => step.step === "openclaw doctor",
      )?.configWriteRefusal;
      expect(refusal).toMatchObject({ reason: "refused", message: "Repair is pending." });
      expect(refusal?.keys).toHaveLength(32);
      expect(refusal?.keys.every((key) => key.length < 1_020)).toBe(true);
      expect(persisted.steps.map((step) => step.step)).toEqual(
        expect.arrayContaining([...UPDATE_RUN_PHASES, ...notices]),
      );
      expect(persisted.steps.length).toBeLessThanOrEqual(128);
      expect(Buffer.byteLength(JSON.stringify(persisted.steps))).toBeLessThanOrEqual(16 * 1024);
    },
  );

  it("loads, lists, and compacts pre-timing persisted rows without new timing steps", () => {
    const options = isolatedOptions();
    const runId = "00000000-0000-4000-8000-000000000098";
    const version = "2026.9.8";
    // Synthetic persisted fixture using the shared UpdateRunRecordSchema fields in
    // v2026.9.8 and pre-change origin/main, plus their update-run-vocabulary enums.
    // No current writer generates this row or adds the new optional timing steps.
    const steps = [
      "requested",
      "staging",
      "validating",
      "repairing",
      "activating",
      "restarting",
      "verifying",
      "finished",
      "candidate-admission",
      "global update",
      "notice:ack",
      "notice:activating",
      "notice:verifying",
      "post-update verification",
      "finalize:doctor",
    ].map((step) => ({
      step,
      status: "completed",
      startedAtMs: 1_000,
      endedAtMs: 2_000,
      detail: "legacy diagnostic ".repeat(50),
    }));
    const oldRecord = {
      runId,
      createdAtMs: 1_000,
      updatedAtMs: 3_000,
      trigger: "cli",
      phase: "finished",
      status: "succeeded",
      reason: null,
      origin: {
        requester: { channel: "discord", senderId: "legacy-operator" },
        sessionKey: "agent:main:discord:channel:legacy",
      },
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
    database.db
      .prepare(
        `INSERT INTO update_runs (
          run_id, created_at_ms, updated_at_ms, trigger, phase, status, reason,
          origin_json, target_json, before_json, after_json, steps_json,
          verification_json, repair_json, confirmed_at_ms, finished_at_ms, downtime_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        1_000,
        3_000,
        "cli",
        "finished",
        "succeeded",
        null,
        JSON.stringify(oldRecord.origin),
        JSON.stringify(oldRecord.target),
        JSON.stringify(oldRecord.before),
        JSON.stringify(oldRecord.after),
        JSON.stringify(steps),
        JSON.stringify(oldRecord.verification),
        "[]",
        2_500,
        3_000,
        500,
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
    expect(persisted.steps).toEqual(
      expect.arrayContaining(
        oldSteps.map(({ detail: _detail, ...timingAndIdentity }) => timingAndIdentity),
      ),
    );
    expect(persisted.steps.some((step) => step.detail === steps[0]!.detail)).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(persisted.steps))).toBeLessThanOrEqual(16 * 1024);
    expect(listUpdateRuns({}, options)).toEqual([persisted]);
  });
});

const names = (prefix: string, suffixes: string) =>
  suffixes.split(",").map((suffix) => prefix + suffix);
function timedStep(step: string, status: "completed" | "failed" = "completed") {
  return { step, status, startedAtMs: 1_000, endedAtMs: 2_000 };
}

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
