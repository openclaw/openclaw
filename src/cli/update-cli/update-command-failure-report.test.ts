import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { acquireFileLockSyncWithRetry } from "../../infra/file-lock-sync.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
} from "../../infra/update-run-ledger.js";
import { getUpdateRunStatusAsync } from "../../infra/update-run-reader.js";
import type { UpdateRunResult } from "../../infra/update-run-result.js";
import { updateGitCheckout } from "../../infra/update-runner-git.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { stepFixture } from "./update-command-fixtures.test-support.js";
import {
  UpdateCommandFailure,
  UpdateCommandPendingRecoveryFailure,
  createUpdateCommandFailureResult,
  failUpdateCommandRun,
} from "./update-command-result.js";
import { completeUpdateCommandRun } from "./update-command-run.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeStateDatabaseForTest);

function checkout() {
  const root = dirs.make("update-failure-report-");
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"openclaw","version":"2026.9.7"}');
  return { root, env: { OPENCLAW_STATE_DIR: path.join(root, "state") } };
}

function makeResult(overrides: Partial<UpdateRunResult>): UpdateRunResult {
  return { status: "error", mode: "git", steps: [], durationMs: 0, ...overrides };
}

function expectReason(body: string, reason: string, check = "update", code = reason) {
  expect(body).toContain(`Reason code: ${reason}`);
  expect(body).toContain(`Failing check ${check} (${code})`);
}

it.each(["invalid-dev-target", "unsupported-package-target", "fetch-failed"])(
  "preserves the existing %s refusal through normalization and public reporting",
  async (reason) => {
    const root = dirs.make("update-refusal-report-");
    const serialized = reason === "fetch-failed";
    const check = serialized ? "update" : reason;
    const facts = [{ check, code: reason }];
    const step = stepFixture(serialized ? "git-fetch" : reason, {
      cwd: root,
      ...(!serialized ? { failureFacts: facts } : {}),
    });
    const original = makeResult({
      mode: serialized ? "git" : "unknown",
      root,
      reason,
      steps: [step],
      ...(serialized ? { failedStep: structuredClone(step), durationMs: 1 } : {}),
    });
    const failure = new UpdateCommandFailure(original);
    const report = await prepareUpdateFailureReport(
      { attemptId: reason, result: failure.result },
      { env: { OPENCLAW_STATE_DIR: path.join(root, "state") } },
    );
    expectReason(report.body, reason, check);
  },
);

it.each([
  "pending-recovery",
  "pending-recovery-cause",
  "run-finish",
  "command-finish",
  "handoff-lock",
] as const)(
  "records a public failure reason when %s receives no runner diagnostics",
  async (boundary) => {
    const { root, env } = checkout();
    const run = {
      runId: createUpdateRun({ trigger: "cli", target: { kind: "git" } }, { env }).runId,
      env,
    };
    const successful = makeResult({ status: "ok", root, after: { version: "2026.9.7" } });
    const pending = new UpdateCommandPendingRecoveryFailure(
      successful,
      "private recovery detail",
      boundary === "pending-recovery-cause"
        ? { cause: new TypeError(path.join(root, "private-recovery-detail")) }
        : undefined,
    );
    const recoveryPending = boundary.startsWith("pending-recovery");
    let outcome = recoveryPending
      ? pending.result
      : boundary === "command-finish"
        ? completeUpdateCommandRun({ ...successful, status: "error", reason: "" }, run)
        : { ...successful, status: "error" as const };
    const reason =
      boundary === "handoff-lock"
        ? "file_lock_timeout"
        : recoveryPending
          ? "update-recovery-pending"
          : "update-failed";
    if (boundary === "handoff-lock") {
      const databasePath = path.join(root, "managed-update-handoffs.sqlite");
      fs.writeFileSync(
        databasePath + ".lock",
        JSON.stringify({ pid: process.ppid, phase: "doctor" }),
      );
      recordUpdateRunPhase(run.runId, "validating", undefined, { env });
      let failure: unknown;
      try {
        acquireFileLockSyncWithRetry(databasePath, {
          timeoutMs: 20,
          phase: "managed-handoff:writer-admission",
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const fact = failUpdateCommandRun(failure, run);
      outcome = completeUpdateCommandRun(
        createUpdateCommandFailureResult({
          mode: "unknown",
          durationMs: 0,
          failure: { cause: failure },
          phase: fact?.check,
        }),
        run,
      );
      expect((await getUpdateRunStatusAsync({ env })).lastRun).toMatchObject({
        status: "failed",
        reason: "file_lock_timeout",
        steps: expect.arrayContaining([
          expect.objectContaining({
            step: "validating",
            failureFacts: [expect.objectContaining({ code: "file_lock_timeout" })],
          }),
        ]),
      });
    }
    if (boundary === "run-finish") {
      finishUpdateRun(run.runId, { status: "failed", after: outcome.after }, { env });
    }
    const recorded = getUpdateRun(run.runId, { env });
    const report = await prepareUpdateFailureReport(
      { attemptId: run.runId, result: outcome, recordedRun: recorded },
      { env },
    );
    expectReason(
      report.body,
      reason,
      boundary === "handoff-lock" ? "validating" : "update",
      boundary === "pending-recovery-cause" ? "TypeError" : reason,
    );
    for (const privateText of ["[redacted-code]", "private recovery detail", root]) {
      expect(report.body).not.toContain(privateText);
    }
  },
);

it.each([
  { channel: "extended-stable", reason: "unsupported_git_channel" },
  { channel: "dev", reason: "git-root-unresolved" },
] as const)("reports $reason without relying on command output", async ({ channel, reason }) => {
  const { root, env } = checkout();
  execFileSync("git", ["init", "--quiet", root]);
  const result = completeUpdateCommandRun(
    await updateGitCheckout({
      gitRoot: root,
      runCommand: runCommandWithTimeout,
      defaultCommandEnv: env,
      timeoutMs: 5000,
      startedAt: Date.now(),
      opts: {
        channel,
        inspectGitTarget: async () => {},
        validateCandidate: async () => {},
        beforeGitMutation: async () => {
          throw new Error("Failed admission must not mutate the checkout");
        },
        runGitDoctor: async () => {
          throw new Error("Failed admission must not run Doctor");
        },
      },
    }),
    undefined,
  );
  const report = await prepareUpdateFailureReport({ attemptId: reason, result }, { env });
  expect(result).toMatchObject({ status: "error", reason });
  expectReason(report.body, reason);
});
