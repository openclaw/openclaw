import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqliteDir } from "../../state/openclaw-state-db.paths.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import {
  UpdateCommandFailure,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";
import {
  deferUpdateCommandTerminalResult,
  publishUpdateCommandTerminalResult,
  withUpdateCommandTerminalResult,
} from "./update-command-terminal.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";

const mocks = vi.hoisted(() => ({
  action: vi.fn<typeof import("./update-command-report.js").runInteractiveUpdateFailureAction>(),
  diagnose: vi.fn(),
  repair: vi.fn(),
}));
vi.mock("../../commands/triage-failure.js", () => ({ triageAfterFailure: mocks.repair }));
vi.mock("./update-command-report.js", () => ({
  runInteractiveUpdateFailureAction: mocks.action,
}));
vi.mock("../terminal-interactivity.js", () => ({ isTerminalInteractive: () => true }));
vi.mock("../../infra/update-triage.js", () => ({
  prepareUpdateFailureTriage: async () => mocks.diagnose,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  mocks.action.mockReset();
  mocks.diagnose.mockReset();
  mocks.repair.mockReset();
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

it.each(["new-error", "pending-aggregate"] as const)(
  "preserves the primary failed result when publication fails with %s",
  async (publication) => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("update-terminal-primary-failure-") };
    const recorded = createUpdateRun({ trigger: "cli" }, { env });
    const run = { runId: recorded.runId, env };
    const result: UpdateRunResult = {
      status: "error",
      mode: "npm",
      reason: "global-install-failed",
      steps: [
        {
          name: "global install",
          command: "npm install",
          cwd: env.OPENCLAW_STATE_DIR,
          durationMs: 1,
          exitCode: 1,
          failureFacts: [{ check: "npm", code: "EACCES", message: "Permission denied" }],
        },
      ],
      durationMs: 1,
    };
    const primary = new UpdateCommandFailure(result, 1, "Package installation failed", {
      automaticTriage: {
        kind: "update",
        phase: "global-install-failed",
        error: "Permission denied",
        gateway: "preserve",
      },
    });
    const pending = new UpdateCommandPendingRecoveryFailure(result);
    const settlementFailure = new AggregateError([pending], "Update executor cleanup failed", {
      cause: pending,
    });
    const publish = vi.fn(async (failure?: unknown) => {
      if (publication === "pending-aggregate") {
        // Recovery publication preserves a changed settlement exception from its executor.
        throw failure;
      }
      throw new Error("Update result publication failed");
    });
    const json = publication === "new-error";
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    await expect(
      withUpdateFailureTriage({ run, json }, { env }, () =>
        withUpdateCommandTerminalResult(
          async (registerRun) => {
            registerRun(run);
            deferUpdateCommandTerminalResult(run, publish);
            throw publication === "pending-aggregate" ? settlementFailure : primary;
          },
          { json },
        ),
      ),
    ).rejects.toMatchObject({ code: 1 });
    expect(publish).toHaveBeenCalledOnce();
    if (json) {
      expect(output).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(result));
    } else {
      expect(output).not.toHaveBeenCalled();
      const summary = vi
        .mocked(defaultRuntime.log)
        .mock.calls.map(([line]) => String(line))
        .join("\n");
      expect(summary).toContain("EACCES");
      expect(summary).toContain("Permission denied");
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("Update recovery remains pending (global-install-failed)"),
      );
    }
    expect(getUpdateRun(run.runId, { env })).toEqual(recorded);
    expect(mocks.action).not.toHaveBeenCalled();
    expect(mocks.diagnose).not.toHaveBeenCalled();
    expect(mocks.repair).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "preserves the committed outcome when its observer throws (pending=%s)",
  async (pending) => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("update-terminal-observer-") };
    const recorded = createUpdateRun({ trigger: "cli" }, { env });
    const run = { runId: recorded.runId, env };
    const onResult = vi.fn(() => {
      throw new TypeError("Observer could not finish");
    });
    const result: UpdateRunResult = {
      status: pending ? "error" : "ok",
      mode: "npm",
      steps: [],
      durationMs: 0,
    };
    const update = withUpdateFailureTriage({ run }, { env }, () =>
      withUpdateCommandTerminalResult(
        async (registerRun) => {
          registerRun(run);
          deferUpdateCommandTerminalResult(run, () =>
            publishUpdateCommandTerminalResult({ opts: { run } }, result, { rolledBack: false }),
          );
          if (pending) {
            throw new UpdateCommandPendingRecoveryFailure(result);
          }
        },
        { onResult },
      ),
    );
    if (pending) {
      await expect(update).rejects.toMatchObject({ code: 1 });
    } else {
      await expect(update).resolves.toBeUndefined();
    }
    expect(onResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: result.status }),
    );
    expect(getUpdateRun(run.runId, { env })).toMatchObject({
      status: pending ? "failed" : "succeeded",
    });
    expect(mocks.action).not.toHaveBeenCalled();
    expect(mocks.diagnose).not.toHaveBeenCalled();
    expect(defaultRuntime.error).not.toHaveBeenCalledWith(
      expect.stringContaining("Update recovery remains pending"),
    );
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Warning: Update result observer failed:"),
    );
  },
);

