import type { DatabaseSync } from "node:sqlite";
import type { Client } from "pg";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAdmittedSqliteSchemaFacts, admitSqliteSchema } from "../sqlite-schema-facts.js";
import { agentPortProvider } from "./agent-port.js";
import { getScopedDatabaseEngineSelection } from "./context.js";
import { logbookPortProvider } from "./logbook-port.js";
import {
  DatabasePortDataError,
  type DatabasePortPluginOwners,
  type DatabasePortProvider,
  type PortDescriptor,
} from "./port-descriptor.js";
import { readPostgresStoreMetadata, withPostgresConnection } from "./postgres-store-metadata.js";
import { statePortProvider } from "./state-port.js";
import { teamReportsPortProvider } from "./team-reports-port.js";
import { workboardPortProvider } from "./workboard-port.js";
export { assertDatabasePortNamespaceOwner } from "./postgres-store-metadata.js";

/** The only registration point for portable database families. */
export const databasePortProviders: readonly DatabasePortProvider[] = [
  workboardPortProvider,
  statePortProvider,
  agentPortProvider,
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
  env: NodeJS.ProcessEnv = process.env,
  options?: Parameters<typeof withPostgresConnection>[2],
): Promise<T> {
  const { resolveDatabaseEngineSelection } = await import("./config.js");
  const input =
    getScopedDatabaseEngineSelection()?.postgres ??
    (await resolveDatabaseEngineSelection(config, env)).postgres;
  if (!input) {
    throw new Error(
      "PostgreSQL requires an effective postgres family and a resolvable connection.",
    );
  }
  return withPostgresConnection(input, run, options);
}

export function withDatabasePortPostgres<T>(
  config: OpenClawConfig,
  anchor: { namespace: string; storeId: string },
  run: (client: Client, descriptor: PortDescriptor, sourceVersion: number) => Promise<T>,
  pluginOwners?: DatabasePortPluginOwners,
  env?: NodeJS.ProcessEnv,
): Promise<T> {
  return withDatabasePortConnection(
    config,
    async (client) => {
      const { store, version } = await readPostgresStoreMetadata(client, anchor);
      const { loadDatabasePortDescriptor } = await import("./port-provider-descriptor.js");
      return run(
        client,
        await loadDatabasePortDescriptor(store, config, {
          version,
          pluginOwners,
        }),
        version,
      );
    },
    env,
  );
}
