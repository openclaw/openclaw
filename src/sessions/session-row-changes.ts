import type { DatabaseSync } from "node:sqlite";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  deferSqlitePostCommitPublication,
  stageSqliteTransactionState,
} from "../infra/sqlite-post-commit.js";
import { resolveGlobalSet } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";

export type SessionRowFacts =
  | { kind: "unchanged" }
  | {
      kind: "entry";
      previousSessionId: string | undefined;
      sessionId: string;
      lifecycleRevision?: string;
      category: string | null;
      clearMembers: boolean;
    }
  | { kind: "member"; sessionId: string; identityId: string; present: boolean }
  | {
      kind: "participants";
      /** Participant history belongs to the logical key, across transcript replacements. */
      projection?: Pick<SessionEntry, "participants" | "participantCount">;
    }
  | { kind: "category"; sessionId: string; category: string | null }
  | { kind: "removed" };

export type SessionRowChange =
  | {
      sessionKey: string;
      agentId?: string;
      storePath?: string;
      scope?: "automation" | "runtime" | "session-entry";
      /** An uncertain storage result requires worker reconciliation before facts are reused. */
      factsInvalidated?: true;
      /** Omission is a metadata notification; storage owners publish their changed facts. */
      facts?: SessionRowFacts;
    }
  | {
      all: true;
      scope: string | { agentId?: string; storePath?: string };
      factsInvalidated?: true;
    };

type SessionRowNotification =
  | Omit<Extract<SessionRowChange, { sessionKey: string }>, "facts" | "factsInvalidated">
  | Omit<Extract<SessionRowChange, { all: true }>, "factsInvalidated">;

const listeners = resolveGlobalSet<(change: SessionRowNotification) => void>(
  Symbol.for("openclaw.sessionRowChanges"),
  "close-and-restart",
);
const factListeners = resolveGlobalSet<(change: SessionRowChange) => void>(
  Symbol.for("openclaw.sessionRowFactChanges"),
  "close-and-restart",
);
const projectionListeners = resolveGlobalSet<(change: SessionRowChange) => void>(
  Symbol.for("openclaw.sessionRowProjectionChanges"),
  "close-and-restart",
);

export const sessionChanges = {
  subscribe(listener: (change: SessionRowNotification) => void): () => void {
    return registerListener(listeners, listener);
  },
  /** Install prepared facts only; live-row observers run after every commit callback. */
  subscribeFacts(listener: (change: SessionRowChange) => void): () => void {
    return registerListener(factListeners, listener);
  },
  /** Refresh resident rows after all committed facts, before public observers can broadcast. */
  subscribeProjection(listener: (change: SessionRowChange) => void): () => void {
    return registerListener(projectionListeners, listener);
  },
  /** SQLite observers run only after all committed owner state has settled. */
  emit(change: SessionRowChange, database?: DatabaseSync): void {
    sessionChanges.emitBatch([change], database);
  },
  emitBatch(changes: readonly SessionRowChange[], database?: DatabaseSync): void {
    const publishFacts = () => {
      for (const change of changes) {
        notifyListeners(factListeners, change);
      }
    };
    const prepareObservers = () => {
      for (const change of changes) {
        notifyListeners(projectionListeners, change);
      }
    };
    // Apply every committed delta before any row/lifecycle observer sees the transaction.
    // Savepoint rollback discards these staged callbacks with the ordinary publications.
    if (
      !database ||
      !stageSqliteTransactionState(database, {
        stage: () => {},
        rollback: () => {},
        commit: publishFacts,
        prepareObservers,
      })
    ) {
      publishFacts();
      prepareObservers();
    }
    const publish = () => {
      for (const change of changes) {
        if ("sessionKey" in change) {
          const { facts: _facts, factsInvalidated: _invalidated, ...notification } = change;
          notifyListeners(listeners, notification);
        } else {
          const { factsInvalidated: _invalidated, ...notification } = change;
          notifyListeners(listeners, notification);
        }
      }
    };
    if (!database || !deferSqlitePostCommitPublication(database, publish)) {
      publish();
    }
  },
};
