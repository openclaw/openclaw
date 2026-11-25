import type { Client } from "pg";

export async function dropPostgresTestSchemas(client: Pick<Client, "query">, prefix: string) {
  const schemas = await client.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE starts_with(nspname, $1)",
    [`${prefix}_`],
  );
  for (const { nspname } of schemas.rows) {
    await client.query(`DROP SCHEMA "${nspname.replaceAll('"', '""')}" CASCADE`);
  }
}
