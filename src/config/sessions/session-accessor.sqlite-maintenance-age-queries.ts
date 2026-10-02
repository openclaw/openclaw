import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { getNodeSqliteKysely, prepareSqliteQueryIterator } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";

const readersByDatabase = new WeakMap<DatabaseSync, ReturnType<typeof createAgeReaders>>();

function createAgeReaders(database: DatabaseSync) {
  const db =
    getNodeSqliteKysely<Pick<DB, "session_nodes" | "session_canonical_validation_pending">>(
      database,
    );
  const projection = db
    .selectFrom("session_nodes")
    .select(["session_key", "updated_at", "archived_at", "last_activity_at", "last_interaction_at"])
    .select((eb) =>
      eb
        .case()
        .when(eb.fn<number>("json_valid", ["entry_json"]), "=", 1)
        .then(
          eb.cast<number>(
            eb.fn("json_extract", [eb.ref("entry_json"), eb.val("$.sessionStartedAt")]),
            "integer",
          ),
        )
        .else(null)
        .end()
        .as("session_started_at"),
    );
  const ordered = db
    .selectFrom(
      projection
        .modifyEnd(
          /* kysely-allow-raw: ordered age probes must not sort the entire active store. */
          sql`INDEXED BY idx_agent_session_nodes_updated_at`,
        )
        .as("age_rows"),
    )
    .where("archived_at", "is", null)
    .orderBy("updated_at", "asc")
    .orderBy("session_key", "desc");

  // Seek between canonical agent namespaces in SQLite, then read only dashboard ranges.
  // Shared session stores may contain several agents; the physical owner is not a key filter.
  const dashboards = db
    .withRecursive("age_namespaces", (query) =>
      query
        .selectFrom("session_nodes")
        .select((eb) => eb.fn.min<string | null>("session_key").as("first_key"))
        .where("session_key", ">=", "agent:")
        .where("session_key", "<", "agent;")
        .unionAll(
          query
            .selectFrom("age_namespaces")
            .select((eb) =>
              eb
                .selectFrom("session_nodes")
                .select((inner) => inner.fn.min<string | null>("session_key").as("first_key"))
                .where(
                  "session_key",
                  ">",
                  /* kysely-allow-raw: skip a complete namespace or only the malformed key, preserving later indexed ranges. */
                  sql<string>`CASE
                    WHEN instr(substr(${eb.ref("age_namespaces.first_key")}, 7), ':') > 0
                    THEN substr(${eb.ref("age_namespaces.first_key")}, 1, 5 + instr(substr(${eb.ref("age_namespaces.first_key")}, 7), ':')) || ';'
                    ELSE ${eb.ref("age_namespaces.first_key")}
                  END`,
                )
                .where("session_key", "<", "agent;")
                .as("first_key"),
            )
            .where("first_key", "is not", null),
        ),
    )
    .selectFrom("age_namespaces")
    // Keep namespace seeks outside the range lookup even before statistics exist.
    .crossJoin(projection.as("age_rows"))
    .where(
      "age_rows.session_key",
      ">=",
      /* kysely-allow-raw: this range is a coarse selector; the canonical key decoder still decides dashboard eligibility. */
      sql<string>`substr(first_key, 1, 6 + instr(substr(first_key, 7), ':')) || 'dashboard:'`,
    )
    .where(
      "age_rows.session_key",
      "<",
      /* kysely-allow-raw: exclusive upper bound for the same dashboard namespace. */
      sql<string>`substr(first_key, 1, 6 + instr(substr(first_key, 7), ':')) || 'dashboard;'`,
    )
    .where("archived_at", "is", null)
    .selectAll("age_rows");
  const uncertified = db
    .selectFrom("session_canonical_validation_pending as pending")
    .crossJoin(projection.as("age_rows"))
    .whereRef("pending.session_key", "=", "age_rows.session_key")
    .where("archived_at", "is", null)
    .selectAll("age_rows");

  return {
    after: prepareSqliteQueryIterator<number, { session_key: string; updated_at: number }>(
      database,
      (parameter) =>
        ordered.select(["session_key", "updated_at"]).where(
          "updated_at",
          ">",
          parameter((minimum) => minimum),
        ),
    ),
    activity: prepareSqliteQueryIterator(database, () => ordered.selectAll("age_rows")),
    dashboards: prepareSqliteQueryIterator(database, () => dashboards),
    // Raw edits remain marked until the canonical owner validates their key/row shape.
    uncertified: prepareSqliteQueryIterator(database, () => uncertified),
  };
}

export function readSessionMaintenanceAgeQueries(database: DatabaseSync) {
  let readers = readersByDatabase.get(database);
  if (!readers) {
    readers = createAgeReaders(database);
    readersByDatabase.set(database, readers);
  }
  return readers;
}
