import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { PortDescriptor } from "./port-types.js";
import { readDatabasePortAllocations } from "./port.worker.js";

const opened: DatabaseSync[] = [];

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  opened.push(db);
  db.exec("CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT)");
  return db;
}

function descriptorFor(table: string): PortDescriptor {
  return {
    id: "test-allocations",
    version: 1,
    minimumPostgresVersion: 17,
    tables: [
      {
        name: table,
        columns: [
          { name: "id", type: "integer" },
          { name: "note", type: "text" },
        ],
        pk: ["id"],
        identities: [{ column: "id", autoIncrement: true }],
      },
    ],
    sqlite: "",
    preData: "",
    postData: "",
    expectedCatalog: [],
  };
}

afterEach(() => {
  while (opened.length) {
    opened.pop()?.close();
  }
});

describe("readDatabasePortAllocations for AUTOINCREMENT tables", () => {
  it("treats a zero sqlite_sequence row as an uncalled sequence", async () => {
    const db = openDb();
    // SQLite writes 0 for an AUTOINCREMENT table that never held a row; a
    // called value of 0 is outside PostgreSQL's 1.. sequence bounds.
    db.exec("INSERT INTO sqlite_sequence (name, seq) VALUES ('audit_events', 0)");

    const allocations = await readDatabasePortAllocations(
      { engine: "sqlite", db },
      descriptorFor("audit_events"),
    );

    expect(allocations["audit_events.id"]).toEqual({ value: "1", called: false });
  });

  it("keeps a real high-water mark callable", async () => {
    const db = openDb();
    db.exec("INSERT INTO audit_events (id, note) VALUES (7, 'recorded')");

    const allocations = await readDatabasePortAllocations(
      { engine: "sqlite", db },
      descriptorFor("audit_events"),
    );

    expect(allocations["audit_events.id"]).toEqual({ value: "7", called: true });
  });
});
