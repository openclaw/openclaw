import type { DatabaseSync } from "node:sqlite";
import {
  publishSqliteCommittedState,
  stageSqliteCommittedPublication,
} from "../infra/sqlite-post-commit.js";
import { normalizeDatabasePath } from "../infra/sqlite-worker-identity.js";
import { resolveGlobalSet } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import type { UserGitHubConnectionCommit } from "./user-github-connections.types.js";

type ConnectionPublication = UserGitHubConnectionCommit & { databasePath: string };
const authorityObservers = resolveGlobalSet<(publication: ConnectionPublication) => void>(
  Symbol.for("openclaw.userGitHubConnectionAuthority"),
  "close-and-restart",
);
const retirementObservers = resolveGlobalSet<(profileIds: readonly string[]) => void>(
  Symbol.for("openclaw.userGitHubProfileRetirement"),
  "close-and-restart",
);

export function observeUserGitHubConnectionAuthority(
  observer: (publication: ConnectionPublication) => void,
): () => void {
  return registerListener(authorityObservers, observer);
}

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

function committedPublication(databasePath: string, receipt: UserGitHubConnectionCommit) {
  const publication = { ...receipt, databasePath: normalizeDatabasePath(databasePath) };
  const revoke = () => notifyListeners(authorityObservers, publication);
  return {
    installFacts: revoke,
    invalidate: revoke,
    notify: () => publishUserGitHubProfileRetirement(receipt.retiredProfileIds),
  };
}

/** Install the whole nonsecret batch before public profile-retirement observers. */
export function publishUserGitHubConnectionCommit(
  databasePath: string,
  receipt: UserGitHubConnectionCommit,
): void {
  publishSqliteCommittedState(committedPublication(databasePath, receipt));
}

export function stageUserGitHubConnectionCommit(
  db: DatabaseSync,
  receipt: UserGitHubConnectionCommit,
): void {
  if (!stageSqliteCommittedPublication(db, committedPublication(db.location() ?? "", receipt))) {
    throw new Error("Personal GitHub connection publication requires its write transaction");
  }
}
