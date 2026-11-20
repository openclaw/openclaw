import { sql, type Expression, type RawBuilder } from "kysely";
import {
  jsonObjectValue,
  jsonRemovePaths,
  jsonValid,
} from "../../infra/database-engine/json-values.js";
import {
  createSqliteQueryCache,
  getNodeSqliteKysely,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { supportsNodeSqliteJsonb } from "../../infra/node-sqlite.js";
import { isPostgresSqlConnection, type EngineConnection } from "../../infra/sql-connection.js";
import {
  projectModelContextEventSql,
  projectModelContextNavigationSql,
  projectResetBoundaryNavigationSql,
  projectTranscriptPayloadNavigationSql,
} from "./session-model-context-projection.js";

const MAX_NAVIGATION_BYTES = 16 * 1024;

// This shape owns both the native envelope and its minimum serialized overhead.
const NAVIGATION_ENVELOPE = {
  version: 1,
  report: null,
  navigation: {},
  reset: {},
  model: {},
  modelBytes: 0,
  modelWithoutCheckpointBytes: 0,
  withoutCustomDataBytes: 0,
};
function minimumNavigationBytes(navigation: Record<string, number>): number {
  return (
    Buffer.byteLength(
      JSON.stringify({ ...NAVIGATION_ENVELOPE, navigation, reset: navigation, model: navigation }),
    ) - "null".length
  );
}
export const TRANSCRIPT_PAYLOAD_MIN_NAVIGATION_BYTES = [
  minimumNavigationBytes({}),
  minimumNavigationBytes({ type: 0, id: 0 }),
  minimumNavigationBytes({ type: 0, id: 0, parentId: 0 }),
] as const;

function navigationProjection(
  database: EngineConnection,
  event: Expression<string | Uint8Array>,
  report: Expression<string>,
  originalEvent: Expression<string>,
): RawBuilder<string | null> {
  if (isPostgresSqlConnection(database)) {
    return /* kysely-allow-raw: the same stored navigation envelope uses PostgreSQL native JSON and byte accounting. */ sql<
      string | null
    >`CASE
      WHEN ${jsonValid(database, originalEvent)} AND ${jsonValid(database, report)} THEN CASE
      WHEN json_typeof(${originalEvent}::json) != 'object'
        OR coalesce(json_typeof(${originalEvent}::json -> 'message'), 'null') NOT IN ('object', 'null') THEN NULL
      ELSE json_build_object('version', 1,
        'report', ${report}::json,
        'navigation', ${projectTranscriptPayloadNavigationSql(database, event)}::json,
        'reset', ${projectResetBoundaryNavigationSql(database, originalEvent)}::json,
        'model', ${projectModelContextNavigationSql(database, event)}::json,
        'modelBytes', octet_length(${projectModelContextEventSql(database, event, sql.lit(0))}),
        'modelWithoutCheckpointBytes', octet_length(${projectModelContextEventSql(database, event, sql.lit(1))}),
        'withoutCustomDataBytes', octet_length(${jsonRemovePaths(database, event, [sql.lit("$.data")])}))::text
      END ELSE NULL END`;
  }
  const metadata = jsonObjectValue(database, {
    ...Object.fromEntries(
      Object.entries(NAVIGATION_ENVELOPE).map(([key, value]) => [
        key,
        typeof value === "number" ? sql.lit(value) : sql`json(${JSON.stringify(value)})`,
      ]),
    ),
    report: sql`json(${report})`,
    navigation: sql`json(${projectTranscriptPayloadNavigationSql(database, event)})`,
    reset: sql`json(${projectResetBoundaryNavigationSql(database, originalEvent)})`,
    model: sql`json(${projectModelContextNavigationSql(database, event, undefined, sql.lit(1))})`,
    modelBytes: sql`octet_length(${projectModelContextEventSql(database, event, sql.lit(0), undefined, undefined, sql.lit(1))})`,
    modelWithoutCheckpointBytes: sql`octet_length(${projectModelContextEventSql(database, event, sql.lit(1), undefined, undefined, sql.lit(1))})`,
    withoutCustomDataBytes: sql`octet_length(json_remove(${event}, '$.data'))`,
  });
  return /* kysely-allow-raw: record native projections and exact byte costs; exceptional envelopes retain identity behavior. */ sql<
    string | null
  >`CASE WHEN json_valid(${originalEvent}) AND json_valid(${report}) THEN CASE
    WHEN json_type(${event}) != 'object'
      OR coalesce(json_type(${event}, '$.message'), 'null') NOT IN ('object', 'null') THEN NULL
    ELSE ${metadata} END ELSE NULL END`;
}

type NavigationInput = { eventJson: string; reportJson: string };
const navigationReader = createSqliteQueryCache((database: EngineConnection) =>
  prepareSqliteQueryTakeFirstSync<NavigationInput, { navigation_json: string | null }>(
    database,
    (parameter) => {
      const db = getNodeSqliteKysely<Record<string, never>>(database);
      const source = db
        .selectFrom(
          db
            .selectNoFrom([
              parameter((value) => value.eventJson).as("event_json"),
              parameter((value) => value.reportJson).as("report_json"),
            ])
            .as("input"),
        )
        .select(["input.event_json", "input.report_json"])
        .select((eb) =>
          !isPostgresSqlConnection(database) && supportsNodeSqliteJsonb()
            ? /* kysely-allow-raw: reuse native binary JSON only after the existing strict text validation. */ sql<
                string | Uint8Array
              >`CASE WHEN json_valid(${eb.ref("input.event_json")})
                  THEN jsonb(${eb.ref("input.event_json")}) ELSE ${eb.ref("input.event_json")} END`.as(
                "event_projection",
              )
            : eb.ref("input.event_json").as("event_projection"),
        );
      return (
        db
          // Full JSON and JSONB intermediates can spill to disk when materialized.
          .with(
            (cte) => cte("source").notMaterialized(),
            () => source,
          )
          // The size guard and returned value must reuse one envelope, not flatten into two projections.
          .with(
            (cte) => cte("metadata").materialized(),
            (cteDb) =>
              cteDb
                .selectFrom("source")
                .select((eb) =>
                  navigationProjection(
                    database,
                    eb.ref("source.event_projection"),
                    eb.ref("source.report_json"),
                    eb.ref("source.event_json"),
                  ).as("navigation_json"),
                ),
          )
          .selectFrom("metadata")
          .select((eb) =>
            /* kysely-allow-raw: reject oversized metadata natively before returning its text to JavaScript. */ sql<
              string | null
            >`CASE WHEN ${jsonValid(database, eb.ref("metadata.navigation_json"))}
                AND octet_length(metadata.navigation_json) <= ${MAX_NAVIGATION_BYTES}
                THEN metadata.navigation_json ELSE NULL END`.as("navigation_json"),
          )
      );
    },
  ),
);

/** Build bounded navigation using the native connection's cached query. */
export function readTranscriptPayloadNavigation(
  database: EngineConnection,
  eventJson: string,
  reportJson: string,
): string | null {
  return navigationReader(database)({ eventJson, reportJson })?.navigation_json ?? null;
}