it.each([
  { phase: "requested", publisher: false },
  { phase: "staging", publisher: false },
  { phase: "verifying", publisher: true },
] as const)(
  "records an unreported $phase exception before offering the interactive report",
  async ({ phase, publisher }) => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("update-unreported-terminal-") };
    const options = { env };
    const recorded = createUpdateRun(
      {
        trigger: "cli",
        target: { kind: "package", installationMethod: "npm-global", version: "2026.9.6" },
      },
      options,
    );
    const run = { runId: recorded.runId, env };
    recordUpdateRunPhase(run.runId, phase, {}, options);
    const failure = new TypeError("Cannot complete update publication");
    const onResult = vi.fn();
    let reportBody: string | undefined;
    mocks.action.mockImplementation(async ({ result, attemptId }) => {
      const terminal = getUpdateRun(attemptId, options);
      expect(terminal).toMatchObject({
        status: "failed",
        reason: "update-failed",
        verification: {
          rollbackOutcome: { status: phase === "requested" ? "not-needed" : "not-attempted" },
        },
      });
      expect(result).toMatchObject({
        status: "error",
        reason: "update-failed",
        failedStep: {
          name: phase,
          failureFacts: [expect.objectContaining({ check: phase, errorName: "TypeError" })],
        },
      });
      reportBody = (
        await prepareUpdateFailureReport(
          { attemptId, result: result!, recordedRun: terminal },
          options,
        )
      ).body;
      return "handled";
    });
    await expect(
      withUpdateFailureTriage({ run }, { env }, () =>
        withUpdateCommandTerminalResult(
          async (registerRun) => {
            registerRun(run);
            if (publisher) {
              deferUpdateCommandTerminalResult(run, async () => {
                throw failure;
              });
              return;
            }
            throw failure;
          },
          { onResult },
        ),
      ),
    ).rejects.toMatchObject({ code: 1 });
    expect(mocks.action).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ runId: run.runId, status: "error", reason: "update-failed" }),
    );
    expect(mocks.diagnose).not.toHaveBeenCalled();
    expect(reportBody).toContain(`Failed phase: ${phase}`);
    expect(reportBody).toContain("Reason code: update-failed");
    expect(reportBody).toContain("Rollback outcome:");
    expect(reportBody).not.toContain("not-recorded");
    expect(reportBody).not.toContain("not recorded");
  },
);

it.each(["lost-authority", "pending-publication", "completed-publication"] as const)(
  "preserves history and skips interactive triage for %s",
  async (condition) => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("update-unreported-pending-") };
    let recorded = createUpdateRun({ trigger: "cli" }, { env });
    const run = { runId: recorded.runId, env };
    const onResult = vi.fn();
    if (condition === "pending-publication") {
      await fs.mkdir(path.join(resolveOpenClawStateSqliteDir(env), ".openclaw-restore-fixture"));
    }
    const failure =
      condition === "lost-authority"
        ? new UpdateCommandRecoveryPendingError("Update executor release could not be confirmed.")
        : new Error("Update publication failed");
    await expect(
      withUpdateFailureTriage({ run }, { env }, () =>
        withUpdateCommandTerminalResult(
          async (registerRun) => {
            registerRun(run);
            if (condition !== "pending-publication") {
              deferUpdateCommandTerminalResult(run, async () => {
                if (condition === "completed-publication") {
                  recorded = finishUpdateRun(run.runId, { status: "succeeded" }, { env });
                }
                throw new Error("Update publication failed");
              });
            }
            if (condition === "completed-publication") {
              return;
            }
            throw failure;
          },
          { onResult },
        ),
      ),
    ).rejects.toMatchObject({ code: 1 });
    expect(getUpdateRun(run.runId, { env })).toEqual(recorded);
    expect(onResult).not.toHaveBeenCalled();
    expect(mocks.action).not.toHaveBeenCalled();
    expect(mocks.diagnose).not.toHaveBeenCalled();
  },
);
