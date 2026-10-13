import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { inlineAuthProfileCredentialSchema } from "../agents/auth-profiles/credential-schema.js";
import { coercePersistedAuthProfileStore } from "../agents/auth-profiles/persisted-store.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import {
  hasSqlitePostCommitScope,
  stageSqliteTransactionState,
} from "../infra/sqlite-post-commit.js";
import {
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "../infra/sqlite-worker-operation-admission.js";
import { resolveGlobalMap, resolveGlobalSingleton } from "../shared/global-singleton.js";
import { findOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import { registerOpenClawAgentDatabaseReadCandidateResource } from "./openclaw-agent-db-resources.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "./openclaw-state-db-cache.js";
import { readTrackedStateDatabaseIdentity } from "./openclaw-state-db-handle.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { createStateDomainPublication } from "./state-domain-publication.js";
import { parseUserModelAuthProfileId } from "./user-model-account-id.js";
import { captureUserProfileAuthorityRead } from "./user-profile-events.js";

type CredentialFact = {
  id: string;
  credential: AuthProfileCredential;
  replacement: boolean;
};

export const personalCredentialPublication = createStateDomainPublication<CredentialFact>({
  domain: "personal-model-credentials",
  keyOf: (fact) => fact.id,
  isValue: (value): value is CredentialFact =>
    isRecord(value) &&
    typeof value.id === "string" &&
    parseUserModelAuthProfileId(value.id) !== undefined &&
    typeof value.replacement === "boolean" &&
    inlineAuthProfileCredentialSchema.safeParse(value.credential).success,
});

type CredentialCell = {
  credential?: AuthProfileCredential;
  identityCurrent: () => boolean;
  observed?: boolean;
};
type CredentialOwner = {
  cells: Map<string, CredentialCell>;
  pending: Set<string>;
  uncertain: boolean;
  sources?: Set<string>;
  canonicalPath?: string;
  dispose?: () => void;
};
const owners = resolveGlobalMap<string, CredentialOwner>(
  Symbol.for("openclaw.personalCredentialAuthority"),
  "close-and-restart",
);
function ownerFor(identity: string) {
  let owner = owners.get(identity);
  if (!owner) {
    owner = { cells: new Map(), pending: new Set(), uncertain: false };
    owners.set(identity, owner);
  }
  return owner;
}

personalCredentialPublication.subscribeFacts((change) => {
  const identity = change.kind === "committed" ? change.receipt.source.identity : change.identity;
  if (typeof identity !== "string") {
    return;
  }
  const owner = ownerFor(identity);
  if (change.kind === "pending") {
    owner.pending.add(change.operationId);
  } else if (change.kind === "settled") {
    owner.pending.delete(change.operationId);
  } else if (change.kind === "unknown") {
    owner.uncertain = true;
    owner.cells.clear();
  } else if (change.kind === "committed") {
    for (const [id, fact] of change.receipt.facts) {
      const cell = owner.cells.get(id);
      if (fact.kind !== "postimage") {
        owner.cells.delete(id);
      } else if (cell) {
        // Reconnect never revives a retained grant, even with identical token bytes.
        const next = fact.value.replacement ? { ...cell } : cell;
        next.credential = fact.value.credential;
        owner.cells.set(id, next);
      }
    }
  }
});
registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind !== "opened") {
    if (event.identity) {
      const rootKey = `${event.identity.key}:${event.identity.birthtime ?? ""}`;
      for (const identity of [
        event.identity.key,
        rootKey,
        ...(owners.get(rootKey)?.sources ?? []),
      ]) {
        owners.get(identity)?.dispose?.();
        owners.delete(identity);
      }
    } else {
      for (const owner of owners.values()) {
        owner.dispose?.();
      }
      owners.clear();
    }
  }
});

