import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createConfigIO } from "../../config/config.js";
import { createRetainedPackageSwap } from "../../infra/package-update-swap.test-support.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import { createRetainedUpdateRecovery } from "../../infra/update-retained-recovery.test-support.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import * as service from "./update-command-service.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
async function readPreviousConfig(env: NodeJS.ProcessEnv) {
  return createConfigIO({ env, pluginValidation: "skip" }).readConfigFileSnapshot();
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
    const lstat = fs.lstat.bind(fs);
    const observation = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const result = await lstat(...args);
      if (String(args[0]) === path.dirname(files[0]!)) {
        changed = true;
        env.OPENCLAW_STATE_DIR = pendingEnv.OPENCLAW_STATE_DIR;
      }
      return result;
    });
    try {
      const result = await rollbackFailedUpdate({
        result: { status: "error", mode: "npm", root, steps: [], durationMs: 0 },
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
    } finally {
      observation.mockRestore();
    }
  });

  it("preserves the real package and recovery material when its executor is lost during observation", async () => {
    const base = dirs.make("rollback-real-executor-");
    const { packageRoot, transaction } = await createRetainedPackageSwap(base);
    const worker = path.join(packageRoot, "dist/infra/update-candidate-state.worker.js");
    await fs.mkdir(path.dirname(worker), { recursive: true });
    await fs.writeFile(
      worker,
      `
        const { tsImport } = await import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))});
        await tsImport(${JSON.stringify(new URL("../../infra/update-candidate-state.worker.ts", import.meta.url).href)}, {
          parentURL: import.meta.url,
          tsconfig: ${JSON.stringify(path.resolve("tsconfig.json"))},
        });
      `,
    );
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      '{"name":"openclaw","version":"2.0.0","type":"module"}',
    );
    const env = { OPENCLAW_STATE_DIR: dirs.make("rollback-real-state-") };
    const configSnapshot = await readPreviousConfig(env);
    const config = configSnapshot.sourceConfigBeforeMigrations ?? configSnapshot.sourceConfig;
    let current = true;
    const run = {
      runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
      env,
      executorFence: {
        assertCurrent() {
          if (!current) {
            throw new Error("original executor lost");
          }
        },
      },
    };
    const schemaVersions = await readUpdateStateSchemaVersions({
      stateDir: env.OPENCLAW_STATE_DIR,
      config,
      env,
    });
    const snapshot = async () => {
      const root = path.join(base, "live");
      const entries = (await fs.readdir(root, { recursive: true })).toSorted();
      return await Promise.all(
        entries.map(async (entry) => {
          const file = path.join(root, entry);
          const stat = await fs.lstat(file);
          return {
            entry,
            ino: stat.ino,
            mode: stat.mode,
            content: stat.isFile() ? await fs.readFile(file) : null,
          };
        }),
      );
    };
    const before = await snapshot();
    const history = getUpdateRun(run.runId, { env });
    const observed = createDeferred();
    const resume = createDeferred();
    const lstat = fs.lstat.bind(fs);
    const observation = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      if (String(args[0]) === packageRoot && args[1] === undefined) {
        observed.resolve();
        await resume.promise;
      }
      return stat;
    });
    const restart = vi.spyOn(service, "maybeRestartService").mockResolvedValue("ok");
    const pending = rollbackFailedUpdate({
      result: {
        status: "error",
        mode: "npm",
        root: packageRoot,
        reason: "readyz-unhealthy",
        steps: [],
        durationMs: 1,
      },
      previousRoot: packageRoot,
      schemaVersions,
      configSnapshot,
      opts: { json: true, run },
      timeoutMs: 1000,
      packageTransaction: transaction,
    });
    try {
      await Promise.race([
        observed.promise,
        pending.then(() => {
          throw new Error("Rollback finished before the package observation");
        }),
      ]);
      current = false;
      resume.resolve();
      const outcome = await pending;
      expect(outcome).toMatchObject({
        rolledBack: false,
        pendingRecoveryReason: "original executor lost",
        result: { recovery: { serviceRestartSafe: false } },
      });
      expect(await snapshot()).toEqual(before);
      expect(getUpdateRun(run.runId, { env })).toEqual(history);
      expect(restart).not.toHaveBeenCalled();
      await expect(transaction.complete({ activationVerified: true }, () => {})).rejects.toThrow(
        "original executor lost",
      );
      expect(await snapshot()).toEqual(before);
    } finally {
      resume.resolve();
      await pending;
      observation.mockRestore();
      restart.mockRestore();
    }
  });

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
