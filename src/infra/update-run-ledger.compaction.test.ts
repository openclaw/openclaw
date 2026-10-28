import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as state from "../state/openclaw-state-db.js";
import * as ledger from "./update-run-ledger.js";
import { toPublicUpdateRun } from "./update-run-record.js";
import { renderUpdateRunReport } from "./update-run-report.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";
import { updateRunLedgerSchema } from "./update-run-write.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await state.closeOpenClawStateDatabaseAsync();
  state.closeOpenClawStateDatabaseForTest();
});

function isolatedOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-update-compaction-") } };
}
function timedStep(step: string, status: "completed" | "failed" = "completed") {
  return { step, status, startedAtMs: 1_000, endedAtMs: 2_000 };
}

describe("update run ledger compaction", () => {
  it.each([
    { name: "step count", count: 130, detail: undefined },
    { name: "retained phase bytes", count: 0, detail: "🦞".repeat(512) },
  ])("retains evidence across the $name bound and reopen", ({ count, detail }) => {
    const options = isolatedOptions();
    const run = ledger.createUpdateRun({ trigger: "chat" }, options);
    const write = (step: Parameters<typeof ledger.recordUpdateRunStep>[1]) =>
      ledger.recordUpdateRunStep(run.runId, step, options);
    // CLI tests own warning generation; this boundary owns its durable, redacted report.
    for (const entry of updateRunStepsFromResultStep({
      name: "database migration writes",
      exitCode: 0,
      warnings: [
        `Automatic database restoration unavailable: databases changed after snapshot capture; the writer is unknown. Snapshots retained at ${options.env.OPENCLAW_STATE_DIR}/backup.`,
      ],
    })) {
      write(entry);
    }
    const evidence = [
      "candidate-admission",
      "warning:update-admission-fallback",
      "global update",
      "candidate-gateway-startup",
      "openclaw doctor",
      "managed-service-restart",
      "update-driver-handoff",
    ].map((step) => timedStep(step, step === "global update" ? "failed" : "completed"));
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
      "validating",
      "notice:ack",
      "previous generation restoration",
      // Candidate Doctor's predecessor-stop receipt: identity lives in the key.
      "finalize:predecessor-stop:1758600000000:1000:631:0123456789abcdef",
      "post-update verification",
    ];
    for (const step of notices) {
      write({ step, status: "completed", detail });
    }
    for (let index = 0; index < count; index++) {
      write({ step: `warning:diagnostic-${index}`, status: "completed", detail });
    }
    ledger.finishUpdateRun(run.runId, { status: "succeeded" }, options);
    state.closeOpenClawStateDatabaseForTest();
    const persisted = ledger.getUpdateRun(run.runId, options)!;
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
    expect(persisted.steps.map((step) => step.step)).toEqual(expect.arrayContaining(notices));
    expect(persisted.steps.length).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(JSON.stringify(persisted.steps))).toBeLessThanOrEqual(16 * 1024);
  });

  it("reads and compacts pre-timing rows without adding timing steps", () => {
    const options = isolatedOptions();
    const runId = "00000000-0000-4000-8000-000000000098";
    const version = "2026.9.8";
    // v2026.9.8 fixture: bypass today's writer so it cannot add the new timing steps.
    const steps = Array.from({ length: 15 }, (_, index) => ({
      ...timedStep(`finalize:legacy-${index}`),
      detail: "legacy diagnostic ".repeat(50),
    }));
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
    const database = state.openOpenClawStateDatabase(options);
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
    state.closeOpenClawStateDatabaseForTest();
    expect(ledger.getUpdateRun(runId, options)).toEqual(oldRecord);
    expect(ledger.listUpdateRuns({}, options)).toEqual([oldRecord]);
    expect(Buffer.byteLength(JSON.stringify(steps))).toBeLessThanOrEqual(16 * 1024);

    for (const step of ["finalize:exit", "finalize:cleanup", "finalize:complete"]) {
      ledger.recordUpdateRunDiagnostic(runId, "d".repeat(1024), options, step);
    }
    state.closeOpenClawStateDatabaseForTest();

    const persisted = ledger.getUpdateRun(runId, options)!;
    const { steps: oldSteps, updatedAtMs, ...coreFacts } = oldRecord;
    expect(persisted).toMatchObject(coreFacts);
    expect(persisted.updatedAtMs).toBeGreaterThan(updatedAtMs);
    const oldTimings = oldSteps.map(
      ({ detail: _detail, ...timingAndIdentity }) => timingAndIdentity,
    );
    expect(persisted.steps).toEqual(expect.arrayContaining(oldTimings));
    expect(persisted.steps.some((step) => step.detail === steps[0]!.detail)).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(persisted.steps))).toBeLessThanOrEqual(16 * 1024);
    expect(ledger.listUpdateRuns({}, options)).toEqual([persisted]);
  });
});
