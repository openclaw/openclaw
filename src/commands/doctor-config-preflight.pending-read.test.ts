import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

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
    const preparedSnapshots = vi.spyOn(snapshotSource, "prepareSqliteReadOnlyLocation");
    const spawnChild = vi.mocked(spawn).getMockImplementation();
    if (!spawnChild) {
      throw new Error("Real child launch observer is unavailable");
    }
    const requestModes = new Map<ChildProcess, string[]>();
    const observeChild: typeof spawnChild = (...args) => {
      const child = spawnChild(...args);
      if (Array.isArray(args[1]) && args[1].includes(SQLITE_READONLY_CHILD_ARG)) {
        const modes: string[] = [];
        requestModes.set(child, modes);
        const send = child.send.bind(child);
        vi.spyOn(child, "send").mockImplementation((...sendArgs) => {
          const message = sendArgs[0];
          modes.push(
            message === "close"
              ? "close"
              : typeof message === "object" &&
                  message !== null &&
                  "args" in message &&
                  Array.isArray(message.args) &&
                  typeof message.args[0] === "string"
                ? message.args[0]
                : "unexpected",
          );
          return send(...sendArgs);
        });
      }
      return child;
    };
    vi.mocked(spawn).mockImplementation(observeChild);
    try {
      const result = await runDoctorConfigPreflight({
        migrateLegacyConfig: false,
        doctorOnlyStateMigrations: true,
        observe: false,
      });
      expect(result.snapshot.valid).toBe(true);
      expect(pendingReadLaunches.length).toBeGreaterThan(0);
      expect(pendingReadLaunches.every((count) => count === 0)).toBe(true);
      expect(preparedSnapshots.mock.calls.length).toBeGreaterThanOrEqual(2);
      const sessions = vi
        .mocked(spawn)
        .mock.calls.flatMap(([, argv], index) =>
          argv?.includes(SQLITE_READONLY_CHILD_ARG)
            ? [vi.mocked(spawn).mock.results[index]?.value]
            : [],
        );
      // Token custodians use the same launch argv as the reused read child.
      // Actual requests distinguish the owners without assuming their launch order.
      const readers = sessions.filter((child) => requestModes.get(child)?.includes("sync"));
      expect(readers).toHaveLength(1);
      for (const child of sessions) {
        const modes = requestModes.get(child);
        expect(modes).toBeDefined();
        if (!modes) {
          throw new Error("Unobserved read-only child requests");
        }
        expect(modes.at(-1)).toBe("close");
        if (child === readers[0]) {
          expect(modes.filter((mode) => mode === "sync").length).toBeGreaterThanOrEqual(2);
          expect(modes.every((mode) => mode === "sync" || mode === "close")).toBe(true);
        } else {
          const creates = modes.filter((mode) => mode === "staging-create").length;
          expect(creates).toBeGreaterThan(0);
          expect(modes.filter((mode) => mode === "staging-retire")).toHaveLength(creates);
          expect(
            modes.every((mode) => ["staging-create", "staging-retire", "close"].includes(mode)),
          ).toBe(true);
        }
        expect(child.exitCode).toBe(0);
        expect(child.signalCode).toBeNull();
        expect(child.connected).toBe(false);
      }
      expect(checkpoint.hasActiveStartupMigrationLease()).toBe(false);
    } finally {
      vi.mocked(spawn).mockImplementation(spawnChild);
      await closeOpenClawStateDatabaseAsync();
    }
  });
});

it.each(["Doctor repair", "Gateway readiness"] as const)(
  "awaits pending inputs before backup selection through %s",
  async (owner) => {
    const gateway = owner === "Gateway readiness";
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
      const operation = gateway
        ? runStartupConfigPreflight({
            gateway: true,
            observe: false,
            validateStartupConfig: () => {
              snapshotsClosedAtValidation.push(snapshotClosed);
            },
          })
        : runDoctorConfigPreflight({
            migrateState: false,
            migrateLegacyConfig: false,
            repairPrefixedConfig: true,
            invalidConfigNote: false,
            observe: false,
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
        expect(snapshotsClosedAtValidation.length > 0).toBe(gateway);
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
