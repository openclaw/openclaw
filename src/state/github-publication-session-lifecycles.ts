import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { GitHubPublicationSessionLifecycle } from "./github-publication-read.types.js";
import {
  encodeGitHubPublicationRequester,
  type GitHubPublicationRequesterSnapshot,
} from "./github-publication-requester.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import { ensureGitHubPublicationSessionLifecycleSchema } from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";

const table = "github_publication_session_lifecycles";
type PublicationIdentity = { publicationKind: "shared" | "personal"; requestId: string };
const query = (db: DatabaseSync) => getNodeSqliteKysely<Pick<DB, typeof table>>(db);

/** The receipt and its captured generation commit together; replay never rebinds it. */
export function insertGitHubPublicationSessionLifecycle(
  db: DatabaseSync,
  input: PublicationIdentity & {
    lifecycleRevision: string | null;
    requester?: GitHubPublicationRequesterSnapshot;
  },
): void {
  ensureGitHubPublicationSessionLifecycleSchema(db);
  executeSqliteQuerySync(
    db,
    query(db)
      .insertInto(table)
      .values({
        publication_kind: input.publicationKind,
        request_id: input.requestId,
        lifecycle_revision: input.lifecycleRevision,
        requester_authority_json: input.requester
          ? encodeGitHubPublicationRequester(input.requester)
          : null,
      }),
  );
}

/** A missing binding is unproven; a retained NULL records an originally absent revision. */
export function readGitHubPublicationSessionLifecycle(
  input: PublicationIdentity,
  db: DatabaseSync = openOpenClawStateDatabase().db,
): GitHubPublicationSessionLifecycle | undefined {
  return tableExists(db, table)
    ? executeSqliteQueryTakeFirstSync(
        db,
        query(db)
          .selectFrom(table)
          .select(["lifecycle_revision", "requester_authority_json"])
          .where("publication_kind", "=", input.publicationKind)
          .where("request_id", "=", input.requestId),
      )
    : undefined;
}

export async function readGitHubPublicationSessionLifecycleInWorker(input: PublicationIdentity) {
  const { publicationKind, requestId } = input;
  const result = await executeExistingOpenClawStateRead(
    {},
    { type: "githubPublication.lifecycle", publicationKind, requestId },
    { current: true },
  );
  if (!result?.ok || result.type !== "githubPublication.lifecycle") {
    throw new Error("GitHub publication requester metadata is unavailable.");
  }
  return result.lifecycle;
}
