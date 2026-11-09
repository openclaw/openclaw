// Gateway state ownership for database.localStores none: a PostgreSQL session-level advisory lock.
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import type { Client } from "pg";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getDatabaseEngineInput } from "./database-engine/context.js";
import { installSchemaName } from "./database-engine/install-identity.js";
import type { DatabaseEngineInput } from "./database-engine/types.js";
import { GatewayStateOwnerContentionError } from "./gateway-state-owner-errors.js";
import { createManagedHandoffBootIdentityReader } from "./update-managed-service-handoff-boot.js";

type InstallInput = Exclude<DatabaseEngineInput, undefined> & {
  localStores: Readonly<{ installationId: string }>;
};

export type GatewayPostgresOwner = {
  assertCurrent(this: void): void;
  release(this: void): Promise<void>;
};

const HEARTBEAT_MS = 10_000;
// Bounds every owner-session query, so a half-open connection is detected by the heartbeat.
const QUERY_TIMEOUT_MS = 10_000;
const log = createSubsystemLogger("gateway");
let reportedHolder: string | undefined;

function advisoryKey(scope: string): string {
  return createHash("sha256").update(scope).digest().readBigInt64BE().toString();
}

/** Distinct from store writer locks, which hash the bare store UUID. */
function gatewayOwnerLockKey(installationId: string): string {
  return advisoryKey(`openclaw.gateway-owner:${installationId}`);
}

function isInstallOwnedInput(input: DatabaseEngineInput): input is InstallInput {
  return input?.localStores !== undefined;
}

function describeOwnerTarget(input: InstallInput): string {
  return `PostgreSQL schema ${installSchemaName(input.schemaPrefix)} (installation ${input.localStores.installationId})`;
}

function readBootId(): string | null {
  try {
    const boot = createManagedHandoffBootIdentityReader(process.env)();
    return `${boot.platform}:${boot.identity}`;
  } catch {
    return null;
  }
}

async function readOwnerRow(client: Client, input: InstallInput) {
  try {
    const { rows } = await client.query<{
      pid: number;
      host: string;
      boot_id: string | null;
      heartbeat_at: string;
    }>(
      `SELECT pid, host, boot_id, heartbeat_at::text FROM "${installSchemaName(input.schemaPrefix)}".gateway_owner
       WHERE installation_id = $1`,
      [input.localStores.installationId],
    );
    return rows[0];
  } catch (error) {
    // The holder may not have created the install schema yet.
    if (
      error instanceof Error &&
      "code" in error &&
      ["3F000", "42P01"].includes(String(error.code))
    ) {
      return undefined;
    }
    throw error;
  }
}

/**
 * One dedicated session outside the pool holds the lock; PostgreSQL releases it when that
 * session ends, so a crashed owner leaves nothing to clean up. The owner row is diagnostic only.
 */
async function acquireGatewayPostgresOwner(
  input: InstallInput,
  options: { heartbeatMs?: number } = {},
): Promise<GatewayPostgresOwner> {
  const { installationId } = input.localStores;
  const schema = `"${installSchemaName(input.schemaPrefix)}"`;
  const { Client } = await import("pg");
  const client = new Client({
    connectionString: input.connection,
    application_name: "openclaw-gateway-owner",
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    query_timeout: QUERY_TIMEOUT_MS,
  });
  let lost: Error | undefined;
  let released = false;
  const lose = (error: Error) => {
    if (lost) {
      return;
    }
    lost = error;
    // A failed owner session never keeps the lock; the next owner can take over.
    void client.end().catch(() => undefined);
  };
  client.on("error", lose);
  client.on("end", () => lose(new Error("PostgreSQL Gateway ownership session ended")));
  await client.connect();
  try {
    const { rows } = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [gatewayOwnerLockKey(installationId)],
    );
    if (!rows[0]?.acquired) {
      const owner = await readOwnerRow(client, input);
      throw new GatewayStateOwnerContentionError(
        describeOwnerTarget(input),
        undefined,
        owner
          ? `Gateway pid ${owner.pid} on host ${owner.host} (boot ${owner.boot_id ?? "unknown"}) holds it; last heartbeat ${owner.heartbeat_at}.`
          : undefined,
        owner ? { pid: owner.pid } : undefined,
      );
    }
    await client.query("BEGIN");
    // Installs that share a schema prefix serialize creation of the shared install schema.
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
      advisoryKey(`openclaw.install-schema:${input.schemaPrefix}`),
    ]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE IF NOT EXISTS ${schema}.gateway_owner (
        installation_id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        host TEXT NOT NULL,
        boot_id TEXT,
        acquired_at TIMESTAMPTZ NOT NULL,
        heartbeat_at TIMESTAMPTZ NOT NULL
      )`);
    await client.query(
      `INSERT INTO ${schema}.gateway_owner
         (installation_id, pid, host, boot_id, acquired_at, heartbeat_at)
       VALUES ($1, $2, $3, $4, now(), now())
       ON CONFLICT (installation_id) DO UPDATE SET pid = EXCLUDED.pid, host = EXCLUDED.host,
         boot_id = EXCLUDED.boot_id, acquired_at = now(), heartbeat_at = now()`,
      [installationId, process.pid, hostname(), readBootId()],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  const heartbeat = setInterval(() => {
    client
      .query(`UPDATE ${schema}.gateway_owner SET heartbeat_at = now() WHERE installation_id = $1`, [
        installationId,
      ])
      .catch((error: unknown) =>
        lose(
          new Error(`heartbeat failed: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
          }),
        ),
      );
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref();
  return {
    assertCurrent() {
      if (released) {
        throw new Error("PostgreSQL Gateway ownership was released");
      }
      if (lost) {
        throw new Error(`PostgreSQL Gateway ownership was lost: ${lost.message}`, { cause: lost });
      }
    },
    async release() {
      if (released) {
        return;
      }
      released = true;
      clearInterval(heartbeat);
      try {
        if (!lost) {
          await client.query(`DELETE FROM ${schema}.gateway_owner WHERE installation_id = $1`, [
            installationId,
          ]);
        }
      } finally {
        // Ending the session releases the advisory lock.
        await client.end().catch(() => undefined);
      }
    },
  };
}

/**
 * Takes the install lock when database.localStores is none. Contention names the holder once
 * per holder while the caller waits, and reports the PostgreSQL target to `onContention`.
 */
export async function acquireConfiguredGatewayPostgresOwner(
  onContention: (target: string) => void,
  options: { heartbeatMs?: number } = {},
): Promise<GatewayPostgresOwner | undefined> {
  const input = getDatabaseEngineInput("state");
  if (!isInstallOwnedInput(input)) {
    return undefined;
  }
  try {
    const owner = await acquireGatewayPostgresOwner(input, options);
    reportedHolder = undefined;
    return owner;
  } catch (error) {
    if (error instanceof GatewayStateOwnerContentionError) {
      onContention(error.databasePath);
      // The detail carries the heartbeat time; report each holder once, not each heartbeat.
      const holder = `${error.databasePath}:${error.holder?.pid}`;
      if (error.holderDetail && holder !== reportedHolder) {
        reportedHolder = holder;
        log.warn(`Gateway state ownership is held in ${error.databasePath}: ${error.holderDetail}`);
      }
    }
    throw error;
  }
}
