import { DatabaseSync } from "node:sqlite";
import { Kysely, sql, type Generated } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { NodeSqliteKyselyDialect } from "./kysely-node-sqlite.js";

type TestDatabase = {
  person: {
    id: Generated<number>;
    name: string;
  };
};

describe("NodeSqliteKyselyDialect", () => {
  let db: Kysely<TestDatabase> | undefined;

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  it("uses node:sqlite with raw row-returning queries and returning clauses", async () => {
    db = new Kysely<TestDatabase>({
      dialect: new NodeSqliteKyselyDialect({
        database: new DatabaseSync(":memory:"),
      }),
    });

    await db.schema
      .createTable("person")
      .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();

    await db.insertInto("person").values({ name: "Ada" }).execute();

    await expect(db.selectFrom("person").selectAll().execute()).resolves.toEqual([
      { id: 1, name: "Ada" },
    ]);
    await expect(sql`select name from person where id = ${1}`.execute(db)).resolves.toMatchObject({
      rows: [{ name: "Ada" }],
    });
    await expect(
      db.insertInto("person").values({ name: "Grace" }).returning(["id", "name"]).execute(),
    ).resolves.toEqual([{ id: 2, name: "Grace" }]);
    await expect(
      sql`insert into person (name) values ('Lin') returning *`.execute(db),
    ).resolves.toMatchObject({
      rows: [{ id: 3, name: "Lin" }],
    });

    const ignoredInsert = await sql`
      insert or ignore into person (id, name) values (${1}, ${"Ada Again"})
    `.execute(db);
    expect(ignoredInsert.insertId).toBeUndefined();
    expect(ignoredInsert.numAffectedRows).toBe(0n);

    const update = await sql`update person set name = ${"Ada Lovelace"} where id = ${1}`.execute(
      db,
    );
    expect(update.insertId).toBeUndefined();
    expect(update.numAffectedRows).toBe(1n);
  });
});
