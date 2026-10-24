import type { Client } from "pg";

export async function dropPostgresTestSchemas(
  client: Pick<Client, "query">,
  prefix: string,
  { includePrefix = false }: { includePrefix?: boolean } = {},
) {
  const schemas = await client.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace WHERE starts_with(nspname, $1)${includePrefix ? " OR nspname = $2" : ""}`,
    [`${prefix}_`, ...(includePrefix ? [prefix] : [])],
  );
  for (const { nspname } of schemas.rows) {
    await client.query(`DROP SCHEMA "${nspname.replaceAll('"', '""')}" CASCADE`);
  }
}
