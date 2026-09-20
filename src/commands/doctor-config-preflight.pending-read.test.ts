import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as pendingMigrations from "../infra/deferred-plugin-migrations.js";
import { SQLITE_READONLY_CHILD_ARG } from "../infra/runtime-process-entrypoints.js";
import * as snapshotSource from "../infra/sqlite-snapshot-source.js";
import * as checkpoint from "../infra/startup-migration-checkpoint.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

// Observe real launches without replacing SQLite or the child's lifecycle owner.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
    spawnSync: vi.fn(actual.spawnSync),
  };
});

beforeEach(() => {
  vi.mocked(spawn).mockClear();
  vi.mocked(spawnSync).mockClear();
});
afterEach(() => vi.restoreAllMocks());

it("reuses Doctor's readonly child for pending records and discovery, then joins it", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = path.join(home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ gateway: { mode: "local" }, plugins: { enabled: false } }),
    );
    openOpenClawStateDatabase({ path: path.join(stateDir, "state", "openclaw.sqlite") });
    await closeOpenClawStateDatabaseAsync();

    const pendingReadLaunches: number[] = [];
    const readPending = pendingMigrations.readDeferredPluginMigrations;
    vi.spyOn(pendingMigrations, "readDeferredPluginMigrations").mockImplementation((options) => {
      const start = vi.mocked(spawnSync).mock.calls.length;
      const result = readPending(options);
      pendingReadLaunches.push(
        vi
          .mocked(spawnSync)
          .mock.calls.slice(start)
          .filter(([, args]) => args?.includes(SQLITE_READONLY_CHILD_ARG)).length,
      );
      return result;
    });
    const prepareSnapshot = snapshotSource.prepareSqliteReadOnlyLocation;
    const snapshotChildren: Array<number | undefined> = [];
    vi.spyOn(snapshotSource, "prepareSqliteReadOnlyLocation").mockImplementation(
      async (...args) => {
        const prepared = await prepareSnapshot(...args);
        const sessionIndex = vi
          .mocked(spawn)
          .mock.calls.findIndex(([, argv]) => argv?.includes(SQLITE_READONLY_CHILD_ARG));
        snapshotChildren.push(vi.mocked(spawn).mock.results[sessionIndex]?.value.pid);
        return prepared;
      },
    );
    try {
      const result = await runDoctorConfigPreflight({
        migrateLegacyConfig: false,
        requireStartupMigrationCheckpoint: true,
        observe: false,
      });
      expect(result.snapshot.valid).toBe(true);
      expect(pendingReadLaunches.length).toBeGreaterThan(0);
      expect(pendingReadLaunches.every((count) => count === 0)).toBe(true);
      expect(snapshotChildren.length).toBeGreaterThanOrEqual(2);
      expect(snapshotChildren[0]).toBeTypeOf("number");
      expect(new Set(snapshotChildren).size).toBe(1);
      const sessions = vi
        .mocked(spawn)
        .mock.calls.flatMap(([, argv], index) =>
          argv?.includes(SQLITE_READONLY_CHILD_ARG)
            ? [vi.mocked(spawn).mock.results[index]?.value]
            : [],
        );
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.exitCode).toBe(0);
      expect(sessions[0]?.connected).toBe(false);
      expect(checkpoint.hasActiveStartupMigrationLease()).toBe(false);
    } finally {
      await closeOpenClawStateDatabaseAsync();
    }
  });
});

