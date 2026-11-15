import type { Client } from "pg";
import { quoteSqliteIdentifier as quote } from "../sqlite-schema-sql.js";
import { listDatabaseEngineStores } from "./registry.js";
import type { DatabaseEngineInput } from "./types.js";

export class DatabasePortDataError extends Error {}

export async function withPostgresConnection<T>(
  input: NonNullable<DatabaseEngineInput>,
  run: (client: Client) => Promise<T>,
  options?: { connectionTimeoutMillis?: number; query_timeout?: number },
): Promise<T> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: input.connection, ...options });
  client.on("error", () => undefined);
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

export async function assertDatabasePortNamespaceOwner(client: Client, namespace: string) {
  const owner = (
    await client.query(
      "SELECT nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned FROM pg_namespace WHERE nspname = $1",
      [namespace],
    )
  ).rows[0];
  if (!owner?.owned) {
    throw new DatabasePortDataError(
      "observed missing namespace or different owner; required namespace owned by the configured role",
    );
  }
}

/** Schema-only admission reads actual metadata without requiring a port descriptor for its version. */
export async function readPostgresStoreMetadata(
  client: Client,
  anchor: { namespace: string; storeId: string },
): Promise<{ store: string; version: number }> {
  const rows = await client
    .query<{ store: string; store_id: string; version: string }>(
      `SELECT store, store_id, version FROM ${quote(anchor.namespace)}.openclaw_schema_meta`,
    )
    .then(
      (result) => result.rows,
      async () => {
        await assertDatabasePortNamespaceOwner(client, anchor.namespace);
        throw new DatabasePortDataError(
          "Cannot resolve PostgreSQL anchor family; use a compatible binary or restore its matched backup.",
        );
      },
    );
  const row = rows[0];
  if (rows.length !== 1 || !row || row.store_id !== anchor.storeId) {
    throw new DatabasePortDataError("PostgreSQL anchor does not match its store metadata");
  }
  const version = Number(row.version);
  if (!/^\d+$/u.test(row.version) || !Number.isSafeInteger(version)) {
    throw new DatabasePortDataError("PostgreSQL store metadata has an invalid schema version");
  }
  if (!listDatabaseEngineStores().some((store) => store.postgres && store.id === row.store)) {
    throw new DatabasePortDataError("Unknown PostgreSQL anchor family; use a compatible binary.");
  }
  return { store: row.store, version };
}

export function withPostgresStoreMetadata<T>(
  input: NonNullable<DatabaseEngineInput>,
  anchor: { namespace: string; storeId: string },
  run: (client: Client, metadata: { store: string; version: number }) => Promise<T>,
): Promise<T> {
  return withPostgresConnection(input, async (client) =>
    run(client, await readPostgresStoreMetadata(client, anchor)),
  );
}