/** The existing identity owner fences merge, including every flattened source alias. */
export async function capturePersonalCredentialAuthority(
  context: OpenClawStateWorkerContext,
  profileId: string,
) {
  const locator = parseUserModelAuthProfileId(profileId);
  if (!locator) {
    throw new Error("Personal credential authority requires an exact account ID");
  }
  const identity = context.admission.identity.key;
  const owner = ownerFor(identity);
  const captured = await captureUserProfileAuthorityRead(context.admission, undefined, "identity");
  const identityCurrent = captured.bind(locator.ownerProfileId);
  if (!identityCurrent) {
    throw new Error("Personal model account ownership changed during preparation; retry");
  }
  let cell = owner.cells.get(profileId);
  if (!cell?.identityCurrent()) {
    cell = { identityCurrent };
    owner.cells.set(profileId, cell);
  }
  const retained = cell;
  const assertCurrent = () => {
    if (
      owners.get(identity) !== owner ||
      owner.cells.get(profileId) !== retained ||
      owner.pending.size ||
      owner.uncertain ||
      !retained.identityCurrent()
    ) {
      throw new Error(
        "Personal model account authority is unavailable; retry after owner recovery",
      );
    }
  };
  assertCurrent();
  return {
    observe(credential: AuthProfileCredential | undefined) {
      assertCurrent();
      // A committed postimage wins over a read dispatched before that mutation.
      retained.credential ??= credential && structuredClone(credential);
    },
    readCurrentCredential(this: void) {
      assertCurrent();
      return retained.credential && structuredClone(retained.credential);
    },
  };
}

/** Denial starts before dispatch and survives an unacknowledged native outcome. */
export function withPersonalCredentialPublication(
  createAdmission: SqliteWorkerAdmissionFactory,
  context: OpenClawStateWorkerContext,
): SqliteWorkerAdmissionFactory {
  return (operation) => {
    const retained = createAdmission(operation);
    const { admission } = retained;
    const publication = personalCredentialPublication.begin({
      identity: context.admission.identity.key,
      assertCurrent: context.assertPublicationCurrent ?? context.admission.assertCurrent,
    });
    observeSqliteWorkerCommittedFacts(admission, ({ facts }) => {
      publication.committed(isRecord(facts) ? facts.personalCredentials : undefined);
    });
    const finish = admission.finish.bind(admission);
    admission.finish = () => {
      try {
        finish();
      } finally {
        if (admission.settlement) {
          const confirmed = admission.settlement.kind === "completed";
          publication.finish(confirmed, confirmed && !admission.committed);
        }
      }
    };
    void operation.settled.then((outcome) => {
      const known = outcome.kind !== "unknown";
      publication.finish(known, known && !admission.committed);
    });
    return retained;
  };
}

/** Shared and agent rows use the physical identity already admitted by their database owner. */
const nativeAuthProfileCredentialPublication = createStateDomainPublication<unknown>({
  domain: "auth-profile-credentials",
  sourceIdentity(db) {
    const shared = readTrackedStateDatabaseIdentity(db);
    if (shared) {
      return `${shared.key}:${shared.birthtime ?? ""}`;
    }
    const agent = findOpenClawAgentDatabaseIdentity({ db });
    if (!agent || typeof agent.identity !== "string") {
      return Symbol("auth-profile-credentials");
    }
    const identity = `file:${agent.identity}:${agent.birthtime ?? ""}`;
    ownerFor(identity).canonicalPath = agent.canonicalPath;
    return identity;
  },
  keyOf: () => "store",
  // Restoration may write legacy or malformed payloads; the canonical parser owns their meaning.
  isValue: (_value): _value is unknown => true,
});
export const authProfileCredentialPublication = {
  ...nativeAuthProfileCredentialPublication,
  bound(receipt: Parameters<typeof nativeAuthProfileCredentialPublication.bound>[0]) {
    return {
      ...nativeAuthProfileCredentialPublication.bound(receipt),
      canonicalPath:
        typeof receipt.source.identity === "string"
          ? ownerFor(receipt.source.identity).canonicalPath
          : undefined,
    };
  },
  begin(owner: { identity: string | symbol; canonicalPath?: string; assertCurrent(): void }) {
    if (typeof owner.identity === "string" && owner.canonicalPath) {
      ownerFor(owner.identity).canonicalPath = owner.canonicalPath;
    }
    return nativeAuthProfileCredentialPublication.begin(owner);
  },
};
export type AuthProfileCredentialReceipts = Array<
  ReturnType<typeof authProfileCredentialPublication.bound>
