import { createHash, randomUUID } from "node:crypto";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installDatabaseEngineSelection,
  withDatabaseEngineSelection,
} from "./database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "./database-engine/context.test-support.js";
import { resolveDatabaseFamilyEngines } from "./database-engine/registry.js";
import { createOwnerProxy } from "./gateway-postgres-owner-proxy.test-support.js";
import { acquireConfiguredGatewayPostgresOwner } from "./gateway-postgres-owner.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) {
    await step();
  }
  resetDatabaseEngineSelectionForTest();
  vi.restoreAllMocks();
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
function install(postgres: { connection: string; ownership: "installation" }) {
  const schemaPrefix = `gpo_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  installDatabaseEngineSelection({
    effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
    postgres: { ...postgres, schemaPrefix },
  });
  return schemaPrefix;
}
function ownerBackends(schemaPrefix: string) {
  const key = createHash("sha256")
    .update(`openclaw.gateway-owner:${schemaPrefix}`)
    .digest()
    .readBigUInt64BE();
  return query<{ pid: number }>(
    `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = $1 AND objid = $2 AND objsubid = 1`,
    [String(key >> 32n), String(key & 0xffffffffn)],
  );
}
function acquireDirect(schemaPrefix: string) {
  return withDatabaseEngineSelection(
    {
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: { connection: connection!, schemaPrefix, ownership: "installation" },
    },
    () => acquireConfiguredGatewayPostgresOwner({ onContention() {}, onLost() {} }),
  );
}
describe.skipIf(!connection)("Gateway PostgreSQL owner failure boundaries", () => {
  it.each(["acquire", "holder", "heartbeat"] as const)(
    "bounds %s despite a longer DSN query_timeout",
    async (phase) => {
      const proxy = await createOwnerProxy(connection!, phase === "acquire" ? 1 : 2);
      cleanup.push(proxy.close);
      const target = new URL(proxy.connection);
      target.searchParams.set("query_timeout", "60000");
      const schemaPrefix = install({ connection: target.toString(), ownership: "installation" });
      if (phase === "holder") {
        const first = await acquireDirect(schemaPrefix);
        cleanup.push(async () => first?.release());
      }
      const onLost = vi.fn();
      let result:
        | {
            owner?: Awaited<ReturnType<typeof acquireConfiguredGatewayPostgresOwner>>;
            error?: unknown;
          }
        | undefined;
      const acquisition = acquireConfiguredGatewayPostgresOwner({
        onContention() {},
        onLost,
        heartbeatMs: 50,
        timeoutMs: 200,
      }).then(
        (owner) => {
          result = { owner };
          cleanup.push(async () => owner?.release());
        },
        (error: unknown) => {
          result = { error };
        },
      );
      await Promise.race([
        proxy.stopped,
        acquisition.then(() => {
          throw new Error(
            `Owner settled before proxy boundary: ${result?.error instanceof Error ? result.error.message : JSON.stringify(result)}`,
          );
        }),
      ]);
      if (phase !== "acquire") {
        proxy.forwardRetained();
      }
      if (phase === "heartbeat") {
        await acquisition;
        expect(result?.owner).toBeDefined();
        await vi.waitFor(() => expect(onLost).toHaveBeenCalledTimes(1), { timeout: 1_500 });
        expect(String(onLost.mock.calls[0]?.[0])).toMatch(/Query read timeout/);
      } else {
        await vi.waitFor(() => expect(result).toBeDefined(), { timeout: 1_500 });
        await acquisition;
        expect(String(result?.error)).toMatch(/Query read timeout/);
        expect(onLost).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects lock success followed by FATAL before ownership handoff", async () => {
    const proxy = await createOwnerProxy(connection!, 2);
    cleanup.push(proxy.close);
    const schemaPrefix = install({ connection: proxy.connection, ownership: "installation" });
    const queries = vi.spyOn(pg.Client.prototype, "query");
    cleanup.push(async () => queries.mockRestore());
    const onLost = vi.fn();
    let settled = false;
    const acquisition = acquireConfiguredGatewayPostgresOwner({
      onContention() {},
      onLost,
      heartbeatMs: 50,
      timeoutMs: 2_000,
    }).then(
      (owner) => {
        settled = true;
        cleanup.push(async () => owner?.release());
        return { owner, error: undefined };
      },
      (error: unknown) => {
        settled = true;
        return { owner: undefined, error };
      },
    );
    await Promise.race([
      proxy.stopped,
      acquisition.then((result) => {
        throw new Error(
          `Owner settled before lock response: ${result.error instanceof Error ? result.error.message : JSON.stringify(result)}`,
        );
      }),
    ]);
    const client = queries.mock.contexts.find(
      (context): context is pg.Client =>
        context instanceof pg.Client && context.port === proxy.port,
    );
    if (!client) {
      throw new Error("Expected real owner client");
    }
    const socket = client.connection.stream;
    socket.pause();
    let fatalBeforeSettlement = false;
    client.on("error", () => {
      fatalBeforeSettlement = !settled;
    });
    const backends = await ownerBackends(schemaPrefix);
    expect(backends).toHaveLength(1);
    await query("SELECT pg_terminate_backend($1)", [backends[0]?.pid]);
    await proxy.fatal;
    const bytes = proxy.forwardRetained();
    await vi.waitFor(() => expect(socket.readableLength).toBeGreaterThanOrEqual(bytes));
    // A paused exact-length read emits one data event synchronously. The actual
    // pg parser must consume success and FATAL before promise continuations run.
    expect(socket.read(bytes)).toHaveLength(bytes);
    socket.resume();
    expect(fatalBeforeSettlement).toBe(true);
    const result = await acquisition;
    expect(result.owner).toBeUndefined();
    expect(String(result.error)).toMatch(/terminat/i);
    expect(onLost).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(socket.destroyed).toBe(true));
    expect(
      queries.mock.calls
        .map(([config]): string | pg.QueryConfig => config)
        .filter((config) =>
          typeof config === "string" ? config === "SELECT 1" : config.text === "SELECT 1",
        ),
    ).toHaveLength(0);
    const next = await acquireDirect(schemaPrefix);
    cleanup.push(async () => next?.release());
    expect(next).toBeDefined();
  });
});
