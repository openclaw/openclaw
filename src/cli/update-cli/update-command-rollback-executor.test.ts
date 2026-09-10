import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createConfigIO } from "../../config/config.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
async function readPreviousConfig(env: NodeJS.ProcessEnv) {
  return createConfigIO({ env, pluginValidation: "skip" }).readConfigFileSnapshot();
}

describe("package rollback executor ownership", () => {
  it.each(["preflight", "package swap"] as const)(
    "loses executor during %s without restart or stale-root reporting",
    async (boundary) => {
      const candidateRoot = process.cwd();
      const previousRoot = dirs.make("rollback-previous-");
      const env = { OPENCLAW_STATE_DIR: dirs.make("rollback-executor-loss-") };
      const configSnapshot = await readPreviousConfig(env);
      const config = configSnapshot.sourceConfigBeforeMigrations ?? configSnapshot.sourceConfig;
      let live = true;
      const run = {
        runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
        env,
        executorFence: {
          assertCurrent() {
            if (!live) {
              throw new Error("original executor lost");
            }
          },
        },
      };
      const before = getUpdateRun(run.runId, { env });
      const schemaVersions = await readUpdateStateSchemaVersions({
        stateDir: env.OPENCLAW_STATE_DIR,
        config,
        env,
      });
      const rollback = vi.fn(async () => {
        live = false;
        return {
          name: "global install rollback",
          activePackageRoot: previousRoot,
          command: "restore",
          cwd: previousRoot,
          durationMs: 1,
          exitCode: 0,
        };
      });
      const outcome = await rollbackFailedUpdate({
        result: {
          status: "error",
          mode: "npm",
          root: candidateRoot,
          reason: "readyz-unhealthy",
          steps: [],
          durationMs: 1,
        },
        previousRoot,
        schemaVersions,
        configSnapshot,
        opts: { json: true, run },
        timeoutMs: 1000,
        packageTransaction: {
          backupRoot: "/backup",
          rollback,
          complete: vi.fn(),
          assertRollbackSafe: async () => {
            if (boundary === "preflight") {
              live = false;
            }
          },
        },
      });
      expect(outcome).toMatchObject({
        rolledBack: false,
        pendingRecoveryReason: "original executor lost",
        result: {
          status: "error",
          reason: "readyz-unhealthy",
          root: boundary === "package swap" ? previousRoot : candidateRoot,
          recovery: { serviceRestartSafe: false },
        },
      });
      expect(rollback).toHaveBeenCalledTimes(boundary === "package swap" ? 1 : 0);
      expect(getUpdateRun(run.runId, { env })).toEqual(before);
    },
  );
});