>;
const authCapture = resolveGlobalSingleton(
  Symbol.for("openclaw.authProfileCredentialCapture"),
  () => new AsyncLocalStorage<AuthProfileCredentialReceipts>(),
);

authProfileCredentialPublication.subscribeFacts((change) => {
  const identity = change.kind === "committed" ? change.receipt.source.identity : change.identity;
  if (typeof identity !== "string") {
    return;
  }
  const owner = ownerFor(identity);
  if (change.kind === "committed" || change.kind === "unknown") {
    authCapture
      .getStore()
      ?.push(
        change.kind === "committed"
          ? authProfileCredentialPublication.bound(change.receipt)
          : { ...change, canonicalPath: owner.canonicalPath },
      );
  }
  const affected = [owner];
  // First credential creation must update grants captured while the local file was absent.
  const absentIdentity = `path:${owner.canonicalPath}:`;
  const absent = owner.canonicalPath && owners.get(absentIdentity);
  if (absent) {
    affected.push(absent);
    for (const root of owners.values()) {
      if (root.sources?.has(absentIdentity)) {
        root.sources.add(identity);
      }
    }
  }
  if (change.kind === "pending") {
    for (const target of affected) {
      target.pending.add(change.operationId);
    }
  } else if (change.kind === "settled") {
    for (const target of affected) {
      target.pending.delete(change.operationId);
    }
  } else if (change.kind === "unknown") {
    for (const target of affected) {
      target.uncertain = true;
    }
  } else if (change.kind === "committed") {
    const fact = change.receipt.facts.get("store");
    if (!fact || fact.kind === "unchanged") {
      return;
    }
    if (fact.kind === "unknown") {
      for (const target of affected) {
        target.uncertain = true;
      }
      return;
    }
    const profiles =
      fact.kind === "postimage" ? coercePersistedAuthProfileStore(fact.value)?.profiles : {};
    if (!profiles) {
      for (const target of affected) {
        target.uncertain = true;
      }
      return;
    }
    for (const target of affected) {
      for (const [id, cell] of target.cells) {
        cell.credential = profiles[id];
        cell.observed = true;
      }
    }
  }
});

/** Deny before the native effect; managed settlement installs all facts before releasing denial. */
export function withAuthProfileCredentialWrite<T>(
  db: DatabaseSync,
  payload: unknown,
  write: () => T,
): T {
  if (db.isTransaction && !hasSqlitePostCommitScope(db)) {
    throw new Error("Credential writes require their owning transaction publication scope");
  }
  const identity = authProfileCredentialPublication.receipt(db, new Map()).source.identity;
  const publication = authProfileCredentialPublication.begin({ identity, assertCurrent() {} });
  let failed = false;
  const managed = stageSqliteTransactionState(db, {
    stage() {},
    commit() {
      if (failed) {
        publication.finish(false);
      }
    },
    prepareObservers: () => publication.finish(true, true),
    invalidate: () => publication.finish(false),
    rollback: () => publication.finish(true, true),
  });
  try {
    const result = write();
    if (payload === undefined) {
      authProfileCredentialPublication.stageDeletions(db, ["store"]);
    } else {
      authProfileCredentialPublication.stagePostimages(db, [payload]);
    }
    if (!managed) {
      publication.finish(true, true);
    }
    return result;
  } catch (error) {
    // A caught native error may still leave an outer transaction able to commit.
    failed = true;
    if (!managed) {
      publication.finish(false);
    }
    throw error;
  }
}

