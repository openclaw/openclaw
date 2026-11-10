import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import { hostname } from "node:os";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { installDatabaseEngineSelection } from "./database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "./database-engine/context.test-support.js";
import { resolveDatabaseFamilyEngines } from "./database-engine/registry.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { acquireConfiguredGatewayPostgresOwner } from "./gateway-postgres-owner.js";
import { captureGatewayStateOwner, captureStateDatabaseAccess } from "./gateway-state-owner.js";

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

function install(postgres: { connection: string; localStores?: "none" }) {
  const schemaPrefix = `gpo_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  installDatabaseEngineSelection({
    effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
    postgres: { ...postgres, schemaPrefix },
  });
  return schemaPrefix;
}

/**
 * Each call is a separate host: its own state dir and lock dir, the same database. The
 * maintenance role skips state-store setup; the gateway role admits ordinary state work.
 */
async function acquireOnHost(role: "maintenance" | "gateway" = "maintenance") {
  const stateDir = tempDirs.make("gateway-pg-owner-host-");
  const lock = await acquireGatewayLock({
    env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: path.join(stateDir, "c.json") },
    lockDir: path.join(stateDir, "locks"),
    ...(role === "maintenance" ? { databaseAccess: "none" as const } : {}),
    allowInTests: true,
    timeoutMs: 0,
  });
  if (!lock) {
    throw new Error("Gateway ownership was not acquired");
  }
  cleanup.push(lock.release);
  return { lock, databasePath: path.join(stateDir, "state", "openclaw.sqlite") };
}

function ownerBackends(schemaPrefix: string) {
  const key = createHash("sha256")
    .update(`openclaw.gateway-owner:${schemaPrefix}`)
    .digest()
    .readBigUInt64BE();
  return query<{ pid: number }>(
    `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted
       AND classid = $1 AND objid = $2 AND objsubid = 1`,
    [String(key >> 32n), String(key & 0xffffffffn)],
  );
}

it("bounds connection startup and closes the failed attempt", async () => {
  const closed: Promise<void>[] = [];
  const silent = net.createServer((socket) => {
    // Reading the socket lets the client's close surface here as "close".
    socket.resume();
    closed.push(
      new Promise((resolve) => {
        socket.once("close", () => resolve());
      }),
    );
  });
  await new Promise<void>((resolve) => {
    silent.listen(0, "127.0.0.1", resolve);
  });
  cleanup.push(
    () =>
      new Promise((resolve) => {
        silent.close(resolve);
      }),
  );
  const address = silent.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP listener");
  }
  install({ connection: `postgres://owner@127.0.0.1:${address.port}/silent`, localStores: "none" });

  await expect(
    acquireConfiguredGatewayPostgresOwner({ onContention() {}, onLost() {}, timeoutMs: 200 }),
  ).rejects.toThrow(/timeout/i);
  expect(closed).toHaveLength(1);
  await closed[0];
});

describe.skipIf(!connection)("Gateway ownership with database.localStores none", () => {
  it("refuses a second Gateway on another host and names the holder", async () => {
    const schemaPrefix = install({ connection: connection!, localStores: "none" });
    const first = await acquireOnHost();

    const refused = acquireOnHost();
    await expect(refused).rejects.toThrow(
      new RegExp(
        `busy at PostgreSQL schema prefix ${schemaPrefix}\\. Gateway pid ${process.pid} on host ${hostname()
          .slice(0, 20)
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    );
    await expect(refused).rejects.not.toThrow(/openclaw\.sqlite/);

    await first.lock.release();
    await first.lock.release();
    await acquireOnHost();
  });

  it("retires the former Gateway's state owner when its session is terminated", async () => {
    const schemaPrefix = install({ connection: connection!, localStores: "none" });
    const former = await acquireOnHost("gateway");
    const owner = captureGatewayStateOwner(former.databasePath);
    // Captured before the loss, as work queued in a worker would be.
    const queued = (await captureStateDatabaseAccess(former.databasePath)).processOwner;
    expect(owner?.signal.aborted).toBe(false);
    queued?.assertCurrent();

    const backends = await ownerBackends(schemaPrefix);
    expect(backends).toHaveLength(1);
    await query("SELECT pg_terminate_backend($1)", [backends[0]?.pid]);

    await vi.waitFor(() => expect(owner?.signal.aborted).toBe(true));
    expect(String(owner?.signal.reason)).toMatch(/PostgreSQL Gateway ownership was lost/);
    expect(() => queued?.assertCurrent()).toThrow(/PostgreSQL Gateway ownership was lost/);
    expect(() => former.lock.assertCurrent()).toThrow(/PostgreSQL Gateway ownership was lost/);
    expect(() => captureGatewayStateOwner(former.databasePath)).toThrow(
      /PostgreSQL Gateway ownership was lost/,
    );
    await expect(
      captureStateDatabaseAccess(former.databasePath).then((access) => access.prepareAccess()),
    ).rejects.toThrow(/PostgreSQL Gateway ownership was lost/);

    await acquireOnHost("gateway");
    expect(await ownerBackends(schemaPrefix)).toHaveLength(1);
  });

  it("reports loss when the network goes silent, from the next heartbeat", async () => {
    const target = new URL(connection!);
    const upstream = { port: Number(target.port || 5432), host: target.hostname };
    let silent = false;
    const proxy = net.createServer((inbound) => {
      const outbound = net.connect(upstream.port, upstream.host);
      // A silent network drops bytes both ways without closing either socket.
      inbound.on("data", (chunk) => {
        if (!silent) {
          outbound.write(chunk);
        }
      });
      outbound.on("data", (chunk) => {
        if (!silent) {
          inbound.write(chunk);
        }
      });
      inbound.on("error", () => outbound.destroy());
      outbound.on("error", () => inbound.destroy());
      cleanup.push(async () => {
        inbound.destroy();
        outbound.destroy();
      });
    });
    await new Promise<void>((resolve) => {
      proxy.listen(0, "127.0.0.1", resolve);
    });
    cleanup.push(
      () =>
        new Promise((resolve) => {
          proxy.close(resolve);
        }),
    );
    const address = proxy.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP listener");
    }
    target.host = `127.0.0.1:${address.port}`;
    install({ connection: target.toString(), localStores: "none" });
    const onLost = vi.fn();

    const owner = await acquireConfiguredGatewayPostgresOwner({
      onContention() {},
      onLost,
      heartbeatMs: 100,
      timeoutMs: 2_000,
    });
    cleanup.push(async () => owner?.release());
    silent = true;

    await vi.waitFor(() => expect(onLost).toHaveBeenCalledTimes(1), { timeout: 6_000 });
    expect(String(onLost.mock.calls[0]?.[0])).toMatch(/heartbeat failed: Query read timeout/);
  });

  it("leaves the default mode on per-state-dir file ownership", async () => {
    const schemaPrefix = install({ connection: connection! });

    await acquireOnHost();
    await acquireOnHost();

    expect(await ownerBackends(schemaPrefix)).toHaveLength(0);
  });
});
