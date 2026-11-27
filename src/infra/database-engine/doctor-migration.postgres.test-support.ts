import type { Client } from "pg";
import { postgresCatalogQuery, readPostgresCatalog } from "./postgres-catalog.js";

/** Preserve full catalog facts while ignoring only the fixture's relocated namespace. */
export async function readAgentCatalog(client: Client, schema: string): Promise<string[]> {
  const { rows } = await client.query(postgresCatalogQuery(schema, true));
  return readPostgresCatalog(rows[0].catalog)
    .map((fact) => JSON.stringify(fact).replaceAll(schema, "fixture_namespace"))
    .toSorted();
}

export async function readAgentReferenceCatalog(client: Client, schema: string): Promise<string[]> {
  // Fresh stores omit the optional floor; the reference models migration-owned metadata.
  await client.query(`ALTER TABLE "${schema}".openclaw_schema_meta ADD COLUMN min_reader BIGINT`);
  return readAgentCatalog(client, schema);
}
