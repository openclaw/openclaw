import type { DatabaseSync } from "node:sqlite";
import type { SessionMembershipFact } from "../config/sessions/session-membership-facts.types.js";
import type { SessionAcpMeta, SessionEntry } from "../config/sessions/types.js";
import {
  publishSqliteCommittedState,
  stageSqliteCommittedPublication,
  type SqliteCommittedPublication,
} from "../infra/sqlite-post-commit.js";
import { resolveGlobalSet, resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";

export type SessionRowFacts =
  | { kind: "unchanged" }
  | { kind: "replacement"; membership: SessionMembershipFact }
  | {
      kind: "acp";
      sessionId: string | undefined;
      lifecycleRevision: string | null;
      sessionStartedAt?: number;
      acp: SessionAcpMeta | null;
    }
  | {
      kind: "entry";
      previousSessionId: string | undefined;
      sessionId: string;
      category: string | null;
      clearMembers: boolean;
    }
  | { kind: "member"; sessionId: string; identityId: string; present: boolean }
  | {
      kind: "owner";
      sessionId: string;
      lifecycleRevision: string | null;
      owner: SessionEntry["owner"];
    }
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
      scope?: "automation" | "runtime" | "session-entry" | "acp" | "transcript";
      /** Category uncertainty cannot change identity or lineage; other storage outcomes can. */
      factsInvalidated?: true | "category";
      /** Omission is a metadata notification; storage owners publish their changed facts. */
      facts?: SessionRowFacts;
    }
  | {
      all: true;
      scope: string | { agentId?: string; storePath?: string; topology?: true };
      factsInvalidated?: true;
    };

/** Store discovery fences also apply to agent-scoped topology publications. */
export function isSessionStoreTopologyChange(change: SessionRowChange): boolean {
  return (
    "all" in change &&
    (change.scope === "stores" ||
      (typeof change.scope === "object" && change.scope.topology === true))
  );
}

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
const invalidationSources = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionRowInvalidationSources"),
  () => new WeakMap<object, object>(),
);

/** Failure invalidations retain physical provenance, but never their old postimages. */
export function sessionRowChangeSource(change: object): object {
  return invalidationSources.get(change) ?? change;
}

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
  /** Pending or indeterminate work fences facts without announcing a committed change. */
  invalidate(change: SessionRowChange): void {
    notifyListeners(factListeners, change);
    notifyListeners(projectionListeners, change);
  },
  /** SQLite observers run only after all committed owner state has settled. */
  emit(change: SessionRowChange, database?: DatabaseSync): void {
    sessionChanges.emitBatch([change], database);
  },
  emitBatch(
    changes: readonly SessionRowChange[],
    database?: DatabaseSync,
    beforePublicNotifications?: () => void,
  ): void {
    const install = (
      targets: Iterable<(change: SessionRowChange) => void>,
      batch: readonly SessionRowChange[],
    ) => {
      const failures: unknown[] = [];
      for (const change of batch) {
        notifyListeners(targets, change, (error) => failures.push(error));
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Session committed fact installation failed");
      }
    };
    const publishFacts = () => {
      install(factListeners, changes);
    };
    const prepareObservers = () => {
      install(projectionListeners, changes);
    };
    const publish = () => {
      try {
        beforePublicNotifications?.();
      } finally {
        for (const change of changes) {
          if ("sessionKey" in change) {
            const { facts: _facts, factsInvalidated: _invalidated, ...notification } = change;
            notifyListeners(listeners, notification);
          } else {
            const { factsInvalidated: _invalidated, ...notification } = change;
            notifyListeners(listeners, notification);
          }
        }
      }
    };
    const publication: SqliteCommittedPublication = {
      installFacts: publishFacts,
      installProjection: prepareObservers,
      invalidate() {
        const invalidations: SessionRowChange[] = changes.map((change) => {
          const invalidated: SessionRowChange =
            "sessionKey" in change
              ? { ...change, facts: undefined, factsInvalidated: true }
              : { ...change, factsInvalidated: true };
          invalidationSources.set(invalidated, sessionRowChangeSource(change));
          return invalidated;
        });
        // Notify both owners even if one cannot retire its failed installation.
        const failures: unknown[] = [];
        for (const targets of [factListeners, projectionListeners]) {
          try {
            install(targets, invalidations);
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "Session publication invalidation failed");
        }
      },
      notify: publish,
    };
    if (!database || !stageSqliteCommittedPublication(database, publication)) {
      publishSqliteCommittedState(publication);
    }
  },
};
