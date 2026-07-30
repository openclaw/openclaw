import type { Expression, ExpressionBuilder, SqlBool } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
} from "../../infra/sqlite-transaction.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionEntryStatus,
  SessionEntrySummary,
} from "./session-accessor.sqlite-contract.js";
import type { SessionEntryListQuery } from "./session-accessor.types.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  canonicalSqliteSessionKeyTokenIsCurrent,
} from "./session-canonical-key.js";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";
import type { SessionEntry } from "./types.js";

type SessionStatusDatabase = Pick<OpenClawAgentKyselyDatabase, "session_nodes">;
type SessionListExpressionBuilder = ExpressionBuilder<SessionStatusDatabase, "session_nodes">;
type SessionDatabaseReader = Pick<OpenClawAgentDatabase, "agentId" | "db"> & {
  writable?: boolean;
};
const CANONICAL_ENTRY_FIELDS = new Set(["sessionId", "updatedAt"]);
const SESSION_ENTRY_VALIDITY_REPAIR_COMMAND = "openclaw doctor --fix";

class SessionEntryValidityMigrationRequiredError extends Error {
  readonly code = "SESSION_ENTRY_VALIDITY_MIGRATION_REQUIRED";

  constructor() {
    super(
      `pending session entry projections require repair; stop the Gateway and run ${SESSION_ENTRY_VALIDITY_REPAIR_COMMAND}`,
    );
    this.name = "SessionEntryValidityMigrationRequiredError";
  }
}

class PendingSessionEntryValidityRetry extends Error {}

function isMissingEntryValidityColumnError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR" &&
    /\bno such column:\s*(?:"?session_nodes"?\.)?"?entry_valid"?/iu.test(error.message)
  );
}

function hasDuplicateCanonicalEntryFields(json: string): boolean {
  const seen = new Set<string>();
  let depth = 0;
  let escaped = false;
  let inString = false;
  let keyStart = -1;
  let expectingTopLevelKey = false;
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
        if (keyStart >= 0) {
          const key = JSON.parse(json.slice(keyStart, index + 1)) as unknown;
          if (typeof key === "string" && CANONICAL_ENTRY_FIELDS.has(key)) {
            if (seen.has(key)) {
              return true;
            }
            seen.add(key);
          }
          keyStart = -1;
          expectingTopLevelKey = false;
        }
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      if (depth === 1 && expectingTopLevelKey) {
        keyStart = index;
      }
    } else if (char === "{" || char === "[") {
      depth += 1;
      if (depth === 1) {
        expectingTopLevelKey = true;
      }
    } else if (char === "}" || char === "]") {
      depth -= 1;
    } else if (char === "," && depth === 1) {
      expectingTopLevelKey = true;
    }
  }
  return false;
}

export type SqliteSessionEntryListQueryResult = {
  creatorActors: NonNullable<SessionEntry["createdActor"]>[];
  entries: SessionEntrySummary[];
  totalCount: number;
};

export function normalizeSqliteStatus(value: unknown): SessionEntryStatus | null {
  return value === "running" ||
    value === "done" ||
    value === "failed" ||
    value === "killed" ||
    value === "timeout"
    ? value
    : null;
}

