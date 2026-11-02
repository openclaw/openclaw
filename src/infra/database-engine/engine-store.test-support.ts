import path from "node:path";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { PostgresSyncConnection } from "../postgres-sync/connection.js";
import { publishSqliteDatabaseSchemaChange } from "../sqlite-database-admission.js";
import { admitSqliteSchema } from "../sqlite-schema-facts.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import type { SearchSchema, StoreSchema } from "./contract.js";
import { openEngineStore, readEngineAnchor } from "./open.js";

export function openPostgresEngineTestStore(
  params: Pick<
    Parameters<typeof openEngineStore>[0],
    "anchor" | "schema" | "input" | "existingVersion" | "existingOnly"
  > & { openSqlite?: () => void },
) {
  return openEngineStore({
    ...params,
    openSqlite:
      params.openSqlite ??
      (() => {
        throw new Error("Unexpected SQLite bootstrap");
      }),
    prepareAnchor() {},
    inspectSqlite() {
      admitSqliteSchema(params.anchor);
      return { hasExistingData: false, hasEngineAnchor: Boolean(readEngineAnchor(params.anchor)) };
    },
  });
}

export function createPostgresEngineTestFixture(params: {
  directory: string;
  connection: string;
  schemaPrefix: string;
  schema: StoreSchema;
}) {
  const anchor = openNodeSqliteDatabase(path.join(params.directory, "anchor.sqlite"));
  const opened: PostgresSyncConnection[] = [];
  return {
    open(this: void, schema = params.schema, existingVersion = false) {
      const db = openPostgresEngineTestStore({
        anchor,
        schema,
        existingVersion,
        input: { connection: params.connection, schemaPrefix: params.schemaPrefix },
      });
      if (!(db instanceof PostgresSyncConnection)) {
        throw new Error("Expected PostgreSQL connection");
      }
      opened.push(db);
      return db;
    },
    invalidate(this: void) {
      publishSqliteDatabaseSchemaChange(anchor);
    },
    [Symbol.dispose]() {
      withEngineStoreAdmission(() => {
        try {
          const db = opened.find((connection) => connection.isOpen);
          db?.exec(`DROP SCHEMA "${db.schema}" CASCADE`);
        } finally {
          for (const db of opened) {
            db.close();
          }
          anchor.close();
        }
      });
    },
  };
}

export function createNotesSearch(): SearchSchema {
  return {
    text: {
      notes: { table: "notes", fields: ["text"], postgres: { identity: "id", mode: "trigram" } },
    },
    vector: {
      notes: {
        table: "vectors",
        alias: "v",
        rowShape: { id: "string" },
        postgres: { source: "notes", key: "id", embedding: "embedding", dimensions: 3 },
      },
    },
  };
}