it.each([false, true])(
  "awaits pending inputs before backup selection (startup checkpoint: %s)",
  async (requireStartupMigrationCheckpoint) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      const retained = {
        gateway: { mode: "local" },
        plugins: { enabled: false },
        legacyFixture: "retained",
      };
      const raw = JSON.stringify(retained);
      const backup = JSON.stringify({ gateway: { mode: "local" }, plugins: { enabled: false } });
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(configPath, raw);
      await fs.writeFile(`${configPath}.bak`, backup);
      const pending = {
        pluginId: "unavailable-fixture",
        reason: "Synthetic migration owner is unavailable",
        command: "openclaw doctor --fix",
        requiresStateMigration: true as const,
        configPaths: [["legacyFixture"]],
        validationExcludedPaths: [["legacyFixture"]],
      };
      pendingMigrations.recordDeferredPluginMigrations({ pending: [pending] });
      await closeOpenClawStateDatabaseAsync();
      const held = createDeferredCore();
      const release = createDeferredCore();
      const prepareSnapshot = snapshotSource.prepareSqliteReadOnlyLocation;
      let intercepted = false;
      let snapshotClosed = false;
      const snapshotsClosedAtValidation: boolean[] = [];
      const pendingRead = vi.spyOn(pendingMigrations, "readDeferredPluginMigrations");
      vi.spyOn(snapshotSource, "prepareSqliteReadOnlyLocation").mockImplementation(
        async (...args) => {
          const prepared = await prepareSnapshot(...args);
          if (
            !intercepted &&
            args[1]?.signal !== undefined &&
            path.toNamespacedPath(path.resolve(args[0])) === path.toNamespacedPath(databasePath)
          ) {
            intercepted = true;
            const cleanup = prepared.cleanupAsync.bind(prepared);
            vi.spyOn(prepared, "cleanupAsync").mockImplementation(async () => {
              snapshotClosed = await cleanup();
              return snapshotClosed;
            });
            held.resolve();
            await release.promise;
          }
          return prepared;
        },
      );
      const acquire = vi.spyOn(checkpoint, "acquireStartupMigrationLeaseWithWait");
      const operation = runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        observe: false,
        requireStartupMigrationCheckpoint,
        validateStartupConfig: () => {
          snapshotsClosedAtValidation.push(snapshotClosed);
        },
      });
      const settled = operation.then(() => "settled" as const);
      try {
        expect(await Promise.race([held.promise.then(() => "held" as const), settled])).toBe(
          "held",
        );
        expect(pendingRead).not.toHaveBeenCalled();
        expect(acquire).not.toHaveBeenCalled();
        expect(snapshotClosed).toBe(false);
        expect(await fs.readFile(configPath, "utf8")).toBe(raw);
        expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(backup);
        release.resolve();
        const result = await operation;
        expect(snapshotsClosedAtValidation.length > 0).toBe(requireStartupMigrationCheckpoint);
        expect(snapshotsClosedAtValidation).not.toContain(false);
        expect(pendingRead).toHaveBeenCalled();
        expect(snapshotClosed).toBe(true);
        expect(result.snapshot.valid).toBe(true);
        expect(result.snapshot.sourceConfig).toHaveProperty("legacyFixture", "retained");
        expect(pendingMigrations.readDeferredPluginMigrations({ path: databasePath })).toEqual([
          pending,
        ]);
        expect(await fs.readFile(configPath, "utf8")).toBe(raw);
        expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(backup);
        expect(checkpoint.hasActiveStartupMigrationLease()).toBe(false);
      } finally {
        release.resolve();
        try {
          await settled;
        } finally {
          await closeOpenClawStateDatabaseAsync();
        }
      }
    });
  },
);

it.each([false, true])(
  "does not create pending-state files (config exists: %s)",
  async (configExists) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      if (configExists) {
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(
          configPath,
          JSON.stringify({ gateway: { mode: "local" }, plugins: { enabled: false } }),
        );
      }
      try {
        const result = await runDoctorConfigPreflight({
          migrateState: false,
          migrateLegacyConfig: false,
          invalidConfigNote: false,
          observe: false,
        });
        expect(result.snapshot.exists).toBe(configExists);
        expect(result.deferredPluginMigrations ?? []).toEqual([]);
        for (const suffix of ["", "-wal", "-shm"]) {
          await expect(fs.stat(`${databasePath}${suffix}`)).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
        for (const [, args] of [
          ...vi.mocked(spawn).mock.calls,
          ...vi.mocked(spawnSync).mock.calls,
        ]) {
          expect(args ?? []).not.toContain(SQLITE_READONLY_CHILD_ARG);
        }
      } finally {
        await closeOpenClawStateDatabaseAsync();
      }
    });
  },
);
