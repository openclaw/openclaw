import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createConfigIO } from "../config/io.factory.js";
import { replaceConfigFile } from "../config/mutate.js";
import { ConfigMutationConflictError } from "../config/mutation-conflict.js";
import {
  restorePluginCohortConfigPublication,
  withPluginCohortConfigCapture,
} from "../config/plugin-cohort-recovery.js";
import { setRuntimeConfigSnapshotRefreshHandler } from "../config/runtime-snapshot.js";
import {
  deleteConfigMachineState,
  writeConfigMachineState,
} from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import {
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
  restorePluginCohortMigrationPublications,
} from "./deferred-plugin-migrations.js";
import {
  decodePluginCohortRecovery,
  type PluginCohortRecovery,
} from "./update-plugin-cohort-schema.js";
import { createUpdateRun } from "./update-run-ledger.js";
import type { UpdateRecoveryRecord } from "./update-run-recovery-schema.js";
import {
  beginPluginCohortRecovery,
  deletePluginCohortRecovery,
  inspectPluginCohortRecoveries,
  loadPluginCohortRecovery,
  readPluginCohortRecoveryPairRows,
  writePluginCohortRecovery,
} from "./update-run-recovery-store.js";
import { assertNoPendingUpdateRecovery, loadUpdateRecovery } from "./update-run-recovery.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
const fence = { assertCurrent() {} };

function setup() {
  const root = dirs.make("plugin-cohort-recovery-");
  const options = { env: { HOME: root, OPENCLAW_STATE_DIR: root } };
  const run = createUpdateRun({ trigger: "cli" }, options);
  const reservation: UpdateRecoveryRecord = {
    runId: run.runId,
    transactionId: randomUUID(),
    revision: 0,
    claimId: randomUUID(),
    claimKind: "initial",
    handoff: null,
    source: { stateDir: root, configPath: path.join(root, "openclaw.json") },
    from: { root, nodePath: process.execPath, version: "2026.10.9", buildId: "old" },
    to: { root, nodePath: process.execPath, version: "2026.10.10", buildId: "new" },
    createdAtMs: 1,
    updatedAtMs: 1,
    effects: [],
    restore: null,
    verification: null,
    primaryFailure: null,
  };
  const cohort: PluginCohortRecovery = {
    runId: run.runId,
    transactionId: reservation.transactionId,
    revision: 0,
    disposition: "pending",
    installKey: root,
    priorArtifacts: [],
    artifacts: [],
    publications: [
      {
        kind: "records",
        records: [
          {
            pluginId: "fixture",
            before: { source: "npm", version: "1.0.0", futureField: { keep: true } },
            after: { source: "npm", version: "2.0.0" },
          },
        ],
      },
    ],
    settledPublications: 0,
  };
  const rows = () =>
    readPluginCohortRecoveryPairRows(openOpenClawStateDatabase(options).db, cohort);
  return { options, reservation, cohort, rows };
}

it("reopens the paired intent, retains old-reader refusal and settles only its own rows", () => {
  const f = setup();
  writeConfigMachineState("unrelated", { keep: true }, f.options);
  const pair = beginPluginCohortRecovery(f.reservation, f.cohort, fence, f.options);
  const originalReservation = f.rows().find((row) => row.state_key.startsWith("update.recovery."));
  closeOpenClawStateDatabaseForTest();
  expect(loadPluginCohortRecovery(f.cohort.runId, f.options)).toEqual(pair);
  expect(loadUpdateRecovery(f.cohort.runId, f.options)).toEqual(f.reservation);
  expect(() => assertNoPendingUpdateRecovery(f.options)).toThrow("unfinished recovery");
  const next = writePluginCohortRecovery(
    pair,
    { ...pair.cohort, disposition: "rollback", settledPublications: 1 },
    fence,
    f.options,
  );
  expect(next.cohort.revision).toBe(1);
  expect(f.rows().find((row) => row.state_key.startsWith("update.recovery."))).toEqual(
    originalReservation,
  );
  expect(inspectPluginCohortRecoveries(f.options)).toEqual([next]);
  deletePluginCohortRecovery(next, fence, f.options);
  deletePluginCohortRecovery(next, fence, f.options);
  expect(loadPluginCohortRecovery(f.cohort.runId, f.options)).toBeUndefined();
  expect(loadUpdateRecovery(f.cohort.runId, f.options)).toBeUndefined();
  expect(readConfigMachineState("unrelated", f.options)).toEqual({ keep: true });
});

