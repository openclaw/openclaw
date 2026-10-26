import { parentPort, workerData } from "node:worker_threads";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { PostgresSyncConnection } from "../postgres-sync/connection.js";
import {
  installSqliteDatabaseAdmissions,
  publishSqliteDatabaseSchemaChange,
  revokeSqliteDatabaseAdmissions,
  type SqliteDatabaseAdmissions,
} from "../sqlite-database-admission.js";
import type { StoreSchema } from "./contract.js";
import { openPostgresEngineTestStore } from "./engine-store.test-support.js";
import type { NamespaceCommand } from "./multi-namespace.test-support.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";
import { pgSearchName } from "./postgres-search-schema.js";
import { bindStoreSearch } from "./search.js";

const schema: StoreSchema = {
  id: "isolation",
  version: 1,
  sqlite: "",
  postgres: "CREATE TABLE notes(id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding BYTEA)",
  search: {
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
  },
};

const input: {
  connection: string;
  path: string;
  prefix: string;
  admissions: SqliteDatabaseAdmissions;
  gates: SharedArrayBuffer;
} = workerData;
const port = parentPort!;
const fail = (event: string, error: unknown) =>
  port.postMessage({ event, error: error instanceof Error ? error.message : String(error) });
const gates = new Int32Array(input.gates);
function wait(index: number) {
  while (Atomics.load(gates, index) === 0) {
    Atomics.wait(gates, index, 0);
  }
}
installSqliteDatabaseAdmissions(input.admissions);
const anchor = openNodeSqliteDatabase(input.path);
function open() {
  const db = openPostgresEngineTestStore({
    anchor,
    schema,
    input: { connection: input.connection, schemaPrefix: input.prefix },
  });
  if (!(db instanceof PostgresSyncConnection)) {
    throw new Error("Expected PostgreSQL");
  }
  return db;
}
let db: PostgresSyncConnection;
try {
  port.postMessage({ event: "booting" });
  wait(0);
  db = open();
  port.postMessage({
    event: "ready",
    result: {
      namespace: db.schema,
      storeId: getPostgresPhysicalFacts(db)!.storeId,
      ...db.prepare("SELECT pg_backend_pid() AS pid, current_database() AS database").get(),
    },
  });
  port.on("message", (command: NamespaceCommand) => {
    try {
      let result: unknown;
      if (command.op === "write") {
        db.runTransaction(() => {
          db.prepare("INSERT INTO notes(id, text, embedding) VALUES (?, ?, ?)").run(
            command.id,
            command.text,
            Buffer.from("000000000000f03f00000000000000000000000000000000", "hex"),
          );
          if (command.hold) {
            port.postMessage({ event: "holding" });
            wait(1);
          }
        });
      } else if (command.op === "search") {
        const search = bindStoreSearch(db, schema.search!);
        const k = getNodeSqliteKysely<{
          notes: { id: string; text: string; openclaw_search: unknown };
        }>(db);
        if (command.withoutSearchPath) {
          db.exec("SET search_path TO pg_catalog");
        }
        try {
          const query = { kind: "term", text: command.text } as const;
          result = executeSqliteQuerySync(
            db,
            k
              .withSchema(db.schema)
              .selectFrom("notes")
              .select([
                "id",
                search.fullText!.snippet(search.text.notes!, "text", 12, query).as("snippet"),
              ])
              .where(search.fullText!.match(search.text.notes!, query))
              .orderBy("id"),
          ).rows;
        } finally {
          db.exec(`SET search_path TO ${pgSearchName(db.schema)}`);
        }
      } else if (command.op === "reopen") {
        db.close();
        if (command.namespace) {
          anchor.prepare("UPDATE openclaw_engine_anchor SET schema = ?").run(command.namespace);
          revokeSqliteDatabaseAdmissions(anchor);
        }
        publishSqliteDatabaseSchemaChange(anchor);
        db = open();
      } else {
        db.close();
        anchor.close();
        port.postMessage({ event: "done" });
        port.close();
        return;
      }
      port.postMessage({ event: "done", result });
    } catch (error) {
      fail("done", error);
    }
  });
} catch (error) {
  anchor.close();
  fail("ready", error);
  port.close();
}
