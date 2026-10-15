import type { DatabaseSync } from "node:sqlite";
import type { Client } from "pg";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAdmittedSqliteSchemaFacts, admitSqliteSchema } from "../sqlite-schema-facts.js";
import { quoteSqliteIdentifier as quote } from "../sqlite-schema-sql.js";
import { logbookPortProvider } from "./logbook-port.js";
import {
  DatabasePortDataError,
  type DatabasePortProvider,
  type PortDescriptor,
} from "./port-descriptor.js";
import { teamReportsPortProvider } from "./team-reports-port.js";
import { workboardPortProvider } from "./workboard-port.js";

/** The only registration point for portable database families. */
export const databasePortProviders: readonly DatabasePortProvider[] = [
  workboardPortProvider,
  logbookPortProvider,
  teamReportsPortProvider,
];

export function requireDatabasePortProvider(id: string) {
  const provider = databasePortProviders.find((entry) => entry.id === id);
  if (!provider) {
    throw new DatabasePortDataError(
      `Unknown database family; supported families: ${databasePortProviders.map((entry) => entry.id).join(", ")}`,
    );
  }
  return provider;
}

export function sqliteDatabasePortProvider(db: DatabaseSync) {
  admitSqliteSchema(db);
  const tables = getAdmittedSqliteSchemaFacts(db)!.tables;
  const matches = databasePortProviders.filter((provider) => provider.matchesSqlite(tables));
  if (matches.length !== 1) {
    throw new DatabasePortDataError(
      `Unclassified SQLite store; supported families: ${databasePortProviders.map((entry) => entry.id).join(", ")}`,
    );
  }
  return matches[0]!;
}

export async function withDatabasePortConnection<T>(
  config: OpenClawConfig,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const { resolveDatabaseEngineInput } = await import("./config.js");
  const input = await resolveDatabaseEngineInput(config);
  if (!input) {
    throw new Error("PostgreSQL requires database.engine=postgres and a resolvable connection.");
  }
  const { Client } = await import("pg");
  const client = new Client({ connectionString: input.connection });
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

export function withDatabasePortPostgres<T>(
  config: OpenClawConfig,
  anchor: { namespace: string; storeId: string },
  run: (client: Client, descriptor: PortDescriptor) => Promise<T>,
): Promise<T> {
  return withDatabasePortConnection(config, async (client) => {
    const rows = await client
      .query<{ store: string; store_id: string }>(
        `SELECT store, store_id FROM ${quote(anchor.namespace)}.openclaw_schema_meta`,
      )
      .then(
        (result) => result.rows,
        async () => {
          // Ownership can make metadata unreadable before the normal source inspection.
          await assertDatabasePortNamespaceOwner(client, anchor.namespace);
          throw new DatabasePortDataError(
            `Cannot resolve PostgreSQL anchor family; supported families: ${databasePortProviders.map((entry) => entry.id).join(", ")}`,
          );
        },
      );
    const row = rows[0];
    if (rows.length !== 1 || !row || row.store_id !== anchor.storeId) {
      throw new DatabasePortDataError("PostgreSQL anchor does not match its store metadata");
    }
    const { loadDatabasePortDescriptor } = await import("./port-provider-descriptor.js");
    return run(client, await loadDatabasePortDescriptor(row.store, config));
  });
}
