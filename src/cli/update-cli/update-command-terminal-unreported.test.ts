import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
} from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqliteDir } from "../../state/openclaw-state-db.paths.js";
import { expectMessages, expectNoCalls } from "./update-boundary.test-support.js";
import { reportUnreportedUpdateAdmissionOutcome } from "./update-command-admission-report.js";
import { snapshotUpdateFixtureTree } from "./update-command-filesystem-snapshot.test-support.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import {
  UnreportedUpdateAdmissionOutcome,
  UpdateCommandFailure,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";
import {
  deferUpdateCommandTerminalResult,
  withUpdateCommandTerminalResult,
} from "./update-command-terminal.js";
import { publishUpdateCommandTerminalResultForTest as publishUpdateCommandTerminalResult } from "./update-command-terminal.test-support.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";

const mocks = vi.hoisted(() => ({
  action: vi.fn<typeof import("./update-command-report.js").runInteractiveUpdateFailureAction>(),
  diagnose: vi.fn(),
  repair: vi.fn(),
}));
vi.mock("../../commands/triage-failure.js", () => ({ triageAfterFailure: mocks.repair }));
// mock-isolation: Keep interactive failure actions inside the terminal fixture.
vi.mock("./update-command-report.js", () => ({ runInteractiveUpdateFailureAction: mocks.action }));
vi.mock("../terminal-interactivity.js", () => ({ isTerminalInteractive: () => true }));
vi.mock("../../infra/update-triage.js", () => ({
  prepareUpdateFailureTriage: async () => mocks.diagnose,
}));

import { resultFixture, stepFixture } from "./update-command-fixtures.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
function createRun(target?: Parameters<typeof createUpdateRun>[0]["target"]) {
  const env = { OPENCLAW_STATE_DIR: dirs.make("update-terminal-") };
  const options = { env };
  const recorded = createUpdateRun({ trigger: "cli", target }, options);
  const run = { runId: recorded.runId, env };
  const onResult = vi.fn();
  const read = () => getUpdateRun(run.runId, options);
  const terminal = (
    operation: () => Promise<void>,
    opts: Parameters<typeof withUpdateCommandTerminalResult>[1] = {},
  ) =>
    withUpdateFailureTriage({ run, json: opts?.json }, { env }, () =>
      withUpdateCommandTerminalResult(
        async (registerRun) => {
          registerRun(run);
          await operation();
        },
        { onResult, ...opts },
      ),
    );
  const fails = (
    operation: () => Promise<void>,
    opts: Parameters<typeof terminal>[1] = {},
    code = 1,
  ) => expect(terminal(operation, opts)).rejects.toMatchObject({ code });
  return { env, options, recorded, run, read, terminal, fails, onResult };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

it.each([
  { status: "skipped", capturedBefore: false },
  { status: "error", capturedBefore: true },
] as const)(
  "does not borrow a nested Run for a detached $status refusal (captured before: $capturedBefore)",
  async ({ status, capturedBefore }) => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("update-detached-admission-") };
    const recorded = createUpdateRun({ trigger: "cli" }, { env });
    const run = { runId: recorded.runId, env };
    closeOpenClawStateDatabaseForTest();
    const before = snapshotUpdateFixtureTree(env.OPENCLAW_STATE_DIR);
    const detachedRoot = dirs.make("update-detached-report-");
    vi.spyOn(os, "tmpdir").mockReturnValue(detachedRoot);
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const refusal = new UnreportedUpdateAdmissionOutcome(
      {
        root: env.OPENCLAW_STATE_DIR,
        ...(capturedBefore ? { before: { version: null } } : {}),
        installKind: "package",
        reason: "fixture-admission-refused",
        message: "captured refusal after the original owner settled",
        opts: { json: true, run },
        controlPlaneUpdateSentinelMeta: { runId: run.runId, note: "must remain unpublished" },
      },
      status === "skipped" ? { exitCode: 0 } : undefined,
    );

    await expect(
      reportUnreportedUpdateAdmissionOutcome(refusal, { detached: true }),
    ).rejects.toMatchObject({ code: status === "skipped" ? 0 : 1 });

    expect(output).toHaveBeenCalledOnce();
    const result = output.mock.calls[0]?.[0] as {
      status: string;
      reason: string;
      reportPath?: string;
      before?: unknown;
      runId?: string;
    };
    expect(result).toMatchObject({ status, reason: "fixture-admission-refused" });
    if (status === "error") {
      expect(result).toMatchObject({
        failedStep: {
          failureFacts: expect.arrayContaining([
            expect.objectContaining({ code: "fixture-admission-refused" }),
            { check: "update", code: "update-failed" },
          ]),
        },
      });
    }
    expect(result.runId).toBeUndefined();
    expect(result.before).toEqual(capturedBefore ? { version: null } : undefined);
    assert(
      typeof result.reportPath === "string" &&
        result.reportPath.startsWith(detachedRoot + path.sep),
    );
    expect(await fs.readFile(result.reportPath, "utf8")).toContain("fixture-admission-refused");
    expect(snapshotUpdateFixtureTree(env.OPENCLAW_STATE_DIR)).toEqual(before);
    expect(getUpdateRun(run.runId, { env })).toEqual(recorded);
  },
);

