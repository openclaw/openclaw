import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as boundaryPath from "../infra/boundary-path.js";
import { executeSqliteQuerySync as query, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { migrateAgentDatabaseRelativePaths as migrate } from "./openclaw-state-db-schema-repair.js";
import type { AgentDatabases, DB } from "./openclaw-state-db.generated.js";

vi.hoisted(() => {
  // The custody runner can preload these owners before the Windows path mock.
  vi.resetModules();
});

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, default: actual.win32 };
});

beforeEach(() => {
  mockProcessPlatform("win32");
  // The in-memory migration rows use synthetic roots, including UNC hosts.
  vi.spyOn(boundaryPath, "resolveIdentityPathViaExistingAncestorSync").mockImplementation(
    (root) => root,
  );
});
afterEach(() => vi.restoreAllMocks());

function row(
  path: string,
  schema_version: number,
  last_seen_at: number,
  size_bytes: number | null,
  agent_id = "main",
): AgentDatabases {
  return { agent_id, path, schema_version, last_seen_at, size_bytes };
}

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
        using db = new (requireNodeSqlite().DatabaseSync)(":memory:");
        db.exec(`
          CREATE TABLE agent_databases (
            agent_id TEXT NOT NULL, path TEXT NOT NULL,
            schema_version INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, size_bytes INTEGER,
            PRIMARY KEY (agent_id, path)
          ) STRICT;
          PRAGMA user_version = 8;
          PRAGMA reverse_unordered_selects = ${reverse ? 1 : 0};
        `);
        const relative = String.raw`agents\main\agent\openclaw-agent.sqlite`;
        const ordinary = nodePath.join(stateDir, relative);
        const namespaced = nodePath.toNamespacedPath(ordinary);
        const external = String.raw`D:\External\custom.sqlite`;
        const newer = [20, 200, null] as const;
        const older = [18, 100, 50] as const;
        const aliases = [
          newest === "ordinary" ? row(ordinary, ...newer) : row(ordinary, ...older),
          newest === "namespaced" ? row(namespaced, ...newer) : row(namespaced, ...older),
        ];
        const retained: AgentDatabases[] = [
          row(ordinary, 18, 300, 75, "other"),
          row(external, 18, 400, 80),
          row(nodePath.toNamespacedPath(external), 20, 500, 90),
        ];
        const queries = getNodeSqliteKysely<Pick<DB, "agent_databases">>(db);
        const input = [...(reverse ? aliases.toReversed() : aliases), ...retained];
        query(db, queries.insertInto("agent_databases").values(input));

        runSqliteImmediateTransactionSync(db, () =>
          migrate(db, 8, nodePath.join(stateDir, "state", "openclaw.sqlite")),
        );

        const rows = query(db, queries.selectFrom("agent_databases").selectAll()).rows;
        expect(rows).toHaveLength(4);
        expect(rows).toEqual(
          expect.arrayContaining([
            row(relative, ...newer),
            { ...retained[0], path: relative },
            retained[1],
            retained[2],
          ]),
        );
      },
    );
  },
);