it("refuses stale settlement and rolls back both rows if live ownership is lost", () => {
  const f = setup();
  let checks = 0;
  expect(() =>
    beginPluginCohortRecovery(
      f.reservation,
      f.cohort,
      {
        assertCurrent() {
          if (++checks === 3) {
            throw new Error("owner lost");
          }
        },
      },
      f.options,
    ),
  ).toThrow("owner lost");
  expect(f.rows()).toEqual([]);
  const pair = beginPluginCohortRecovery(f.reservation, f.cohort, fence, f.options);
  const next = writePluginCohortRecovery(
    pair,
    { ...pair.cohort, disposition: "commit" },
    fence,
    f.options,
  );
  expect(() => writePluginCohortRecovery(pair, pair.cohort, fence, f.options)).toThrow(
    "changed before settlement",
  );
  expect(() => deletePluginCohortRecovery(pair, fence, f.options)).toThrow(
    "changed before settlement",
  );
  expect(loadPluginCohortRecovery(f.cohort.runId, f.options)).toEqual(next);
});

it("refuses partial, mismatched and full-state pairs without changing retained evidence", () => {
  const f = setup();
  const pair = beginPluginCohortRecovery(f.reservation, f.cohort, fence, f.options);
  expect(() =>
    readPluginCohortRecoveryPairRows(openOpenClawStateDatabase(f.options).db, {
      ...f.cohort,
      transactionId: randomUUID(),
    }),
  ).toThrow("transaction changed");
  deleteConfigMachineState("update.recovery." + f.cohort.runId, f.options);
  expect(() => loadPluginCohortRecovery(f.cohort.runId, f.options)).toThrow("matching reservation");
  writeConfigMachineState(
    "update.recovery." + f.cohort.runId,
    {
      ...pair.reservation,
      transactionId: randomUUID(),
    },
    f.options,
  );
  expect(() => inspectPluginCohortRecoveries(f.options)).toThrow("match its reservation");
  writeConfigMachineState(
    "update.recovery." + f.cohort.runId,
    {
      ...pair.reservation,
      afterImages: [],
    },
    f.options,
  );
  expect(() => loadPluginCohortRecovery(f.cohort.runId, f.options)).toThrow("full-state recovery");
  expect(readConfigMachineState("update.pluginCohort." + f.cohort.runId, f.options)).toEqual(
    f.cohort,
  );
});

it("bounds persisted JSON and rejects invalid settlement progress", () => {
  const { cohort } = setup();
  expect(() =>
    decodePluginCohortRecovery(
      JSON.stringify({
        ...cohort,
        settledPublications: 2,
      }),
      cohort.runId,
    ),
  ).toThrow("settlement exceeds");
  expect(() => decodePluginCohortRecovery(" ".repeat(1024 * 1024 + 1), cohort.runId)).toThrow(
    "storage limit",
  );
});

