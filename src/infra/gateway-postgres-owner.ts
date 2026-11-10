// Gateway state ownership for database.localStores none: a PostgreSQL session-level advisory lock.
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { Client } from "pg";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getDatabaseEngineInput } from "./database-engine/context.js";
import type { DatabaseEngineInput } from "./database-engine/types.js";
import { GatewayStateOwnerContentionError } from "./gateway-state-owner-errors.js";

export type GatewayPostgresOwner = {
  /** Ends the owner session, which releases the lock; never reports loss afterwards. */
  release(this: void): Promise<void>;
};

const HEARTBEAT_MS = 10_000;
// Bounds connection startup and every owner query, so a silent server cannot hang startup
// and a half-open session fails the next heartbeat.
const TIMEOUT_MS = 10_000;
const APPLICATION = "openclaw-gateway-owner";
const log = createSubsystemLogger("gateway");
let reportedHolder: string | undefined;

/**
 * Advisory locks are scoped to one database, so the schema prefix names the installation there:
 * every store namespace of an installation starts with it.
 */
function ownerLockKey(schemaPrefix: string): string {
  return createHash("sha256")
    .update(`openclaw.gateway-owner:${schemaPrefix}`)
    .digest()
    .readBigInt64BE()
    .toString();
}

/** Names the live holder from PostgreSQL itself; there is no owner row to go stale. */
async function readHolder(client: Client, key: string) {
  const { rows } = await client.query<{ pid: number; application_name: string }>(
    `SELECT a.pid, a.application_name FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
       AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND ((l.classid::bigint << 32) | l.objid::bigint) = $1::bigint`,
    [key],
  );
  const holder = rows[0];
  const match = holder?.application_name?.match(new RegExp(`^${APPLICATION}:(\\d+):(.*)$`));
  return holder
    ? {
        pid: match ? Number(match[1]) : undefined,
        detail: match
          ? `Gateway pid ${match[1]} on host ${match[2]} holds it (PostgreSQL backend ${holder.pid}).`
          : `PostgreSQL backend ${holder.pid} holds it.`,
      }
    : undefined;
}

/**
 * One dedicated session outside the pool holds the lock; PostgreSQL releases it when that
 * session ends, so a crashed owner leaves nothing to clean up. Any later loss of the session
 * is reported through `onLost`, which retires the process state owner.
 */
async function acquireGatewayPostgresOwner(
  input: Exclude<DatabaseEngineInput, undefined>,
  onLost: (error: Error) => void,
  timing: { heartbeatMs: number; timeoutMs: number },
): Promise<GatewayPostgresOwner> {
  const key = ownerLockKey(input.schemaPrefix);
  const { Client } = await import("pg");
  const client = new Client({
    connectionString: input.connection,
    // Read back by contending owners to name the holder; PostgreSQL truncates it to 63 bytes.
    application_name: `${APPLICATION}:${process.pid}:${hostname()}`,
    connectionTimeoutMillis: timing.timeoutMs,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    query_timeout: timing.timeoutMs,
  });
  // A half-open socket can delay the close; PostgreSQL still drops the lock with the session.
  const endSession = () =>
    Promise.race([
      client.end().catch(() => undefined),
      sleep(timing.timeoutMs, undefined, { ref: false }),
    ]);
  let held = false;
  let lost = false;
  const lose = (error: Error) => {
    if (lost) {
      return;
    }
    lost = true;
    // A failed owner session never keeps the lock; the next owner can take over.
    void endSession();
    if (held) {
      held = false;
      onLost(
        new Error(
          `PostgreSQL Gateway ownership was lost (${error.message}); state work is refused and the Gateway stops. Check the PostgreSQL connection, then restart the Gateway.`,
          { cause: error },
        ),
      );
    }
  };
  client.on("error", lose);
  client.on("end", () => lose(new Error("the ownership session ended")));
  try {
    await client.connect();
    const { rows } = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [key],
    );
    if (!rows[0]?.acquired) {
      const holder = await readHolder(client, key);
      throw new GatewayStateOwnerContentionError(
        `PostgreSQL schema prefix ${input.schemaPrefix}`,
        undefined,
        holder?.detail,
        holder?.pid === undefined ? undefined : { pid: holder.pid },
      );
    }
  } catch (error) {
    lost = true;
    await endSession();
    throw error;
  }
  held = true;
  const heartbeat = setInterval(() => {
    if (lost) {
      clearInterval(heartbeat);
      return;
    }
    client.query("SELECT 1").catch((error: unknown) =>
      lose(
        new Error(`heartbeat failed: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        }),
      ),
    );
  }, timing.heartbeatMs);
  heartbeat.unref();
  return {
    async release() {
      held = false;
      clearInterval(heartbeat);
      lost = true;
      await endSession();
    },
  };
}

/**
 * Takes the install lock when database.localStores is none. Contention names the holder once
 * per holder while the caller waits, and reports the PostgreSQL target to `onContention`.
 */
export async function acquireConfiguredGatewayPostgresOwner(params: {
  onContention: (target: string) => void;
  onLost: (error: Error) => void;
  heartbeatMs?: number;
  timeoutMs?: number;
}): Promise<GatewayPostgresOwner | undefined> {
  const input = getDatabaseEngineInput("state");
  if (input?.localStores !== "none") {
    return undefined;
  }
  try {
    const owner = await acquireGatewayPostgresOwner(input, params.onLost, {
      heartbeatMs: params.heartbeatMs ?? HEARTBEAT_MS,
      timeoutMs: params.timeoutMs ?? TIMEOUT_MS,
    });
    reportedHolder = undefined;
    return owner;
  } catch (error) {
    if (error instanceof GatewayStateOwnerContentionError) {
      params.onContention(error.databasePath);
      const holder = `${error.databasePath}:${error.holderDetail}`;
      if (error.holderDetail && holder !== reportedHolder) {
        reportedHolder = holder;
        log.warn(`Gateway state ownership is held in ${error.databasePath}: ${error.holderDetail}`);
      }
    }
    throw error;
  }
}

/**
 * The PostgreSQL half of one Gateway lock. Each acquisition attempt of the process owner takes a
 * fresh loss signal; `acquire` takes the session lock at most once (also after a late engine
 * selection), and release ends it. Without a signal, as for a borrowed owner, acquire is a no-op.
 */
export function createGatewayPostgresCustody() {
  let owner: GatewayPostgresOwner | undefined;
  let custody: AbortController | undefined;
  return {
    signal(): AbortSignal {
      custody = new AbortController();
      return custody.signal;
    },
    async acquire(onContention: (target: string) => void = () => undefined): Promise<void> {
      const lost = custody;
      if (!owner && lost) {
        owner = await acquireConfiguredGatewayPostgresOwner({
          onContention,
          onLost: (error) => lost.abort(error),
        });
      }
    },
    async release(): Promise<void> {
      const held = owner;
      owner = undefined;
      custody = undefined;
      await held?.release();
    },
  };
}
