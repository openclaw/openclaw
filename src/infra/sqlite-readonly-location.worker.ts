import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { SQLITE_READONLY_CHILD_ARG } from "./runtime-process-entrypoints.js";
import { formatSqliteErrorCodeSuffix } from "./sqlite-error-diagnostics.js";
import {
  inspectSqliteSchemaHeaderInProcess,
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
} from "./sqlite-readonly-location.js";
import {
  SQLITE_READONLY_WORKER_MAX_BUFFER,
  type SqliteReadOnlyWorkerResult,
} from "./sqlite-readonly-worker-protocol.js";

// The sync strategy raw-copies without attaching SQLite to the source, so sync
// callers stay byte-neutral on the live family; the async strategy holds a read
// transaction on the source and may update its WAL index.
async function inspect(args: string[]): Promise<SqliteReadOnlyWorkerResult> {
  const mode = args[0];
  const pathname = args[1];
  const stagingRoot = args[2];
  const agentSchemaVersionForOwnership = args[3] === undefined ? undefined : Number(args[3]);
  if ((mode !== "sync" && mode !== "async" && mode !== "schema-header") || !pathname) {
    return {
      ok: false,
      message: "SQLite read-only worker requires a mode and a database path",
    };
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
      return { ok: true, header };
    }
    const prepared =
      mode === "sync"
        ? prepareSqliteReadOnlyLocationSyncInProcess(pathname, stagingRoot)
        : await prepareSqliteReadOnlyLocationInProcess(pathname, stagingRoot);
    return { ok: true, location: prepared.location };
  } catch (error) {
    const message = `${coerceErrorMessage(error)}${formatSqliteErrorCodeSuffix(error)}`;
    return { ok: false, message };
  }
}

function runSession(): void {
  let busy = false;
  process.once("disconnect", () => {
    if (busy) {
      process.exit(1);
    }
  });
  process.on("message", (message: unknown) => {
    if (message === "close" && !busy) {
      process.disconnect?.();
      return;
    }
    if (
      busy ||
      !message ||
      typeof message !== "object" ||
      Object.keys(message).length !== 2 ||
      !("id" in message) ||
      typeof message.id !== "number" ||
      !Number.isSafeInteger(message.id) ||
      !("args" in message) ||
      !Array.isArray(message.args) ||
      message.args[0] !== "sync" ||
      !message.args.every((arg): arg is string => typeof arg === "string")
    ) {
      process.exit(1);
    }
    busy = true;
    const id = message.id;
    void inspect(message.args).then((inspected) => {
      const result: SqliteReadOnlyWorkerResult =
        Buffer.byteLength(JSON.stringify(inspected)) > SQLITE_READONLY_WORKER_MAX_BUFFER
          ? { ok: false, message: "exceeded its output buffer" }
          : inspected;
      if (result.ok) {
        busy = false;
      }
      process.send?.({ id, result }, (error) => {
        if (error || !result.ok) {
          // A failed inspection may still own a native handle and admission.
          process.exit(1);
        }
      });
    });
  });
}

if (process.argv[2] === SQLITE_READONLY_CHILD_ARG) {
  if (process.argv[3] === "session" && process.send) {
    runSession();
  } else {
    void inspect(process.argv.slice(3)).then((result) => {
      if (!result.ok) {
        process.exitCode = 1;
      }
      process.stdout.write(JSON.stringify(result));
    });
  }
}
