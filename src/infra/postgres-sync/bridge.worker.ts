import { parentPort, workerData } from "node:worker_threads";
import pg, { type QueryResult } from "pg";
import {
  fingerprintPostgresGeneration,
  inspectPostgresGeneration,
  lockPostgresGeneration,
} from "../../snapshot/postgres-generation.js";
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
let client: pg.Client;
let connectionError: Error | undefined;
process.once("exit", () => {
  Atomics.store(control, 1, 1);
  Atomics.notify(control, 1);
});

async function handleRequest(request: BridgeRequest) {
  let reply: BridgeReply;
  try {
    if (request.operation === "connect") {
      // URL parsing can throw too; every connect failure must wake the waiting host.
      client = new pg.Client({
        connectionString: url,
        connectionTimeoutMillis: connectTimeoutMs,
        types: {
          // Store decoders own JSON parsing, including malformed legacy payload handling.
          getTypeParser: (oid, format) =>
            (oid === pg.types.builtins.JSON || oid === pg.types.builtins.JSONB) &&
            format !== "binary"
              ? (value: string) => value
              : pg.types.getTypeParser(oid, format),
        },
      });
      client.on("error", (error) => {
        connectionError = error;
      });
      await client.connect();
      // Matches the pilot's SQLite WAL + synchronous=NORMAL durability tradeoff.
      await client.query("SET synchronous_commit = off");
      await client.query(
        "SELECT set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false)",
        [`${lockTimeoutMs}ms`, `${statementTimeoutMs}ms`],
      );
      await client.query(`SET search_path TO "${schema.replaceAll('"', '""')}"`);
      reply = { id: request.id, result: { rows: [], rowCount: 0, fields: [] } };
    } else if (request.operation === "close") {
      await client.end();
      reply = { id: request.id, result: { rows: [], rowCount: 0, fields: [] } };
    } else {
      if (connectionError) {
        throw connectionError;
      }
      if (request.operation === "recovery-generation") {
        if (request.lock) {
          await lockPostgresGeneration(client, schema);
        }
        const anchor = { namespace: schema, storeId: request.storeId };
        const generation = fingerprintPostgresGeneration(
          anchor,
          await inspectPostgresGeneration(client, anchor),
        );
        reply = { id: request.id, generation };
      } else {
        const results = await client.query(request.sql, [...request.parameters]);
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
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const reported =
      request.operation === "connect"
        ? new Error(
            `PostgreSQL connection failed: ${failure.message}. Check database.postgres.connection, network, and credentials.`,
          )
        : failure;
    if (request.operation === "connect") {
      reported.name = "PostgresConnectionError";
    }
    const details: PostgresErrorData = {
      name: reported.name,
      message: reported.message,
      stack: reported.stack,
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
