import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { SQLITE_READONLY_CHILD_ARG } from "./runtime-process-entrypoints.js";
import { formatSqliteErrorCodeSuffix } from "./sqlite-error-diagnostics.js";
import {
  inspectSqliteSchemaHeaderInProcess,
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
} from "./sqlite-readonly-location.js";

// The sync strategy raw-copies without attaching SQLite to the source, so sync
// callers stay byte-neutral on the live family; the async strategy holds a read
// transaction on the source and may update its WAL index.
async function runWorker(): Promise<void> {
  const mode = process.argv[3];
  const pathname = process.argv[4];
  const stagingRoot = process.argv[5];
  const agentSchemaVersionForOwnership =
    process.argv[6] === undefined ? undefined : Number(process.argv[6]);
  if ((mode !== "sync" && mode !== "async" && mode !== "schema-header") || !pathname) {
    process.exitCode = 1;
    process.stdout.write(
      JSON.stringify({
        ok: false,
        message: "SQLite read-only worker requires a mode and a database path",
      }),
    );
    return;
  }
  try {
    if (mode === "schema-header") {
      if (
        agentSchemaVersionForOwnership !== undefined &&
        (!Number.isSafeInteger(agentSchemaVersionForOwnership) ||
          agentSchemaVersionForOwnership < 0)
      ) {
        throw new Error("SQLite schema header requires a valid supported agent schema version");
      }
      const header = await inspectSqliteSchemaHeaderInProcess(
        pathname,
        stagingRoot,
        agentSchemaVersionForOwnership,
      );
      process.stdout.write(JSON.stringify({ ok: true, header }));
      return;
    }
    const prepared =
      mode === "sync"
        ? prepareSqliteReadOnlyLocationSyncInProcess(pathname, stagingRoot)
        : await prepareSqliteReadOnlyLocationInProcess(pathname, stagingRoot);
    process.stdout.write(JSON.stringify({ ok: true, location: prepared.location }));
  } catch (error) {
    process.exitCode = 1;
    const message = `${coerceErrorMessage(error)}${formatSqliteErrorCodeSuffix(error)}`;
    process.stdout.write(JSON.stringify({ ok: false, message }));
  }
}

if (process.argv[2] === SQLITE_READONLY_CHILD_ARG) {
  void runWorker();
}
