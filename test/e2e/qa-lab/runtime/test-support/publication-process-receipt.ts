import { withSqliteReadOnlyInspection } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../../../../src/infra/kysely-sync.js";
import type { DB } from "../../../../../src/state/openclaw-state-db.generated.js";
import { resolveOpenClawStateSqlitePath } from "../../../../../src/state/openclaw-state-db.paths.js";

/** Inspect only the runtime-produced durable row; never seed a receipt or its digest. */
export function publicationProcessReceipt(env: NodeJS.ProcessEnv, requestId: string) {
  return withSqliteReadOnlyInspection(resolveOpenClawStateSqlitePath(env), (database) =>
    executeSqliteQueryTakeFirstSync(
      database,
      getNodeSqliteKysely<DB>(database)
        .selectFrom("github_repository_publication_requests")
        .select([
          "request_id",
          "request_digest",
          "checkpoint_ref",
          "checkpoint_digest",
          "source_head_commit",
          "source_index_tree",
          "workspace_tree",
          "status",
          "requester_authority_json",
          "head_commit",
          "branch",
          "error_code",
        ])
        .where("request_id", "=", requestId),
    ),
  );
}
