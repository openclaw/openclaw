import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createTestConfigSnapshot } from "../../commands/test-runtime-config-helpers.js";
import * as snapshots from "../../infra/sqlite-snapshot-source.js";
import {
  createRetainedUpdateRecovery,
  storeRetainedUpdateRecovery,
  retainedReadinessRecord,
  retainedTerminalRecord,
} from "../../infra/update-retained-recovery.test-support.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { legacyRecord } from "../../infra/update-run-recovery-legacy.test-support.js";
import { inspectUpdateRecoveries, loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { UpdateCommandOptions } from "./shared.js";
import { resultFixture } from "./update-command-fixtures.test-support.js";
import { continueMigratedUpdateInFreshProcess } from "./update-command-migrated.js";
import { assertUpdateCommandPackageFinalization } from "./update-command-recovery.js";
import { completeUpdateCommandRun } from "./update-command-run.js";
import { resolveSettledUpdateCommandResult } from "./update-command-terminal.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
afterEach(() => vi.restoreAllMocks());

function afterRecoveryRead(databasePath: string, action: () => void) {
  const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    const result = await lstat(...args);
    if (String(args[0]) === path.dirname(databasePath)) {
      action();
    }
    return result;
  });
}

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
      afterRecoveryRead(first.databasePath, () => {
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
      afterRecoveryRead(first.databasePath, () => {
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
  const fence = { assertCurrent() {} };
  let record = createRetainedUpdateRecovery({ runId: run.runId, from, to }, options);
  const recovery = {
    getRecord: () => record,
    onRecord: (next: typeof record) => {
      record = next;
    },
    fence,
    options,
    assertReady: () => fence.assertCurrent(),
  };
  const opts: UpdateCommandOptions = { json: true, run: { runId: run.runId, env }, recovery };
  record = retainedReadinessRecord(record, rollback ? "previous" : "candidate");
  if (rollback) {
    record.primaryFailure = { code: "candidate-failed", effectId: null };
  }
  storeRetainedUpdateRecovery(record, options);
  return { opts, options, run, live, root, record };
}

it("refuses to serialize live authority into a legacy migrated worker", async () => {
  const f = fixture();
  await expect(
    continueMigratedUpdateInFreshProcess(
      {
        opts: f.opts,
        mutationStarted: true,
        root: f.live,
        result: resultFixture(f.live),
        configSnapshot: createTestConfigSnapshot({}, {}, path.join(f.root, "openclaw.json")),
        installKindChanged: false,
        requestedChannel: null,
        storedChannel: null,
        channel: "stable",
        downgradeRisk: false,
        shouldRestart: true,
        controlPlaneUpdateSentinelMeta: null,
        preUpdatePluginInstallRecords: {},
        startedAt: Date.now(),
        updateStepTimeoutMs: 1000,
      },
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
    const directory = path.dirname(source.path);
    const basename = path.basename(source.path);
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
    return { ...f, family, saved };
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
        f.opts.run,
      );
      expect(result).toMatchObject({
        status: outcome === "succeeded" ? "ok" : "error",
        reason: rollback ? "candidate-failed" : terminal ? undefined : "update-recovery-pending",
        runId: f.run.runId,
      });
      expect(await f.family()).toEqual(before);
      if (!terminal) {
        expect(getUpdateRun(f.run.runId, f.options)?.status).toBe("running");
      }
    },
  );

  it.each([false, true])(
    "keeps unrelated legacy history separate from fallback completion (terminal=%s)",
    async (terminal) => {
      const f = await historical(false, terminal);
      const other = createUpdateRun({ trigger: "cli" }, f.options);
      closeOpenClawStateDatabaseForTest();
      const before = await f.family();
      const result = completeUpdateCommandRun(resultFixture(undefined, { durationMs: 1 }), {
        runId: other.runId,
        env: f.opts.run!.env,
      });
      expect(result).toMatchObject(
        terminal ? { status: "ok" } : { status: "error", reason: "update-recovery-pending" },
      );
      if (!terminal) {
        expect(await f.family()).toEqual(before);
      }
      expect(getUpdateRun(other.runId, f.options)?.status).toBe(terminal ? "succeeded" : "running");
      expect(inspectUpdateRecoveries(f.options)[0]?.raw).toBe(f.saved);
    },
  );
});
