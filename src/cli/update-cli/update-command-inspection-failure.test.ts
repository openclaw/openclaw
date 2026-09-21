import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createRetainedUpdateRecovery } from "../../infra/update-retained-recovery.test-support.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import * as admission from "../../infra/update-run-recovery-admission.js";
import { loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withUpdateCommandTerminalResult } from "./update-command-terminal.js";
import { withUpdateCommandRecoveryUnwind } from "./update-command-unwind.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

it.each(["recovered", "unreadable", "retained", "settlement-failed"] as const)(
  "retains the original pre-staging inspection failure when fresh admission is %s",
  async (outcome) => {
    const root = dirs.make("update-inspection-failure-");
    const env = {
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    };
    const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    const original = new Error(
      "SQLite read-only worker SQLite source did not stabilize for read-only inspection",
    );
    const from = { root, nodePath: process.execPath, version: "1.0.0", buildId: null };
    const retained =
      outcome === "retained"
        ? createRetainedUpdateRecovery(
            { runId: run.runId, from, to: { ...from, version: "2.0.0" } },
            { env },
          )
        : undefined;
    const inspect = vi.spyOn(admission, "assertUpdateRecoveryAdmission");
    if (outcome === "unreadable") {
      inspect.mockRejectedValue(
        Object.assign(new Error("database disk image is malformed"), { errcode: 11 }),
      );
    }
    // The same snapshot failure occurs again during unwind. A later read must
    // prove admission before terminal publication can touch the real ledger.
    inspect.mockRejectedValueOnce(original);
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    let failure: unknown;
    await withUpdateCommandTerminalResult(
      (registerRun) => {
        registerRun(run);
        return withUpdateCommandRecoveryUnwind(
          { json: true, run },
          { triageTarget: { root, env } },
          async () => {
            throw original;
          },
        ).catch((error: unknown) => {
          if (outcome === "settlement-failed") {
            throw new AggregateError([error], "Update executor cleanup failed", { cause: error });
          }
          throw error;
        });
      },
      { json: true },
    ).catch((error: unknown) => {
      failure = error;
    });

    const reported =
      outcome === "settlement-failed" && failure instanceof AggregateError
        ? failure.cause
        : failure;
    expect(reported).toMatchObject({
      result: {
        status: "error",
        steps: [
          expect.objectContaining({
            failureFacts: [expect.objectContaining({ message: original.message })],
          }),
        ],
      },
    });
    const recorded = getUpdateRun(run.runId, { env });
    if (outcome === "recovered") {
      expect(recorded).toMatchObject({
        status: "failed",
        reason: "update-failed",
        origin: { nextAction: expect.stringContaining("openclaw triage") },
        steps: expect.arrayContaining([
          expect.objectContaining({
            step: "requested",
            status: "failed",
            failureFacts: [expect.objectContaining({ message: original.message })],
          }),
        ]),
      });
      expect(recorded?.origin.nextAction).toContain("Retry the same update command");
      expect(output).toHaveBeenCalledOnce();
      expect(output.mock.calls[0]?.[0]).toMatchObject({ status: "error", runId: run.runId });
    } else {
      expect(recorded?.status).toBe("running");
      expect(output).not.toHaveBeenCalled();
      if (retained) {
        expect(loadUpdateRecovery(run.runId, { env })).toEqual(retained);
      }
    }
  },
);
