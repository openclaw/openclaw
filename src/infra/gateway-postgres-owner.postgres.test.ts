import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { installDatabaseEngineSelection } from "./database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "./database-engine/context.test-support.js";
import { readOrCreateInstallationId } from "./database-engine/install-identity.js";
import { resolveDatabaseFamilyEngines } from "./database-engine/registry.js";
import { acquireGatewayLock, type GatewayLockHandle } from "./gateway-lock.js";
import { acquireGatewayPostgresOwner, gatewayOwnerLockKey } from "./gateway-postgres-owner.js";
import { createManagedHandoffBootIdentityReader } from "./update-managed-service-handoff-boot.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cleanup: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) {
    await step();
  }
  resetDatabaseEngineSelectionForTest();
});

async function query<T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) {
  const admin = new pg.Client({ connectionString: connection });
  await admin.connect();
  try {
    return (await admin.query<T>(sql, values)).rows;
  } finally {
    await admin.end();
  }
}

function createInstall(localStores: boolean) {
  const schemaPrefix = `gpo_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const installationId = readOrCreateInstallationId(tempDirs.make("gateway-pg-owner-id-"));
  cleanup.push(() => query(`DROP SCHEMA IF EXISTS "${schemaPrefix}_install" CASCADE`));
  const input = { connection: connection!, schemaPrefix, localStores: { installationId } };
  installDatabaseEngineSelection({
    effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
    postgres: localStores ? input : { connection: connection!, schemaPrefix },
  });
  return input;
}

/** Each call is a separate host: its own state dir and lock dir, the same install. */
async function acquireOnHost(): Promise<GatewayLockHandle> {
  const stateDir = tempDirs.make("gateway-pg-owner-host-");
  const lock = await acquireGatewayLock({
    env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: path.join(stateDir, "c.json") },
    lockDir: path.join(stateDir, "locks"),
    databaseAccess: "none",
    allowInTests: true,
    timeoutMs: 0,
  });
  if (!lock) {
    throw new Error("Gateway ownership was not acquired");
  }
  cleanup.push(lock.release);
  return lock;
}

async function installSchemaExists(schemaPrefix: string) {
  const rows = await query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [
    `${schemaPrefix}_install`,
  ]);
  return rows.length > 0;
}

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe.skipIf(!connection)("Gateway ownership with database.localStores none", () => {
  it("refuses a second Gateway on another host and names the holder", async () => {
    const install = createInstall(true);
    const first = await acquireOnHost();
    const boot = createManagedHandoffBootIdentityReader(process.env)();

    const refused = acquireOnHost();
    await expect(refused).rejects.toThrow(
      new RegExp(
        `busy at PostgreSQL schema ${install.schemaPrefix}_install[\\s\\S]*pid ${process.pid} on host ${escape(hostname())} \\(boot ${escape(`${boot.platform}:${boot.identity}`)}\\)`,
      ),
    );
    await expect(refused).rejects.not.toThrow(/openclaw\.sqlite/);

    await first.release();
    await first.release();
    await acquireOnHost();
  });

  it("loses ownership when the session ends or the heartbeat fails, and releases the lock", async () => {
    const install = createInstall(true);
    const terminated = await acquireGatewayPostgresOwner(install);
    cleanup.push(terminated.release);
    await expect(acquireGatewayPostgresOwner(install)).rejects.toThrow(/busy at PostgreSQL/);
    const key = BigInt.asUintN(64, BigInt(gatewayOwnerLockKey(install.localStores.installationId)));
    const backends = await query(
      `SELECT pg_terminate_backend(pid) FROM pg_locks
       WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND objsubid = 1`,
      [String(key >> 32n), String(key & 0xffffffffn)],
    );
    expect(backends).toHaveLength(1);
    await vi.waitFor(() => expect(terminated.assertCurrent).toThrow(/ownership was lost/));

    const stalled = await acquireGatewayPostgresOwner(install, { heartbeatMs: 20 });
    cleanup.push(stalled.release);
    await query(`DROP TABLE "${install.schemaPrefix}_install".gateway_owner`);
    await vi.waitFor(() => expect(stalled.assertCurrent).toThrow(/lost: heartbeat failed/));

    const next = await acquireGatewayPostgresOwner(install);
    next.assertCurrent();
    await next.release();
    await next.release();
    expect(next.assertCurrent).toThrow(/was released/);
    const after = await acquireGatewayPostgresOwner(install);
    cleanup.push(after.release);
  });

  it("leaves the default mode on per-state-dir file ownership", async () => {
    const install = createInstall(false);

    await acquireOnHost();
    await acquireOnHost();

    expect(await installSchemaExists(install.schemaPrefix)).toBe(false);
  });
});
