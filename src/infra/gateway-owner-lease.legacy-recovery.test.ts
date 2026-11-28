import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveGatewayLockPaths } from "./gateway-lock.js";
import {
  acquireLock,
  createGatewayOwnerLeaseFixtures,
} from "./gateway-owner-lease.test-support.js";
import { requireNodeSqlite } from "./node-sqlite.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

const { seedClosedOwner } = createGatewayOwnerLeaseFixtures(tempDirs);

describe("legacy Gateway owner lease recovery", () => {
  it.skipIf(process.platform !== "linux").each(["expired", "missing"] as const)(
    "recovers a legacy Gateway lock only after its matching lease is %s",
    async (kind) => {
      const env = await seedClosedOwner({}, (stateEnv) => {
        withOpenClawStateStartupMigrationCheckpointDatabase(
          (db) => {
            db.prepare(
              "UPDATE state_leases SET payload_json = json_remove(payload_json, '$.owner.processNamespace') WHERE scope = 'gateway-owner'",
            ).run();
          },
          { env: stateEnv },
        );
      });
      const databasePath = resolveOpenClawStateSqlitePath(env);
      const paths = resolveGatewayLockPaths(env);
      const payload = {
        pid: 2_147_483_647,
        ownerId: "previous-generation",
        role: "gateway",
        createdAt: new Date(Date.now() - 300_001).toISOString(),
        configPath: paths.configPath,
        stateDir: paths.stateDir,
      };
      fs.mkdirSync(path.dirname(paths.ownerLockPath), { recursive: true });
      const writeLocks = (value: object) => {
        for (const file of [paths.ownerLockPath, paths.stateLockPath]) {
          fs.writeFileSync(file, JSON.stringify(value));
        }
      };
      const acquire = () => acquireLock(env, { role: "sqlite-maintenance", timeoutMs: 0 });
      writeLocks(payload);
      const old = new Date(Date.now() - 600_000);
      fs.utimesSync(paths.ownerLockPath, old, old);
      await expect(acquire()).rejects.toThrow("cannot verify Gateway ownership");

      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(databasePath);
      try {
        if (kind === "missing") {
          db.prepare("DELETE FROM state_leases WHERE scope = 'gateway-owner'").run();
        } else {
          db.prepare("UPDATE state_leases SET expires_at = ? WHERE scope = 'gateway-owner'").run(
            Date.now() - 1,
          );
        }
      } finally {
        db.close();
      }
      for (const changed of [
        { ownerId: undefined },
        { role: undefined },
        { role: "sqlite-maintenance" },
        { processNamespace: null },
        { createdAt: new Date().toISOString() },
        { createdAt: "invalid" },
      ]) {
        writeLocks({ ...payload, ...changed });
        await expect(acquire()).rejects.toThrow("cannot verify Gateway ownership");
        if ("role" in changed && changed.role === undefined) {
          await expect(acquire()).rejects.toThrow("openclaw gateway recover-lock --json");
        }
      }
      writeLocks(payload);
      fs.renameSync(databasePath, databasePath + ".unavailable");
      try {
        await expect(acquire()).rejects.toThrow("cannot verify Gateway ownership");
      } finally {
        fs.renameSync(databasePath + ".unavailable", databasePath);
      }
      const owner = await acquire();
      expect(owner).not.toBeNull();
      await owner?.release();
    },
  );

  it.skipIf(process.platform !== "linux")(
    "waits for the five-minute legacy lease instead of ending maintenance admission at 95 seconds",
    async () => {
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const env = await seedClosedOwner({ expiresAt: now + 300_000 }, (stateEnv) => {
        withOpenClawStateStartupMigrationCheckpointDatabase(
          (db) => {
            db.prepare(
              "UPDATE state_leases SET payload_json = json_remove(payload_json, '$.owner.processNamespace') WHERE scope = 'gateway-owner'",
            ).run();
          },
          { env: stateEnv },
        );
      });
      const paths = resolveGatewayLockPaths(env);
      fs.mkdirSync(path.dirname(paths.ownerLockPath), { recursive: true });
      fs.writeFileSync(
        paths.ownerLockPath,
        JSON.stringify({
          pid: 2_147_483_647,
          ownerId: "previous-generation",
          role: "gateway",
          createdAt: new Date(now).toISOString(),
          configPath: paths.configPath,
        }),
      );
      const startedAt = now;
      const owner = await acquireLock(env, {
        role: "sqlite-maintenance",
        databaseAccess: "none",
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      });
      expect(now - startedAt).toBeGreaterThan(300_000);
      expect(now - startedAt).toBeLessThanOrEqual(305_000);
      await owner?.release();
    },
  );

  it.skipIf(process.platform !== "linux")(
    "admits maintenance after an expired legacy Gateway lease without leftover lock files",
    async () => {
      const env = await seedClosedOwner({ expiresAt: Date.now() - 1 }, (stateEnv) => {
        withOpenClawStateStartupMigrationCheckpointDatabase(
          (db) => {
            db.prepare(
              "UPDATE state_leases SET payload_json = json_remove(payload_json, '$.owner.processNamespace') WHERE scope = 'gateway-owner'",
            ).run();
          },
          { env: stateEnv },
        );
      });
      const owner = await acquireLock(env, { role: "sqlite-maintenance", timeoutMs: 0 });
      expect(owner).not.toBeNull();
      await owner?.release();
    },
  );
});
