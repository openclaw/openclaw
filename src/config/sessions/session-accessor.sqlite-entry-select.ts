import { expressionBuilder } from "kysely";
import { executeSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import {
  getExactSessionEntryQueries,
  selectReadableSessionEntryRows,
} from "./session-accessor.sqlite-entry-query.js";
import {
  selectSessionEntryWindowFacts,
  takeSessionEntryWindowFacts,
} from "./session-accessor.sqlite-provenance.js";
import { canonicalSessionValidationQuery } from "./session-canonical-key.js";
import type { CanonicalSessionValidationRow } from "./session-canonical-row.js";
import type { SessionEntryProjection } from "./session-entry-snapshot-values.js";
import { sessionEntrySnapshotColumnsForKeys } from "./session-entry-snapshots.js";
import type { ResolvedSessionEntryRow } from "./session-entry-storage.types.js";

type OpenClawAgentDatabaseReader = Pick<OpenClawAgentDatabase, "agentId" | "db">;

export type ReadableSessionEntryRow = ResolvedSessionEntryRow["row"] &
  (CanonicalSessionValidationRow | { retained_window_id?: never });

/** Single-key and cohort readers share the same row selection and ordering. */
export function readSelectedSessionEntryRows(
  database: OpenClawAgentDatabaseReader,
  selection: string | readonly string[],
  projection: SessionEntryProjection | "delivery",
  validation?: "canonical",
  options?: {
    includeBoardPresence?: boolean;
    includeMembership?: boolean;
    includeWindowFacts?: true;
  },
): ReadableSessionEntryRow[] {
  const key =
    typeof selection === "string" ? selection : selection.length === 1 ? selection[0] : undefined;
  if (
    key !== undefined &&
    projection !== "delivery" &&
    !options?.includeBoardPresence &&
    !options?.includeMembership &&
    !options?.includeWindowFacts
  ) {
    const queries = getExactSessionEntryQueries(database.db);
    const row =
      validation === "canonical"
        ? queries.canonical(key, projection)
        : queries.row(key, projection);
    return row ? [row] : [];
  }
  const baseQuery =
    validation === "canonical"
      ? canonicalSessionValidationQuery(database, { metadata: true })
          .select("session_nodes.updated_at")
          .select(
            sessionEntrySnapshotColumnsForKeys(
              undefined,
              projection === "delivery" ? "list" : projection,
            ),
          )
      : selectReadableSessionEntryRows(database, projection);
  const windowQuery = baseQuery.$if(options?.includeWindowFacts === true, (builder) =>
    builder
      .leftJoin(
        selectSessionEntryWindowFacts(database),
        "entry_window.window_session_id",
        "session_nodes.current_session_id",
      )
      .selectAll("entry_window")
      .select((eb) => [
        eb
          .selectFrom("transcript_rewrite_watermarks")
          .select("generation")
          .whereRef("session_id", "=", "session_nodes.current_session_id")
          .as("transcript_generation"),
        eb.fn
          .coalesce(
            eb
              .selectFrom("session_transcript_cold_archives")
              .select("last_seq")
              .whereRef("session_id", "=", "session_nodes.current_session_id"),
            eb
              .selectFrom("transcript_events")
              .select((inner) => inner.fn.max<number>("seq").as("max_seq"))
              .whereRef("session_id", "=", "session_nodes.current_session_id"),
          )
          .as("transcript_max_seq"),
      ]),
  );
  const eb = expressionBuilder<OpenClawAgentKyselyDatabase, "session_nodes">();
  // Old stores have no board tables until first use; branch before compiling SQL.
  const boardQuery = options?.includeBoardPresence
    ? windowQuery.select(
        (tableExists(database.db, "board_widgets")
          ? eb.exists(
              eb
                .selectFrom("board_tabs")
                .select("session_key")
                .whereRef("board_tabs.session_key", "=", "session_nodes.session_key"),
            )
          : eb.lit(0)
        ).as("board_present"),
      )
    : windowQuery;
  const query = options?.includeMembership
    ? boardQuery.select((outer) =>
        tableExists(database.db, "session_members")
          ? outer
              .selectFrom("session_members")
              .select(({ fn }) =>
                fn
                  .agg<string>("json_group_array", ["identity_id"])
                  .orderBy("identity_id")
                  .as("ids"),
              )
              .whereRef("session_members.session_key", "=", "session_nodes.session_key")
              .$asScalar()
              .as("member_ids_json")
          : outer.val("[]").as("member_ids_json"),
      )
    : boardQuery;
  const rows = executeSqliteQuerySync(
    database.db,
    (typeof selection === "string"
      ? query.where("session_nodes.session_key", "=", selection)
      : query.where("session_nodes.session_key", "in", sqliteStringSet(selection))
    ).orderBy("session_nodes.session_key", "asc"),
  ).rows;
  return options?.includeWindowFacts
    ? rows.map((row) => {
        const window = takeSessionEntryWindowFacts(row);
        const { transcript_generation, transcript_max_seq, ...entryRow } = row;
        return {
          ...entryRow,
          window,
          transcriptWatermark: {
            sessionId: row.current_session_id,
            generation: transcript_generation ?? null,
            maxSeq: transcript_max_seq ?? null,
          },
        };
      })
    : rows;
}
