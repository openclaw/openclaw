import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { listSessionEntriesCore } from "../config/sessions/session-accessor.entry.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { withOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const trace = vi.hoisted(() => ({
  execute: vi.fn<(database: DatabaseSync, sql: string) => void>(),
}));
vi.mock("../infra/kysely-sync-cache-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/kysely-sync-cache-state.js")>();
  return {
    ...actual,
    executeWithCachedStatement: (...args: Parameters<typeof actual.executeWithCachedStatement>) => {
      // Count executions, including hits in the prepared-statement cache.
      if (!/^PRAGMA data_version\b/i.test(args[1])) {
        trace.execute(args[0], args[1]);
      }
      return actual.executeWithCachedStatement(...args);
    },
  };
});
vi.mock("../infra/node-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/node-sqlite.js")>();
  return {
    ...actual,
    openNodeSqliteDatabase: (...args: Parameters<typeof actual.openNodeSqliteDatabase>) => {
      const database = actual.openNodeSqliteDatabase(...args);
      const prepare = database.prepare.bind(database);
      vi.spyOn(database, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        // Observe before admission: the state owner retains raw statements outside Kysely.
        if (/^PRAGMA data_version\b/i.test(sql)) {
          const get = statement.get.bind(statement);
          vi.spyOn(statement, "get").mockImplementation((...bindings) => {
            trace.execute(database, sql);
            return get(...bindings);
          });
        }
        return statement;
      });
      return database;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const counts: Array<{
  owner: string;
  userVersion: number;
  sqliteMaster: number;
  dataVersion: number;
}> = [];

afterAll(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

beforeAll(async () => {
  const scope = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("openclaw-schema-budget-") },
    sessionKey: "agent:main:schema-budget",
    projection: "list" as const,
  };
  await upsertSessionEntryCore(scope, { sessionId: "schema-budget", updatedAt: 1 });
  const agent = openOpenClawAgentDatabase(scope);
  const state = openOpenClawStateDatabase(scope);
  const read = () => {
    expect(loadSessionEntryReadOnly(scope)?.sessionId).toBe("schema-budget");
    expect(listSessionEntriesCore(scope).map(({ entry }) => entry.sessionId)).toEqual([
      "schema-budget",
    ]);
    expect(openOpenClawStateDatabase(scope)).toBe(state);
  };
  read();
  expect(trace.execute.mock.calls.some(([, sql]) => /^PRAGMA user_version\b/i.test(sql))).toBe(
    true,
  );
  expect(trace.execute.mock.calls.some(([, sql]) => /^PRAGMA data_version\b/i.test(sql))).toBe(
    true,
  );
  trace.execute.mockClear();

  // No await: all 100 reads of each entry point occur in the same event-loop turn.
  for (let i = 0; i < 100; i++) {
    read();
  }
  for (const [owner, database] of [
    ["agent", agent.db],
    ["state", state.db],
  ] as const) {
    const sql = trace.execute.mock.calls.filter(([db]) => db === database).map(([, text]) => text);
    counts.push({
      owner,
      userVersion: sql.filter((text) => /^PRAGMA user_version\b/i.test(text)).length,
      sqliteMaster: sql.filter((text) => /\bsqlite_(master|schema)\b/i.test(text)).length,
      dataVersion: sql.filter((text) => /^PRAGMA data_version\b/i.test(text)).length,
    });
  }
  console.info("Admitted database checks for 100 reads per entry point:", counts);
});

it("keeps admitted reads within the schema-query budget", () => {
  expect(
    counts.map(({ owner, userVersion, sqliteMaster }) => ({ owner, userVersion, sqliteMaster })),
  ).toEqual(
    ["agent", "state"].map((owner) => ({
      owner,
      userVersion: 0,
      sqliteMaster: 0,
    })),
  );
});

it("refuses schemas migrated by another process on the next read", () => {
  const scope = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("openclaw-schema-migration-") },
  };
  const databases: Array<[string, number]> = [];
  try {
    const agent = openOpenClawAgentDatabase(scope);
    const state = openOpenClawStateDatabase(scope);
    databases.push(
      [agent.path, OPENCLAW_AGENT_SCHEMA_VERSION + 1],
      [state.path, OPENCLAW_STATE_SCHEMA_VERSION + 1],
    );
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { DatabaseSync } from 'node:sqlite';
         for (const [pathname, version] of JSON.parse(process.argv[1])) {
           const db = new DatabaseSync(pathname);
           db.exec('PRAGMA user_version = ' + version);
           db.close();
         }`,
        JSON.stringify(databases),
      ],
      { stdio: "pipe" },
    );
    expect(() => withOpenClawAgentDatabaseReadOnly(() => undefined, scope)).toThrow(
      /uses newer schema version/,
    );
    expect(() => openOpenClawStateDatabase(scope)).toThrow(/uses newer schema version/);
  } finally {
    // Lease cleanup still needs the synthetic shared state after exercising its refusal.
    for (const [pathname, version] of databases) {
      const database = new DatabaseSync(pathname);
      try {
        database.exec(`PRAGMA user_version = ${version - 1}`);
      } finally {
        database.close();
      }
    }
    closeOpenClawStateDatabaseForTest();
  }
});
