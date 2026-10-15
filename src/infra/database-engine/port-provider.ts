import type { DatabaseSync } from "node:sqlite";
import type { Client } from "pg";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { getAdmittedSqliteSchemaFacts, admitSqliteSchema } from "../sqlite-schema-facts.js";
import { quoteSqliteIdentifier as quote } from "../sqlite-schema-sql.js";
import { resolveDatabaseEngineInput } from "./config.js";
import { DatabasePortDataError, type PortDescriptor } from "./port.worker.js";
import { workboardPortProvider } from "./workboard-port.js";

export type DatabasePortProvider = {
  id: string;
  resolveRoots(context: {
    config: OpenClawConfig;
    stateDir: string;
    env: NodeJS.ProcessEnv;
    plugins: ReturnType<typeof resolvePluginMetadataSnapshot>;
  }): readonly string[];
  matchesSqlite(tables: ReadonlySet<string>): boolean;
  /** Includes the expected catalog from the same generated source as the bundled DDL. */
  loadDescriptor(): Promise<PortDescriptor>;
};

/** The only registration point for portable database families. */
export const databasePortProviders: readonly DatabasePortProvider[] = [workboardPortProvider];

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
        () => {
          throw new DatabasePortDataError(
            `Cannot resolve PostgreSQL anchor family; supported families: ${databasePortProviders.map((entry) => entry.id).join(", ")}`,
          );
        },
      );
    if (rows.length !== 1 || rows[0].store_id !== anchor.storeId) {
      throw new DatabasePortDataError("PostgreSQL anchor does not match its store metadata");
    }
    return run(client, await requireDatabasePortProvider(rows[0].store).loadDescriptor());
  });
}