export function captureAuthProfileCredentialAuthority(
  context: OpenClawStateWorkerContext,
  source: { identity: string; databasePath: string },
  profileId: string,
) {
  const rootIdentity = `${context.admission.identity.key}:${context.admission.identity.birthtime ?? ""}`;
  const root = ownerFor(rootIdentity);
  (root.sources ??= new Set()).add(source.identity);
  const owner = ownerFor(source.identity);
  if (source.identity !== rootIdentity && !owner.dispose) {
    owner.dispose = registerOpenClawAgentDatabaseReadCandidateResource({
      path: source.databasePath,
      revoke: () => {
        owner.uncertain = true;
      },
      close: async () => {
        owner.dispose?.();
        owners.delete(source.identity);
      },
    });
  }
  let cell = owner.cells.get(profileId);
  if (!cell) {
    cell = { identityCurrent: () => true };
    owner.cells.set(profileId, cell);
  }
  const retained = cell;
  const assertCurrent = () => {
    context.admission.assertCurrent();
    if (
      owners.get(rootIdentity) !== root ||
      owners.get(source.identity) !== owner ||
      root.pending.size ||
      root.uncertain ||
      owner.pending.size ||
      owner.uncertain
    ) {
      throw new Error(
        "Auth profile credential authority is unavailable; retry after owner recovery",
      );
    }
  };
  // Preparation may overlap publication; only the effect reader grants current authority.
  return {
    observe(credential: AuthProfileCredential | undefined) {
      if (!retained.observed) {
        retained.credential = credential && structuredClone(credential);
        retained.observed = true;
      }
    },
    readCurrentCredential(this: void) {
      assertCurrent();
      return retained.credential && structuredClone(retained.credential);
    },
  };
}

/** A catalog task can change any known source; one transport carries all committed postimages. */
export function beginAuthProfileCredentialBatch(context: OpenClawStateWorkerContext) {
  const identity = `${context.admission.identity.key}:${context.admission.identity.birthtime ?? ""}`;
  const root = ownerFor(identity);
  const publications = new Map(
    [...new Set([identity, ...(root.sources ?? [])])].map((source) => [
      source,
      authProfileCredentialPublication.begin({
        identity: source,
        assertCurrent: context.admission.assertCurrent,
      }),
    ]),
  );
  const changedSources = new Set<string>();
  const unsubscribe = authProfileCredentialPublication.subscribeFacts((change) => {
    if (change.kind !== "committed" && change.kind !== "unknown") {
      return;
    }
    const source = change.kind === "committed" ? change.receipt.source.identity : change.identity;
    if (typeof source === "string" && !publications.has(source)) {
      changedSources.add(source);
    }
  });
  return {
    committed(receipts: AuthProfileCredentialReceipts) {
      for (const receipt of receipts) {
        const source = "source" in receipt ? receipt.source.identity : receipt.identity;
        if (typeof source === "string") {
          if (receipt.canonicalPath) {
            ownerFor(source).canonicalPath = receipt.canonicalPath;
          }
          let publication = publications.get(source);
          if (!publication) {
            (root.sources ??= new Set()).add(source);
            publication = authProfileCredentialPublication.begin({
              identity: source,
              assertCurrent: context.admission.assertCurrent,
            });
            publications.set(source, publication);
          }
          // A newly created source can be changed locally before its catalog receipt arrives.
          // Registering above excludes this installation from the unknown-source observer.
          publication.committed(
            changedSources.has(source) ? { kind: "unknown", identity: source } : receipt,
          );
        }
      }
    },
    finish(known: boolean) {
      unsubscribe();
      for (const publication of publications.values()) {
        publication.finish(known, known);
      }
    },
  };
}

export async function captureAuthProfileCredentialCommits<T>(operation: () => Promise<T>) {
  const receipts: AuthProfileCredentialReceipts = [];
  const result = await authCapture.run(receipts, operation);
  return { result, receipts };
}
