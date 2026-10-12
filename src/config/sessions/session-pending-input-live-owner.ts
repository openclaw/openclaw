import {
  SessionMutationAuthorizationChangedError,
  SessionSharingProfileFactsChangedError,
} from "../../gateway/session-mutation-authorization-error.js";
import {
  isSameOpenClawAgentDatabasePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import {
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import {
  withCurrentPendingInputAuthority,
  type SessionPendingInputAuthority,
  type SessionPendingInputAuthorityFacts,
} from "./session-pending-input-authority.js";

type LiveInputIdentity<Owner> = {
  promotedOwner?: Owner;
  workerDatabasePath: string;
  sessionId: string;
  sessionKey: string;
  transcriptInputId: string;
  idempotencyKey: string;
};

type LiveInputAuthority<Owner> = {
  authority?: SessionPendingInputAuthority;
  sources?: readonly Owner[];
  assertCurrent: () => void;
};

export function assertLiveSessionPendingInputLifetimeCurrent<
  Owner extends LiveInputAuthority<Owner>,
>(owner: Owner, assertActive: (owner: Owner) => void): void {
  if (owner.sources) {
    for (const source of owner.sources) {
      assertLiveSessionPendingInputLifetimeCurrent(source, assertActive);
    }
    return;
  }
  assertActive(owner);
  (owner.authority?.assertLifetimeCurrent ?? owner.assertCurrent)();
}

/** Sync commits and worker receipts publish the same host-owned promotion fact. */
export function publishConsumedSessionPendingInputSources<
  Owner extends {
    inputId: string;
    consumed?: true;
    promotedOwner?: Owner;
    sources?: readonly Owner[];
  },
>(
  owner: Owner | undefined,
  sources: readonly Owner[],
  consumedInputIds?: ReadonlySet<string>,
): void {
  for (const source of sources) {
    if (consumedInputIds && !consumedInputIds.has(source.inputId)) {
      continue;
    }
    source.consumed = true;
    if (owner?.sources) {
      source.promotedOwner = owner;
    }
  }
}

/** A promoted input can outlive its pending row while another turn still owns it. */
function collectForeignLiveSessionPendingInputEntries<
  Owner extends LiveInputIdentity<Owner>,
>(params: {
  scope: ResolvedTranscriptScope;
  liveOwners: Iterable<Owner>;
  currentOwner: Owner | undefined;
  assertCurrent: (owner: Owner) => void;
}): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  const checked = new Set<Owner>();
  const databasePath = resolveOpenClawAgentSqlitePath(toDatabaseOptions(params.scope));
  for (const source of params.liveOwners) {
    const owner = source.promotedOwner ?? source;
    if (
      checked.has(owner) ||
      owner === (params.currentOwner?.promotedOwner ?? params.currentOwner) ||
      (owner.workerDatabasePath !== databasePath &&
        !isSameOpenClawAgentDatabasePath(owner.workerDatabasePath, databasePath)) ||
      owner.sessionId !== params.scope.sessionId ||
      owner.sessionKey !== params.scope.sessionKey
    ) {
      continue;
    }
    checked.add(owner);
    try {
      params.assertCurrent(owner);
      entries.set(owner.transcriptInputId, owner.idempotencyKey);
    } catch {
      // Finished, cancelled, or superseded turns no longer protect an orphan.
    }
  }
  return entries;
}

/** All candidates consume one fresh session snapshot; a denied owner cannot block its siblings. */
export async function prepareForeignLiveSessionPendingInputEntries<
  Owner extends LiveInputIdentity<Owner> & LiveInputAuthority<Owner>,
>(params: {
  scope: ResolvedTranscriptScope;
  liveOwners: () => Iterable<Owner>;
  currentOwner: Owner | undefined;
  assertLifetimeCurrent: (owner: Owner) => void;
  assertCurrent: (
    owner: Owner,
    facts?: SessionPendingInputAuthorityFacts,
    assertSourceCurrent?: () => void,
  ) => void;
  signal?: AbortSignal;
}): Promise<ReadonlyMap<string, string>> {
  const authorities = (owner: Owner) =>
    (owner.sources ?? [owner]).flatMap((source) => (source.authority ? [source.authority] : []));
  const select = () => {
    const selected = new Set<Owner>();
    collectForeignLiveSessionPendingInputEntries({
      ...params,
      liveOwners: params.liveOwners(),
      // Selection is provisional; retained admission guards need fresh worker facts.
      assertCurrent: (owner) => {
        selected.add(owner);
      },
    });
    return selected;
  };
  // Only ended custody or an authorization denial releases protection. Worker failures and
  // exhausted profile refreshes are inconclusive and must stop reconciliation instead.
  const isEndedCustody = (owner: Owner, error: unknown) => {
    params.signal?.throwIfAborted();
    try {
      params.assertLifetimeCurrent(owner);
    } catch {
      return true;
    }
    return (
      error instanceof SessionMutationAuthorizationChangedError &&
      !(error instanceof SessionSharingProfileFactsChangedError)
    );
  };
  const releaseEndedCustody = (owner: Owner, error: unknown) => {
    if (!isEndedCustody(owner, error)) {
      throw error;
    }
  };
  const refreshed = new Set<Owner>();
  for (;;) {
    params.signal?.throwIfAborted();
    const selected = select();
    const prepared = new Set<Owner>();
    for (const owner of selected) {
      try {
        await withCurrentPendingInputAuthority(
          authorities(owner),
          () => {
            params.signal?.throwIfAborted();
            params.assertLifetimeCurrent(owner);
          },
          () => params.assertLifetimeCurrent(owner),
        );
        prepared.add(owner);
      } catch (error) {
        releaseEndedCustody(owner, error);
      }
    }
    let failure: { error: unknown } | undefined;
    const consume = (
      facts?: SessionPendingInputAuthorityFacts,
      assertSourceCurrent?: () => void,
    ) => {
      params.signal?.throwIfAborted();
      const current = select();
      // An await may register, finish, or promote input. Prepare the new exact owners first.
      if (current.size !== selected.size || [...current].some((owner) => !selected.has(owner))) {
        return undefined;
      }
      let refresh = false;
      const entries = collectForeignLiveSessionPendingInputEntries({
        ...params,
        liveOwners: params.liveOwners(),
        assertCurrent: (owner) => {
          if (!prepared.has(owner)) {
            throw new Error("Foreign input authority preparation failed");
          }
          try {
            params.assertCurrent(owner, facts, assertSourceCurrent);
          } catch (error) {
            if (isEndedCustody(owner, error)) {
              throw error;
            }
            // A prepared profile can change while another owner reads. Refresh once;
            // the next preparation distinguishes renewed authority from revocation.
            if (!refreshed.has(owner)) {
              refreshed.add(owner);
              refresh = true;
            } else {
              // Repeatedly stale facts cannot establish that accepted custody ended.
              failure = { error };
            }
            throw error;
          }
        },
      });
      if (failure) {
        throw failure.error;
      }
      return refresh ? undefined : entries;
    };
    let changed = false;
    for (const owner of prepared) {
      const authority = authorities(owner)[0];
      if (!authority) {
        continue;
      }
      try {
        const entries = await authority.withCurrent(consume);
        params.signal?.throwIfAborted();
        if (entries) {
          return entries;
        }
        changed = true;
        break;
      } catch (error) {
        params.signal?.throwIfAborted();
        if (failure) {
          throw failure.error;
        }
        releaseEndedCustody(owner, error);
        prepared.delete(owner);
      }
    }
    if (!changed) {
      const entries = consume();
      if (entries) {
        return entries;
      }
    }
  }
}
