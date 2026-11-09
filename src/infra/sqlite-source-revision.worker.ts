// Keep ordinary content/file observations independent of the SQLite import graph.
import { SQLITE_READONLY_CHILD_ARG } from "./runtime-process-entrypoints.js";
import {
  readStableSqliteFileGeneration,
  serializeSqliteFileGeneration,
} from "./sqlite-file-generation.js";
import type { SqliteReadOnlyWorkerResult } from "./sqlite-readonly-worker-protocol.js";
import { readSqliteSourceContentVersionInProcess } from "./sqlite-source-revision.js";

if (process.argv[2] === SQLITE_READONLY_CHILD_ARG) {
  let result: SqliteReadOnlyWorkerResult;
  try {
    const pathname = process.argv[4];
    const mode = process.argv[3];
    if (
      (mode !== "content-version" && mode !== "file-generation" && mode !== "update-generation") ||
      !pathname
    ) {
      throw new Error("SQLite content observation requires its mode and source path");
    }
    if (mode === "update-generation") {
      const { readUpdateDatabaseGenerationObservation } =
        await import("./update-database-generations.js");
      result = {
        ok: true,
        generation: JSON.stringify(readUpdateDatabaseGenerationObservation(pathname)),
      };
    } else {
      result =
        mode === "file-generation"
          ? {
              ok: true,
              generation: serializeSqliteFileGeneration(readStableSqliteFileGeneration(pathname)),
            }
          : { ok: true, contentVersion: readSqliteSourceContentVersionInProcess(pathname) ?? "" };
    }
  } catch (error) {
    process.exitCode = 1;
    result = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(JSON.stringify(result));
}
