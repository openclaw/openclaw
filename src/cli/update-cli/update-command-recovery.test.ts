import fsSync, { lstatSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createTestConfigSnapshot } from "../../commands/test-runtime-config-helpers.js";
import { createConfigIO } from "../../config/config.js";
import { createRetainedPackageSwap } from "../../infra/package-update-swap.test-support.js";
import * as snapshots from "../../infra/sqlite-snapshot-source.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import { materializeUpdateCandidateStateWorker as writeCandidateWorker } from "../../infra/update-candidate-state.test-support.js";
import { createRetainedCheckpointFixture } from "../../infra/update-retained-checkpoint.test-support.js";
import {
  createRetainedUpdateRecovery,
  storeRetainedUpdateRecovery,
  retainedReadinessRecord,
  retainedTerminalRecord,
} from "../../infra/update-retained-recovery.test-support.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { legacyRecord } from "../../infra/update-run-recovery-legacy.test-support.js";
import {
  inspectUpdateRecoveries,
  loadUpdateRecovery,
  UpdateRecoveryRequiredError,
} from "../../infra/update-run-recovery.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { UpdateCommandOptions } from "./shared.js";
import { cleanupUpdateCommandTest } from "./update-command-cleanup.test-support.js";
import { snapshotUpdateFixtureTree } from "./update-command-filesystem-snapshot.test-support.js";
import { resultFixture } from "./update-command-fixtures.test-support.js";
import { finishParams } from "./update-command-maintenance-fixtures.test-support.js";
import { continueMigratedUpdateInFreshProcess } from "./update-command-migrated.js";
import { assertUpdateCommandPackageFinalization } from "./update-command-recovery.js";
import { UpdateCommandPendingRecoveryFailure } from "./update-command-result.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import { completeUpdateCommandRun } from "./update-command-run.js";
import * as service from "./update-command-service.js";
import { resolveSettledUpdateCommandResult } from "./update-command-terminal.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(cleanupUpdateCommandTest);

describe("package finalization recovery targets", () => {
  function target() {
    const root = dirs.make("finalization-recovery-target-");
    const env = { OPENCLAW_STATE_DIR: root };
    const run: NonNullable<UpdateCommandOptions["run"]> = {
      runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
      env,
    };
    const params: Parameters<typeof assertUpdateCommandPackageFinalization>[0] & {
      root: string;
    } = { root, opts: { run }, result: resultFixture(undefined) };
    return { run, params, databasePath: resolveOpenClawStateSqlitePath(env) };
  }

  it.each(
    ["entry", "settlement"].flatMap((phase) =>
      ["same-target", "distinct-target", "retargeted"].map((kind) => ({ phase, kind })),
    ),
  )("inspects each selected recovery target once at $phase ($kind)", async ({ phase, kind }) => {
    const first = target();
    const other = kind === "same-target" ? undefined : target();
    if (kind === "same-target") {
      first.params.ownedManagedUpdateEnv = {
        ...first.run.env,
        OPENCLAW_STATE_DIR: first.params.root + path.sep + ".",
      };
    } else if (kind === "distinct-target") {
      first.params.ownedManagedUpdateEnv = other!.run.env;
    }
    closeOpenClawStateDatabaseForTest();
    const prepare = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync");
    if (kind === "retargeted") {
      observeStat(path.dirname(first.databasePath), () => {
        first.run.env.OPENCLAW_STATE_DIR = other!.params.root;
      });
    }
    if (phase === "entry") {
      await expect(assertUpdateCommandPackageFinalization(first.params)).resolves.toBeUndefined();
    } else {
      await expect(
        resolveSettledUpdateCommandResult(first.params, first.params.result),
      ).resolves.toEqual({ result: first.params.result, settlementFailed: false });
    }
    const recoveryPaths =
      kind === "distinct-target"
        ? [other!.databasePath, first.databasePath]
        : kind === "retargeted"
          ? [first.databasePath, other!.databasePath]
          : [first.databasePath];
    expect(prepare.mock.calls.map(([pathname]) => pathname)).toEqual([
      ...recoveryPaths,
      // Settlement still needs its independent terminal-history read.
      ...(phase === "settlement" ? [resolveOpenClawStateSqlitePath(first.run.env)] : []),
    ]);
  });

  it.each(["first-read", "distinct-read"] as const)(
    "retains the original executor after recovery admission (%s)",
    async (boundary) => {
      const first = target();
      const other = boundary === "distinct-read" ? target() : undefined;
      if (other) {
        first.params.ownedManagedUpdateEnv = other.run.env;
      }
      let current = true;
      first.run.executorFence = {
        assertCurrent() {
          if (!current) {
            throw new Error("original finalizer authority lost");
          }
        },
      };
      closeOpenClawStateDatabaseForTest();
      observeStat(path.dirname(first.databasePath), () => {
        current = false;
      });
      await expect(assertUpdateCommandPackageFinalization(first.params)).rejects.toMatchObject({
        name: "UpdateCommandPendingRecoveryFailure",
        cause: { message: "original finalizer authority lost" },
      });
    },
  );
});

