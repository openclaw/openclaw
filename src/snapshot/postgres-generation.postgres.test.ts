import { createHash, randomUUID } from "node:crypto";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inspectPostgresGeneration } from "./postgres-generation.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;

describe.skipIf(!connection)("PostgreSQL generation row hashing", () => {
  const client = new Client({ connectionString: connection });
  const namespace = `generation_${randomUUID().replaceAll("-", "")}`;
  const anchor = { namespace, storeId: "store-1" };

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA "${namespace}"`);
    await client.query(
      `CREATE TABLE "${namespace}".openclaw_schema_meta (store text, version integer, store_id text);
       INSERT INTO "${namespace}".openclaw_schema_meta VALUES ('state', 1, 'store-1');
       CREATE TABLE "${namespace}".rows (id integer, body text, amount numeric);
       CREATE TABLE "${namespace}".parts (id integer, body text) PARTITION BY LIST (id);
       CREATE TABLE "${namespace}".parts_a PARTITION OF "${namespace}".parts FOR VALUES IN (1);
       CREATE TABLE "${namespace}".parts_b PARTITION OF "${namespace}".parts FOR VALUES IN (2);
       INSERT INTO "${namespace}".parts SELECT p, 'part ' || g FROM generate_series(1, 2) p, generate_series(1, 200) g;`,
    );
    // Long shared prefixes force tie runs that straddle cursor batches and run reads.
    const shared = "x".repeat(300);
    await client.query(
      `INSERT INTO "${namespace}".rows
       SELECT NULL, $1 || (g % 97)::text || repeat('y', g % 5), g FROM generate_series(1, 400) g
       UNION ALL SELECT g, 'é' || g::text, NULL FROM generate_series(1, 150) g
       UNION ALL SELECT 7, '😀 Ω 中', 1e30 FROM generate_series(1, 3) g
       UNION ALL SELECT NULL, NULL, NULL
       UNION ALL SELECT NULL, repeat('z', 300) || (g % 7)::text, g FROM generate_series(1, 50) g`,
      [shared],
    );
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`).catch(() => {});
    await client.end();
  });

  async function wholeRowSort(table: string) {
    const reference = await client.query<{ row: string }>(
      `SELECT row_to_json(t)::text AS row FROM "${namespace}".${table} t ORDER BY row_to_json(t)::text COLLATE "C"`,
    );
    const hash = createHash("sha256");
    for (const { row } of reference.rows) {
      hash.update(row).update("\n");
    }
    return { rows: reference.rows.length, sha256: hash.digest("hex") };
  }

  async function inspect(limits?: Parameters<typeof inspectPostgresGeneration>[2]) {
    const query = vi.spyOn(client, "query");
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const generation = await inspectPostgresGeneration(client, anchor, limits);
      const statements = query.mock.calls.map(([sql]) => sql);
      return { generation, statements };
    } finally {
      await client.query("ROLLBACK");
      query.mockRestore();
    }
  }

  const tidReads = (statements: string[], table: string) =>
    statements.filter((sql) => sql.includes(`."${table}" t`) && sql.includes("ctid = ANY"));
  const runCursors = (statements: string[]) =>
    statements.filter((sql) => sql.startsWith("DECLARE openclaw_generation_run "));

  it("hashes rows in the same order as a whole-row C sort on every path", async () => {
    const whole = await inspect();
    expect(whole.generation.tables.rows).toEqual(await wholeRowSort("rows"));
    expect(whole.generation.tables.rows?.rows).toBe(604);
    // Partitions reuse the same TIDs, so each row must still be read exactly once.
    expect(whole.generation.tables.parts).toEqual(await wholeRowSort("parts"));
    expect(whole.generation.tables.parts?.rows).toBe(400);
    expect(tidReads(whole.statements, "rows")).toEqual([]);

    const prefixed = await inspect({ runRows: 10_000, wholeSortBytes: 0 });
    expect(prefixed.generation).toEqual(whole.generation);
    expect(tidReads(prefixed.statements, "rows").length).toBeGreaterThan(1);
    expect(runCursors(prefixed.statements)).toEqual([]);

    // The 400-row and 50-row tie runs exceed the cap and stream on their own cursors.
    const capped = await inspect({ runRows: 16, wholeSortBytes: 0 });
    expect(capped.generation).toEqual(whole.generation);
    expect(runCursors(capped.statements)).toHaveLength(2);
    expect(tidReads(capped.statements, "rows").length).toBeGreaterThan(1);
  });

  it("sizes a partitioned parent by all of its leaves", async () => {
    const sizes = await client.query<{ leaf: string; tree: string }>(
      `SELECT max(pg_table_size(relid))::text AS leaf, sum(pg_table_size(relid))::text AS tree
       FROM pg_partition_tree('"${namespace}".parts'::regclass)`,
    );
    const { leaf, tree } = sizes.rows[0]!;
    expect(Number(tree)).toBeGreaterThan(Number(leaf));
    const below = await inspect({ runRows: 10_000, wholeSortBytes: Number(leaf) + 1 });
    expect(tidReads(below.statements, "parts").length).toBeGreaterThan(0);
    const above = await inspect({ runRows: 10_000, wholeSortBytes: Number(tree) + 1 });
    expect(tidReads(above.statements, "parts")).toEqual([]);
    expect(above.generation).toEqual(below.generation);
  });
});
