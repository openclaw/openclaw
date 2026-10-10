import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as pendingMigrations from "../infra/deferred-plugin-migrations.js";
import * as snapshotSource from "../infra/sqlite-snapshot-source.js";
import * as checkpoint from "../infra/startup-migration-checkpoint.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

afterEach(() => vi.restoreAllMocks());

it.each(["Doctor repair", "Gateway readiness"] as const)(
  "awaits pending inputs before backup selection through %s",
  async (owner) => {
    const gateway = owner === "Gateway readiness";
    await withDoctorConfigPreflightHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      const retained = {
        meta: { migrations: { webhookListeners: true } },
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
      await pendingMigrations.recordDeferredPluginMigrations({ pending: [pending] });
      await closeOpenClawStateDatabaseAsync();
      const held = createDeferredCore();
      const release = createDeferredCore();
      const prepareSnapshot = snapshotSource.prepareSqliteReadOnlyLocation;
      let intercepted = false;
      let snapshotClosed = false;
      const snapshotsClosedAtReadiness: boolean[] = [];
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
            beforeStatePreparation: async () => {
              snapshotsClosedAtReadiness.push(snapshotClosed);
              return true;
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
        expect(snapshotsClosedAtReadiness.length > 0).toBe(gateway);
        expect(snapshotsClosedAtReadiness).not.toContain(false);
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
