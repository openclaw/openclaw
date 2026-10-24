import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";

type TaskPublicationSession = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string | null;
};
export type TaskPublicationRead = {
  sessions: TaskPublicationSession[];
  ownerProfileId?: string;
  branchUrls?: string[];
};

/** Only compact acknowledged publication facts cross the worker boundary, never PR bodies. */
export function readTaskPublicationReceipts(db: EngineConnection, input: TaskPublicationRead) {
  const query = getNodeSqliteKysely<DB>(db);
  let receipts = query
    .selectNoFrom((eb) => [
      eb.val("").as("session_key"),
      eb.val("").as("agent_id"),
      eb.val("").as("session_id"),
      eb.val<string | null>(null).as("pull_request_url"),
      eb.val("").as("branch"),
      eb.val<string | null>(null).as("title"),
      eb.val(0).as("updated_at_ms"),
      eb.val("").as("request_id"),
      eb.val<string | null>(null).as("lifecycle_revision"),
    ])
    .where((eb) => eb.val(1), "=", 0);
  const sessionIds = input.sessions.map((session) => session.sessionId);
  if (sessionIds.length === 0) {
    return { receipts: [], count: 0, branchMatchCount: 0 };
  }
  const lifecycle = tableExists(db, "github_publication_session_lifecycles");
  for (const table of [
    "github_publication_requests",
    "github_personal_publication_requests",
  ] as const) {
    if (
      !tableExists(db, table) ||
      (table === "github_personal_publication_requests" && !input.ownerProfileId)
    ) {
      continue;
    }
    // Old receipts without a lifecycle sidecar can only match an originally absent revision.
    let selection = query
      .selectFrom(table)
      .select([
        "session_key",
        "agent_id",
        "session_id",
        "pull_request_url",
        "branch",
        "title",
        "updated_at_ms",
        "request_id",
      ])
      .where("status", "=", "published")
      .where("pull_request_url", "is not", null)
      .where("session_id", "in", sessionIds);
    if (table === "github_personal_publication_requests") {
      selection = selection.where("owner_profile_id", "=", input.ownerProfileId!);
    }
    receipts = receipts.unionAll(
      selection.select((eb) =>
        lifecycle
          ? eb
              .selectFrom("github_publication_session_lifecycles as l")
              .select("l.lifecycle_revision")
              .whereRef("l.request_id", "=", `${table}.request_id`)
              .where(
                "l.publication_kind",
                "=",
                table === "github_publication_requests" ? "shared" : "personal",
              )
              .$asScalar()
              .as("lifecycle_revision")
          : eb.val<string | null>(null).as("lifecycle_revision"),
      ),
    );
  }
  if (tableExists(db, "github_repository_publication_requests")) {
    receipts = receipts.unionAll(
      query
        .selectFrom("github_repository_publication_requests")
        .select([
          "session_key",
          "agent_id",
          "session_id",
          "pull_request_url",
          "branch",
          "title",
          "updated_at_ms",
          "request_id",
          "session_lifecycle_revision as lifecycle_revision",
        ])
        .where("status", "=", "published")
        .where("pull_request_url", "is not", null)
        .where("session_id", "in", sessionIds)
        .where((eb) =>
          input.ownerProfileId
            ? eb.or([
                eb("owner_profile_id", "is", null),
                eb("owner_profile_id", "=", input.ownerProfileId),
              ])
            : eb("owner_profile_id", "is", null),
        ),
    );
  }
  const selected = query
    .with("receipts", () => receipts)
    .selectFrom("receipts")
    .selectAll()
    .select((eb) => eb.fn<string>("lower", ["pull_request_url"]).as("canonical_url"))
    .where((eb) =>
      eb.or(
        input.sessions.map((session) =>
          eb.and([
            eb("session_key", "=", session.sessionKey),
            eb("agent_id", "=", session.agentId),
            eb("session_id", "=", session.sessionId),
            eb(
              "lifecycle_revision",
              session.lifecycleRevision === null ? "is" : "=",
              session.lifecycleRevision,
            ),
          ]),
        ),
      ),
    );
  // A URL is the publisher's canonical repository/number identity. Windowing bounds the
  // preview without truncating its count, even after repeated publications of the same PR.
  const ranked = query
    .with("selected", () => selected)
    .selectFrom("selected")
    .selectAll()
    .select((eb) =>
      eb.fn
        .agg<number>("row_number", [])
        .over((window) =>
          window
            .partitionBy("canonical_url")
            .orderBy("updated_at_ms", "desc")
            .orderBy("request_id", "desc"),
        )
        .as("rank"),
    );
  const rows = executeSqliteQuerySync(
    db,
    query
      .with("ranked", () => ranked)
      .selectFrom("ranked")
      .select(["session_key", "agent_id", "pull_request_url", "branch", "title"])
      .select((eb) => eb.fn.countAll<number>().over().as("total"))
      .select((eb) =>
        input.branchUrls?.length
          ? eb.fn
              .sum<number>(
                eb
                  .case()
                  .when(
                    eb.fn<string>("lower", ["pull_request_url"]),
                    "in",
                    input.branchUrls.map((url) => url.toLowerCase()),
                  )
                  .then(1)
                  .else(0)
                  .end(),
              )
              .over()
              .as("branch_matches")
          : eb.val(0).as("branch_matches"),
      )
      .where("rank", "=", 1)
      .orderBy("updated_at_ms", "desc")
      .orderBy("request_id", "desc")
      .limit(20),
  ).rows;
  return {
    receipts: rows,
    count: rows[0]?.total ?? 0,
    branchMatchCount: rows[0]?.branch_matches ?? 0,
  };
}
