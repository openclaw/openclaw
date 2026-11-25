import { captureGitHubPublicationChanges } from "../gateway/github-publication-events.js";
import { sqlPublicationAnchor } from "../infra/sql-connection.js";
import { deferSqliteWorkerCommitReceipt } from "../infra/sqlite-worker-operation-admission.js";
import { captureGitHubPublicationWorkerReceipt } from "./github-publication-receipts.js";
import type { PublicationMutationResult } from "./github-publication-worker.types.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";

export function captureGitHubPublicationMutation(
  database: OpenClawStateDatabase,
  write: () => PublicationMutationResult,
) {
  return captureGitHubPublicationWorkerReceipt(sqlPublicationAnchor(database.db), () => {
    const { value, changes } = captureGitHubPublicationChanges(write);
    return { ...value, changes };
  });
}

export function commitGitHubPublicationBookkeeping(
  database: OpenClawStateDatabase,
  operation: string,
  write: () => PublicationMutationResult,
) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      // Accepted bookkeeping can settle after caller revocation; it grants no GitHub action.
      const receipt = captureGitHubPublicationMutation(database, write);
      deferSqliteWorkerCommitReceipt(sqlPublicationAnchor(db), receipt);
    },
    { database },
    { operationLabel: `github-publication.${operation}` },
  );
}