export function parseSqliteSessionEntryJson(row: {
  current_session_id?: string;
  entry_json: string;
  updated_at?: number;
}): SessionEntry | null {
  try {
    const parsed = JSON.parse(row.entry_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    if (hasDuplicateCanonicalEntryFields(row.entry_json)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const storedSessionId =
      typeof record.sessionId === "string" &&
      record.sessionId.trim() &&
      !record.sessionId.includes("\0")
        ? record.sessionId
        : undefined;
    const storedUpdatedAt =
      typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
        ? record.updatedAt
        : undefined;
    // entry_json is canonical; current_session_id only indexes a live canonical blob.
    // Retained-window placeholders use {}, so column fallback would resurrect deleted sessions.
    if (!storedSessionId || storedUpdatedAt === undefined) {
      return null;
    }
    if (
      (row.current_session_id !== undefined && row.current_session_id !== storedSessionId) ||
      (row.updated_at !== undefined && row.updated_at !== storedUpdatedAt)
    ) {
      return null;
    }
    // entry_json is the canonical record; promoted columns select rows but never override it.
    const entry = projectCanonicalSessionEntryShape(record);
    return typeof entry.sessionId === "string" ? entry : null;
  } catch {
    return null;
  }
}

function settlePendingSessionEntryValidity(database: SessionDatabaseReader): void {
  const db = getNodeSqliteKysely<SessionStatusDatabase>(database.db);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let pending: Array<{
      current_session_id: string;
      entry_json: string;
      session_key: string;
      updated_at: number;
    }>;
    try {
      pending = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_nodes")
          .select(["current_session_id", "entry_json", "session_key", "updated_at"])
          .where("entry_valid", "=", 0),
      ).rows;
    } catch (error) {
      if (isMissingEntryValidityColumnError(error)) {
        throw new SessionEntryValidityMigrationRequiredError();
      }
      throw error;
    }
    if (pending.length === 0) {
      return;
    }
    if (database.writable === false) {
      throw new SessionEntryValidityMigrationRequiredError();
    }
    const settled = pending.map((row) => ({
      entry_json: row.entry_json,
      entryValid: parseSqliteSessionEntryJson(row) ? 1 : -1,
      session_key: row.session_key,
    }));
    runSqliteImmediateTransactionSync(
      database.db,
      () => {
        for (const row of settled) {
          executeSqliteQuerySync(
            database.db,
            db
              .updateTable("session_nodes")
              .set({ entry_valid: row.entryValid })
              .where("session_key", "=", row.session_key)
              .where("entry_json", "=", row.entry_json)
              .where("entry_valid", "=", 0),
          );
        }
      },
      { operationLabel: "settle pending session entry validity" },
    );
  }
  throw new Error("SQLite session entries changed repeatedly during validity settlement");
}

function hasPendingSessionEntryValidity(database: SessionDatabaseReader): boolean {
  const db = getNodeSqliteKysely<SessionStatusDatabase>(database.db);
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      database.db,
      db.selectFrom("session_nodes").select("session_key").where("entry_valid", "=", 0).limit(1),
    ),
  );
}

