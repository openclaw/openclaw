import fs from "node:fs";
import asyncFs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import { useExecutorFixture } from "../cli/update-cli/update-command-executor.test-support.js";
import { assertUpdateCommandRecoveryState } from "../cli/update-cli/update-command-recovery.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { createDanglingSkillWorkshopReviewIndex } from "../state/openclaw-state-db-corruption.test-support.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { defaultPayload } from "./gateway-state-owner-record.js";
import { acquireGatewayStateOwner } from "./gateway-state-owner.js";
import { startSqliteCheckpointWriter } from "./sqlite-checkpoint-writer.test-support.js";
import { readSqliteDatabaseCleanClose } from "./sqlite-database-admission.js";
import * as locations from "./sqlite-readonly-location.js";
import { withSqliteReadOnlyWorkerScope } from "./sqlite-readonly-worker.js";
import * as snapshots from "./sqlite-snapshot-source.js";
import { createRetainedCheckpointFixture } from "./update-retained-checkpoint.test-support.js";
import { createRetainedUpdateRecovery } from "./update-retained-recovery.test-support.js";
import { readUpdateRunDriver } from "./update-run-driver.js";
import {
  createUpdateRun,
  getUpdateRun,
  getUpdateRunWithReconciliationAsync,
  reconcileAbandonedUpdateRunsAsync,
} from "./update-run-ledger.js";
import { assertUpdateRecoveryAdmission } from "./update-run-recovery-admission.js";
import { assertNoPendingUpdateRecovery } from "./update-run-recovery.js";
import { recordUpdateRunPhaseAsync } from "./update-run-write.async.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const executorFixture = useExecutorFixture("update-cohort-admission-", {
  beforeCleanup: closeStateDatabaseForTest,
});
afterEach(() => closeOpenClawStateDatabaseForTest());
afterEach(() => vi.restoreAllMocks());

