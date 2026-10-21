import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import { admitStoreSearch } from "./adapters.js";
import { openEngineStore } from "./open.js";

const schema = {
  id: "search-fixture",
  version: 1,
  sqlite: "CREATE VIRTUAL TABLE notes USING fts5(text)",
};
const indexes = { text: { notes: { table: "notes", fields: ["text"] } } };

function openSearchStore(db: DatabaseSync) {
  openEngineStore({
    anchor: db,
    schema,
    prepareAnchor: () => {},
    inspectSqlite: () => ({ hasExistingData: false, hasEngineAnchor: false }),
    openSqlite: () => db.exec(schema.sqlite),
  });
  return admitStoreSearch(db, indexes);
}

describe("experimental admitted search capabilities", () => {
  it("composes literal phrase and prefix search with caller filtering and bounds", () => {
    using db = new DatabaseSync(":memory:");
    const admitted = openSearchStore(db);
    if (!admitted.fullText) {
      throw new Error(admitted.diagnostics.join("; "));
    }
    const index = admitted.text.notes!;
    db.prepare("INSERT INTO notes (text) VALUES (?), (?)").run(
      "quartz compass calibrating",
      "quartz compass hidden",
    );
    const rows = executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<{ notes: { rowid: number; text: string } }>(db)
        .selectFrom("notes")
        .where(
          admitted.fullText.match(index, {
            kind: "all",
            clauses: [
              { kind: "phrase", text: "quartz" },
              { kind: "phrase", text: "cal", prefix: true },
            ],
          }),
        )
        .where("rowid", "=", 1)
        .select(admitted.fullText.snippet(index, "text", 48).as("snippet"))
        .limit(1),
    ).rows;
    expect(rows).toEqual([{ snippet: "quartz compass calibrating" }]);
  });

  it("rejects foreign indexes and retained capabilities after native close", () => {
    const first = new DatabaseSync(":memory:");
    using second = new DatabaseSync(":memory:");
    const owner = openSearchStore(first);
    const foreign = openSearchStore(second);
    if (!owner.fullText) {
      throw new Error(owner.diagnostics.join("; "));
    }
    expect(() => owner.fullText!.rank(foreign.text.notes!)).toThrow("not admitted");
    first.close();
    expect(() => owner.fullText!.rank(owner.text.notes!)).toThrow("not admitted");
  });

  it("refuses unadmitted PostgreSQL descriptors", () => {
    expect(() =>
      admitStoreSearch(
        {
          databasePath: "/synthetic/anchor.sqlite",
          input: {
            connection: "postgresql://localhost/synthetic",
            schemaPrefix: "fixture",
          },
        },
        indexes,
      ),
    ).toThrow("admitted worker connection");
  });
});