it.each(["new-error", "pending-aggregate"] as const)(
  "preserves primary failure after %s publication",
  async (publication) => {
    const { recorded, run, read, fails } = createRun();
    const result = resultFixture(undefined, {
      status: "error",
      reason: "global-install-failed",
      steps: [
        stepFixture("global install", {
          failureFacts: [{ check: "npm", code: "EACCES", message: "Permission denied" }],
        }),
      ],
    });
    const primary = new UpdateCommandFailure(result, 1, "Package installation failed");
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
    await fails(
      async () => {
        deferUpdateCommandTerminalResult(run, publish);
        throw publication === "pending-aggregate" ? settlementFailure : primary;
      },
      { json, onResult: undefined },
    );
    expect(publish).toHaveBeenCalledOnce();
    if (json) {
      expect(output).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(result));
    } else {
      expect(output).not.toHaveBeenCalled();
      expectMessages(defaultRuntime.log, "EACCES", "Permission denied");
      expectMessages(
        defaultRuntime.error,
        "Update recovery remains pending (global-install-failed)",
      );
    }
    expect(read()).toEqual(recorded);
    expectNoCalls(mocks.action, mocks.diagnose, mocks.repair);
  },
);

it.each([false, true])("preserves outcome after observer throws (pending=%s)", async (pending) => {
  const { run, read, terminal, onResult } = createRun();
  onResult.mockImplementation(() => {
    throw new TypeError("Observer could not finish");
  });
  const result = resultFixture(undefined, { status: pending ? "error" : "ok" });
  const update = terminal(async () => {
    deferUpdateCommandTerminalResult(run, () =>
      publishUpdateCommandTerminalResult({ opts: { run } }, result, { rolledBack: false }),
    );
    if (pending) {
      throw new UpdateCommandPendingRecoveryFailure(result);
    }
  });
  if (pending) {
    await expect(update).rejects.toMatchObject({ code: 1 });
  } else {
    await expect(update).resolves.toBeUndefined();
  }
  expect(onResult).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ status: result.status }),
  );
  expect(read()).toMatchObject({ status: pending ? "failed" : "succeeded" });
  expectNoCalls(mocks.action, mocks.diagnose);
  expect(defaultRuntime.error).not.toHaveBeenCalledWith(
    expect.stringContaining("Update recovery remains pending"),
  );
  expectMessages(defaultRuntime.error, "Warning: Update result observer failed:");
});

it.each([
  { phase: "requested", publisher: false },
  { phase: "verifying", publisher: true },
] as const)(
  "records $phase exceptions before interactive reporting",
  async ({ phase, publisher }) => {
    const { options, run, fails, onResult } = createRun({
      kind: "package",
      installationMethod: "npm-global",
      version: "2026.9.6",
    });
    recordUpdateRunPhase(run.runId, phase, {}, options);
    const failure = new TypeError("Cannot complete update publication");
    let reportBody: string | undefined;
    mocks.action.mockImplementation(async ({ result, attemptId }) => {
      const recordedRun = getUpdateRun(attemptId, options);
      expect(recordedRun).toMatchObject({
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
        await prepareUpdateFailureReport({ attemptId, result: result!, recordedRun }, options)
      ).body;
      return "handled";
    });
    await fails(async () => {
      if (publisher) {
        deferUpdateCommandTerminalResult(run, async () => {
          throw failure;
        });
        return;
      }
      throw failure;
    });
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
    const fixture = createRun();
    const { env, run, read, fails, onResult } = fixture;
    let { recorded } = fixture;
    if (condition === "pending-publication") {
      await fs.mkdir(path.join(resolveOpenClawStateSqliteDir(env), ".openclaw-restore-fixture"));
    }
    const failure =
      condition === "lost-authority"
        ? new UpdateCommandRecoveryPendingError("Update executor release could not be confirmed.")
        : new Error("Update publication failed");
    await fails(
      async () => {
        if (condition !== "pending-publication") {
          deferUpdateCommandTerminalResult(run, async () => {
            if (condition === "completed-publication") {
              recorded = finishUpdateRun(run.runId, { status: "succeeded" }, { env });
            }
            throw new Error("Update publication failed");
          });
        }
        if (condition !== "completed-publication") {
          throw failure;
        }
      },
      {},
      condition === "completed-publication" ? 0 : 1,
    );
    expect(read()).toEqual(recorded);
    expectNoCalls(onResult, mocks.action, mocks.diagnose);
    if (condition === "completed-publication") {
      expectMessages(
        defaultRuntime.error,
        "Warning: Update succeeded, but result publication failed:",
      );
      expect(defaultRuntime.error).not.toHaveBeenCalledWith(
        expect.stringContaining("Update recovery remains pending"),
      );
    }
  },
);