function buildSessionListPredicate(
  eb: SessionListExpressionBuilder,
  query: SessionEntryListQuery,
  includeCreator: boolean,
) {
  const conditions: Expression<SqlBool>[] = [];
  if (query.archived !== "all") {
    conditions.push(eb("archived_at", query.archived === true ? "is not" : "is", null));
  }
  if (query.activeAfter !== undefined) {
    conditions.push(eb("updated_at", ">=", query.activeAfter));
  }
  if (query.requireLastInteraction) {
    conditions.push(eb("last_interaction_at", ">", 0));
  }
  if (query.label) {
    conditions.push(eb("label", "=", query.label));
  }
  if (includeCreator && query.createdActorId) {
    conditions.push(eb("created_actor_id", "=", query.createdActorId));
  }
  if (query.sessionId) {
    conditions.push(
      eb.or([
        eb("current_session_id", "=", query.sessionId),
        eb("session_key", "=", query.sessionId),
      ]),
    );
  }
  if (!query.includeGlobal) {
    conditions.push(eb("session_key", "!=", "global"));
  }
  if (!query.includeUnknown) {
    conditions.push(eb("session_key", "!=", "unknown"));
  }
  const agentTail = eb.fn<string>("substr", ["session_key", eb.val(7)]);
  const agentDelimiter = eb.fn<number>("instr", [agentTail, eb.val(":")]);
  if (query.ownerAgentId) {
    const ownerConditions: Expression<SqlBool>[] = [
      eb.and([
        eb("session_key", "like", "agent:%"),
        eb(agentDelimiter, ">", 0),
        eb(
          eb.fn<string>("substr", [agentTail, eb.val(1), eb(agentDelimiter, "-", 1)]),
          "=",
          query.ownerAgentId,
        ),
      ]),
    ];
    if (query.includeGlobal) {
      ownerConditions.push(eb("session_key", "=", "global"));
    }
    if (query.includeUnknown) {
      ownerConditions.push(eb("session_key", "=", "unknown"));
    }
    // Doctor owns legacy key migration; runtime accepts canonical agent keys plus explicit sentinels.
    conditions.push(eb.or(ownerConditions));
  }
  const agentRest = eb.fn<string>("substr", [agentTail, eb(agentDelimiter, "+", 1)]);
  if (!query.includeHidden) {
    const isCronRun = (rest: Expression<string>) => {
      const cronTail = eb.fn<string>("substr", [rest, eb.val(6)]);
      const delimiter = eb.fn<number>("instr", [cronTail, eb.val(":")]);
      const afterJob = eb.fn<string>("substr", [cronTail, eb(delimiter, "+", 1)]);
      return eb.and([
        eb(rest, "like", "cron:%"),
        eb(delimiter, ">", 1),
        eb(eb.fn<number>("glob", [eb.val("run:[^:]*"), afterJob]), "=", 1),
      ]);
    };
    const asInteger = (condition: Expression<SqlBool>) =>
      eb.case().when(condition).then(1).else(0).end();
    const hidden = eb
      .case()
      .when("session_key", "like", "internal-session-effects:%")
      .then(1)
      .when("session_key", "like", "cron:%")
      .then(asInteger(isCronRun(eb.ref("session_key"))))
      .when(
        eb.or([
          eb("session_key", "like", "agent:%:internal-session-effects:%"),
          eb("session_key", "like", "agent:%:cron:%:run:%"),
        ]),
      )
      .then(
        asInteger(
          eb.or([eb(agentRest, "like", "internal-session-effects:%"), isCronRun(agentRest)]),
        ),
      )
      .else(0)
      .end();
    conditions.push(eb(hidden, "=", 0));
  }
  // Writers and pending-row settlement own canonical blob validation. The partial indexes make
  // the exact parser contract available to selection/count queries without rescanning blobs.
  conditions.push(eb("entry_valid", "=", eb.lit(1)));
  if (query.spawnedBy) {
    // Canonical sentinels are valid rows, but they never participate in child lineage.
    conditions.push(eb("session_key", "!=", "global"));
    conditions.push(eb("session_key", "!=", "unknown"));
    const lineageKeys = query.lineageKeys?.length ? [...query.lineageKeys] : [query.spawnedBy];
    const storedLineage = eb.or([
      eb("parent_session_key", "in", lineageKeys),
      eb("spawned_by", "in", lineageKeys),
    ]);
    const excluded = query.excludeLineageSessionKeys ?? [];
    if (excluded.length > 400) {
      throw new Error("SQLite lineage exclusion query must use residual selection above 400 keys");
    }
    const storedSelection = excluded.length
      ? eb.and([eb("session_key", "not in", [...excluded]), storedLineage])
      : storedLineage;
    conditions.push(
      query.includeLineageSessionKeys?.length
        ? eb.or([eb("session_key", "in", [...query.includeLineageSessionKeys]), storedSelection])
        : storedSelection,
    );
  }
  return eb.and(conditions);
}

export function querySqliteSessionEntries(
  database: SessionDatabaseReader,
  query: SessionEntryListQuery,
  options: {
    projection?: "full" | "list";
    setProjectedTitle: (entry: SessionEntry, title: string | null) => void;
  },
): SqliteSessionEntryListQueryResult {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Older same-version writers leave rows pending through the trigger. Reconcile only that
    // partial-indexed set before relying on the steady-state validity indexes.
    settlePendingSessionEntryValidity(database);
    const validationToken = assertCanonicalSqliteSessionKeysCurrent(database, query.mainKey);
    try {
      return runSqliteDeferredTransactionSync(
        database.db,
        () => {
          // This read establishes the same snapshot used by selection. A compatible writer
          // that committed after settlement is retried instead of disappearing from the page.
          if (hasPendingSessionEntryValidity(database)) {
            throw new PendingSessionEntryValidityRetry();
          }
          return querySqliteSessionEntriesInSnapshot(database, query, options, validationToken);
        },
        { operationLabel: "query session list" },
      );
    } catch (error) {
      if (!(error instanceof PendingSessionEntryValidityRetry)) {
        throw error;
      }
      if (database.writable === false) {
        throw new SessionEntryValidityMigrationRequiredError();
      }
    }
  }
  throw new Error("SQLite session entries changed repeatedly during list selection");
}

