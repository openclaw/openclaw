import type { DatabaseSync } from "node:sqlite";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { resolveGlobalSet } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";

export type SessionRowChange =
  | { sessionKey: string; agentId?: string; storePath?: string }
  | { all: true; scope: string | { agentId?: string; storePath?: string } };

const listeners = resolveGlobalSet<(change: SessionRowChange) => void>(
  Symbol.for("openclaw.sessionRowChanges"),
  "close-and-restart",
);

export const sessionChanges = {
  subscribe(listener: (change: SessionRowChange) => void): () => void {
    return registerListener(listeners, listener);
  },
  /** SQLite observers run only after all committed owner state has settled. */
  emit(change: SessionRowChange, database?: DatabaseSync): void {
    const publish = () => notifyListeners(listeners, change);
    if (!database || !deferSqlitePostCommitPublication(database, publish)) {
      publish();
    }
  },
};
