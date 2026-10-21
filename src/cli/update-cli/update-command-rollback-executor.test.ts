import { lstatSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createConfigIO } from "../../config/config.js";
import { createRetainedPackageSwap } from "../../infra/package-update-swap.test-support.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import { materializeUpdateCandidateStateWorker as writeCandidateWorker } from "../../infra/update-candidate-state.test-support.js";
import { createRetainedUpdateRecovery } from "../../infra/update-retained-recovery.test-support.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { snapshotUpdateFixtureTree } from "./update-command-filesystem-snapshot.test-support.js";
import { resultFixture } from "./update-command-fixtures.test-support.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import * as service from "./update-command-service.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});
async function readPreviousConfig(env: NodeJS.ProcessEnv) {
  return createConfigIO({ env, pluginValidation: "skip" }).readConfigFileSnapshot();
}

async function rollbackFixture(root: string) {
  const env = { OPENCLAW_STATE_DIR: dirs.make("rollback-executor-state-") };
  const configSnapshot = await readPreviousConfig(env);
  const authority = { live: true };
  const run = {
    runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
    env,
    executorFence: {
      assertCurrent() {
        if (!authority.live) {
          throw new Error("original executor lost");
        }
      },
    },
  };
  const schemaVersions = await readUpdateStateSchemaVersions({
    stateDir: env.OPENCLAW_STATE_DIR,
    config: configSnapshot.sourceConfigBeforeMigrations ?? configSnapshot.sourceConfig,
    env,
  });
  return {
    env,
    run,
    authority,
    params: {
      definitionRecovery: {},
      result: resultFixture(root, { status: "error", reason: "readyz-unhealthy", durationMs: 1 }),
      previousRoot: root,
      schemaVersions,
      configSnapshot,
      opts: { json: true, run },
      timeoutMs: 1000,
    },
  };
}
function observeStat(target: string, observed: () => void | Promise<void>, defaultOptions = false) {
  const lstat = fs.lstat.bind(fs);
  return vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    const result = await lstat(...args);
    if (String(args[0]) === target && (!defaultOptions || args[1] === undefined)) {
      await observed();
    }
    return result;
  });
}

describe("package rollback executor ownership", () => {
  it("checks the new history target after its admission environment changes", async () => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("rollback-first-target-") };
    const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    const pendingEnv = { OPENCLAW_STATE_DIR: dirs.make("rollback-pending-target-") };
    const pendingRun = createUpdateRun({ trigger: "cli" }, { env: pendingEnv });
    const root = dirs.make("rollback-target-package-");
    const runtime = { root, nodePath: process.execPath, version: "1.0.0", buildId: null };
    createRetainedUpdateRecovery(
      { runId: pendingRun.runId, from: runtime, to: runtime },
      { env: pendingEnv },
    );
    const configSnapshot = await readPreviousConfig(env);
    closeOpenClawStateDatabaseForTest();
    const files = [resolveOpenClawStateSqlitePath(env), resolveOpenClawStateSqlitePath(pendingEnv)];
    const before = await Promise.all(files.map((file) => fs.readFile(file)));
    let changed = false;
    observeStat(path.dirname(files[0]!), () => {
      changed = true;
      env.OPENCLAW_STATE_DIR = pendingEnv.OPENCLAW_STATE_DIR;
    });
    const result = await rollbackFailedUpdate({
      definitionRecovery: {},
      result: resultFixture(root, { status: "error" }),
      previousRoot: root,
      rollbackBlockedReason: "state-migrated-no-rollback",
      configSnapshot,
      opts: { run },
      timeoutMs: 1000,
    });
    expect(changed).toBe(true);
    expect(result).toMatchObject({
      rolledBack: false,
      pendingRecoveryReason: expect.stringContaining(pendingRun.runId),
    });
    expect(await Promise.all(files.map((file) => fs.readFile(file)))).toEqual(before);
  });

  it("preserves the real package and recovery material when its executor is lost during observation", async () => {
    const base = dirs.make("rollback-real-executor-");
    const { packageRoot, transaction } = await createRetainedPackageSwap(base);
    await writeCandidateWorker(packageRoot);
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      '{"name":"openclaw","version":"2.0.0","type":"module"}',
    );
    const { env, run, authority, params } = await rollbackFixture(packageRoot);
    const snapshot = () => snapshotUpdateFixtureTree(path.join(base, "live"), lstatSync);
    const before = snapshot();
    const history = getUpdateRun(run.runId, { env });
    const observed = createDeferred();
    const resume = createDeferred();
    observeStat(
      packageRoot,
      async () => {
        observed.resolve();
        await resume.promise;
      },
      true,
    );
    const restart = vi.spyOn(service, "maybeRestartService").mockResolvedValue("ok");
    const pending = rollbackFailedUpdate({
      ...params,
      packageTransaction: transaction,
    });
    try {
      await awaitGateBeforeSettlement(
        observed.promise,
        pending,
        "Rollback finished before the package observation",
      );
      authority.live = false;
      resume.resolve();
      const outcome = await pending;
      expect(outcome).toMatchObject({
        rolledBack: false,
        pendingRecoveryReason: "original executor lost",
        result: { recovery: { serviceRestartSafe: false } },
      });
      expect(snapshot()).toEqual(before);
      expect(getUpdateRun(run.runId, { env })).toEqual(history);
      expect(restart).not.toHaveBeenCalled();
      await expect(transaction.complete({ activationVerified: true }, () => {})).rejects.toThrow(
        "original executor lost",
      );
      expect(snapshot()).toEqual(before);
    } finally {
      resume.resolve();
      await pending;
    }
  });

  it.each(["preflight", "package swap", "missing worker"] as const)(
    "fences rollback at %s without stale-root reporting",
    async (boundary) => {
      const candidateRoot = dirs.make("rollback-source-only-candidate-");
      if (boundary !== "missing worker") {
        await writeCandidateWorker(candidateRoot);
        await fs.writeFile(path.join(candidateRoot, "package.json"), '{"type":"module"}');
      }
      const previousRoot = dirs.make("rollback-previous-");
      const { env, run, authority, params } = await rollbackFixture(candidateRoot);
      const before = getUpdateRun(run.runId, { env });
      expect(params.schemaVersions).toContainEqual({
        path: resolveOpenClawStateSqlitePath(env),
        userVersion: OPENCLAW_STATE_SCHEMA_VERSION,
        contentVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      const assertRollbackSafe = vi.fn(async () => {
        if (boundary === "preflight") {
          authority.live = false;
        }
      });
      const rollback = vi.fn(async () => {
        authority.live = false;
        return {
          name: "global install rollback",
          command: "restore",
          cwd: previousRoot,
          durationMs: 1,
          exitCode: 0,
          activePackageRoot: previousRoot,
        };
      });
      const outcome = await rollbackFailedUpdate({
        ...params,
        previousRoot,
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
        expect(authority.live).toBe(true);
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
    },
  );
});
