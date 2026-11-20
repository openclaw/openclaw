import { expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import type { PortDescriptor } from "./port-types.js";
import { inspectDatabasePort } from "./port.worker.js";

const table = "audit_events";
const descriptor: PortDescriptor = {
  id: "test-allocations",
  version: 1,
  minimumPostgresVersion: 17,
  tables: [
    {
      name: table,
      columns: [{ name: "id", type: "integer" }],
      pk: ["id"],
      identities: [{ column: "id", autoIncrement: true }],
    },
  ],
  sqlite: "",
  preData: "",
  postData: "",
  expectedCatalog: [],
};

it.each([
  { seq: 0, expected: { value: "1", called: false } },
  { seq: 7, expected: { value: "7", called: true } },
])(
  "inspects an empty AUTOINCREMENT port source with high-water $seq",
  async ({ seq, expected }) => {
    using db = openNodeSqliteDatabase(":memory:");
    db.exec("CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT)");
    db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(table, seq);
    const result = await inspectDatabasePort({ engine: "sqlite", db }, descriptor);
    expect(result.allocations["audit_events.id"]).toEqual(expected);
  },
);
