import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import {
  recordDeferredPluginMigrations,
  recordDeferredPluginMigrationsInTransaction,
} from "../infra/deferred-plugin-migrations.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import * as reads from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import {
  confirmPluginStateMigrationReadiness,
  readPluginStateMigrationReadinessAsync as read,
} from "./plugin-state-migration-readiness.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeStateDatabaseForTest);
afterEach(() => vi.restoreAllMocks());

it("retains settled readiness until a migration commits, independently of database and engine", async () => {
  const env = { ...process.env, OPENCLAW_STATE_DIR: dirs.make("plugin-readiness-") };
  const other = { ...process.env, OPENCLAW_STATE_DIR: dirs.make("plugin-readiness-other-") };
  const migration = {
    pluginId: "fixture",
    reason: "Retained data needs migration",
    command: "openclaw doctor --fix",
    requiresStateMigration: true as const,
  };
  writeConfigMachineState("fixture.unrelated", true, { env });
  writeConfigMachineState("fixture.unrelated", true, { env: other });
  const operations = vi.spyOn(reads, "executeExistingOpenClawStateRead");
  const backup = vi.spyOn(requireNodeSqlite(), "backup");
  const warn = vi.fn();
  const signal = new AbortController().signal;
  await confirmPluginStateMigrationReadiness({ config: {}, env, signal, warn });
  expect(warn).not.toHaveBeenCalled();
  expect(backup).not.toHaveBeenCalled();
  expect(operations).toHaveBeenCalledOnce();
  operations.mockClear();
  expect(await read({ env })).toEqual([]);
  expect(operations).toHaveBeenCalledOnce();
  operations.mockClear();
  writeConfigMachineState("fixture.unrelated", false, { env });
  expect(await read({ env })).toEqual([]);
  expect(operations).not.toHaveBeenCalled();

  await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(env));
  expect(await read({ env })).toEqual([]);
  expect(operations).not.toHaveBeenCalled();
  writeConfigMachineState("fixture.unrelated", true, { env });
  expect(await read({ env })).toEqual([]);
  expect(operations).not.toHaveBeenCalled();

  expect(await read({ env: other })).toEqual([]);
  expect(operations).toHaveBeenCalledOnce();
  operations.mockClear();
  const selection = { effectiveEngines: resolveDatabaseFamilyEngines({}) };
  expect(await withDatabaseEngineSelection(selection, () => read({ env }))).toEqual([]);
  expect(operations).toHaveBeenCalledOnce();
  operations.mockClear();
  expect(await read({ env })).toEqual([]);
  expect(await withDatabaseEngineSelection(selection, () => read({ env }))).toEqual([]);
  expect(operations).not.toHaveBeenCalled();

  runOpenClawStateWriteTransaction(
    ({ db }) => recordDeferredPluginMigrationsInTransaction(db, { pending: [migration] }),
    { env },
  );
  expect(await read({ env })).toEqual([migration]);
  expect(await read({ env: other })).toEqual([]);
  expect(operations).toHaveBeenCalledOnce();
  operations.mockClear();
  await recordDeferredPluginMigrations({
    env,
    pending: [],
    resolvedPluginIds: [migration.pluginId],
  });
  expect(await read({ env })).toEqual([]);
  expect(operations).toHaveBeenCalledOnce();
  operations.mockClear();
  expect(() =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        recordDeferredPluginMigrationsInTransaction(db, { pending: [migration] });
        throw new Error("rollback migration");
      },
      { env },
    ),
  ).toThrow("rollback migration");
  expect(await read({ env })).toEqual([]);

  operations.mockClear();
  await reads.withArtifactPreservingStateReads(() => read({ env }));
  expect(operations).toHaveBeenCalledOnce();
});