it.each([false, true])(
  "reopens exact migration obligations without overwriting a later Doctor decision (baseline restored=%s)",
  async (baselineRestored) => {
    const f = setup();
    const original = {
      pluginId: "fixture",
      requiresStateMigration: true as const,
      reason: "original settings need repair",
      command: "openclaw doctor --fix",
    };
    const unrelated = { ...original, pluginId: "unrelated" };
    const created = { ...original, pluginId: "candidate-only" };
    const row = (pluginId: string) =>
      openOpenClawStateDatabase(f.options)
        .db.prepare(
          "SELECT id, started_at, finished_at, status, report_json FROM migration_runs WHERE id = ?",
        )
        .get("deferred-plugin-migration:" + pluginId);
    try {
      await recordDeferredPluginMigrations({ env: f.options.env, pending: [original, unrelated] });
      const before = row(original.pluginId);
      const pair = beginPluginCohortRecovery(
        f.reservation,
        { ...f.cohort, publications: [] },
        fence,
        f.options,
      );
      const context = {
        runId: pair.cohort.runId,
        installKey: pair.cohort.installKey,
        env: f.options.env,
        assertCurrent: () => fence.assertCurrent(),
      };
      await withPluginCohortConfigCapture(context, async () => {
        await recordDeferredPluginMigrations({
          env: f.options.env,
          pending: [created],
          resolvedPluginIds: [original.pluginId],
          expectedPending: readDeferredPluginMigrations(f.options),
        });
        await recordDeferredPluginMigrations({
          env: f.options.env,
          pending: [{ ...original, reason: "candidate config needs retry" }],
        });
        await recordDeferredPluginMigrations({
          env: f.options.env,
          pending: [],
          resolvedPluginIds: [original.pluginId],
        });
      });
      await closeOpenClawStateDatabaseAsync();
      const recovered = loadPluginCohortRecovery(pair.cohort.runId, f.options)!;
      const publications = recovered.cohort.publications.filter(
        (publication) => publication.kind === "plugin-migrations",
      );
      expect(publications).toHaveLength(3);
      const publication = publications[0];
      if (!publication) {
        throw new Error("Expected an actual obligation transaction receipt");
      }
      expect(publication.rows.map((entry) => entry.pluginId).toSorted()).toEqual([
        created.pluginId,
        original.pluginId,
      ]);
      expect(row(original.pluginId)?.status).toBe("completed");
      expect(row(created.pluginId)?.status).toBe("pending");

      await recordDeferredPluginMigrations({
        env: f.options.env,
        pending: [{ ...unrelated, reason: "later independent repair" }],
      });
      const laterUnrelated = row(unrelated.pluginId);
      if (baselineRestored) {
        // A full database restore preserves the cohort pair while restoring these original rows.
        runOpenClawStateWriteTransaction(({ db }) => {
          db.prepare(
            "UPDATE migration_runs SET started_at = ?, finished_at = ?, status = ?, report_json = ? WHERE id = ?",
          ).run(
            before!.started_at!,
            before!.finished_at!,
            before!.status!,
            before!.report_json!,
            before!.id!,
          );
          db.prepare("DELETE FROM migration_runs WHERE id = ?").run(
            "deferred-plugin-migration:" + created.pluginId,
          );
        }, f.options);
      }
      const authority = { env: f.options.env, assertCurrent: () => fence.assertCurrent() };
      await restorePluginCohortMigrationPublications(publications, authority);
      expect(row(original.pluginId)).toEqual(before);
      expect(row(created.pluginId)).toBeUndefined();
      expect(row(unrelated.pluginId)).toEqual(laterUnrelated);
      await restorePluginCohortMigrationPublications(publications, authority);
      expect(row(original.pluginId)).toEqual(before);

      await recordDeferredPluginMigrations({
        env: f.options.env,
        pending: [],
        settlements: [
          {
            pluginId: original.pluginId,
            status: "completed",
            reason: "later independent completion",
          },
        ],
      });
      const laterOriginal = row(original.pluginId);
      await expect(
        restorePluginCohortMigrationPublications(publications, authority),
      ).rejects.toThrow("Plugin migration obligation changed after update publication");
      expect(row(original.pluginId)).toEqual(laterOriginal);
      expect(row(unrelated.pluginId)).toEqual(laterUnrelated);
    } finally {
      await closeOpenClawStateDatabaseAsync();
    }
  },
);

it.each(["present", "originally absent", "originally present"] as const)(
  "settles actual migration publications on an older database without initialization (%s)",
  async (table) => {
    const f = setup();
    const obligation = {
      pluginId: "fixture",
      reason: "settings need repair",
      command: "openclaw doctor --fix",
      requiresStateMigration: true as const,
    };
    const database = resolveOpenClawStateSqlitePath(f.options.env);
    const inspect = () => {
      using db = new DatabaseSync(database, { readOnly: true });
      return {
        version: db.prepare("PRAGMA user_version").get(),
        metadata: db.prepare("SELECT * FROM schema_meta ORDER BY meta_key").all(),
        schema: db
          .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
          .all(),
      };
    };
    if (table !== "originally absent") {
      await recordDeferredPluginMigrations({ env: f.options.env, pending: [obligation] });
    }
    const pair = beginPluginCohortRecovery(
      f.reservation,
      { ...f.cohort, publications: [] },
      fence,
      f.options,
    );
    await withPluginCohortConfigCapture(
      {
        runId: pair.cohort.runId,
        installKey: pair.cohort.installKey,
        env: f.options.env,
        assertCurrent: () => fence.assertCurrent(),
      },
      async () => {
        await recordDeferredPluginMigrations({
          env: f.options.env,
          pending: [{ ...obligation, reason: "candidate needs repair" }],
        });
        await recordDeferredPluginMigrations({
          env: f.options.env,
          pending: [],
          resolvedPluginIds: [obligation.pluginId],
        });
      },
    );
    const publications = loadPluginCohortRecovery(
      pair.cohort.runId,
      f.options,
    )!.cohort.publications.filter((publication) => publication.kind === "plugin-migrations");
    expect(publications).toHaveLength(2);
    await closeOpenClawStateDatabaseAsync();
    {
      using db = new DatabaseSync(database);
      // Test-only restored publication floor; canonical content can remain newer.
      db.exec(
        "PRAGMA user_version=15; UPDATE schema_meta SET schema_version=15 WHERE meta_key='primary'",
      );
      if (table !== "present") {
        // Model a backup captured before the migration owner's tables existed.
        db.exec("DROP TABLE migration_sources; DROP TABLE migration_runs");
      }
    }
    const before = inspect();
    const restore = () =>
      restorePluginCohortMigrationPublications(publications, {
        env: f.options.env,
        assertCurrent: () => fence.assertCurrent(),
      });
    if (table === "originally present") {
      await expect(restore()).rejects.toThrow("missing its original obligations");
    } else {
      await restore();
      await restore();
      if (table === "present") {
        expect(readDeferredPluginMigrations(f.options)).toEqual([obligation]);
      }
    }
    expect(inspect()).toEqual(before);
  },
);