function querySqliteSessionEntriesInSnapshot(
  database: SessionDatabaseReader,
  query: SessionEntryListQuery,
  options: {
    projection?: "full" | "list";
    setProjectedTitle: (entry: SessionEntry, title: string | null) => void;
  },
  validationToken: ReturnType<typeof assertCanonicalSqliteSessionKeysCurrent>,
  attempt = 0,
): SqliteSessionEntryListQueryResult {
  const finish = (result: SqliteSessionEntryListQueryResult) => {
    if (canonicalSqliteSessionKeyTokenIsCurrent(database, validationToken)) {
      return result;
    }
    if (attempt >= 2) {
      throw new Error("SQLite session state changed repeatedly during list selection");
    }
    return querySqliteSessionEntriesInSnapshot(
      database,
      query,
      options,
      assertCanonicalSqliteSessionKeysCurrent(database, query.mainKey),
      attempt + 1,
    );
  };
  const included = query.includeLineageSessionKeys;
  if (included && included.length > 400) {
    const entries = new Map<string, SessionEntrySummary>();
    const creatorActors = new Map<string, NonNullable<SessionEntry["createdActor"]>>();
    for (let offset = 0; offset < included.length; offset += 400) {
      const result = querySqliteSessionEntriesInSnapshot(
        database,
        {
          ...query,
          includeLineageSessionKeys: included.slice(offset, offset + 400),
          limit: undefined,
        },
        options,
        validationToken,
      );
      for (const entry of result.entries) {
        entries.set(entry.sessionKey, entry);
      }
      for (const actor of result.creatorActors) {
        creatorActors.set(`${actor.type}\0${actor.id ?? ""}`, actor);
      }
    }
    const compareSessionKeys = (left: string, right: string) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
    const mergedEntries = [...entries.values()].toSorted((left, right) => {
      if (query.sortBy === "lastInteractionAt") {
        return (
          (right.entry.lastInteractionAt ?? 0) - (left.entry.lastInteractionAt ?? 0) ||
          compareSessionKeys(left.sessionKey, right.sessionKey)
        );
      }
      return (
        (right.entry.pinnedAt ?? 0) - (left.entry.pinnedAt ?? 0) ||
        (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0) ||
        compareSessionKeys(left.sessionKey, right.sessionKey)
      );
    });
    const limit = query.limit === undefined ? undefined : Math.max(1, Math.floor(query.limit));
    return finish({
      creatorActors: [...creatorActors.values()],
      entries: limit === undefined ? mergedEntries : mergedEntries.slice(0, limit),
      totalCount: entries.size,
    });
  }
  const db = getNodeSqliteKysely<SessionStatusDatabase>(database.db);
  const base = db
    .selectFrom("session_nodes")
    .where((eb) => buildSessionListPredicate(eb, query, true));
  const selected = base.select([
    "session_key",
    "current_session_id",
    "entry_json",
    "updated_at",
    "display_name",
  ]);
  const limit = query.limit === undefined ? undefined : Math.max(1, Math.floor(query.limit));
  const rows =
    query.sortBy === "lastInteractionAt"
      ? executeSqliteQuerySync(
          database.db,
          (limit ? selected.limit(limit) : selected)
            .orderBy((eb) => eb.fn.coalesce("last_interaction_at", eb.val(0)), "desc")
            .orderBy("session_key", "asc"),
        ).rows
      : (() => {
          const pinned = executeSqliteQuerySync(
            database.db,
            (limit ? selected.limit(limit) : selected)
              .where("pinned_at", ">", 0)
              .orderBy("pinned_at", "desc")
              .orderBy("updated_at", "desc")
              .orderBy("session_key", "asc"),
          ).rows;
          const remaining = limit === undefined ? undefined : limit - pinned.length;
          if (remaining !== undefined && remaining <= 0) {
            return pinned;
          }
          const unpinned = executeSqliteQuerySync(
            database.db,
            (remaining === undefined ? selected : selected.limit(remaining))
              .where((eb) => eb.or([eb("pinned_at", "is", null), eb("pinned_at", "<=", 0)]))
              .orderBy("updated_at", "desc")
              .orderBy("session_key", "asc"),
          ).rows;
          return [...pinned, ...unpinned];
        })();
  const entries = rows.flatMap((row) => {
    const entry = parseSqliteSessionEntryJson(row);
    if (!entry) {
      return [];
    }
    const projected = entry;
    if (options.projection === "list") {
      delete projected.skillsSnapshot;
      delete projected.systemPromptReport;
    }
    options.setProjectedTitle(projected, row.display_name);
    return [{ sessionKey: row.session_key, entry: projected }];
  });
  const count = executeSqliteQueryTakeFirstSync(
    database.db,
    base.clearSelect().select((eb) => eb.fn.countAll<number>().as("count")),
  )?.count;
  const creatorRows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select((eb) => [
        "created_actor_id",
        "created_actor_type",
        eb
          .case()
          .when(eb(eb.fn<number>("json_valid", ["entry_json"]), "=", 1))
          .then(
            eb
              .case()
              .when(
                eb(
                  eb.fn<string | null>("json_type", ["entry_json", eb.val("$.createdActor.label")]),
                  "=",
                  "text",
                ),
              )
              .then(eb.fn<string>("json_extract", ["entry_json", eb.val("$.createdActor.label")]))
              .else(null)
              .end(),
          )
          .else(null)
          .end()
          .as("created_actor_label"),
      ])
      .distinct()
      .where((eb) => buildSessionListPredicate(eb, query, false))
      .where("created_actor_id", "is not", null),
  ).rows;
  const creatorActors = new Map<string, NonNullable<SessionEntry["createdActor"]>>();
  for (const row of creatorRows) {
    const actorType = row.created_actor_type;
    if (
      !row.created_actor_id ||
      (actorType !== "agent" && actorType !== "human" && actorType !== "system")
    ) {
      continue;
    }
    const label =
      typeof row.created_actor_label === "string" ? row.created_actor_label.trim() : undefined;
    const key = `${actorType}\0${row.created_actor_id}`;
    const existing = creatorActors.get(key);
    if (!existing?.label || (label && label.localeCompare(existing.label) < 0)) {
      creatorActors.set(key, {
        id: row.created_actor_id,
        type: actorType,
        ...(label ? { label } : {}),
      });
    }
  }
  return finish({
    creatorActors: [...creatorActors.values()],
    entries,
    totalCount: count ?? 0,
  });
}

export function readSqliteSessionEntriesByStatus(
  database: OpenClawAgentDatabase,
  statuses: readonly SessionEntryStatus[],
  sessionKeys?: readonly string[],
): SessionEntrySummary[] {
  const selectedStatuses = [...new Set(statuses)];
  const selectedSessionKeys = sessionKeys ? [...new Set(sessionKeys)] : undefined;
  if (selectedStatuses.length === 0 || selectedSessionKeys?.length === 0) {
    return [];
  }
  const db = getNodeSqliteKysely<SessionStatusDatabase>(database.db);
  let query = db
    .selectFrom("session_nodes")
    .select(["session_key", "entry_json", "current_session_id", "updated_at"])
    .where("status", "in", selectedStatuses);
  if (selectedSessionKeys) {
    query = query.where("session_key", "in", selectedSessionKeys);
  }
  return executeSqliteQuerySync(database.db, query)
    .rows.flatMap((row) => {
      const entry = parseSqliteSessionEntryJson(row);
      return entry ? [{ entry, sessionKey: row.session_key }] : [];
    })
    .toSorted((a, b) => a.sessionKey.localeCompare(b.sessionKey));
}
