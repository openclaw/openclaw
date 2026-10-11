import type { DatabaseSync } from "node:sqlite";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { resolveGlobalSet } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import type { UserGitHubConnectionCommit } from "./user-github-connections.types.js";

const retirementObservers = resolveGlobalSet<(profileIds: readonly string[]) => void>(
  Symbol.for("openclaw.userGitHubProfileRetirement"),
  "close-and-restart",
);

export function observeUserGitHubProfileRetirement(
  observer: (profileIds: readonly string[]) => void,
): () => void {
  return registerListener(retirementObservers, observer);
}

function publishUserGitHubProfileRetirement(ids: readonly string[]): void {
  if (ids.length > 0) {
    notifyListeners(retirementObservers, ids);
  }
}

export function publishUserGitHubConnectionCommit(receipt: UserGitHubConnectionCommit): void {
  publishUserGitHubProfileRetirement(receipt.retiredProfileIds);
}

export function stageUserGitHubConnectionCommit(
  db: DatabaseSync,
  receipt: UserGitHubConnectionCommit,
): void {
  if (!deferSqlitePostCommitPublication(db, () => publishUserGitHubConnectionCommit(receipt))) {
    throw new Error("Personal GitHub connection publication requires its write transaction");
  }
}
