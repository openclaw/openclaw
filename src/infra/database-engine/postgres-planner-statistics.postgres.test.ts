import { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { usePostgresTestHarness } from "../postgres-sync/postgres.test-support.js";
import { refreshPostgresPlannerStatistics } from "./postgres-planner-statistics.js";

const database = usePostgresTestHarness("planner_statistics");

describe.skipIf(!database.connection)("PostgreSQL bulk-load planner statistics", () => {
  beforeAll(async () => {
    const { client, prefix } = database;
    const other = `${prefix}_other`;
    await client.query(`CREATE SCHEMA "${prefix}"; CREATE SCHEMA "${other}";
      CREATE TABLE "${prefix}"."quoted""table" AS SELECT generate_series(1, 500) AS id;
      CREATE TABLE "${other}".untouched AS SELECT generate_series(1, 500) AS id`);
  });

  it("analyzes only the named namespace and restores connection timeouts", async () => {
    const { client, prefix } = database;
    const other = `${prefix}_other`;
    await client.query("SET statement_timeout = '23s'; SET lock_timeout = '4s'");
    expect(await refreshPostgresPlannerStatistics(client, prefix)).toEqual({
      status: "analyzed",
      tables: 1,
    });
    const { rows } = await client.query(
      `SELECT n.nspname, c.reltuples FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN ($1, $2) AND c.relkind = 'r' ORDER BY n.nspname`,
      [prefix, other],
    );
    expect(rows).toEqual([
      { nspname: prefix, reltuples: 500 },
      { nspname: other, reltuples: -1 },
    ]);
    expect((await client.query("SHOW statement_timeout")).rows).toEqual([
      { statement_timeout: "23s" },
    ]);
    expect((await client.query("SHOW lock_timeout")).rows).toEqual([{ lock_timeout: "4s" }]);
  });

  it("warns on an ANALYZE error without losing committed rows or poisoning the client", async () => {
    const { client, prefix } = database;
    const locker = new Client({ connectionString: database.connection });
    await locker.connect();
    try {
      await locker.query(`BEGIN; LOCK TABLE "${prefix}"."quoted""table" IN ACCESS EXCLUSIVE MODE`);
      expect(await refreshPostgresPlannerStatistics(client, prefix)).toMatchObject({
        status: "warning",
        warning: expect.stringContaining("verified data is retained"),
      });
      await locker.query("ROLLBACK");
      expect(
        (await client.query(`SELECT count(*)::int AS count FROM "${prefix}"."quoted""table"`)).rows,
      ).toEqual([{ count: 500 }]);
    } finally {
      await locker.end();
    }
  });
});
