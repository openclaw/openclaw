import { createHash } from "node:crypto";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import pg, { type QueryResult } from "pg";
import {
  fingerprintPostgresGeneration,
  inspectPostgresGeneration,
  lockPostgresGeneration,
} from "../../snapshot/postgres-generation.js";
import { materializeErrorStack } from "../error-graph-internal.js";
import type { PostgresPoolEndpoint } from "./pool-state.js";
import type { PostgresPoolSetup, PostgresPoolWorkerData } from "./pool.js";
import type {
  BridgeReply,
  BridgeRequest,
  BridgeWorkerData,
  PostgresErrorData,
} from "./protocol.js";

const { host: serviceHost, peers }: PostgresPoolWorkerData = workerData;
function watchPeer({ port, signal }: PostgresPoolEndpoint) {
  port.on("close", () => {
    const peer = new Int32Array(signal);
    Atomics.store(peer, 1, 1);
    Atomics.notify(peer, 1);
  });
}
peers.forEach(watchPeer);
parentPort?.on("message", (message: { watch: PostgresPoolEndpoint }) => watchPeer(message.watch));

function attachHost(host: MessagePort) {
  const clients = new Set<() => void>();
  host.on("message", (message: PostgresPoolSetup) => {
    if ("host" in message) {
      attachHost(message.host);
    } else {
      attachConnection(message.connection, clients);
    }
  });
  host.on("close", () => {
    for (const close of clients) {
      close();
    }
  });
}

// pgjdbc's preparedStatementCacheQueries default; bounds server memory per connection.
const STATEMENT_LIMIT = 256;
const CACHED_PLAN_RESULT_CHANGED = "0A000";

/**
 * Reuses server-side prepared statements on one connection, so PostgreSQL parses each
 * parameterized SQL text once per session instead of on every call; plan choice stays
 * automatic (plan_cache_mode). The server re-analyzes a prepared statement when
 * search_path changes, so the SQL text is the key.
 */
function createStatementCache(client: pg.Client) {
  // node-postgres skips Parse for names in this map and has no deallocate API, so every
  // DEALLOCATE must drop its name here too.
  // SAFETY: pinned pg 8.23.1 records each ParseComplete name here; the PostgreSQL test proves it.
  const { parsedStatements } = client.connection as typeof client.connection & {
    parsedStatements: Record<string, string>;
  };
  // SQL text -> statement name, least recently used first.
  const names = new Map<string, string>();
  // Names whose result type changed under a transaction; deallocated before their next use.
  const stale = new Set<string>();

  async function deallocate(name: string) {
    await client.query(`DEALLOCATE "${name}"`);
    delete parsedStatements[name];
    stale.delete(name);
  }

  return {
    async query(sql: string, parameters: readonly unknown[]): Promise<QueryResult | QueryResult[]> {
      // Parameterless SQL keeps the simple protocol, which multi-statement batches need.
      if (parameters.length === 0) {
        return client.query(sql);
      }
      let name = names.get(sql);
      if (name === undefined) {
        if (names.size >= STATEMENT_LIMIT) {
          const [victimSql, victim] = names.entries().next().value!;
          await deallocate(victim);
          names.delete(victimSql);
        }
        name = createHash("sha1").update(sql).digest("hex");
      } else {
        names.delete(sql);
      }
      names.set(sql, name);
      if (stale.has(name)) {
        await deallocate(name);
      }
      const reused = parsedStatements[name] !== undefined;
      const autocommit = client.getTransactionStatus() === "I";
      const config = { name, text: sql, values: [...parameters] };
      try {
        return await client.query(config);
      } catch (error) {
        if (parsedStatements[name] === undefined) {
          names.delete(sql);
        }
        // DDL from another connection (Doctor migrations) can change a cached statement's
        // result type. It fails before executing; only autocommit can run it again, because
        // inside a transaction the failure has already aborted the transaction.
        if (
          !reused ||
          !(error instanceof pg.DatabaseError) ||
          error.code !== CACHED_PLAN_RESULT_CHANGED
        ) {
          throw error;
        }
        stale.add(name);
        if (!autocommit) {
          throw error;
        }
        await deallocate(name);
        return client.query(config);
      }
    },
    /** Drops every statement after DDL on this connection, before a stale plan can fail. */
    async reset() {
      if (names.size === 0) {
        return;
      }
      await client.query("DEALLOCATE ALL");
      names.clear();
      stale.clear();
      for (const name of Object.keys(parsedStatements)) {
        delete parsedStatements[name];
      }
    },
  };
}

