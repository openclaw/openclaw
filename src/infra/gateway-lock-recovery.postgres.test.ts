import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { stateEngineSchema } from "../state/openclaw-state-db-engine.js";
import { withDatabaseEngineSelection } from "./database-engine/context.js";
import { resolveDatabaseFamilyEngines } from "./database-engine/registry.js";
import { readGatewayLockProcessNamespace } from "./gateway-lock-payload.js";
import { inspectGatewayLockRecovery, recoverGatewayLock } from "./gateway-lock-recovery.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

describe.skipIf(!connection)("confirmed PostgreSQL Gateway owner recovery", () => {
  const client = new pg.Client({ connectionString: connection });
  const namespaces: string[] = [];
  const quote = pg.escapeIdentifier;
  beforeAll(() => client.connect());
  afterAll(async () => {
    try {
      for (const namespace of namespaces) {
        await client.query(`DROP SCHEMA ${quote(namespace)} CASCADE`);
      }
    } finally {
      await client.end();
    }
  });

  async function fixture() {
    const root = directories.make("gateway-pg-recovery-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
    const storeId = randomUUID(),
      namespace = `lock_recovery_${randomUUID().replaceAll("-", "")}`;
    namespaces.push(namespace);
    const file = path.join(root, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    using db = openNodeSqliteDatabase(file);
    db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)");
    db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run(
      storeId,
      namespace,
    );
    await client.query(`CREATE SCHEMA ${quote(namespace)};
      CREATE TABLE ${quote(namespace)}.openclaw_schema_meta (store TEXT, version BIGINT, store_id TEXT);
      CREATE TABLE ${quote(namespace)}.state_leases (scope TEXT, lease_key TEXT, owner TEXT, expires_at BIGINT,
        heartbeat_at BIGINT, payload_json TEXT, created_at BIGINT, updated_at BIGINT);
      CREATE TABLE ${quote(namespace)}.retained_history (event_id TEXT, body TEXT)`);
    await client.query(
      `INSERT INTO ${quote(namespace)}.openclaw_schema_meta VALUES ('state', $2, $1)`,
      [storeId, stateEngineSchema.version],
    );
    const payload = JSON.stringify({
      owner: {
        pid: 2147483647,
        host: "stopped-old-pod",
        startedAt: 1,
        processNamespace: { ...readGatewayLockProcessNamespace(), host: "stopped-old-pod" },
      },
      port: 18789,
      mode: "foreground",
      supervisor: null,
    });
    await client.query(
      `INSERT INTO ${quote(namespace)}.state_leases VALUES ('gateway-owner','global','old-owner',2,1,$1,1,1),
      ('unrelated','global','retained-neighbor',2,1,$1,1,1)`,
      [payload],
    );
    await client.query(
      `INSERT INTO ${quote(namespace)}.retained_history VALUES ('original-event','retained bytes')`,
    );
    const selected = {
      effectiveEngines: resolveDatabaseFamilyEngines({
        database: { engine: "sqlite", families: { state: { engine: "postgres" } } },
      }),
      postgres: { connection: connection!, schemaPrefix: "lock_recovery" },
    };
    return {
      root,
      file,
      storeId,
      namespace,
      selected,
      run: <T>(body: () => T) => withDatabaseEngineSelection(selected, body),
      rows: async () =>
        (await client.query(`SELECT * FROM ${quote(namespace)}.state_leases ORDER BY scope`)).rows,
      change: (sql: string, values?: unknown[]) =>
        client.query(sql.replaceAll("$namespace", quote(namespace)), values),
    };
  }

  it("recovers the exact owner at the current GLOBAL schema version", async () => {
    const h = await fixture();
    await h.run(async () => {
      const before = await h.rows();
      const inspected = await inspectGatewayLockRecovery();
      expect(inspected.lease?.owner).toBe("old-owner");
      expect(await h.rows()).toEqual(before);
      expect(inspected.holders.join("\n")).toContain("PostgreSQL Gateway owner lease");
      await expect(recoverGatewayLock({ confirmation: inspected.confirmation })).resolves.toEqual({
        recovered: true,
        removed: 1,
      });
      expect(await h.rows()).toEqual(before.filter((row) => row.scope !== "gateway-owner"));
      expect((await h.change("SELECT * FROM $namespace.retained_history")).rows).toEqual([
        { event_id: "original-event", body: "retained bytes" },
      ]);
      using anchor = openNodeSqliteDatabase(h.file, { readOnly: true });
      expect(anchor.prepare("SELECT * FROM openclaw_engine_anchor").all()).toEqual([
        { store_id: h.storeId, engine: "postgres", schema: h.namespace },
      ]);
      expect(anchor.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([
        { name: "openclaw_engine_anchor" },
      ]);
      const absent = await inspectGatewayLockRecovery();
      await expect(recoverGatewayLock({ confirmation: absent.confirmation })).resolves.toEqual({
        recovered: false,
        removed: 0,
      });
    });
  });

  it("inspects future GLOBAL state but refuses confirmation before a future DELETE trigger can remove work", async () => {
    const h = await fixture();
    await h.change("UPDATE $namespace.openclaw_schema_meta SET version=$1", [
      stateEngineSchema.version + 1,
    ]);
    await h.change(`CREATE FUNCTION $namespace.future_lease_cleanup() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN DELETE FROM $namespace.retained_history; RETURN OLD; END $$;
      CREATE TRIGGER future_lease_cleanup AFTER DELETE ON $namespace.state_leases
      FOR EACH ROW EXECUTE FUNCTION $namespace.future_lease_cleanup()`);
    await h.run(async () => {
      const before = await h.rows();
      const inspected = await inspectGatewayLockRecovery();
      expect(inspected.lease?.owner).toBe("old-owner");
      await expect(recoverGatewayLock({ confirmation: inspected.confirmation })).rejects.toThrow(
        /schema version.*not supported/,
      );
      expect(await h.rows()).toEqual(before);
      expect((await h.change("SELECT * FROM $namespace.retained_history")).rows).toEqual([
        { event_id: "original-event", body: "retained bytes" },
      ]);
    });
  });

  it.each([
    "owner",
    "heartbeat",
    "revision",
    "payload",
    "store-id",
    "namespace",
    "anchor-file",
    "state-version",
    "selection",
  ])("refuses changed %s without altering the owner", async (change) => {
    const h = await fixture();
    await h.run(async () => {
      const inspected = await inspectGatewayLockRecovery();
      if (change === "store-id") {
        await h.change("UPDATE $namespace.openclaw_schema_meta SET store_id=$1", [randomUUID()]);
      } else if (change === "state-version") {
        await h.change("UPDATE $namespace.openclaw_schema_meta SET version=$1", [
          stateEngineSchema.version + 1,
        ]);
      } else if (change === "anchor-file") {
        fs.renameSync(h.file, `${h.file}.old`);
        fs.copyFileSync(`${h.file}.old`, h.file);
      } else if (change === "namespace") {
        using db = openNodeSqliteDatabase(h.file);
        db.prepare("UPDATE openclaw_engine_anchor SET schema=?").run("missing_recovery_namespace");
      } else if (change !== "selection") {
        const fields = {
          owner: "owner='new-owner'",
          heartbeat: "heartbeat_at=3",
          revision: "updated_at=3",
          payload: "payload_json=replace(payload_json,'stopped-old-pod','new-pod')",
        };
        await h.change(
          `UPDATE $namespace.state_leases SET ${fields[change as keyof typeof fields]} WHERE scope='gateway-owner'`,
        );
      }
      const before = await h.rows();
      const recover = () => recoverGatewayLock({ confirmation: inspected.confirmation });
      const changedConnection = new URL(connection!);
      changedConnection.searchParams.set("application_name", "changed-recovery-selection");
      const changed = {
        ...h.selected,
        postgres: {
          ...h.selected.postgres,
          connection: changedConnection.href,
        },
      };
      await expect(
        change === "selection" ? withDatabaseEngineSelection(changed, recover) : recover(),
      ).rejects.toThrow();
      expect(await h.rows()).toEqual(before);
    });
  });

  it.each(["zero-version", "missing-column", "ambiguous", "malformed-owner"])(
    "refuses an unqualified %s store during inspection",
    async (scenario) => {
      const h = await fixture();
      if (scenario === "zero-version") {
        await h.change("UPDATE $namespace.openclaw_schema_meta SET version=0");
      }
      if (scenario === "missing-column") {
        await h.change("ALTER TABLE $namespace.state_leases DROP COLUMN heartbeat_at");
      }
      if (scenario === "ambiguous") {
        await h.change(
          "INSERT INTO $namespace.state_leases SELECT * FROM $namespace.state_leases WHERE scope='gateway-owner'",
        );
      }
      if (scenario === "malformed-owner") {
        await h.change(
          "UPDATE $namespace.state_leases SET payload_json='{}' WHERE scope='gateway-owner'",
        );
      }
      await h.run(() => expect(inspectGatewayLockRecovery()).rejects.toThrow());
    },
  );

  it("refuses an unavailable selected PostgreSQL store without SQLite fallback", async () => {
    const h = await fixture();
    const unavailable = new URL(connection!);
    unavailable.port = "1";
    await h.run(async () => {
      const before = await h.rows();
      await expect(
        withDatabaseEngineSelection(
          {
            ...h.selected,
            postgres: { ...h.selected.postgres, connection: unavailable.href },
          },
          () => inspectGatewayLockRecovery(),
        ),
      ).rejects.toThrow();
      expect(await h.rows()).toEqual(before);
      using anchor = openNodeSqliteDatabase(h.file, { readOnly: true });
      expect(anchor.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([
        { name: "openclaw_engine_anchor" },
      ]);
    });
  });

  it("refuses a verified live local lease and bounded store-lock contention", async () => {
    const h = await fixture();
    await h.run(async () => {
      const saved = await h.rows();
      const payload = JSON.stringify({
        owner: {
          pid: process.pid,
          host: readGatewayLockProcessNamespace()!.host,
          startedAt: getFileLockProcessStartTime(process.pid),
          processNamespace: readGatewayLockProcessNamespace(),
        },
        port: 18789,
        mode: "foreground",
        supervisor: null,
      });
      await h.change(
        "UPDATE $namespace.state_leases SET payload_json=$1 WHERE scope='gateway-owner'",
        [payload],
      );
      const live = await inspectGatewayLockRecovery();
      await expect(recoverGatewayLock({ confirmation: live.confirmation })).rejects.toThrow(
        "still live",
      );
      await h.change(
        "UPDATE $namespace.state_leases SET payload_json=$1 WHERE scope='gateway-owner'",
        [saved.find((row) => row.scope === "gateway-owner").payload_json],
      );
      const inspected = await inspectGatewayLockRecovery();
      const key = createHash("sha256").update(h.storeId).digest().readBigInt64BE().toString();
      await client.query("SELECT pg_advisory_lock($1::bigint)", [key]);
      try {
        await expect(recoverGatewayLock({ confirmation: inspected.confirmation })).rejects.toThrow(
          "store is busy",
        );
      } finally {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [key]);
      }
      expect(await h.rows()).toEqual(saved);
    });
  });

  it.each(["lease", "anchor"])(
    "rechecks a changed %s after waiting for its PostgreSQL row lock",
    async (change) => {
      const h = await fixture();
      const blocker = new pg.Client({ connectionString: connection });
      await blocker.connect();
      try {
        await h.run(async () => {
          const inspected = await inspectGatewayLockRecovery();
          await blocker.query("BEGIN");
          await blocker.query(
            `SELECT * FROM ${quote(h.namespace)}.state_leases WHERE scope='gateway-owner' FOR UPDATE`,
          );
          const recovering = recoverGatewayLock({ confirmation: inspected.confirmation });
          void recovering.catch(() => {});
          await vi.waitFor(
            async () => {
              const waiting = await client.query(
                "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1",
                [`%FROM ${quote(h.namespace)}.state_leases AS lease%FOR UPDATE%`],
              );
              expect(waiting.rows).toHaveLength(1);
            },
            { timeout: 5000, interval: 10 },
          );
          if (change === "lease") {
            await blocker.query(
              `UPDATE ${quote(h.namespace)}.state_leases SET updated_at=8 WHERE scope='gateway-owner'`,
            );
          } else {
            using anchor = openNodeSqliteDatabase(h.file);
            anchor.prepare("UPDATE openclaw_engine_anchor SET store_id=?").run(randomUUID());
          }
          await blocker.query("COMMIT");
          const rows = await h.rows();
          await expect(recovering).rejects.toThrow(/changed/);
          expect(await h.rows()).toEqual(rows);
        });
      } finally {
        await blocker.query("ROLLBACK");
        await blocker.end();
      }
    },
  );

  it.each(["commit", "close"])(
    "does not acknowledge recovery after a lost %s acknowledgement",
    async (lost) => {
      const h = await fixture();
      await h.run(async () => {
        const inspected = await inspectGatewayLockRecovery();
        // These recovery calls use pg's promise overloads, not its callback overloads.
        const methods = pg.Client.prototype as unknown as {
          query: (...args: unknown[]) => Promise<pg.QueryResult>;
          end: (...args: unknown[]) => Promise<void>;
        };
        const query = methods.query,
          end = methods.end;
        let committed = false;
        const queries = vi.spyOn(methods, "query").mockImplementation(function (
          this: pg.Client,
          ...args
        ) {
          const result = Reflect.apply(query, this, args) as unknown as Promise<pg.QueryResult>;
          if (args[0] !== "COMMIT") {
            return result;
          }
          return result.then((value) => {
            committed = true;
            if (lost === "commit") {
              throw new Error("synthetic commit acknowledgement lost");
            }
            return value;
          });
        });
        const closing = vi.spyOn(methods, "end").mockImplementation(function (
          this: pg.Client,
          ...args
        ) {
          const result = Reflect.apply(end, this, args) as unknown as Promise<void>;
          return committed && lost === "close"
            ? result.then(() => {
                throw new Error("synthetic close acknowledgement lost");
              })
            : result;
        });
        try {
          await expect(
            recoverGatewayLock({ confirmation: inspected.confirmation }),
          ).rejects.toThrow(/acknowledgement lost/);
        } finally {
          queries.mockRestore();
          closing.mockRestore();
        }
        expect(committed).toBe(true);
        expect((await h.rows()).map((row) => row.owner)).toEqual(["retained-neighbor"]);
        expect((await h.change("SELECT body FROM $namespace.retained_history")).rows).toEqual([
          { body: "retained bytes" },
        ]);
      });
    },
  );
});
