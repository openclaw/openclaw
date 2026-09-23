import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { migrateAgentDatabaseRelativePaths } from "./openclaw-state-db-schema-repair.js";
import type { AgentDatabases, DB } from "./openclaw-state-db.generated.js";

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, default: actual.win32 };
});

beforeEach(() => mockProcessPlatform("win32"));
afterEach(() => vi.restoreAllMocks());

describe.each([String.raw`C:\OpenClaw`, String.raw`\\Server\Share\OpenClaw`])(
  "v8 Windows inventory migration under %s",
  (stateDir) => {
    it.each([
      { reverse: false, newest: "ordinary" },
      { reverse: false, newest: "namespaced" },
      { reverse: true, newest: "ordinary" },
      { reverse: true, newest: "namespaced" },
    ])(
      "merges aliases with newest $newest facts (reverse scan: $reverse)",
      ({ reverse, newest }) => {
        const db = new (requireNodeSqlite().DatabaseSync)(":memory:");
        try {
          db.exec(`
          CREATE TABLE agent_databases (
            agent_id TEXT NOT NULL,
            path TEXT NOT NULL,
            schema_version INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            size_bytes INTEGER,
            PRIMARY KEY (agent_id, path)
          ) STRICT;
          PRAGMA user_version = 8;
          PRAGMA reverse_unordered_selects = ${reverse ? 1 : 0};
        `);
          const relative = String.raw`agents\main\agent\openclaw-agent.sqlite`;
          const ordinary = path.join(stateDir, relative);
          const namespaced = path.toNamespacedPath(ordinary);
          const external = String.raw`D:\External\custom.sqlite`;
          const newestFacts = { schema_version: 20, last_seen_at: 200, size_bytes: null };
          const olderFacts = { schema_version: 18, last_seen_at: 100, size_bytes: 50 };
          const aliases: AgentDatabases[] = [
            {
              agent_id: "main",
              path: ordinary,
              ...(newest === "ordinary" ? newestFacts : olderFacts),
            },
            {
              agent_id: "main",
              path: namespaced,
              ...(newest === "namespaced" ? newestFacts : olderFacts),
            },
          ];
          const retained: AgentDatabases[] = [
            {
              agent_id: "other",
              path: ordinary,
              schema_version: 18,
              last_seen_at: 300,
              size_bytes: 75,
            },
            {
              agent_id: "main",
              path: external,
              schema_version: 18,
              last_seen_at: 400,
              size_bytes: 80,
            },
            {
              agent_id: "main",
              path: path.toNamespacedPath(external),
              schema_version: 20,
              last_seen_at: 500,
              size_bytes: 90,
            },
          ];
          const queries = getNodeSqliteKysely<Pick<DB, "agent_databases">>(db);
          executeSqliteQuerySync(
            db,
            queries
              .insertInto("agent_databases")
              .values([...(reverse ? aliases.toReversed() : aliases), ...retained]),
          );

          runSqliteImmediateTransactionSync(db, () =>
            migrateAgentDatabaseRelativePaths(
              db,
              8,
              path.join(stateDir, "state", "openclaw.sqlite"),
            ),
          );

          const rows = executeSqliteQuerySync(
            db,
            queries.selectFrom("agent_databases").selectAll(),
          ).rows;
          expect(rows).toHaveLength(4);
          expect(rows).toEqual(
            expect.arrayContaining([
              { agent_id: "main", path: relative, ...newestFacts },
              { ...retained[0], path: relative },
              retained[1],
              retained[2],
            ]),
          );
        } finally {
          db.close();
        }
      },
    );
  },
);
