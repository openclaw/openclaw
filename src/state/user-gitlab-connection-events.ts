import type { EngineConnection } from "../infra/sql-connection.js";
import {
  publishSqliteCommittedState,
  stageSqliteCommittedPublication,
} from "../infra/sqlite-post-commit.js";
import { normalizeDatabasePath } from "../infra/sqlite-worker-identity.js";
import { resolveGlobalSet } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import { readTrackedStateDatabaseIdentity } from "./openclaw-state-db-handle.js";
import type { UserGitLabConnectionCommit } from "./user-gitlab-connections.types.js";

type Change = { databasePath: string; changed: UserGitLabConnectionCommit["changed"] };
const observers = resolveGlobalSet<(change: Change) => void>(
  Symbol.for("openclaw.userGitLabConnectionAuthority"),
  "close-and-restart",
);

export function observeUserGitLabConnectionAuthority(
  listener: (change: Change) => void,
): () => void {
  return registerListener(observers, listener);
}
export function invalidateUserGitLabConnectionAuthority(
  databasePath: string,
  changed: Change["changed"],
): void {
  notifyListeners(observers, { databasePath: normalizeDatabasePath(databasePath), changed });
}
function publication(databasePath: string, receipt: UserGitLabConnectionCommit) {
  const change: Change = {
    databasePath: normalizeDatabasePath(databasePath),
    changed: receipt.changed,
  };
  const revoke = () => notifyListeners(observers, change);
  return { installFacts: revoke, invalidate: revoke, notify: () => {} };
}
export function publishUserGitLabConnectionCommit(
  databasePath: string,
  receipt: UserGitLabConnectionCommit,
): void {
  publishSqliteCommittedState(publication(databasePath, receipt));
}
export function stageUserGitLabConnectionCommit(
  db: EngineConnection,
  receipt: UserGitLabConnectionCommit,
): void {
  if (
    !stageSqliteCommittedPublication(
      db,
      publication(readTrackedStateDatabaseIdentity(db)?.canonicalPath ?? "", receipt),
    )
  ) {
    throw new Error("Personal GitLab connection publication requires its write transaction");
  }
}
