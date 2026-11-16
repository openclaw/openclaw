import { catalog, portTables } from "../../../scripts/lib/postgres-schema-catalog.mts";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import type { PortDescriptor } from "./port.worker.js";
import { expectedPostgresCatalog } from "./postgres-catalog.js";

const trigger = {
  name: "port_item_edits",
  table: "port_items",
  sql: "CREATE TRIGGER port_item_edits AFTER INSERT ON port_items BEGIN UPDATE port_items SET edits = edits + 1 WHERE id = NEW.id; END",
};
function schema(name: string, extra = false) {
  const sqlite = `CREATE TABLE ${name} (id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL${extra ? ", edits INTEGER NOT NULL" : ""}) STRICT;`;
  const postgres = `CREATE TABLE ${name} (id TEXT COLLATE "C" PRIMARY KEY, value TEXT COLLATE "C" NOT NULL${extra ? ", edits BIGINT NOT NULL" : ""});`;
  using db = openNodeSqliteDatabase(":memory:");
  db.exec(sqlite);
  const data = catalog(db, "");
  return {
    tables: portTables(data),
    sqlite,
    preData: postgres.slice(0, -1),
    postData: "",
    expectedCatalog: expectedPostgresCatalog(data),
  };
}

export function fixtureDescriptor(): PortDescriptor {
  const items = schema("port_items", true);
  const projection = schema("port_projection");
  const sqlite = items.sqlite + projection.sqlite + trigger.sql;
  const postData = `CREATE FUNCTION port_item_edits_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.edits := NEW.edits + 1; RETURN NEW; END $$;
    CREATE TRIGGER port_item_edits BEFORE INSERT ON port_items FOR EACH ROW EXECUTE FUNCTION port_item_edits_fn();`;
  return {
    id: "synthetic",
    version: 2,
    minimumPostgresVersion: 16,
    ...items,
    tables: [...items.tables, ...projection.tables],
    sqlite,
    preData: items.preData + ";\n" + projection.preData,
    postData,
    triggers: [trigger],
    expectedCatalog: [...items.expectedCatalog, ...projection.expectedCatalog],
    fragments: [
      { id: "labels", dependencies: [], ...schema("port_labels") },
      { id: "notes", dependencies: ["labels"], ...schema("port_notes") },
    ],
    projections: [
      {
        tables: ["port_projection"],
        async rebuild(target) {
          const sql =
            "DELETE FROM port_projection; INSERT INTO port_projection SELECT id, upper(value) FROM port_items";
          if (target.engine === "sqlite") {
            target.db.exec(sql);
          } else {
            await target.db.query(sql);
          }
        },
      },
    ],
    inspectSqliteSource(db) {
      const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
      const pendingColumns: Record<string, readonly string[]> = {};
      if (version < 2) {
        pendingColumns.port_items = ["edits"];
      }
      return {
        version,
        migrationRequired: version < 2,
        pendingColumns,
      };
    },
    migrateSqliteSource(file, sourceVersion) {
      if (sourceVersion >= 2) {
        return;
      }
      using db = openNodeSqliteDatabase(file);
      db.exec(
        "ALTER TABLE port_items ADD COLUMN edits INTEGER NOT NULL DEFAULT 0; PRAGMA user_version = 2",
      );
    },
  };
}
