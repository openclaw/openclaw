import { createHash } from "node:crypto";
import type { Client } from "pg";
import {
  postgresCatalogQuery,
  readPostgresCatalog,
  type PostgresCatalogFact,
} from "../infra/database-engine/postgres-catalog.js";
import { quoteSqliteIdentifier as quote } from "../infra/sqlite-schema-sql.js";

type Anchor = { namespace: string; storeId: string };
type PostgresGeneration = {
  store: string;
  version: number;
  catalog: PostgresCatalogFact[];
  tables: Record<string, { rows: number; sha256: string }>;
  allocations: Record<string, { value: string; called: boolean }>;
};

/** Hold native writers out until the caller's migration transaction settles. */
export async function lockPostgresGeneration(client: Client, namespace: string): Promise<void> {
  const relations = await client.query<{ name: string; kind: string; owner: string }>(
    `SELECT c.relname AS name, c.relkind AS kind, pg_get_userbyid(c.relowner) AS owner
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=$1 AND c.relkind IN ('r','p','m','S') ORDER BY c.relname COLLATE "C"`,
    [namespace],
  );
  const tables = relations.rows.filter(({ kind }) => kind === "r" || kind === "p");
  if (tables.length) {
    await client.query(
      `LOCK TABLE ${tables.map(({ name }) => `${quote(namespace)}.${quote(name)}`).join(",")} IN ACCESS EXCLUSIVE MODE`,
    );
  }
  for (const { name, kind, owner } of relations.rows) {
    if (kind === "S" || kind === "m") {
      // Same-owner ALTER takes AccessExclusiveLock without changing catalog or sequence state.
      await client.query(
        `ALTER ${kind === "S" ? "SEQUENCE" : "MATERIALIZED VIEW"} ${quote(namespace)}.${quote(name)} OWNER TO ${quote(owner)}`,
      );
    }
  }
}

/** Observe the caller's snapshot without interpreting it through this build's schema. */
export async function inspectPostgresGeneration(
  client: Client,
  anchor: Anchor,
): Promise<PostgresGeneration> {
  const metadata = await client.query<{
    store: string;
    version: string;
    store_id: string;
    owned: boolean;
  }>(
    `SELECT m.store, m.version::text AS version, m.store_id,
     n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned
     FROM ${quote(anchor.namespace)}.openclaw_schema_meta m
     CROSS JOIN pg_namespace n WHERE n.nspname=$1`,
    [anchor.namespace],
  );
  const row = metadata.rows[0];
  if (
    metadata.rows.length !== 1 ||
    !row?.owned ||
    row.store_id !== anchor.storeId ||
    !Number.isSafeInteger(Number(row.version)) ||
    Number(row.version) < 0
  ) {
    throw new Error("PostgreSQL anchor does not match its owned generation metadata");
  }
  await client.query("SELECT set_config('search_path',$1,true)", [quote(anchor.namespace)]);
  // Force text on both ordinary pg clients and the runtime's raw-JSON bridge.
  const catalog = readPostgresCatalog(
    JSON.parse(
      (
        await client.query<{ catalog: string }>(
          `SELECT catalog::text FROM (${postgresCatalogQuery(anchor.namespace, true)}) generation`,
        )
      ).rows[0]!.catalog,
    ),
  ).filter((fact) => fact.kind !== "functionDefinition");
  const routines = await client.query<{ name: string; definition: string }>(
    `SELECT p.oid::regprocedure::text AS name, pg_get_functiondef(p.oid) AS definition
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname=$1 AND p.prokind IN ('f','p','w')`,
    [anchor.namespace],
  );
  for (const { name, definition } of routines.rows) {
    catalog.push({ table: name, kind: "functionDefinition", value: definition });
  }
  const tables: PostgresGeneration["tables"] = {};
  const relations = await client.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=$1 AND c.relkind IN ('r','p','m') ORDER BY c.relname COLLATE "C"`,
    [anchor.namespace],
  );
  for (const { name } of relations.rows) {
    const hash = createHash("sha256");
    let rows = 0;
    // Server serialization preserves integers beyond 2^53 and duplicate JSON keys.
    await client.query(
      `DECLARE openclaw_generation_rows NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS row FROM ${quote(anchor.namespace)}.${quote(name)} t ORDER BY row_to_json(t)::text COLLATE "C"`,
    );
    try {
      for (;;) {
        const batch = await client.query<{ row: string }>(
          "FETCH FORWARD 128 FROM openclaw_generation_rows",
        );
        for (const record of batch.rows) {
          hash.update(record.row).update("\n");
          rows++;
        }
        if (batch.rows.length < 128) {
          break;
        }
      }
    } finally {
      await client.query("CLOSE openclaw_generation_rows");
    }
    tables[name] = { rows, sha256: hash.digest("hex") };
  }
  const sequences = await client.query<{
    name: string;
    start: string;
    increment: string;
    minimum: string;
    maximum: string;
    cache: string;
    cycle: boolean;
  }>(
    `SELECT c.relname AS name, s.seqstart::text AS start, s.seqincrement::text AS increment,
     s.seqmin::text AS minimum, s.seqmax::text AS maximum, s.seqcache::text AS cache, s.seqcycle AS cycle
     FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=$1 ORDER BY c.relname COLLATE "C"`,
    [anchor.namespace],
  );
  const allocations: PostgresGeneration["allocations"] = {};
  for (const { name, ...definition } of sequences.rows) {
    catalog.push({ table: name, kind: "sequenceDefinition", value: definition });
    const allocation = await client.query<{ value: string; called: boolean }>(
      `SELECT last_value::text AS value, is_called AS called FROM ${quote(anchor.namespace)}.${quote(name)}`,
    );
    allocations[name] = allocation.rows[0]!;
  }
  catalog.sort((a, b) => {
    const left = JSON.stringify(a),
      right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return { store: row.store, version: Number(row.version), catalog, tables, allocations };
}

export function fingerprintPostgresGeneration(
  anchor: Anchor,
  generation: PostgresGeneration,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        engine: "postgres",
        namespace: anchor.namespace,
        storeId: anchor.storeId,
        ...generation,
      }),
    )
    .digest("hex");
}
