import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as state from "../state/openclaw-state-db.js";
import * as ledger from "./update-run-ledger.js";
import { updateOwedStepRow } from "./update-run-owed-step.js";
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
    for (const entry of updateRunStepsFromResultStep({
      name: "database migration writes",
      exitCode: 0,
      warnings: [
        `Automatic database restoration unavailable: databases changed after snapshot capture; the writer is unknown. Snapshots retained at ${options.env.OPENCLAW_STATE_DIR}/backup.`,
      ],
    })) {
      write(entry);
    }
    const widenings = [
      "Retirement-only Doctor widened: config.model-retirement",
      "Retirement-only Doctor widened: config.model-retirement.warning-notes.codex-routes",
    ];
    const evidence = [
      "candidate-admission",
      "warning:update-admission-fallback",
      "global update",
      "candidate-gateway-startup",
      "openclaw doctor",
      "managed-service-restart",
      "managed-service update handoff",
      "warning:managed-service-reconciliation",
      "service-stop",
      "service-start",
      "service-running",
      "update-driver-handoff",
      ...widenings.map((_, index) => `diagnostic:post-plugin doctor:${index}`),
    ].map((step) =>
      Object.assign(
        timedStep(step, step === "global update" ? "failed" : "completed"),
        step.startsWith("diagnostic:") ? { detail: widenings[Number(step.split(":").at(-1))] } : {},
      ),
    );
    const refusal = {
      reason: "refused",
      message: "Repair is pending.",
      keys: Array.from({ length: 32 }, (_, index) => `${index}:${"k".repeat(1_020)}`),
    };
    for (const step of evidence) {
      write({
        ...step,
        detail: step.detail ?? detail,
        ...(step.step === "openclaw doctor" ? { configWriteRefusal: refusal } : {}),
      });
    }
    const notices = [
      "validating",
      "notice:ack",
      "previous generation restoration",
      "warning:post-plugin doctor",
      "warning:post-stop-checks",
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
    expect(persisted.steps).toContainEqual(
      expect.objectContaining({
        step: "warning:database migration writes",
        detail:
          "Automatic database restoration unavailable: databases changed after snapshot capture; the writer is unknown. Snapshots retained at $OPENCLAW_STATE_DIR/backup.",
      }),
    );
    expect(JSON.stringify(persisted.steps)).not.toContain(options.env.OPENCLAW_STATE_DIR);
    for (const expected of evidence) {
      expect(persisted.steps.find(({ step }) => step === expected.step)).toMatchObject(expected);
    }
    const retainedRefusal = persisted.steps.find(
      (step) => step.step === "openclaw doctor",
    )?.configWriteRefusal;
    expect(retainedRefusal).toMatchObject({ reason: "refused", message: "Repair is pending." });
    expect(retainedRefusal?.keys).toHaveLength(32);
    expect(retainedRefusal?.keys.every((key) => key.length < 1_020)).toBe(true);
    expect(persisted.steps.map((step) => step.step)).toEqual(expect.arrayContaining(notices));
    for (const key of ["warning:post-plugin doctor", "warning:post-stop-checks"]) {
      expect(persisted.steps.find((step) => step.step === key)?.detail).toBe(detail);
    }
    expect(persisted.steps.length).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(JSON.stringify(persisted.steps))).toBeLessThanOrEqual(16 * 1024);
  });

  it.each([
    { name: "byte", count: 40, detail: "diagnostic ".repeat(100) },
    { name: "step", count: 140, detail: "diagnostic" },
  ])("keeps warning rows ahead of plain steps across the $name bound", ({ count, detail }) => {
    const options = isolatedOptions();
    const run = ledger.createUpdateRun({ trigger: "chat" }, options);
    const write = (step: string) =>
      ledger.recordUpdateRunStep(run.runId, { step, status: "completed", detail: step }, options);
    write("warning:finalize:plugins:skipped");
    write("warning:update-channel-note");
    for (let index = 0; index < count; index++) {
      ledger.recordUpdateRunStep(
        run.runId,
        { step: `plugin-check-${index}`, status: "completed", detail },
        options,
      );
    }
    ledger.finishUpdateRun(run.runId, { status: "succeeded" }, options);
    const stored = ledger.getUpdateRun(run.runId, options)!;
    expect(stored.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          step: "warning:finalize:plugins:skipped",
          detail: "warning:finalize:plugins:skipped",
        }),
        expect.objectContaining({
          step: "warning:update-channel-note",
          detail: "warning:update-channel-note",
        }),
        // Requested phase + two warnings + count plain rows, plus the new marker.
        expect.objectContaining({
          step: "history:truncated",
          detail: String(count + 4 - stored.steps.length),
        }),
      ]),
    );
  });

  it("keeps actionable rows through late cleanup and counts unavoidable warning overflow", () => {
    const options = isolatedOptions();
    const run = ledger.createUpdateRun({ trigger: "cli" }, options);
    const write = (step: Parameters<typeof ledger.recordUpdateRunStep>[1]) =>
      ledger.recordUpdateRunStep(run.runId, step, options);
    const browserWarning = "Review legacy Browser Relay authentication.";
    write({ step: "warning:doctor:browser", status: "completed", detail: browserWarning });
    write({ step: "service-refresh", status: "failed", detail: "Service definition unchanged." });
    write(updateOwedStepRow("service-definition", "Review the service installation."));
    for (let index = 0; index < 14; index++) {
      write({
        step: `warning:doctor:${index}`,
        status: "completed",
        detail: `Doctor advisory ${index}: ${"🦞".repeat(235)}`,
      });
    }
    write({ step: "diagnostic:disposable", status: "completed", detail: "i".repeat(350) });
    ledger.finishUpdateRun(run.runId, { status: "succeeded" }, options);
    const cleanup = (suffix: string) =>
      write({ step: suffix, status: "completed", detail: `Late cleanup: ${"🦞".repeat(240)}` });
    cleanup("recovery-artifact-cleanup");
    cleanup("diagnostic:recovery-artifact-cleanup");
    cleanup("warning:recovery-artifact-cleanup");
    state.closeOpenClawStateDatabaseForTest();

    const persisted = ledger.getUpdateRun(run.runId, options)!;
    expect(persisted.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ step: "history:truncated", detail: "1" }),
        expect.objectContaining({ step: "warning:doctor:browser", detail: browserWarning }),
        expect.objectContaining({
          step: "service-refresh",
          status: "failed",
          detail: "Service definition unchanged.",
        }),
        expect.objectContaining({
          step: "finalize:owed:service-definition",
          status: "skipped",
          detail: "Review the service installation.",
        }),
      ]),
    );
    expect(persisted.steps.some((step) => step.step === "diagnostic:disposable")).toBe(false);

    cleanup("warning:recovery-artifact-cleanup:extra");
    state.closeOpenClawStateDatabaseForTest();
    const overflow = ledger.getUpdateRun(run.runId, options)!;
    expect(Buffer.byteLength(JSON.stringify(overflow.steps))).toBeLessThanOrEqual(16 * 1024);
    expect(overflow.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ step: "history:truncated", detail: "3" }),
        expect.objectContaining({
          step: "service-refresh",
          status: "failed",
          detail: "Service definition unchanged.",
        }),
        expect.objectContaining({
          step: "finalize:owed:service-definition",
          status: "skipped",
          detail: "Review the service installation.",
        }),
      ]),
    );
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