function fixture(rollback = false) {
  const root = dirs.make("terminal-consumer-");
  const env = { HOME: root, OPENCLAW_STATE_DIR: root };
  const options = { env };
  const live = path.join(root, "node_modules", "openclaw");
  const run = createUpdateRun({ trigger: "cli" }, options);
  const from = { root: live, nodePath: process.execPath, version: "1.0.0", buildId: null };
  const to = { ...from, version: "2.0.0" };
  let record = createRetainedUpdateRecovery({ runId: run.runId, from, to }, options);
  record = retainedReadinessRecord(record, rollback ? "previous" : "candidate");
  if (rollback) {
    record.primaryFailure = { code: "candidate-failed", effectId: null };
  }
  storeRetainedUpdateRecovery(record, options);
  return { options, run: { runId: run.runId, env }, live, record };
}

it("preserves the initiating failure when retained recovery prevents terminal settlement", async () => {
  const f = fixture();
  const result = resultFixture(f.live, { status: "error", reason: "restart-unhealthy" });
  const refusal = new UpdateRecoveryRequiredError(f.record);
  const pending = new UpdateCommandPendingRecoveryFailure(result, refusal.message, {
    cause: refusal,
  });
  const prepare = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync");
  await expect(
    resolveSettledUpdateCommandResult({ opts: { run: f.run }, root: f.live }, result, pending),
  ).rejects.toBe(pending);
  expect(prepare).not.toHaveBeenCalled();
});

it("refuses to serialize live authority into a legacy migrated worker", async () => {
  const f = await checkpointRollbackFixture();
  await expect(
    continueMigratedUpdateInFreshProcess(
      finishParams({
        opts: f.opts,
        root: f.root,
        result: resultFixture(f.root),
        configSnapshot: createTestConfigSnapshot({}, {}, f.configPath),
        storedChannel: null,
        updateStepTimeoutMs: 1000,
      }),
      [],
    ),
  ).rejects.toMatchObject({ name: "UpdateCommandRecoveryPendingError" });
  closeOpenClawStateDatabaseForTest();
  expect(loadUpdateRecovery(f.run.runId, f.options)?.terminal).toBeUndefined();
});

