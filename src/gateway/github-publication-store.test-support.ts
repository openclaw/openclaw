import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { insertRepositoryGitHubPublicationInDatabase } from "./github-repository-publication-store.js";

/** Seed historical receipts without running requester admission, OAuth or external effects. */
export function insertRepositoryPublicationFixture(
  row: RepositoryGitHubPublicationRow,
  assertCurrent: () => void,
) {
  return runOpenClawStateWriteTransaction(({ db }) => {
    assertCurrent();
    const stored = insertRepositoryGitHubPublicationInDatabase(db, row);
    assertCurrent();
    return stored;
  });
}
