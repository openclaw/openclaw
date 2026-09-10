import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createConfigIO } from "../../config/config.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
async function readPreviousConfig(env: NodeJS.ProcessEnv) {
  return createConfigIO({ env, pluginValidation: "skip" }).readConfigFileSnapshot();
}

describe("package rollback executor ownership", () => {
  it.each([
    {
      boundary: "preflight",
      name: "loses executor during preflight without restart or stale-root reporting",
    },
    {
      boundary: "package swap",
      name: "loses executor during package swap without restart or stale-root reporting",
    },
    {
      boundary: "missing worker",
      name: "refuses rollback before preflight when the active runtime cannot inspect state",
    },
  ] as const)("$name", async ({ boundary }) => {
    const candidateRoot = dirs.make("rollback-source-only-candidate-");
    if (boundary !== "missing worker") {
      const worker = path.join(candidateRoot, "dist/infra/update-candidate-state.worker.js");
      await fs.mkdir(path.dirname(worker), { recursive: true });
      await fs.writeFile(path.join(candidateRoot, "package.json"), '{"type":"module"}');
      // Exercise the real child reader from this source generation, without
      // assuming an unrelated package build exists in the checkout's dist.
      await fs.writeFile(
        worker,
        `
          import { tsImport } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))};
          await tsImport(${JSON.stringify(new URL("../../infra/update-candidate-state.worker.ts", import.meta.url).href)}, {
            parentURL: import.meta.url,
            tsconfig: ${JSON.stringify(path.resolve("tsconfig.json"))},
          });
        `,
      );
    }
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
    expect(schemaVersions).toContainEqual({
      path: resolveOpenClawStateSqlitePath(env),
      userVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      contentVersion: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    const assertRollbackSafe = vi.fn(async () => {
      if (boundary === "preflight") {
        live = false;
      }
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
        assertRollbackSafe,
      },
    });
    if (boundary === "missing worker") {
      expect(outcome).toMatchObject({
        rolledBack: false,
        result: { status: "error", reason: "rollback-state-unverified", root: candidateRoot },
      });
      expect(assertRollbackSafe).not.toHaveBeenCalled();
      expect(rollback).not.toHaveBeenCalled();
      expect(live).toBe(true);
      expect(getUpdateRun(run.runId, { env })).toMatchObject({
        status: before?.status,
        steps: expect.arrayContaining([
          expect.objectContaining({
            step: "package rollback",
            status: "failed",
            detail: expect.stringContaining("State schema inspection failed"),
          }),
        ]),
      });
      return;
    }
    expect(assertRollbackSafe).toHaveBeenCalledOnce();
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
  });
});