describe("historical terminal completion diagnostics", () => {
  async function historical(rollback: boolean, terminal = true) {
    const f = fixture(rollback);
    if (terminal) {
      f.record = retainedTerminalRecord(f.record, rollback);
      finishUpdateRun(
        f.run.runId,
        {
          status: rollback ? "rolled-back" : "succeeded",
          ...(rollback ? { reason: "candidate-failed" } : {}),
        },
        f.options,
      );
    }
    const saved = JSON.stringify(legacyRecord(f.record), null, 2);
    const source = openOpenClawStateDatabase(f.options);
    source.db
      .prepare("UPDATE config_machine_state SET value_json=? WHERE state_key=?")
      .run(saved, "update.recovery." + f.run.runId);
    closeOpenClawStateDatabaseForTest();
    const { dir: directory, base: basename } = path.parse(source.path);
    const family = async () =>
      Promise.all(
        (await fs.readdir(directory))
          .filter((name) => name === basename || name.startsWith(basename + "-"))
          .toSorted()
          .map(async (name) => {
            const file = path.join(directory, name);
            const { ino, size, mtimeMs, ctimeMs } = await fs.stat(file);
            return { name, bytes: await fs.readFile(file), ino, size, mtimeMs, ctimeMs };
          }),
      );
    const expectUnchanged = async (before: Awaited<ReturnType<typeof family>>) => {
      const metadata = (await family()).map(({ bytes, ...fields }, index) => {
        expect(bytes.equals(before[index]!.bytes), fields.name).toBe(true);
        return fields;
      });
      expect(metadata).toEqual(before.map(({ bytes: _bytes, ...fields }) => fields));
    };
    return { ...f, family, saved, expectUnchanged };
  }

  it.each(["succeeded", "rolled-back", "running"] as const)(
    "reports historical %s without rewriting legacy artifacts",
    async (outcome) => {
      const rollback = outcome === "rolled-back";
      const terminal = outcome !== "running";
      const f = await historical(rollback, terminal);
      const before = await f.family();
      const result = completeUpdateCommandRun(
        resultFixture(f.live, {
          status: terminal && !rollback ? "error" : "ok",
          ...(terminal ? { reason: "stale-process-result" } : {}),
          durationMs: 1,
        }),
        f.run,
      );
      expect(result).toMatchObject({
        status: outcome === "succeeded" ? "ok" : "error",
        reason: rollback ? "candidate-failed" : terminal ? undefined : "update-recovery-pending",
        runId: f.run.runId,
      });
      await f.expectUnchanged(before);
      if (!terminal) {
        expect(getUpdateRun(f.run.runId, f.options)?.status).toBe("running");
      }
    },
  );

  it("keeps pending legacy history separate from fallback completion", async () => {
    const f = await historical(false, false);
    const other = createUpdateRun({ trigger: "cli" }, f.options);
    closeOpenClawStateDatabaseForTest();
    const before = await f.family();
    const result = completeUpdateCommandRun(resultFixture(undefined, { durationMs: 1 }), {
      runId: other.runId,
      env: f.run.env,
    });
    expect(result).toMatchObject({ status: "error", reason: "update-recovery-pending" });
    await f.expectUnchanged(before);
    expect(getUpdateRun(other.runId, f.options)?.status).toBe("running");
    expect(inspectUpdateRecoveries(f.options)[0]?.raw).toBe(f.saved);
  });
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
      const pending = observed();
      if (pending) {
        await pending;
      }
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
    const after = await Promise.all(files.map((file) => fs.readFile(file)));
    after.forEach((bytes, index) => expect(bytes.equals(before[index]!), files[index]).toBe(true));
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

function refuse(message: string): never {
  throw new Error(message);
}

async function checkpointRollbackFixture() {
  const f = createRetainedCheckpointFixture(fsSync.realpathSync(dirs.make("rollback-retained-")));
  const { env, configPath } = f;
  const configSnapshot = await createConfigIO({ env, configPath }).readConfigFileSnapshot();
  const opts: UpdateCommandOptions = {
    run: f.run,
    recovery: {
      options: f.options,
      fence: { assertCurrent: () => refuse("retained owner is no longer live") },
      getRecord: () => f.record,
      onRecord: () => refuse("retained record must remain read-only"),
      assertReady: () => refuse("no live readiness authority"),
    },
  };
  const rollback = vi.fn(async () => refuse("legacy rollback must not run"));
  const complete = vi.fn();
  const invoke = async (
    preManagedServiceStop?: Parameters<typeof rollbackFailedUpdate>[0]["preManagedServiceStop"],
    files = [f.file],
  ) => {
    const before = files.map((file) => fsSync.readFileSync(file));
    const result = await rollbackFailedUpdate({
      definitionRecovery: {},
      result: resultFixture(f.root, { status: "error", reason: "candidate-failed", durationMs: 1 }),
      previousRoot: f.root,
      configSnapshot,
      opts,
      timeoutMs: 1000,
      packageTransaction: { rollback, complete, backupRoot: path.join(f.root, "retained") },
      preManagedServiceStop,
    });
    files.forEach((file, index) => {
      expect(fsSync.readFileSync(file).equals(before[index]!), file).toBe(true);
    });
    expect(rollback).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      rolledBack: false,
      pendingRecoveryReason: expect.any(String),
    });
    return result;
  };
  return { ...f, opts, invoke };
}

const deferred = {
  result: { reason: "candidate-failed", recovery: { serviceRestartSafe: false } },
};

it("refuses checkpoint recovery before package mutation and preserves the primary failure", async () => {
  const f = await checkpointRollbackFixture();
  const files = [f.file, f.record.checkpoint!.ref.manifestPath, f.record.restore!.planPath];
  expect(await f.invoke(undefined, files)).toMatchObject({
    ...deferred,
    pendingRecoveryReason: expect.stringContaining("deferred"),
  });
  expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(f.record);
  expect(getUpdateRun(f.run.runId, f.options)?.status).toBe("running");
});

it.each(["lost context", "lost run", "interrupted displacement"] as const)(
  "does not reinterpret %s as permission for package rollback",
  async (change) => {
    const f = await checkpointRollbackFixture();
    f.opts.recovery = undefined;
    if (change === "lost run") {
      f.opts.run = undefined;
      vi.stubEnv("OPENCLAW_STATE_DIR", f.root);
    }
    if (change === "interrupted displacement") {
      f.displace();
      await f.invoke(undefined, [f.displaced]);
      expect(fsSync.existsSync(f.file)).toBe(false);
    } else {
      expect(await f.invoke(undefined, [f.file, f.configPath])).toMatchObject(deferred);
    }
  },
);

it.each(["service", "admitted"] as const)(
  "checks pending recovery in the %s root when service and history differ",
  async (pendingRoot) => {
    const f = await checkpointRollbackFixture();
    f.opts.recovery = undefined;
    const cleanEnv = { OPENCLAW_STATE_DIR: dirs.make("rollback-other-root-") };
    f.opts.run = { ...f.run, env: pendingRoot === "admitted" ? f.env : cleanEnv };
    const { result } = await f.invoke({
      stopped: false,
      inspected: true,
      runtimeInspected: true,
      running: false,
      serviceEnv: pendingRoot === "service" ? f.env : cleanEnv,
    });
    expect(result.reason).toBe("candidate-failed");
  },
);