it.each([
  ["unchanged paths", false],
  ["unchanged paths", true],
  ["root device changed", false],
  ["root inode changed", false],
  ["parent inode changed", false],
  ["recorded target anchor absent", false],
] as const)(
  "journals physical config publication and restores only owned leaves (%s; include=%s)",
  async (pathCase, include) => {
    const f = setup();
    const configPath = f.reservation.source!.configPath;
    const filePath = include ? path.join(path.dirname(configPath), "gateway.json5") : configPath;
    const env = { ...f.options.env, NODE_ENV: "test", COHORT_TOKEN: "fixture-token" };
    const gateway = {
      mode: "local" as const,
      port: 18789,
      auth: { token: "${COHORT_TOKEN}" },
      remote: { token: { source: "env" as const, provider: "default", id: "COHORT_TOKEN" } },
    };
    const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
    const beforeRaw = json(include ? gateway : { gateway });
    await fs.writeFile(filePath, beforeRaw);
    if (include) {
      await fs.writeFile(configPath, json({ gateway: { $include: "./gateway.json5" } }));
    }
    beginPluginCohortRecovery(f.reservation, { ...f.cohort, publications: [] }, fence, f.options);
    const authority = { env, assertCurrent: () => fence.assertCurrent() };
    const io = createConfigIO({ env, configPath, observe: false, pluginValidation: "skip" });
    try {
      await withPluginCohortConfigCapture(
        { ...authority, runId: f.cohort.runId, installKey: f.cohort.installKey },
        async () => {
          const prepared = await io.readConfigFileSnapshotForWrite();
          await replaceConfigFile({
            snapshot: prepared.snapshot,
            sourceConfig: {
              ...prepared.snapshot.sourceConfig,
              gateway: { ...prepared.snapshot.sourceConfig.gateway, port: 18790 },
            },
            // This boundary fixture has no installed plugin inventory.
            writeOptions: { ...prepared.writeOptions, skipPluginValidation: true },
            io: {
              env,
              readConfigFileSnapshotForWrite: io.readConfigFileSnapshotForWrite,
              writeConfigFile: io.writeConfigFile,
            },
          });
        },
      );
      await closeOpenClawStateDatabaseAsync();
      const pair = loadPluginCohortRecovery(f.cohort.runId, f.options)!;
      expect(pair.cohort.publications).toHaveLength(1);
      const publication = pair.cohort.publications[0];
      if (!publication || publication.kind !== "config") {
        throw new Error("Expected a physical configuration publication");
      }
      let intent = publication.file;
      expect(intent.filePath).toBe(filePath);
      expect(intent.beforeRaw).toBe(beforeRaw);
      expect(intent.afterRaw).toBe(await fs.readFile(filePath, "utf8"));
      expect(intent.include?.boundaryPath).toEqual(include ? ["gateway"] : undefined);

      if (pathCase !== "unchanged paths") {
        const historicalIntent = structuredClone(intent);
        const filesystemRoot = path.parse(historicalIntent.targetPath).root;
        const rootEntry = historicalIntent.pathSnapshot.entries.find(
          (entry) => entry.path === filesystemRoot,
        );
        if (!rootEntry || rootEntry.kind !== "existing" || rootEntry.link !== undefined) {
          throw new Error("Config publication did not record its filesystem root directory");
        }
        // Simulate the historical mount facts; current paths and all file bytes stay real.
        rootEntry.dev = (BigInt(rootEntry.dev) + 1n).toString();
        if (pathCase === "root inode changed") {
          rootEntry.ino = (BigInt(rootEntry.ino) + 1n).toString();
        } else if (pathCase === "parent inode changed") {
          const parentEntry = historicalIntent.pathSnapshot.entries.find(
            (entry) => entry.path === path.dirname(historicalIntent.targetPath),
          );
          if (!parentEntry || parentEntry.kind !== "existing" || parentEntry.link !== undefined) {
            throw new Error("Config publication did not record its canonical parent directory");
          }
          parentEntry.ino = (BigInt(parentEntry.ino) + 1n).toString();
        } else if (pathCase === "recorded target anchor absent") {
          historicalIntent.pathSnapshot.entries = [rootEntry];
        }
        const historicalPair = writePluginCohortRecovery(
          pair,
          {
            ...pair.cohort,
            publications: [{ kind: "config", file: historicalIntent }],
          },
          fence,
          f.options,
        );
        await closeOpenClawStateDatabaseAsync();
        const reopenedPublication = loadPluginCohortRecovery(f.cohort.runId, f.options)!.cohort
          .publications[0];
        if (!reopenedPublication || reopenedPublication.kind !== "config") {
          throw new Error("Expected the reopened physical config publication");
        }
        intent = reopenedPublication.file;
        if (pathCase !== "root device changed") {
          await expect(
            restorePluginCohortConfigPublication(intent, authority),
          ).rejects.toBeInstanceOf(ConfigMutationConflictError);
          expect(await fs.readFile(filePath, "utf8")).toBe(intent.afterRaw);
          expect(loadPluginCohortRecovery(f.cohort.runId, f.options)).toEqual(historicalPair);
          return;
        }
      }
      const historicalPathSnapshot = structuredClone(intent.pathSnapshot);

      await restorePluginCohortConfigPublication(intent, authority);
      expect(await fs.readFile(filePath, "utf8")).toBe(beforeRaw);
      await fs.writeFile(filePath, intent.afterRaw);

      // A later independent writer keeps its setting, metadata and authored secret references.
      const later = JSON.parse(intent.afterRaw);
      const laterGateway = include ? later : later.gateway;
      laterGateway.auth.allowTailscale = true;
      const laterTouchedAt = "2026-10-30T12:34:56.000Z";
      const laterRaw = json(later);
      await fs.writeFile(filePath, laterRaw);
      writeConfigMachineState("config.lastTouchedAt", laterTouchedAt, f.options);
      setRuntimeConfigSnapshotRefreshHandler({
        preflight: () => {
          throw new Error("fixture SecretRef preflight refusal");
        },
        refresh: () => true,
      });
      await expect(restorePluginCohortConfigPublication(intent, authority)).rejects.toThrow(
        "active SecretRef resolution failed: fixture SecretRef preflight refusal",
      );
      expect(await fs.readFile(filePath, "utf8")).toBe(laterRaw);
      setRuntimeConfigSnapshotRefreshHandler(null);
      await restorePluginCohortConfigPublication(intent, authority);
      const restoredRaw = await fs.readFile(filePath, "utf8");
      const restored = JSON.parse(restoredRaw);
      const restoredGateway = include ? restored : restored.gateway;
      expect(restoredGateway.port).toBe(18789);
      expect(restoredGateway.auth).toEqual({ token: "${COHORT_TOKEN}", allowTailscale: true });
      expect(restoredGateway.remote).toEqual(gateway.remote);
      if (!include) {
        expect(restored.meta.lastTouchedVersion).toBe(later.meta.lastTouchedVersion);
        expect(restored.meta.migrations?.modelPolicyAllowlist).toBeUndefined();
        expect(restored.meta.migrations?.utilityModelSeparation).toBeUndefined();
      }
      expect(readConfigMachineState("config.lastTouchedAt", f.options)).toBe(laterTouchedAt);
      await restorePluginCohortConfigPublication(intent, authority);
      expect(await fs.readFile(filePath, "utf8")).toBe(restoredRaw);
      expect(loadPluginCohortRecovery(f.cohort.runId, f.options)?.cohort.publications).toHaveLength(
        1,
      );

      restoredGateway.port = 18791;
      const conflictingRaw = json(restored);
      await fs.writeFile(filePath, conflictingRaw);
      await expect(restorePluginCohortConfigPublication(intent, authority)).rejects.toThrow(
        "Configuration changed after update publication",
      );
      expect(await fs.readFile(filePath, "utf8")).toBe(conflictingRaw);
      const retainedPublication = loadPluginCohortRecovery(f.cohort.runId, f.options)!.cohort
        .publications[0];
      if (!retainedPublication || retainedPublication.kind !== "config") {
        throw new Error("Expected the retained physical config publication");
      }
      expect(retainedPublication.file.pathSnapshot).toEqual(historicalPathSnapshot);
    } finally {
      setRuntimeConfigSnapshotRefreshHandler(null);
      await closeOpenClawStateDatabaseAsync();
    }
  },
);