function attachConnection(data: BridgeWorkerData, clients: Set<() => void>) {
  const { port, signal, url, connectTimeoutMs, lockTimeoutMs, statementTimeoutMs } = data;
  let schema = data.schema;
  const control = new Int32Array(signal);
  let client: pg.Client;
  let statements: ReturnType<typeof createStatementCache>;
  let connectionError: Error | undefined;
  const close = () => {
    clients.delete(close);
    port.close();
    void client?.end().catch(() => {});
  };
  clients.add(close);
  port.on("close", close);

  function send(reply: BridgeReply) {
    port.postMessage(reply);
    Atomics.store(control, 0, reply.id);
    Atomics.notify(control, 0);
  }

  async function connect(namespace: string) {
    const searchPath = `"${namespace.replaceAll('"', '""')}"`;
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
          (oid === pg.types.builtins.JSON || oid === pg.types.builtins.JSONB) && format !== "binary"
            ? (value: string) => value
            : pg.types.getTypeParser(oid, format),
      },
    });
    statements = createStatementCache(client);
    client.on("error", (error) => {
      materializeErrorStack(error);
      connectionError = error;
    });
    await client.connect();
    await client.query(
      "SELECT set_config('lock_timeout', $1, false), " +
        "set_config('statement_timeout', $2, false), set_config('search_path', $3, false)",
      [`${lockTimeoutMs}ms`, `${statementTimeoutMs}ms`, searchPath],
    );
    schema = namespace;
  }

  async function useSchema(namespace: string, reconnectIfIdle: boolean) {
    if (connectionError) {
      // Only a returned transport can reconnect before its new borrower starts work.
      if (!reconnectIfIdle || client.getTransactionStatus() !== "I") {
        throw connectionError;
      }
      await connect(namespace);
      return;
    }
    if (schema === namespace) {
      return;
    }
    if (client.getTransactionStatus() !== "I") {
      throw new Error("Cannot switch PostgreSQL schemas inside a transaction");
    }
    try {
      await client.query("SELECT set_config('search_path', $1, false)", [
        `"${namespace.replaceAll('"', '""')}"`,
      ]);
      schema = namespace;
    } catch {
      // No user statement ran; discard the failed setup before opening a fresh transport.
      await connect(namespace);
    }
  }

  async function handleRequest(request: BridgeRequest) {
    let reply: BridgeReply;
    try {
      if (request.operation === "connect") {
        await connect(request.schema);
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
        if (request.operation === "release") {
          if (connectionError) {
            throw connectionError;
          }
          // Server status also catches transactions opened later in a multi-statement query.
          const reusable = client.getTransactionStatus() === "I";
          if (!reusable) {
            await client.end();
          }
          reply = { id: request.id, reusable };
        } else if (request.operation === "recovery-generation") {
          await useSchema(request.schema, request.reconnectIfIdle === true);
          if (request.lock) {
            await lockPostgresGeneration(client, schema);
          }
          const anchor = { namespace: schema, storeId: request.storeId };
          const generation = fingerprintPostgresGeneration(
            anchor,
            await inspectPostgresGeneration(client, anchor),
          );
          reply = {
            id: request.id,
            generation,
            inTransaction: client.getTransactionStatus() !== "I",
          };
        } else {
          await useSchema(request.schema, request.reconnectIfIdle === true);
          const results = await statements.query(request.sql, request.parameters);
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
          if (mutation === "unscoped") {
            await statements.reset();
          }
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
      if (
        request.operation === "connect" &&
        "code" in failure &&
        typeof failure.code === "string"
      ) {
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
    send(reply);
    if (
      request.operation === "close" ||
      (request.operation === "connect" && "error" in reply) ||
      ("reusable" in reply && !reply.reusable)
    ) {
      close();
    }
  }

  port.on("message", (request: BridgeRequest) => {
    void handleRequest(request);
  });
}
attachHost(serviceHost);
parentPort?.postMessage({ poolReady: true }, []);
