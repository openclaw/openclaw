import "../../test-utils/prepare-compiled-subprocesses.js";
import "./backup-worker.test-support.js";
import { randomUUID } from "node:crypto";
import { getEnvironmentData } from "node:worker_threads";
import { Client, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { agentPortProvider } from "./agent-port.js";
import type { PortEndpoint } from "./port-descriptor.js";
import { materializeDatabasePort, type PortDescriptor } from "./port.worker.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;

function port(
  source: PortEndpoint,
  destination: PortEndpoint,
  descriptor: PortDescriptor,
  storeId: string,
) {
  return materializeDatabasePort({ source, destination, descriptor, storeId, assertCurrent() {} });
}
const sqlite = (db: ReturnType<typeof openNodeSqliteDatabase>): PortEndpoint => ({
  engine: "sqlite",
  db,
});
describe.skipIf(!connection)("agent database port memory recovery", () => {
  const client = new Client({ connectionString: connection });
  const namespaces = new Set<string>();
  const pg = (namespace: string): PortEndpoint => ({ engine: "postgres", db: client, namespace });
  const rows = async <T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) =>
    (await client.query<T>(sql, values)).rows;
  beforeAll(() => client.connect());
  afterAll(async () => {
    for (const namespace of namespaces) {
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    await client.end();
  });

  it("refuses a legacy NUL memory chunk without changing the SQLite source", async () => {
    const descriptor = await agentPortProvider.loadDescriptor();
    using source = openNodeSqliteDatabase(":memory:");
    source.exec(descriptor.sqlite);
    const embedding = Buffer.from("000000000000f03f", "hex");
    const insertChunk = source.prepare(`INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES (?, ?, 'sessions', 1, 1, ?, 'fixture-model', CAST(? AS TEXT), ?, 1)`);
    insertChunk.run("valid", "sessions/valid.jsonl", "valid-hash", Buffer.from("valid"), embedding);
    insertChunk.run(
      "legacy",
      "sessions/session.jsonl",
      "legacy-hash",
      Buffer.from("before\0after"),
      embedding,
    );
    const chunkQuery =
      "SELECT id, hash, hex(text) AS text_hex, hex(embedding) AS embedding_hex FROM memory_index_chunks ORDER BY id";
    const original = source.prepare(chunkQuery).all();
    const rejected = `agent_legacy_mem_${randomUUID().replaceAll("-", "")}`;
    namespaces.add(rejected);
    await expect(port(sqlite(source), pg(rejected), descriptor, randomUUID())).rejects.toThrow(
      /Port refused memory_index_chunks\.text: unrepresentable UTF-8 text/,
    );
    expect(source.prepare(chunkQuery).all()).toEqual(original);
    expect(await rows("SELECT 1 FROM pg_namespace WHERE nspname = $1", [rejected])).toEqual([]);
  });
});
