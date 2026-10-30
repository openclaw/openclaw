import fs from "node:fs/promises";
import path from "node:path";
import { flatMapRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { afterEach, expect, it, vi } from "vitest";
import * as pendingMigrations from "../infra/deferred-plugin-migrations.js";
import { invalidateSqliteDatabaseCleanClose } from "../infra/sqlite-database-admission.js";
import * as snapshotSource from "../infra/sqlite-snapshot-source.js";
import * as checkpoint from "../infra/startup-migration-checkpoint.js";
import { createDeferredCore } from "../shared/deferred.js";
import { observeAsyncFixture } from "../state/openclaw-state-db-readonly.test-support.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

afterEach(() => vi.restoreAllMocks());

it.each(["Doctor repair", "Gateway readiness"] as const)(
  "preserves config and closes state reads through %s",
  async (owner) => {
    const gateway = owner === "Gateway readiness";
    await withDoctorConfigPreflightHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      const baseConfig = { gateway: { mode: "local" }, plugins: { enabled: false } };
      const raw = JSON.stringify({
        ...baseConfig,
        meta: { migrations: { webhookListeners: true } },
        ...(gateway ? {} : { legacyFixture: "retained" }),
      });
      const backup = JSON.stringify(baseConfig);
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
      // Exercise snapshot admission; a clean seal intentionally skips this wait.
      invalidateSqliteDatabaseCleanClose(databasePath);
      const held = createDeferredCore();
      const release = createDeferredCore();
      const startSnapshot = snapshotSource.startSqliteReadOnlyLocationAsync;
      let intercepted = false;
      let snapshotClosed = false;
      const snapshotsClosedAtReadiness: boolean[] = [];
      const pendingRead = vi.spyOn(pendingMigrations, "readDeferredPluginMigrations");
      vi.spyOn(snapshotSource, "startSqliteReadOnlyLocationAsync").mockImplementation((...args) => {
        const preparation = startSnapshot(...args);
        return {
          ...preparation,
          ...flatMapRetainedOperation(preparation, (prepared) =>
            observeAsyncFixture(async () => {
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
            }),
          ),
        };
      });
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
        expect(pendingRead.mock.calls.length > 0).toBe(!gateway);
        expect(snapshotClosed).toBe(true);
        expect(result.snapshot).toMatchObject({
          valid: true,
          sourceConfig: {
            gateway: { mode: "local" },
            ...(!gateway ? { legacyFixture: "retained" } : {}),
          },
        });
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
