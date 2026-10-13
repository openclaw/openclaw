import { DatabaseSync } from "node:sqlite";
import { PostgresSyncConnection } from "../postgres-sync/connection.js";
import { databaseEngineAdapters } from "./adapters.js";
import { withEngineStoreAdmission } from "./admission-scope.js";

process.once("message", (input: { connection?: string }) => {
  const anchor = new DatabaseSync(":memory:");
  let db: PostgresSyncConnection | undefined;
  const refused = (operation: () => unknown) => {
    try {
      operation();
      return false;
    } catch (error) {
      return error instanceof Error && error.message.includes("only synchronous admission");
    }
  };
  try {
    const constructionRefused = refused(() =>
      databaseEngineAdapters.postgres.openConnection({
        anchor,
        schema: { id: "fixture", version: 1, sqlite: "" },
        input: { connection: "postgresql://127.0.0.1:1/unused", schemaPrefix: "unused" },
        namespace: "unused",
        storeId: "unused",
        openSqlite: () => {},
      }),
    );
    let scopeRead: unknown;
    let retainedReadRefused: boolean | undefined;
    if (input.connection) {
      db = withEngineStoreAdmission(() => {
        const opened = new PostgresSyncConnection(input.connection!, "public", anchor, "fixture");
        scopeRead = opened.prepare("SELECT 7 AS value").get();
        return opened;
      });
      retainedReadRefused = refused(() => db!.prepare("SELECT 8 AS value").get());
    }
    process.send?.({ constructionRefused, scopeRead, retainedReadRefused });
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : "Main-thread guard failed" });
  } finally {
    db?.close();
    anchor.close();
    process.disconnect?.();
  }
});
