import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-run-result.js";
import { updateGitCheckout } from "../../infra/update-runner-git.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  UpdateCommandFailure,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";
import { completeUpdateCommandRun } from "./update-command-run.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeStateDatabaseForTest);

it.each(["invalid-dev-target", "unsupported-package-target"])(
  "preserves the existing %s refusal through normalization and public reporting",
  async (reason) => {
    const root = dirs.make("update-refusal-report-");
    const result: UpdateRunResult = {
      status: "error",
      mode: "unknown",
      root,
      reason,
      steps: [
        {
          name: reason,
          command: "openclaw update",
          cwd: root,
          durationMs: 0,
          exitCode: 1,
          failureFacts: [{ check: reason, code: reason }],
        },
      ],
      durationMs: 0,
    };
    const failure = new UpdateCommandFailure(result);
    expect(failure.result).toEqual(result);
    const report = await prepareUpdateFailureReport(
      { attemptId: reason, result: failure.result },
      { env: { OPENCLAW_STATE_DIR: path.join(root, "state") } },
    );
    expect(report.body).toContain(`Reason code: ${reason}`);
    expect(report.body).toContain(`Failing check ${reason} (${reason})`);
  },
);

it("keeps one failed step after the candidate result crosses a serialized boundary", () => {
  const step = {
    name: "git-fetch",
    command: "git fetch",
    cwd: "/fixture",
    durationMs: 1,
    exitCode: 1,
  };
  const failure = new UpdateCommandFailure({
    status: "error",
    mode: "git",
    reason: "fetch-failed",
    durationMs: 1,
    steps: [step],
    failedStep: structuredClone(step),
  });
  expect(failure.result.steps).toHaveLength(1);
  expect(failure.result.steps[0]?.failureFacts).toEqual([
    { check: "update", code: "fetch-failed" },
  ]);
});

it.each(["pending-recovery", "pending-recovery-cause", "run-finish", "command-finish"] as const)(
  "records a public failure reason when %s receives no runner diagnostics",
  async (boundary) => {
    const directory = dirs.make("update-failure-report-");
    const root = path.join(directory, "checkout");
    fs.mkdirSync(root);
    execFileSync("git", ["init", "--quiet", root]);
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"openclaw","version":"2026.9.7"}');
    const env = { OPENCLAW_STATE_DIR: path.join(directory, "state") };
    const run = {
      runId: createUpdateRun({ trigger: "cli", target: { kind: "git" } }, { env }).runId,
      env,
    };
    const successful: UpdateRunResult = {
      status: "ok",
      mode: "git",
      root,
      after: { version: "2026.9.7" },
      steps: [],
      durationMs: 0,
    };
    // Recovery can refuse after core work succeeded; a released driver may also
    // finish without runner diagnostics. Both are accepted production boundaries.
    const pending = new UpdateCommandPendingRecoveryFailure(
      successful,
      "private recovery detail",
      boundary === "pending-recovery-cause"
        ? { cause: new TypeError(path.join(root, "private-recovery-detail")) }
        : undefined,
    );
    const recoveryPending = boundary.startsWith("pending-recovery");
    const result = recoveryPending
      ? pending.result
      : boundary === "command-finish"
        ? completeUpdateCommandRun({ ...successful, status: "error", reason: "" }, run)
        : { ...successful, status: "error" as const };
    const reason = recoveryPending ? "update-recovery-pending" : "update-failed";
    if (boundary === "run-finish") {
      finishUpdateRun(run.runId, { status: "failed", after: result.after }, { env });
    }
    const recorded = getUpdateRun(run.runId, { env });
    const report = await prepareUpdateFailureReport(
      { attemptId: run.runId, result, recordedRun: recorded },
      { env },
    );
    expect(report.body).toContain(`Reason code: ${reason}`);
    expect(report.body).toContain(
      `Failing check update (${boundary === "pending-recovery-cause" ? "TypeError" : reason})`,
    );
    if (!recoveryPending) {
      expect(
        recorded?.steps.some((step) => step.failureFacts?.some((fact) => fact.code === reason)),
      ).toBe(true);
      finishUpdateRun(run.runId, { status: "succeeded" }, { env });
      expect(getUpdateRun(run.runId, { env })).toEqual(recorded);
    }
    expect(report.body).not.toContain("[redacted-code]");
    expect(report.body).not.toContain("private recovery detail");
    expect(report.body).not.toContain(root);
  },
);

it.each([
  { channel: "extended-stable", reason: "unsupported_git_channel" },
  { channel: "dev", reason: "git-root-unresolved" },
] as const)("reports $reason without relying on command output", async ({ channel, reason }) => {
  const root = dirs.make("update-git-failure-");
  execFileSync("git", ["init", "--quiet", root]);
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"openclaw","version":"2026.9.7"}');
  const env = { OPENCLAW_STATE_DIR: path.join(root, "state") };
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
  expect(report.body).toContain(`Reason code: ${reason}`);
  expect(report.body).toContain(`Failing check update (${reason})`);
});
