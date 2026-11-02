import { on } from "node:events";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { deserialize, serialize } from "node:v8";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { serializeNativeErrorResponse } from "./native-error-response.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { readSqliteIntegrityFileIdentity } from "./sqlite-file-generation.js";
import type {
  SqliteIntegrityWorkerInput,
  SqliteIntegrityWorkerMessage,
  SqliteIntegrityWorkerPhase,
  SqliteIntegrityWorkerResult,
} from "./sqlite-integrity-worker.js";
import { assertSqliteIntegrity, SqliteIntegrityError } from "./sqlite-integrity.js";
import { configureSqliteMaintenanceCache } from "./sqlite-maintenance-cache.js";

const synchronous = process.argv[2] === "--check-sync";
if (!synchronous && (!process.send || !process.disconnect)) {
  throw new Error("SQLite integrity child requires parent IPC.");
}

function send(message: SqliteIntegrityWorkerMessage): Promise<void> {
  if (!process.send) {
    throw new Error("SQLite integrity child requires parent IPC.");
  }
  const sendMessage = process.send.bind(process);
  return new Promise((resolve, reject) => {
    // Flush each phase before native work can block this child's event loop.
    sendMessage(message, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function sendPhase(phase: SqliteIntegrityWorkerPhase): Promise<void> {
  return synchronous ? Promise.resolve() : send({ type: "phase", phase });
}

async function check(input: SqliteIntegrityWorkerInput): Promise<SqliteIntegrityWorkerResult> {
  let database: import("node:sqlite").DatabaseSync | undefined;
  let failure: Error | undefined;
  let checkElapsedMs: number | undefined;
  try {
    await sendPhase("opening");
    readSqliteIntegrityFileIdentity(input.pathname, input.identity);
    database = openNodeSqliteDatabase(input.pathname, {
      readOnly: true,
      timeout: input.busyTimeoutMs,
    });
    configureSqliteMaintenanceCache(database);
    readSqliteIntegrityFileIdentity(input.pathname, input.identity);
    await sendPhase("checking");
    const startedAt = performance.now();
    try {
      assertSqliteIntegrity(database, input.databaseLabel, input.integrity);
    } finally {
      checkElapsedMs = performance.now() - startedAt;
    }
  } catch (error) {
    failure = toStringifiedError(error);
  } finally {
    if (database) {
      try {
        await sendPhase("closing");
      } catch (error) {
        // Reporting failure cannot replace a native failure or skip native close.
        failure ??= toStringifiedError(error);
      }
    }
    try {
      database?.close();
    } catch (error) {
      failure = toStringifiedError(error);
    }
  }
  let result: SqliteIntegrityWorkerResult = { ok: true };
  if (failure) {
    result = {
      ok: false,
      error: {
        ...serializeNativeErrorResponse(failure),
        ...(failure instanceof SqliteIntegrityError ? { findings: failure.findings } : {}),
      },
    };
  }
  if (checkElapsedMs !== undefined) {
    result.checkElapsedMs = checkElapsedMs;
  }
  return result;
}

if (synchronous) {
  // SAFETY: Only the owning integrity parent supplies this private native payload.
  const input = deserialize(fs.readFileSync(0)) as SqliteIntegrityWorkerInput;
  fs.writeFileSync(1, serialize(await check(input)));
} else {
  // Plain inputs and results remain compatible with published one-shot parents.
  // SAFETY: Only the private integrity parent sends these requests; node:events leaves IPC payloads untyped.
  for await (const [input] of on(process, "message") as AsyncIterable<
    [SqliteIntegrityWorkerInput | { type: "close" }]
  >) {
    if ("type" in input) {
      process.disconnect?.();
      break;
    }
    const result = await check(input);
    await send(result);
    if (!input.reuse || !result.ok) {
      process.disconnect?.();
      break;
    }
  }
}
