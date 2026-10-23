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
      if (client && !connectionError) {
        try {
          // Validate only while idle: user statements are never replayed after a lost connection.
          await client.query("SELECT 1");
          reply = {
            id: request.id,
            result: { inTransaction: false, rows: [], rowCount: 0, fields: [] },
          };
          port.postMessage(reply);
          Atomics.store(control, 0, request.id);
          Atomics.notify(control, 0);
          return;
        } catch (error) {
          connectionError = error instanceof Error ? error : new Error(String(error));
        }
      }
      if (client) {
        await client.end().catch(() => {});
      }
      connectionError = undefined;
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
      await client.query(
        "SELECT set_config('lock_timeout', $1, false), " +
          "set_config('statement_timeout', $2, false), set_config('search_path', $3, false)",
        [`${lockTimeoutMs}ms`, `${statementTimeoutMs}ms`, `"${schema.replaceAll('"', '""')}"`],
      );
      reply = {
        id: request.id,
        result: { inTransaction: false, rows: [], rowCount: 0, fields: [] },
      };
    } else if (request.operation === "close") {
      await client.end();
      reply = {
        id: request.id,
        result: { inTransaction: false, rows: [], rowCount: 0, fields: [] },
      };
    } else {
      if (connectionError) {
        throw connectionError;
      }
      if (request.operation === "release") {
        // Server status also catches transactions opened later in a multi-statement query.
        const reusable = client.getTransactionStatus() === "I";
        if (!reusable) {
          await client.end();
        }
        reply = { id: request.id, reusable };
      } else if (request.operation === "recovery-generation") {
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
        const result: QueryResult = Array.isArray(results) ? results.at(-1)! : results;
        // A trailing SELECT must not hide an earlier write in the same SQL batch.
        const commands = (Array.isArray(results) ? results : [results]).map(
          ({ command }) => command,
        );
        const mutation = commands.some((command) =>
          /^(?:CREATE|ALTER|DROP|TRUNCATE|COMMENT|GRANT|REVOKE|COPY|CALL|DO|REFRESH)$/.test(
            command,
          ),
        )
          ? "unscoped"
          : commands.some((command) => /^(?:INSERT|UPDATE|DELETE|MERGE)$/.test(command))
            ? "scoped"
            : undefined;
        reply = {
          id: request.id,
          result: {
            inTransaction: client.getTransactionStatus() !== "I",
            command: result.command,
            mutation,
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
  if (
    request.operation === "close" ||
    (request.operation === "connect" && "error" in reply) ||
    ("reusable" in reply && !reply.reusable)
  ) {
    port.close();
    parentPort?.close();
  }
}

port.on("message", (request: BridgeRequest) => {
  void handleRequest(request);
});