describe("package-only recovery admission", () => {
  it("admits a verified live checkpoint writer without copying unrelated state", async () => {
    const root = dirs.make("update-live-admission-");
    const env = { HOME: root, OPENCLAW_STATE_DIR: root };
    createUpdateRun({ trigger: "cli" }, { env });
    closeOpenClawStateDatabaseForTest();
    const databasePath = resolveOpenClawStateSqlitePath(env);
    const snapshot = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync");
    const asyncSnapshot = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation");
    const owner = acquireGatewayStateOwner({
      databasePath,
      payload: { ...defaultPayload(databasePath), role: "gateway" },
    });
    try {
      const writer = await startSqliteCheckpointWriter(databasePath);
      try {
        await withSqliteReadOnlyWorkerScope(async () => {
          await writer.commit();
          await expect(assertUpdateRecoveryAdmission({ env })).resolves.toBeUndefined();
          await writer.commit();
          expect(snapshot).not.toHaveBeenCalled();
          expect(asyncSnapshot).not.toHaveBeenCalled();
        });
      } finally {
        await writer.stop();
      }
    } finally {
      owner.release();
    }
  });

  it.each([false, true])(
    "reconciles and records progress with a live writer (warm=%s)",
    async (warm) => {
      const { root } = executorFixture();
      const env = { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "profile") };
      const driver = readUpdateRunDriver();
      expect(driver).toBeDefined();
      const run = createUpdateRun({ trigger: "cli", origin: { driver } }, { env });
      if (warm) {
        openOpenClawStateDatabase({ env });
      } else {
        closeOpenClawStateDatabaseForTest();
      }
      const databasePath = resolveOpenClawStateSqlitePath(env);
      const copies = [
        vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync"),
        vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation"),
        vi.spyOn(locations, "prepareSqliteReadOnlyLocationFromOwnedDatabase"),
      ];
      const owner = acquireGatewayStateOwner({
        databasePath,
        payload: { ...defaultPayload(databasePath), role: "gateway" },
      });
      try {
        const writer = await startSqliteCheckpointWriter(databasePath);
        try {
          await withSqliteReadOnlyWorkerScope(async () => {
            await writer.commit();
            await expect(
              reconcileAbandonedUpdateRunsAsync({ runIds: [run.runId] }, { env, snapshot: true }),
            ).resolves.toEqual([]);
            expect(
              (await getUpdateRunWithReconciliationAsync(run.runId, { env, snapshot: true })).run,
            ).toEqual(run);
            await withUpdateCommandExecutor(run.runId, async (executor) => {
              const fence = await executor.enter(root);
              const patch = { before: { version: "captured" } };
              let settlement: Promise<void> | undefined;
              const pending = recordUpdateRunPhaseAsync(run.runId, "validating", patch, {
                env,
                requireNoRecovery: true,
                pluginCohort: { runId: run.runId, fence },
                retainSettlement: (settled) => {
                  settlement = settled;
                },
              });
              const retainedBeforeYield = settlement;
              patch.before.version = "changed-after-admission";
              await Promise.all([pending, retainedBeforeYield]);
              expect(retainedBeforeYield).toBeDefined();
            });
            expect(
              (await getUpdateRunWithReconciliationAsync(run.runId, { env, snapshot: true })).run,
            ).toMatchObject({
              phase: "validating",
              before: { version: "captured" },
            });
            await writer.commit();
            for (const copy of copies) {
              expect(copy).not.toHaveBeenCalled();
            }
          });
        } finally {
          await writer.stop();
        }
      } finally {
        owner.release();
      }
    },
  );

  it("preserves Doctor catalog admission and typed pending-recovery refusal", async () => {
    const f = createRetainedCheckpointFixture(dirs.make("update-legacy-catalog-"));
    createDanglingSkillWorkshopReviewIndex(f.file);
    const before = fs.readFileSync(f.file);
    await expect(assertUpdateRecoveryAdmission(f.options)).rejects.toMatchObject({
      name: "UpdateRecoveryRequiredError",
      record: { runId: f.run.runId },
    });
    expect(fs.readFileSync(f.file)).toEqual(before);
  });

  it("runs host recovery guards without copying the database", () => {
    const f = createRetainedCheckpointFixture(dirs.make("update-guard-copies-"));
    const copies = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync");
    for (let check = 0; check < 3; check += 1) {
      expect(() =>
        assertNoPendingUpdateRecovery({ ...f.options, allowNativeRead: true }),
      ).toThrowError(expect.objectContaining({ name: "UpdateRecoveryRequiredError" }));
    }
    expect(copies).not.toHaveBeenCalled();
  });

  it("keeps Doctor catalog admission for host guards reading the live file", () => {
    const f = createRetainedCheckpointFixture(dirs.make("update-guard-catalog-"));
    createDanglingSkillWorkshopReviewIndex(f.file);
    const before = fs.readFileSync(f.file);
    const copies = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync");
    expect(() =>
      assertNoPendingUpdateRecovery({ ...f.options, allowNativeRead: true }),
    ).toThrowError(expect.objectContaining({ name: "UpdateRecoveryRequiredError" }));
    expect(copies).not.toHaveBeenCalled();
    expect(fs.readFileSync(f.file)).toEqual(before);
  });

  it("reads a certified clean close without copying or changing its bytes", async () => {
    const root = dirs.make("update-sealed-admission-");
    const env = { HOME: root, OPENCLAW_STATE_DIR: root };
    createUpdateRun({ trigger: "cli" }, { env });
    openOpenClawStateDatabase({ env });
    closeOpenClawStateDatabaseForTest();
    const databasePath = resolveOpenClawStateSqlitePath(env);
    expect(readSqliteDatabaseCleanClose(databasePath)).toBe(true);
    const before = fs.readFileSync(databasePath);
    const copy = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation");
    await expect(assertUpdateRecoveryAdmission({ env })).resolves.toBeUndefined();
    expect(copy).not.toHaveBeenCalled();
    expect(fs.readFileSync(databasePath)).toEqual(before);
  });

  it("keeps an explicitly retained metadata snapshot separate from current admission", async () => {
    const root = dirs.make("update-retained-metadata-");
    const options = { env: { HOME: root, OPENCLAW_STATE_DIR: root } };
    const run = createUpdateRun({ trigger: "cli" }, options);
    const read = () =>
      executeExistingOpenClawStateRead(options, { type: "updateRuns.recoveryAdmission" });
    await withArtifactPreservingStateReads(() =>
      withOpenClawStateDatabaseReadSnapshot(async () => {
        expect((await read())?.facts).toEqual({ cohorts: [], recoveries: [] });
        writeConfigMachineState("update.pluginCohort." + run.runId, { runId: run.runId }, options);
        expect((await read())?.facts).toEqual({ cohorts: [], recoveries: [] });
      }, options),
    );
    await expect(assertUpdateRecoveryAdmission(options)).rejects.toThrow(
      "missing its matching reservation",
    );
  });

  it("refuses a live orphan companion without admitting it as an empty recovery set", async () => {
    const root = dirs.make("update-orphan-cohort-");
    const env = { HOME: root, OPENCLAW_STATE_DIR: root };
    const run = createUpdateRun({ trigger: "cli" }, { env });
    writeConfigMachineState("update.pluginCohort." + run.runId, { runId: run.runId }, { env });
    const databasePath = openOpenClawStateDatabase({ env }).path;
    const before = fs.readFileSync(databasePath);
    const owner = acquireGatewayStateOwner({
      databasePath,
      payload: { ...defaultPayload(databasePath), role: "gateway" },
    });
    const copy = vi.spyOn(locations, "prepareSqliteReadOnlyLocationFromOwnedDatabase");
    try {
      await expect(assertUpdateRecoveryAdmission({ env })).rejects.toThrow(
        "missing its matching reservation",
      );
      expect(copy).not.toHaveBeenCalled();
      expect(fs.readFileSync(databasePath)).toEqual(before);
    } finally {
      owner.release();
    }
  });

  it("continues only its paired intent under the same live executor and source", async () => {
    const { root } = executorFixture();
    const env = { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "profile") };
    const runId = randomUUID();
    const continuation = await withUpdateCommandExecutor(runId, async (executor) => {
      const fence = await executor.enter(root);
      createUpdateRun({ runId, trigger: "cli" }, { env });
      const runtime = {
        root,
        nodePath: process.execPath,
        version: "2026.10.9",
        buildId: "fixture",
      };
      // Synthetic retained storage; the executor and worker admission remain real.
      const reservation = createRetainedUpdateRecovery(
        { runId, from: runtime, to: runtime },
        { env },
      );
      writeConfigMachineState(
        "update.pluginCohort." + runId,
        {
          runId,
          transactionId: reservation.transactionId,
          revision: 0,
          disposition: "pending",
          installKey: root,
          priorArtifacts: [],
          artifacts: [],
          publications: [],
          settledPublications: 0,
        },
        { env },
      );
      const pluginCohort = { runId, fence };
      await expect(assertUpdateRecoveryAdmission({ env })).rejects.toThrow("unfinished recovery");
      await expect(
        assertUpdateRecoveryAdmission({
          env,
          pluginCohort: { runId, fence: { assertCurrent() {} } },
        }),
      ).rejects.toThrow("admitted executor");
      await expect(
        assertUpdateRecoveryAdmission({
          env: { ...env, OPENCLAW_CONFIG_PATH: path.join(root, "other.json") },
          pluginCohort,
        }),
      ).rejects.toThrow("unfinished recovery");
      await expect(assertUpdateRecoveryAdmission({ env, pluginCohort })).resolves.toBeUndefined();
      expect(() =>
        assertUpdateCommandRecoveryState({ run: { runId, env, executorFence: fence } }),
      ).not.toThrow();
      await recordUpdateRunPhaseAsync(
        runId,
        "validating",
        {},
        {
          env,
          requireNoRecovery: true,
          pluginCohort,
        },
      );
      expect(getUpdateRun(runId, { env })?.phase).toBe("validating");
      return pluginCohort;
    });
    await expect(
      assertUpdateRecoveryAdmission({ env, pluginCohort: continuation }),
    ).rejects.toThrow("no longer current");
  });

  it("admits absent state without creating it", async () => {
    const root = path.join(dirs.make("update-admission-"), "absent");
    await assertUpdateRecoveryAdmission({ env: { OPENCLAW_STATE_DIR: root } });
    expect(fs.existsSync(root)).toBe(false);
  });

  it.each([false, true])(
    "keeps the selected recovery directory and file together (explicit path=%s)",
    async (explicitPath) => {
      const f = createRetainedCheckpointFixture(dirs.make("update-admission-target-"));
      const replacement = path.join(dirs.make("update-admission-replacement-"), "absent");
      const before = fs.readFileSync(f.file);
      let changed = false;
      const lstat = asyncFs.lstat.bind(asyncFs);
      vi.spyOn(asyncFs, "lstat").mockImplementation(async (...args) => {
        const result = await lstat(...args);
        if (String(args[0]) === path.dirname(f.file)) {
          changed = true;
          f.env.OPENCLAW_STATE_DIR = replacement;
        }
        return result;
      });
      await expect(
        assertUpdateRecoveryAdmission(explicitPath ? { ...f.options, path: f.file } : f.options),
      ).rejects.toMatchObject({
        name: "UpdateRecoveryRequiredError",
        record: { runId: f.run.runId },
      });
      expect(changed).toBe(true);
      expect(fs.readFileSync(f.file).equals(before)).toBe(true);
      expect(fs.existsSync(replacement)).toBe(false);
    },
  );

  it.each(["sealed", "unsealed", "displaced", "orphan beside canonical"] as const)(
    "refuses %s checkpoint state without changing retained bytes",
    async (kind) => {
      const f = createRetainedCheckpointFixture(
        dirs.make("update-admission-"),
        kind !== "unsealed",
      );
      if (kind === "displaced" || kind === "orphan beside canonical") {
        f.displace();
      }
      const freshRun =
        kind === "orphan beside canonical"
          ? createUpdateRun({ trigger: "cli" }, f.options)
          : undefined;
      closeOpenClawStateDatabaseForTest();
      const files = [
        f.file,
        f.displaced,
        f.record.checkpoint!.ref.manifestPath,
        f.record.restore!.planPath,
      ];
      const snapshot = () =>
        files.map((file) => (fs.existsSync(file) ? fs.readFileSync(file) : null));
      const before = snapshot();
      await expect(assertUpdateRecoveryAdmission(f.options)).rejects.toThrow(
        /recovery|publication/i,
      );
      const after = snapshot();
      expect(after).toHaveLength(before.length);
      for (const [index, bytes] of before.entries()) {
        if (bytes === null) {
          expect(after[index]).toBeNull();
        } else {
          expect(after[index]?.equals(bytes)).toBe(true);
        }
      }
      if (freshRun) {
        expect(getUpdateRun(freshRun.runId, f.options)).toEqual(freshRun);
      }
    },
  );
});
import { randomUUID } from "node:crypto";
