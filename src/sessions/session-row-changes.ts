import type { DatabaseSync } from "node:sqlite";
import type { SessionMembershipFact } from "../config/sessions/session-membership-facts.types.js";
import type { SessionAcpMeta, SessionEntry } from "../config/sessions/types.js";
import {
  hasSqlitePostCommitScope,
  publishSqliteCommittedState,
  stageSqliteCommittedPublication,
  stageSqliteTransactionState,
  type SqliteCommittedPublication,
} from "../infra/sqlite-post-commit.js";
import { resolveGlobalSet, resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";

export type SessionRowFacts =
  | { kind: "unchanged" }
  | { kind: "replacement"; membership: SessionMembershipFact; lifecycleChanged?: boolean }
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
      /** Exact peer-policy/lifecycle projection; absent publications require a fresh read. */
      communicationBinding?: string;
      lifecycleChanged?: boolean;
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

/** Display/runtime and auth refreshes do not replace committed storage facts. */
export function sessionChangeScopeAffectsStoredRows(change: SessionRowChange): boolean {
  if ("all" in change) {
    // Profiles still refresh authorization at its owner, independently of row freshness.
    return (
      typeof change.scope !== "string" ||
      ![
        "profiles",
        "catalog",
        "acp",
        "agent-runs",
        "subagent-runs",
        "worker-placements",
        "worker-environments",
        "config",
        "config-presentation",
        "config-profiles",
        "runtime",
        "automation",
      ].includes(change.scope)
    );
  }
  return change.scope !== "automation" && change.scope !== "runtime" && change.scope !== "acp";
}

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
const privateFacts = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionRowPrivateFacts"),
  () => new WeakMap<object, (() => void) | undefined>(),
);
const captures = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionRowChangeCaptures"),
  () => new WeakMap<DatabaseSync, Set<SessionRowChange[]>>(),
);

/** Worker receipts borrow the producer's transaction postimages, including savepoint rollback. */
export function captureSessionRowChanges<T>(
  database: DatabaseSync,
  run: (changes: readonly SessionRowChange[]) => T,
) {
  const changes: SessionRowChange[] = [];
  const active = captures.get(database) ?? new Set<SessionRowChange[]>();
  active.add(changes);
  captures.set(database, active);
  try {
    return { result: run(changes), changes };
  } finally {
    active.delete(changes);
    if (active.size === 0) {
      captures.delete(database);
    }
  }
}

/** Failure invalidations retain physical provenance, but never their old postimages. */
export function sessionRowChangeSource(change: object): object {
  return invalidationSources.get(change) ?? change;
}

export const sessionChanges = {
  /** Authority-only facts join commit installation without a duplicate presentation event. */
  markFactsOnly<T extends SessionRowChange>(change: T, install?: () => void): T {
    privateFacts.set(change, install);
    return change;
  },
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
    if (!privateFacts.has(change)) {
      notifyListeners(projectionListeners, change);
    }
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
    if (database && hasSqlitePostCommitScope(database)) {
      for (const captured of captures.get(database) ?? []) {
        const start = captured.length;
        if (
          !stageSqliteTransactionState(database, {
            stage: () => captured.push(...changes),
            commit() {},
            rollback: () => captured.splice(start),
          })
        ) {
          throw new Error("Session receipt capture requires a transaction publication owner");
        }
      }
    }
    const visible = changes.filter((change) => !privateFacts.has(change));
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
      for (const change of changes) {
        privateFacts.get(change)?.();
      }
      install(factListeners, changes);
    };
    const prepareObservers = () => {
      install(projectionListeners, visible);
    };
    const publish = () => {
      try {
        beforePublicNotifications?.();
      } finally {
        for (const change of visible) {
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
          if (privateFacts.has(change)) {
            privateFacts.set(invalidated, undefined);
          }
          return invalidated;
        });
        // Notify both owners even if one cannot retire its failed installation.
        const failures: unknown[] = [];
        for (const [targets, batch] of [
          [factListeners, invalidations],
          [projectionListeners, invalidations.filter((change) => !privateFacts.has(change))],
        ] as const) {
          try {
            install(targets, batch);
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
