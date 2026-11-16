import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as state from "../state/openclaw-state-db.js";
import * as ledger from "./update-run-ledger.js";
import { renderUpdateRunReport } from "./update-run-report.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.useRealTimers();
  await state.closeOpenClawStateDatabaseAsync();
  state.closeOpenClawStateDatabaseForTest();
});

const SHELL_RETRY =
  "Retried by the next `openclaw update`; run `openclaw update repair` to retry it now.";
const SERVICE_RETRY =
  "Settled when `openclaw update` next refreshes the service definition; `openclaw update repair` rechecks it.";

function privateLedger() {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-update-owed-") } };
  const start = () => ledger.createUpdateRun({ trigger: "cli" }, options).runId;
  const finish = (runId: string, status: "succeeded" | "failed" | "skipped" = "succeeded") =>
    ledger.finishUpdateRun(runId, { status }, options);
  const owe = (runId: string, id: "shell-completion" | "service-definition", reason: string) =>
    ledger.recordUpdateRunOwedStep(runId, id, reason, options);
  const owedLines = (runId: string) =>
    renderUpdateRunReport(ledger.getUpdateRun(runId, options)!).lines.filter((line) =>
      line.includes(" is owed: "),
    );
  return { options, start, finish, owe, owedLines };
}

describe("update run owed steps", () => {
  it.each(["running", "succeeded", "skipped"] as const)(
    "records, reports and settles an owed step on a %s run",
    (status) => {
      const { options, start, finish, owe, owedLines } = privateLedger();
      const runId = start();
      if (status !== "running") {
        finish(runId, status);
      }

      expect(owe(runId, "shell-completion", "EACCES: permission denied.")).toBe(true);

      expect(ledger.readOwedUpdateSteps(options)).toEqual([
        { id: "shell-completion", runId, reason: "EACCES: permission denied." },
      ]);
      // The row is the contract older and newer readers share: an existing status, reason in detail.
      const recorded = ledger.getUpdateRun(runId, options)!;
      expect(recorded.steps.find((step) => step.step === "finalize:owed:shell-completion")).toEqual(
        expect.objectContaining({ status: "skipped", detail: "EACCES: permission denied." }),
      );
      expect(recorded.status).toBe(status);
      expect(owedLines(runId)).toEqual([
        `Warning: Shell completion refresh is owed: EACCES: permission denied. ${SHELL_RETRY}`,
      ]);

      expect(ledger.settleUpdateRunOwedStep(runId, "shell-completion", options)).toBe(true);

      expect(ledger.readOwedUpdateSteps(options)).toEqual([]);
      expect(owedLines(runId)).toEqual([]);
      expect(ledger.settleUpdateRunOwedStep(runId, "shell-completion", options)).toBe(false);
    },
  );

  it("owes nothing on a failed update and leaves other finished history immutable", () => {
    const { options, start, finish, owe, owedLines } = privateLedger();
    const failed = start();
    owe(failed, "shell-completion", "recorded before the update failed");
    finish(failed, "failed");
    const succeeded = start();
    finish(succeeded);
    const before = ledger.getUpdateRun(succeeded, options);

    expect(owe(failed, "service-definition", "install failed")).toBe(false);
    expect(ledger.settleUpdateRunOwedStep(succeeded, "service-definition", options)).toBe(false);
    ledger.recordUpdateRunStep(
      succeeded,
      { step: "post-update verification", status: "failed", detail: "late writer" },
      options,
    );

    expect(ledger.readOwedUpdateSteps(options)).toEqual([]);
    expect(owedLines(failed)).toEqual([]);
    expect(ledger.getUpdateRun(succeeded, options)).toEqual(before);
  });

  it("lets the newest run that mentions a step decide whether it is owed", () => {
    const { options, start, finish, owe } = privateLedger();
    // Runs are ordered by creation time.
    vi.useFakeTimers({ toFake: ["Date"], now: 1_800_000_000_000 });
    const first = start();
    owe(first, "shell-completion", "first failure");
    owe(first, "service-definition", "install failed");
    // A newer release may owe a step this version cannot retry; it is still reported.
    ledger.recordUpdateRunStep(
      first,
      { step: "finalize:owed:future-step", status: "skipped", detail: "from a newer release" },
      options,
    );
    finish(first);
    vi.advanceTimersByTime(1_000);
    const rolledBack = start();
    owe(rolledBack, "service-definition", "moot after rollback");
    finish(rolledBack, "failed");
    vi.advanceTimersByTime(1_000);
    const latest = start();
    owe(latest, "shell-completion", "second failure");
    finish(latest, "skipped");

    const olderRows = [
      { id: "service-definition", runId: first, reason: "install failed" },
      { id: "future-step", runId: first, reason: "from a newer release" },
    ];
    expect(ledger.readOwedUpdateSteps(options)).toEqual([
      { id: "shell-completion", runId: latest, reason: "second failure" },
      ...olderRows,
    ]);

    ledger.settleUpdateRunOwedStep(latest, "shell-completion", options);

    expect(ledger.readOwedUpdateSteps(options)).toEqual(olderRows);
  });

  it("keeps an owed step and its reason through step and byte compaction", () => {
    const { options, start, owe, owedLines } = privateLedger();
    const runId = start();
    const warning = `Failed to reconcile gateway service: ${"x".repeat(300)}. ${"y".repeat(400)}`;
    const record = (step: string, detail: string) =>
      ledger.recordUpdateRunStep(runId, { step, status: "completed", detail }, options);
    owe(runId, "service-definition", warning);
    record("warning:managed-service-reconciliation", warning);
    // A long reason is bounded; the original warning repeats it and is reported once.
    const reason = warning.slice(0, 500);
    const line = `Warning: Gateway service definition refresh is owed: ${reason}. ${SERVICE_RETRY}`;
    expect(
      renderUpdateRunReport(ledger.getUpdateRun(runId, options)!).lines.filter((entry) =>
        entry.includes("Failed to reconcile"),
      ),
    ).toEqual([line]);

    for (let index = 0; index < 160; index += 1) {
      record(`warning:noise:${index}`, "🦞".repeat(250));
    }
    for (let index = 0; index < 40; index += 1) {
      record(`finalize:noise:${index}`, "🦞".repeat(250));
    }
    state.closeOpenClawStateDatabaseForTest();

    expect(ledger.readOwedUpdateSteps(options)).toEqual([
      { id: "service-definition", runId, reason },
    ]);
    expect(owedLines(runId)).toEqual([line]);
  });
});
