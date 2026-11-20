import { parentPort, workerData } from "node:worker_threads";
import pg, { type QueryResult } from "pg";
import type {
  BridgeReply,
  BridgeRequest,
  BridgeWorkerData,
  PostgresErrorData,
} from "./protocol.js";

const {
  port,
  signal,
  url,
  schema,
  connectTimeoutMs,
  lockTimeoutMs,
  statementTimeoutMs,
}: BridgeWorkerData = workerData;
const control = new Int32Array(signal);
const TRANSPORT_TIMEOUT_MS = 10_000;
const client = new pg.Client({
  connectionString: url,
  connectionTimeoutMillis: connectTimeoutMs,
  keepAlive: true,
  keepAliveInitialDelayMillis: TRANSPORT_TIMEOUT_MS,
  types: {
    // Store decoders own JSON parsing, including malformed legacy payload handling.
    getTypeParser: (oid, format) =>
      (oid === pg.types.builtins.JSON || oid === pg.types.builtins.JSONB) && format !== "binary"
        ? (value: string) => value
        : pg.types.getTypeParser(oid, format),
  },
});
let connectionError: Error | undefined;
client.on("error", (error) => {
  connectionError = error;
});
process.once("exit", () => {
  Atomics.store(control, 1, 1);
  Atomics.notify(control, 1);
});

async function handleRequest(request: BridgeRequest) {
  let reply: BridgeReply;
  // A socket can stay open after PostgreSQL has already finished the statement.
  // End only this connection; the host owns outcome classification and never retries it.
  const cutoff =
    request.operation === "query"
      ? setTimeout(() => void client.end().catch(() => {}), request.deadlineMs - 20_000)
      : undefined;
  try {
    if (request.operation === "connect") {
      await client.connect();
      const setup = {
        text:
          "SELECT set_config('lock_timeout', $1, false), " +
          "set_config('statement_timeout', $2, false), set_config('search_path', $3, false)",
        values: [
          `${lockTimeoutMs}ms`,
          `${statementTimeoutMs}ms`,
          `"${schema.replaceAll('"', '""')}"`,
        ],
        query_timeout: TRANSPORT_TIMEOUT_MS,
      };
      await client.query(setup);
      reply = { id: request.id, result: { rows: [], rowCount: 0, fields: [] } };
    } else if (request.operation === "close") {
      await client.end();
      reply = { id: request.id, result: { rows: [], rowCount: 0, fields: [] } };
    } else {
      if (connectionError) {
        throw connectionError;
      }
      const values = request.parameters.map((value) =>
        ArrayBuffer.isView(value)
          ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
          : value,
      );
      const results = await client.query(request.sql, values);
      const result: QueryResult | undefined = Array.isArray(results) ? results.at(-1) : results;
      if (!result) {
        throw new Error("PostgreSQL returned no query result");
      }
      reply = {
        id: request.id,
        result: {
          command: result.command,
          rows: result.rows,
          rowCount: result.rowCount ?? 0,
          fields: result.fields.map(({ name, dataTypeID }) => ({ name, dataTypeID })),
        },
      };
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const details: PostgresErrorData = {
      name: failure.name,
      message: failure.message,
      stack: failure.stack,
    };
    if (request.operation === "connect" && "code" in failure && typeof failure.code === "string") {
      details.code = failure.code;
    }
    if (error instanceof pg.DatabaseError) {
      Object.assign(details, {
        code: error.code,
        detail: error.detail,
        constraint: error.constraint,
        column: error.column,
      });
    }
    reply = { id: request.id, error: details };
  } finally {
    clearTimeout(cutoff);
  }
  port.postMessage(reply);
  Atomics.store(control, 0, request.id);
  Atomics.notify(control, 0);
  if (request.operation === "close" || (request.operation === "connect" && "error" in reply)) {
    port.close();
    parentPort?.close();
  }
}

port.on("message", (request: BridgeRequest) => {
  void handleRequest(request);
});
