import path from "node:path";
import { getEnvironmentData, threadId } from "node:worker_threads";
import { expect } from "vitest";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { PostgresSyncConnection } from "../postgres-sync/connection.js";
import { publishSqliteDatabaseSchemaChange } from "../sqlite-database-admission.js";
import { admitSqliteSchema } from "../sqlite-schema-facts.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import type { StoreSchema } from "./contract.js";
import { openEngineStore, readEngineAnchor } from "./open.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
export const searchConnection = typeof configured === "string" ? configured : undefined;
type VectorRow = { id: string; distance: number };
export const isVectorRow = (value: unknown): value is VectorRow =>
  value !== null &&
  typeof value === "object" &&
  "id" in value &&
  typeof value.id === "string" &&
  "distance" in value &&
  typeof value.distance === "number";
export function embedding(values: readonly number[]) {
  const bytes = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => bytes.writeDoubleLE(value, index * 8));
  return bytes;
}

export function createSearchStore(directory: string, schema: StoreSchema, schemaPrefix: string) {
  expect(threadId, "The fixture host must retain the native admission descriptor").toBe(0);
  const anchor = openNodeSqliteDatabase(path.join(directory, "anchor.sqlite"));
  const connections: PostgresSyncConnection[] = [];
  const open = () => {
    const db = openEngineStore({
      anchor,
      schema,
      input: { connection: searchConnection!, schemaPrefix },
      openSqlite: () => {
        throw new Error("Unexpected SQLite bootstrap");
      },
      prepareAnchor: () => {},
      inspectSqlite: () => {
        admitSqliteSchema(anchor);
        return { hasExistingData: false, hasEngineAnchor: Boolean(readEngineAnchor(anchor)) };
      },
    });
    if (!(db instanceof PostgresSyncConnection)) {
      throw new Error("Expected PostgreSQL");
    }
    connections.push(db);
    return db;
  };
  return {
    open,
    invalidate: () => publishSqliteDatabaseSchemaChange(anchor),
    close: (db = connections[0]) =>
      withEngineStoreAdmission(() => {
        try {
          db?.exec(`DROP SCHEMA "${db.schema}" CASCADE`);
        } finally {
          connections.forEach((opened) => opened.close());
          anchor.close();
        }
      }),
  };
}
