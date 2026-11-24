import { sql, type InferResult } from "kysely";
import { engineIndexHint } from "../../infra/database-engine/index-hint.js";
import {
  createSqliteQueryCache,
  getNodeSqliteKysely,
  prepareSqliteQueryIterator,
} from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";

export const readSessionMaintenanceAgeQueries = createSqliteQueryCache((database) => {
  const postgres = isPostgresSqlConnection(database);
  const position =
    /* kysely-allow-raw: Closed engine choice of equivalent substring-position functions. */ sql.raw(
      postgres ? "strpos" : "instr",
    );
  const db =
    getNodeSqliteKysely<Pick<DB, "session_nodes" | "session_canonical_validation_pending">>(
      database,
    );
  const projection = db
    .selectFrom("session_nodes")
    .select([
      "session_key",
      "updated_at",
      "archived_at",
      "last_activity_at",
      "last_interaction_at",
      "session_started_at",
    ]);
  type ActivityRow = InferResult<typeof projection>[number];
  const ordered = db
    .selectFrom(
      projection
        .modifyEnd(engineIndexHint(database, "idx_agent_session_nodes_updated_at"))
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
                    WHEN ${position}(substr(${eb.ref("age_namespaces.first_key")}, 7), ':') > 0
                    THEN substr(${eb.ref("age_namespaces.first_key")}, 1, 5 + ${position}(substr(${eb.ref("age_namespaces.first_key")}, 7), ':')) || ';'
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
      sql<string>`substr(first_key, 1, 6 + ${position}(substr(first_key, 7), ':')) || 'dashboard:'`,
    )
    .where(
      "age_rows.session_key",
      "<",
      /* kysely-allow-raw: exclusive upper bound for the same dashboard namespace. */
      sql<string>`substr(first_key, 1, 6 + ${position}(substr(first_key, 7), ':')) || 'dashboard;'`,
    )
    .where("archived_at", "is", null)
    .selectAll("age_rows");
  const uncertified = db
    .selectFrom("session_canonical_validation_pending as pending")
    .crossJoin(projection.as("age_rows"))
    .whereRef("pending.session_key", "=", "age_rows.session_key")
    .where("archived_at", "is", null)
    .selectAll("age_rows");
  type AgeRow = Pick<ActivityRow, "session_key" | "updated_at">;
  const pageSize = 64;
  const after = prepareSqliteQueryIterator<{ minimum: number; previous?: AgeRow }, AgeRow>(
    database,
    (parameter) => {
      const query = ordered.select(["session_key", "updated_at"]).where(
        "updated_at",
        ">",
        parameter(({ minimum }) => minimum),
      );
      if (!postgres) {
        return query;
      }
      const timestamp = parameter(({ minimum, previous }) => previous?.updated_at ?? minimum);
      return query
        .where("updated_at", ">=", timestamp)
        .where((eb) =>
          eb.or([
            eb("updated_at", ">", timestamp),
            eb(
              "session_key",
              "<",
              parameter(({ previous }) => previous?.session_key ?? null),
            ),
          ]),
        )
        .limit(pageSize);
    },
  );

  return {
    // PostgreSQL buffers replies; page lazily past protected keys without reading the tail.
    // Its admitted UTF-8 keys round-trip exactly. SQLite keeps native streaming/text semantics.
    after: postgres
      ? function* (minimum: number) {
          let previous: AgeRow | undefined;
          while (true) {
            let count = 0;
            for (const row of after({ minimum, previous })) {
              previous = row;
              count++;
              yield row;
            }
            if (count < pageSize) {
              return;
            }
          }
        }
      : (minimum: number) => after({ minimum }),
    activity: prepareSqliteQueryIterator(database, () => ordered.selectAll("age_rows")),
    activityBefore: prepareSqliteQueryIterator<number, ActivityRow>(database, (parameter) =>
      ordered.selectAll("age_rows").where(
        "updated_at",
        "<",
        parameter((maximum) => maximum),
      ),
    ),
    // Raw edits remain marked until the canonical owner validates their key/row shape.
    dashboards: prepareSqliteQueryIterator(database, () => dashboards.unionAll(uncertified)),
    dashboardsBefore: prepareSqliteQueryIterator<number, ActivityRow>(database, (parameter) => {
      const maximum = parameter((value) => value);
      return dashboards
        .where("age_rows.updated_at", "<", maximum)
        .unionAll(uncertified.where("age_rows.updated_at", "<", maximum));
    }),
  };
});
