import { expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { admitDatabasePortDescriptor } from "./port-descriptor.js";
import { fixtureDescriptor } from "./port-provider-fixture.test-support.js";
import { requireDatabasePortProvider, sqliteDatabasePortProvider } from "./port-provider.js";
import { inspectDatabasePort } from "./port.worker.js";

function fixture(fragments: readonly string[] = []) {
  const descriptor = fixtureDescriptor();
  const db = openNodeSqliteDatabase(":memory:");
  db.exec(descriptor.sqlite);
  for (const fragment of descriptor.fragments ?? []) {
    if (fragments.includes(fragment.id)) {
      db.exec(fragment.sqlite);
    }
  }
  const endpoint = { engine: "sqlite" as const, db };
  return {
    db,
    descriptor,
    admit: () => admitDatabasePortDescriptor(endpoint, descriptor),
    [Symbol.dispose]: () => db.close(),
  };
}

it.each([{ fragments: [] }, { fragments: ["labels"] }, { fragments: ["labels", "notes"] }])(
  "infers, orders and composes admitted fragments %j after a canonical trigger",
  async ({ fragments }) => {
    using f = fixture(fragments);
    f.descriptor.fragments = f.descriptor.fragments!.toReversed();
    const admitted = await f.admit();
    expect(admitted.activeFragments).toEqual(fragments);
    using destination = openNodeSqliteDatabase(":memory:");
    expect(() => destination.exec(admitted.sqlite)).not.toThrow();
  },
);

const both = ["labels", "notes"];
it.each<[string, string[], string]>([
  ["missing", ["notes"], "Port fragment notes requires missing fragment labels"],
  ["cycle", both, "Cyclic port fragment dependency: labels"],
])("refuses a %s fragment selection", async (kind, fragments, message) => {
  using f = fixture(fragments);
  if (kind === "cycle") {
    for (const fragment of f.descriptor.fragments!) {
      fragment.dependencies = fragment.id === "labels" ? ["notes"] : ["labels"];
    }
  }
  await expect(f.admit()).rejects.toThrow(message);
});

it.each([
  ["trigger", "CREATE TRIGGER surprise AFTER INSERT ON port_items BEGIN SELECT 1; END"],
  ["view", "CREATE VIEW surprise AS SELECT * FROM port_items"],
])("refuses an undeclared SQLite %s", async (_kind, sql) => {
  using f = fixture();
  f.db.exec(sql);
  await expect(f.admit()).rejects.toThrow("Unknown SQLite table, trigger or view");
});

it("names supported families when an id or SQLite store is unknown", () => {
  expect(() => requireDatabasePortProvider("unknown")).toThrow(
    "Unknown database family; supported families: workboard, state, agent, logbook, team-reports",
  );
  using source = openNodeSqliteDatabase(":memory:");
  source.exec("CREATE TABLE unrelated (id TEXT)");
  expect(() => sqliteDatabasePortProvider(source)).toThrow(
    "Unclassified SQLite store; supported families: workboard",
  );
});

it("refuses source fragments that differ from the recorded backup", async () => {
  using f = fixture(["labels", "notes"]);
  await expect(
    admitDatabasePortDescriptor({ engine: "sqlite", db: f.db }, f.descriptor, ["labels"]),
  ).rejects.toThrow("Port source fragments differ from the recorded backup");
});

it("omits stale derived projection rows from copy verification", async () => {
  using f = fixture();
  f.db.exec(
    "INSERT INTO port_items VALUES ('first', 'retained', 6); INSERT INTO port_projection VALUES ('wrong', 'stale projection')",
  );
  const verification = await inspectDatabasePort({ engine: "sqlite", db: f.db }, f.descriptor);
  expect(Object.keys(verification.tables)).toEqual(["port_items"]);
  expect(verification.tables.port_items?.rows).toBe(1);
});

it("selects the registered family by id and admitted SQLite tables", () => {
  using source = openNodeSqliteDatabase(":memory:");
  source.exec("CREATE TABLE workboard_schema_migrations (id TEXT)");
  expect(sqliteDatabasePortProvider(source)).toBe(requireDatabasePortProvider("workboard"));
});
