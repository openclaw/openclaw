import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  mergeToolUsage,
  TOOL_USAGE_RETENTION_MS,
  type ToolUsageRow,
} from "../../agents/tool-usage.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { withSqliteDatabaseWriteScope } from "../../infra/sqlite-database-admission.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { AgentToolUsageState, AgentToolUsageStatus } from "./tool-usage.types.js";

const scope = "agent-tool-usage";
const key = "import-state-v1";
const liveScope = "agent-tool-usage-live-runs";

export function emptyAgentToolUsageState(): AgentToolUsageState {
  return { generation: 0, liveSince: null, importedWindows: [], lastImportAt: null };
}

function readAgentToolUsageStateInDatabase(db: EngineConnection): AgentToolUsageState {
  const query = getNodeSqliteKysely<DB>(db)
    .selectFrom("cache_entries")
    .select("value_json")
    .where("scope", "=", scope)
    .where("key", "=", key);
  const stored = executeSqliteQuerySync(db, query).rows[0]?.value_json;
  if (!stored) {
    return emptyAgentToolUsageState();
  }
  const state: unknown = JSON.parse(stored);
  if (
    !isRecord(state) ||
    typeof state.generation !== "number" ||
    !Number.isSafeInteger(state.generation) ||
    state.generation < 0
  ) {
    throw new Error(
      "Invalid tool usage import metadata; repair the agent database before retrying",
    );
  }
  const readTimestamp = (value: unknown): number | null => {
    if (
      value === null ||
      (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    ) {
      return value;
    }
    throw new Error(
      "Invalid tool usage import timestamp; repair the agent database before retrying",
    );
  };
  if (!Array.isArray(state.importedWindows)) {
    throw new Error("Invalid tool usage import windows");
  }
  const importedWindows: AgentToolUsageState["importedWindows"] = [];
  for (const window of state.importedWindows) {
    if (!isRecord(window)) {
      throw new Error("Invalid tool usage import window");
    }
    const since = readTimestamp(window.since),
      before = readTimestamp(window.before);
    if (
      since === null ||
      before === null ||
      since >= before ||
      (importedWindows.length && importedWindows.at(-1)!.before >= since)
    ) {
      throw new Error("Invalid tool usage import window boundaries");
    }
    importedWindows.push({ since, before });
  }
  return {
    generation: state.generation,
    liveSince: readTimestamp(state.liveSince),
    importedWindows,
    lastImportAt: readTimestamp(state.lastImportAt),
  };
}

function writeState(db: EngineConnection, state: AgentToolUsageState, now: number): void {
  const query = getNodeSqliteKysely<DB>(db)
    .insertInto("cache_entries")
    .values({
      scope,
      key,
      value_json: JSON.stringify(state),
      blob: null,
      expires_at: null,
      updated_at: now,
    })
    .onConflict((conflict) =>
      conflict.columns(["scope", "key"]).doUpdateSet({
        value_json: JSON.stringify(state),
        updated_at: now,
      }),
    );
  executeSqliteQuerySync(db, query);
}

export function readAgentToolUsageLiveRunsInDatabase(
  db: EngineConnection,
  now: number,
): Set<string> {
  return new Set(
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<DB>(db)
        .selectFrom("cache_entries")
        .select("key")
        .where("scope", "=", liveScope)
        .where("expires_at", ">=", now),
    ).rows.map((row) => row.key),
  );
}

function retainLiveRun(db: EngineConnection, runId: string | undefined, now: number): void {
  if (!runId) {
    return;
  }
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<DB>(db)
      .insertInto("cache_entries")
      .values({
        scope: liveScope,
        key: runId,
        value_json: "{}",
        blob: null,
        expires_at: now + TOOL_USAGE_RETENTION_MS,
        updated_at: now,
      })
      .onConflict((conflict) =>
        conflict.columns(["scope", "key"]).doUpdateSet({
          expires_at: now + TOOL_USAGE_RETENTION_MS,
          updated_at: now,
        }),
      ),
  );
}

export function pruneAgentToolUsageInDatabase(db: EngineConnection, now: number): void {
  return withSqliteDatabaseWriteScope(db, [], () => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<DB>(db)
        .deleteFrom("cache_entries")
        .where("scope", "=", liveScope)
        .where("expires_at", "<", now),
    );
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<DB>(db)
        .deleteFrom("agent_tool_usage")
        .where("updated_at", "<", now - TOOL_USAGE_RETENTION_MS),
    );
  });
}

export function readAgentToolUsageInDatabase(
  db: EngineConnection,
  now: number,
): AgentToolUsageStatus {
  const rows = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom("agent_tool_usage")
      .select(["tool_id as toolId", "score", "updated_at as updatedAt"])
      .where("updated_at", ">=", now - TOOL_USAGE_RETENTION_MS)
      .orderBy("tool_id"),
  ).rows;
  return { ...readAgentToolUsageStateInDatabase(db), rows };
}

export function beginAgentToolUsageInDatabase(
  db: EngineConnection,
  now: number,
  runId?: string,
): AgentToolUsageState {
  return withSqliteDatabaseWriteScope(db, [], () => {
    const state = readAgentToolUsageStateInDatabase(db);
    retainLiveRun(db, runId, now);
    if (state.liveSince === null) {
      state.liveSince = now;
      writeState(db, state, now);
    }
    pruneAgentToolUsageInDatabase(db, now);
    return state;
  });
}

