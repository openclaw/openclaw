import { expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { admitDatabasePortDescriptor, type PortDescriptor } from "./port-descriptor.js";
import { fixtureDescriptor } from "./port-provider-fixture.test-support.js";
import { requireDatabasePortProvider, sqliteDatabasePortProvider } from "./port-provider.js";
import { inspectDatabasePort } from "./port.worker.js";

function openFixture(descriptor: PortDescriptor, fragments: readonly string[] = []) {
  const source = openNodeSqliteDatabase(":memory:");
  source.exec(descriptor.sqlite);
  for (const fragment of descriptor.fragments ?? []) {
    if (fragments.includes(fragment.id)) {
      source.exec(fragment.sqlite);
    }
  }
  return source;
}

it.each([{ fragments: [] }, { fragments: ["labels"] }, { fragments: ["labels", "notes"] }])(
  "infers, orders and composes admitted fragments %j after a canonical trigger",
  async ({ fragments }) => {
    const descriptor = fixtureDescriptor();
    descriptor.fragments = descriptor.fragments!.toReversed();
    using source = openFixture(descriptor, fragments);
    const admitted = await admitDatabasePortDescriptor(
      { engine: "sqlite", db: source },
      descriptor,
    );
    expect(admitted.activeFragments).toEqual(fragments);
    using destination = openNodeSqliteDatabase(":memory:");
    expect(() => destination.exec(admitted.sqlite)).not.toThrow();
  },
);

it("refuses an active fragment whose dependency is absent", async () => {
  const descriptor = fixtureDescriptor();
  using source = openFixture(descriptor, ["notes"]);
  await expect(
    admitDatabasePortDescriptor({ engine: "sqlite", db: source }, descriptor),
  ).rejects.toThrow("Port fragment notes requires missing fragment labels");
});

it("refuses cyclic active fragment dependencies", async () => {
  const descriptor = fixtureDescriptor();
  for (const fragment of descriptor.fragments!) {
    fragment.dependencies = fragment.id === "labels" ? ["notes"] : ["labels"];
  }
  using source = openFixture(descriptor, ["labels", "notes"]);
  await expect(
    admitDatabasePortDescriptor({ engine: "sqlite", db: source }, descriptor),
  ).rejects.toThrow("Cyclic port fragment dependency: labels");
});

it.each([
  ["trigger", "CREATE TRIGGER surprise AFTER INSERT ON port_items BEGIN SELECT 1; END"],
  ["view", "CREATE VIEW surprise AS SELECT * FROM port_items"],
])("refuses an undeclared SQLite %s", async (_kind, sql) => {
  const descriptor = fixtureDescriptor();
  using source = openFixture(descriptor);
  source.exec(sql);
  await expect(
    admitDatabasePortDescriptor({ engine: "sqlite", db: source }, descriptor),
  ).rejects.toThrow("Unknown SQLite table, trigger or view");
});

it("refuses source fragments that differ from the recorded backup", async () => {
  const descriptor = fixtureDescriptor();
  using source = openFixture(descriptor, ["labels", "notes"]);
  await expect(
    admitDatabasePortDescriptor({ engine: "sqlite", db: source }, descriptor, ["labels"]),
  ).rejects.toThrow("Port source fragments differ from the recorded backup");
});

it("omits stale derived projection rows from copy verification", async () => {
  const descriptor = fixtureDescriptor();
  using source = openFixture(descriptor);
  source.exec(
    "INSERT INTO port_items VALUES ('first', 'retained', 6); INSERT INTO port_projection VALUES ('wrong', 'stale projection')",
  );
  const verification = await inspectDatabasePort({ engine: "sqlite", db: source }, descriptor);
  expect(Object.keys(verification.tables)).toEqual(["port_items"]);
  expect(verification.tables.port_items?.rows).toBe(1);
});

it("selects the registered family by id and admitted SQLite tables", () => {
  using source = openNodeSqliteDatabase(":memory:");
  source.exec("CREATE TABLE workboard_schema_migrations (id TEXT)");
  expect(sqliteDatabasePortProvider(source)).toBe(requireDatabasePortProvider("workboard"));
});

it("names supported families when an id or SQLite store is unknown", () => {
  expect(() => requireDatabasePortProvider("unknown")).toThrow(
    "Unknown database family; supported families: workboard",
  );
  using source = openNodeSqliteDatabase(":memory:");
  source.exec("CREATE TABLE unrelated (id TEXT)");
  expect(() => sqliteDatabasePortProvider(source)).toThrow(
    "Unclassified SQLite store; supported families: workboard",
  );
});
