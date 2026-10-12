import { parentPort, workerData } from "node:worker_threads";
import pg, { type QueryResult } from "pg";
import type {
  BridgeReply,
  BridgeRequest,
  BridgeWorkerData,
  PostgresErrorData,
} from "./protocol.js";

const { port, signal, url, schema }: BridgeWorkerData = workerData;
const control = new Int32Array(signal);
const client = new pg.Client({
  connectionString: url,
  connectionTimeoutMillis: 15_000,
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
  try {
    if (request.operation === "connect") {
      await client.connect();
      // Matches the pilot's SQLite WAL + synchronous=NORMAL durability tradeoff.
      await client.query("SET synchronous_commit = off");
      await client.query(`SET search_path TO "${schema.replaceAll('"', '""')}"`);
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
    if (error instanceof pg.DatabaseError) {
      Object.assign(details, {
        code: error.code,
        detail: error.detail,
        constraint: error.constraint,
        column: error.column,
      });
    }
    reply = { id: request.id, error: details };
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