function mergeRows(db: EngineConnection, rows: readonly ToolUsageRow[], now: number): void {
  const sql = getNodeSqliteKysely<DB>(db);
  const retained = rows.filter((row) => row.updatedAt >= now - TOOL_USAGE_RETENTION_MS);
  if (!retained.length) {
    return;
  }
  const current = new Map(
    executeSqliteQuerySync(
      db,
      sql
        .selectFrom("agent_tool_usage")
        .select(["tool_id as toolId", "score", "updated_at as updatedAt"])
        .where(
          "tool_id",
          "in",
          retained.map((row) => row.toolId),
        ),
    ).rows.map((row) => [row.toolId, row]),
  );
  for (const row of retained) {
    const old = current.get(row.toolId);
    current.set(row.toolId, old ? mergeToolUsage(old, row) : row);
  }
  // Keep parameter count bounded on both engines; each turn ordinarily fits one statement.
  const values = [...current.values()].map((row) => ({
    tool_id: row.toolId,
    score: row.score,
    updated_at: row.updatedAt,
  }));
  for (let offset = 0; offset < values.length; offset += 250) {
    executeSqliteQuerySync(
      db,
      sql
        .insertInto("agent_tool_usage")
        .values(values.slice(offset, offset + 250))
        .onConflict((conflict) =>
          conflict.column("tool_id").doUpdateSet((eb) => ({
            score: eb.ref("excluded.score"),
            updated_at: eb.ref("excluded.updated_at"),
          })),
        ),
    );
  }
}

export function flushAgentToolUsageInDatabase(
  db: EngineConnection,
  input: {
    generation: number;
    runId?: string;
    rows: readonly ToolUsageRow[];
    startedAt?: number;
    now: number;
  },
): boolean {
  return withSqliteDatabaseWriteScope(db, [], () => {
    const state = readAgentToolUsageStateInDatabase(db);
    if (state.generation !== input.generation) {
      return false;
    }
    if (state.liveSince === null) {
      if (input.startedAt === undefined) {
        return false;
      }
      state.liveSince = input.startedAt;
      writeState(db, state, input.now);
    }
    retainLiveRun(db, input.runId, input.now);
    mergeRows(db, input.rows, input.now);
    pruneAgentToolUsageInDatabase(db, input.now);
    return true;
  });
}

export function resetAgentToolUsageInDatabase(
  db: EngineConnection,
  now: number,
): AgentToolUsageState {
  return withSqliteDatabaseWriteScope(db, [], () => {
    const state = readAgentToolUsageStateInDatabase(db);
    const next = {
      ...emptyAgentToolUsageState(),
      generation: state.generation + 1,
      liveSince: now,
    };
    executeSqliteQuerySync(db, getNodeSqliteKysely<DB>(db).deleteFrom("agent_tool_usage"));
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<DB>(db).deleteFrom("cache_entries").where("scope", "=", liveScope),
    );
    writeState(db, next, now);
    return next;
  });
}

export function commitAgentToolUsageImportInDatabase(
  db: EngineConnection,
  input: {
    expected: AgentToolUsageState;
    rows: readonly ToolUsageRow[];
    since: number;
    now: number;
  },
): boolean {
  return withSqliteDatabaseWriteScope(db, [], () => {
    const state = readAgentToolUsageStateInDatabase(db);
    if (
      state.generation !== input.expected.generation ||
      state.liveSince !== input.expected.liveSince ||
      JSON.stringify(state.importedWindows) !== JSON.stringify(input.expected.importedWindows) ||
      state.lastImportAt !== input.expected.lastImportAt
    ) {
      return false;
    }
    mergeRows(db, input.rows, input.now);
    pruneAgentToolUsageInDatabase(db, input.now);
    const floor = input.now - TOOL_USAGE_RETENTION_MS;
    const windows = [...state.importedWindows, { since: input.since, before: input.now }]
      .filter((window) => window.before > Math.max(floor, window.since))
      .map((window) => ({ before: window.before, since: Math.max(window.since, floor) }))
      .toSorted((a, b) => a.since - b.since);
    const importedWindows: AgentToolUsageState["importedWindows"] = [];
    for (const window of windows) {
      const previous = importedWindows.at(-1);
      if (previous && previous.before >= window.since) {
        previous.before = Math.max(previous.before, window.before);
      } else {
        importedWindows.push(window);
      }
    }
    writeState(db, { ...state, importedWindows, lastImportAt: input.now }, input.now);
    return true;
  });
}

/** Agent retirement has already closed pending database admissions. */
export function deleteAgentToolUsageInDatabase(db: EngineConnection): void {
  return withSqliteDatabaseWriteScope(db, [], () => {
    const sql = getNodeSqliteKysely<DB>(db);
    executeSqliteQuerySync(db, sql.deleteFrom("agent_tool_usage"));
    executeSqliteQuerySync(
      db,
      sql.deleteFrom("cache_entries").where("scope", "in", [scope, liveScope]),
    );
  });
}
