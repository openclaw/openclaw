import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import {
  cleanupPostgresStateFixture,
  installPostgresStateFixture,
} from "./openclaw-state-db.postgres-fixture.test-support.js";
import { startOpenClawStateLeaseHeartbeat } from "./openclaw-state-lease-heartbeat.js";
import { acquireOpenClawStateLeaseInTransaction } from "./openclaw-state-lease-store.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const directories = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(!connection)("PostgreSQL state lease heartbeat reconnect", () => {
  it.each([false, true])(
    "recovers an interrupted renewal without reviving lost rows (ownership changed: %s)",
    async (replace) => {
      const directory = directories.make("state-heartbeat-reconnect-");
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: directory,
        OPENCLAW_CONFIG_PATH: path.join(directory, "openclaw.json"),
      };
      fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, "{}");
      installPostgresStateFixture(connection!, "heartbeat_reconnect");
      const client = new pg.Client({ connectionString: connection });
      const observer = new pg.Client({ connectionString: connection });
      await client.connect();
      await observer.connect();
      const heartbeats: ReturnType<typeof startOpenClawStateLeaseHeartbeat>[] = [];
      let namespace: string | undefined;
      let pathname = "";
      try {
        const database = withEngineStoreAdmission(() => openOpenClawStateDatabase({ env }));
        pathname = database.path;
        namespace = getPostgresPhysicalFacts(database.db)!.namespace;
        const table = `"${namespace}".state_leases`;
        const leaseMs = 30_000;
        const lost = [vi.fn(), vi.fn()];
        for (const [index, key] of ["first", "second"].entries()) {
          const identity = { scope: "core:test-heartbeat", key, owner: "original" };
          const acquired = withEngineStoreAdmission(() =>
            runOpenClawStateWriteTransaction(
              ({ db }) => acquireOpenClawStateLeaseInTransaction(db, identity, leaseMs),
              { database, env },
            ),
          );
          if (acquired.kind !== "acquired") {
            throw new Error("Fixture did not acquire its lease");
          }
          const heartbeat = startOpenClawStateLeaseHeartbeat({
            path: pathname,
            identity,
            leaseMs,
            acquiredAt: acquired.expiresAt - leaseMs,
            expiresAt: acquired.expiresAt,
            heartbeatMs: 100,
            onLost: lost[index]!,
          });
          heartbeats.push(heartbeat);
          await heartbeat.ready;
        }
        const rows = async () =>
          (await observer.query(`SELECT * FROM ${table} ORDER BY lease_key`)).rows;
        await client.query("BEGIN");
        await client.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
        const before = (await client.query(`SELECT * FROM ${table} ORDER BY lease_key`)).rows;
        let backend: number | undefined;
        // Wait for the real renewal UPDATE to block, so the socket dies in flight,
        // rather than on idle checkout (which already reconnects).
        await expect
          .poll(async () => {
            const { rows: waiting } = await observer.query<{ pid: number }>(
              `SELECT pid FROM pg_locks WHERE relation = $1::regclass AND NOT granted`,
              [table],
            );
            backend = waiting[0]?.pid;
            return backend;
          })
          .toBeTypeOf("number");
        await observer.query("SELECT pg_terminate_backend($1)", [backend]);
        if (replace) {
          await client.query(`UPDATE ${table} SET owner = 'successor' WHERE lease_key = 'first'`);
          await client.query(`UPDATE ${table} SET expires_at = 0 WHERE lease_key = 'second'`);
        }
        await client.query("COMMIT");
        if (replace) {
          await expect
            .poll(() => lost.map((callback) => callback.mock.calls.length))
            .toEqual([1, 1]);
          expect(lost[0]!.mock.calls[0]?.[0]).toMatchObject({ loss: { reason: "replaced" } });
          expect(lost[1]!.mock.calls[0]?.[0]).toMatchObject({ loss: { reason: "expired" } });
          const after = await rows();
          expect(after[0].owner).toBe("successor");
          expect(Number(after[1].expires_at)).toBe(0);
          expect(after.map((row) => row.heartbeat_at)).toEqual(
            before.map((row) => row.heartbeat_at),
          );
        } else {
          await expect
            .poll(async () => {
              const after = await rows();
              return after.every(
                (row, index) => Number(row.heartbeat_at) > Number(before[index].heartbeat_at),
              );
            })
            .toBe(true);
          expect(lost.map((callback) => callback.mock.calls)).toEqual([[], []]);
          for (const heartbeat of heartbeats) {
            await expect(heartbeat.verify()).resolves.toBeGreaterThan(Date.now());
            await expect(heartbeat.renew()).resolves.toBeGreaterThan(Date.now());
          }
        }
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        await Promise.all(heartbeats.map((heartbeat) => heartbeat.stop()));
        await closeOpenClawStateDatabaseAsync();
        await observer.end();
        await cleanupPostgresStateFixture(client, pathname, namespace);
      }
    },
  );
});
