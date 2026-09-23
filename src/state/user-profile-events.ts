import type { DatabaseSync } from "node:sqlite";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import type { OpenClawStateDatabaseReadAdmission } from "./openclaw-state-db-async-lifecycle.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "./openclaw-state-db-cache.js";
import type { UserProfileMutationChanges } from "./user-profile-mutation.js";
import type { UserProfileEmailBinding } from "./user-profiles.types.js";

type EmailBindingChange = {
  db: DatabaseSync;
  email: string;
  binding: UserProfileEmailBinding | null;
};

export class UserProfileMutationUnsettledError extends Error {
  constructor(kind: "pending" | "uncertain") {
    super(
      kind === "pending"
        ? "Profile authority mutation has not settled"
        : "Profile authority mutation requires canonical recovery",
    );
    this.name = "UserProfileMutationUnsettledError";
  }
}

type ProfileAuthorityStore = {
  revision: object;
  identityRevision: object;
  profiles: Map<string, object>;
  profileIdentities: Map<string, object>;
  channelIdentities: Map<string, object>;
  pending: Map<string, Set<Promise<void>>>;
  uncertain: Set<string>;
};

// The native SDK module identity owns these publications across plugin callers.
const changes = {
  version: 0,
  aliasRevision: 0,
  bindingRevision: 0,
  bindingListeners: new Set<(change: EmailBindingChange) => void>(),
  listeners: new Set<() => void>(),
  authorityStores: new Map<string, ProfileAuthorityStore>(),
  authorityHandles: new WeakMap<DatabaseSync, ProfileAuthorityStore>(),
  authorityLifecycleRegistered: false,
};

function authorityStore(identity: DatabasePathIdentity): ProfileAuthorityStore {
  let store = changes.authorityStores.get(identity.key);
  if (!store) {
    store = {
      revision: {},
      identityRevision: {},
      profiles: new Map(),
      profileIdentities: new Map(),
      channelIdentities: new Map(),
      pending: new Map(),
      uncertain: new Set(),
    };
    changes.authorityStores.set(identity.key, store);
  }
  return store;
}

function observeAuthorityLifecycle(): void {
  if (changes.authorityLifecycleRegistered) {
    return;
  }
  changes.authorityLifecycleRegistered = true;
  registerOpenClawStateDatabaseLifecycleListener((event) => {
    if (event.kind === "opened") {
      changes.authorityHandles.set(event.database.db, authorityStore(event.identity));
    } else if (event.identity) {
      changes.authorityStores.delete(event.identity.key);
    }
  });
}

/** Authority revisions belong to the profile writer, independently of display notifications. */
export function publishUserProfileAuthorityChange(db: DatabaseSync, ...profileIds: string[]): void {
  observeAuthorityLifecycle();
  const store = changes.authorityHandles.get(db);
  if (!store || profileIds.length === 0) {
    return;
  }
  const commit = () => {
    store.revision = {};
    for (const profileId of profileIds) {
      store.profiles.set(profileId, {});
    }
  };
  if (!stageSqliteTransactionState(db, { stage: () => {}, rollback: () => {}, commit })) {
    commit();
  }
}

/** Only changed merge pointers invalidate account selection; roles and login grants do not. */
export function publishUserProfileIdentityChange(db: DatabaseSync, ...profileIds: string[]): void {
  observeAuthorityLifecycle();
  const store = changes.authorityHandles.get(db);
  if (!store || profileIds.length === 0) {
    return;
  }
  const commit = () => {
    store.identityRevision = {};
    for (const profileId of profileIds) {
      store.profileIdentities.set(profileId, {});
    }
  };
  if (!stageSqliteTransactionState(db, { stage: () => {}, rollback: () => {}, commit })) {
    commit();
  }
}

export function publishUserChannelIdentityAuthorityChange(db: DatabaseSync, subject: string): void {
  observeAuthorityLifecycle();
  const store = changes.authorityHandles.get(db);
  if (!store) {
    return;
  }
  const commit = () => {
    store.revision = {};
    store.channelIdentities.set(subject, {});
  };
  if (!stageSqliteTransactionState(db, { stage: () => {}, rollback: () => {}, commit })) {
    commit();
  }
}

const mutationKey = (kind: "profile" | "identity" | "channel", id: string) =>
  JSON.stringify([kind, id]);

/** Close affected preparation before granting COMMIT; settlement, not delivery, reopens it. */
export function fenceUserProfileMutationAuthority(
  admission: OpenClawStateDatabaseReadAdmission,
  changed: UserProfileMutationChanges,
): { settle: (known: boolean) => void } {
  observeAuthorityLifecycle();
  admission.assertCurrent();
  const store = authorityStore(admission.identity);
  const keys = [
    ...changed.profiles.map((id) => mutationKey("profile", id)),
    ...changed.identities.map((id) => mutationKey("identity", id)),
    ...changed.channels.map((id) => mutationKey("channel", id)),
  ];
  if (changed.profiles.length || changed.channels.length) {
    store.revision = {};
  }
  if (changed.identities.length) {
    store.identityRevision = {};
  }
  changed.profiles.forEach((id) => store.profiles.set(id, {}));
  changed.identities.forEach((id) => store.profileIdentities.set(id, {}));
  changed.channels.forEach((id) => store.channelIdentities.set(id, {}));
  const pending = createDeferredCore();
  for (const key of keys) {
    const entries = store.pending.get(key) ?? new Set<Promise<void>>();
    store.pending.set(key, entries);
    entries.add(pending.promise);
  }
  let settled = false;
  return {
    settle(known) {
      if (settled) {
        return;
      }
      settled = true;
      for (const key of keys) {
        if (!known) {
          store.uncertain.add(key);
        }
        const entries = store.pending.get(key);
        entries?.delete(pending.promise);
        if (entries?.size === 0) {
          store.pending.delete(key);
        }
      }
      pending.resolve();
    },
  };
}

/** A read is qualified once; retained assertions inspect only owner-held memory. */
export async function captureUserProfileAuthorityRead(
  admission: OpenClawStateDatabaseReadAdmission,
  subject?: string,
  dependency: "authority" | "identity" = "authority",
) {
  observeAuthorityLifecycle();
  const store = authorityStore(admission.identity);
  const subjectKey = subject === undefined ? undefined : mutationKey("channel", subject);
  const profileKind = dependency === "identity" ? "identity" : "profile";
  const pending: Promise<void>[] = [];
  for (const [key, entries] of store.pending) {
    if (key === subjectKey || key.startsWith(`["${profileKind}",`)) {
      for (const entry of entries) {
        pending.push(entry);
      }
    }
  }
  if (pending.length) {
    await Promise.all(pending);
  }
  admission.assertCurrent();
  const subjectIsSettled = () =>
    subjectKey === undefined ||
    (!store.uncertain.has(subjectKey) && !store.pending.get(subjectKey)?.size);
  if (!subjectIsSettled()) {
    throw new UserProfileMutationUnsettledError("pending");
  }
  const currentRevision = () =>
    dependency === "identity" ? store.identityRevision : store.revision;
  const profileRevisions = dependency === "identity" ? store.profileIdentities : store.profiles;
  const revision = currentRevision();
  return {
    /** Current-fact readers tolerate settled changes, but never borrow an unknown mutation. */
    assertSettled(this: void, profileIds: string | readonly string[]): void {
      admission.assertCurrent();
      if (changes.authorityStores.get(admission.identity.key) !== store) {
        throw new Error("Profile authority store changed");
      }
      for (const id of typeof profileIds === "string" ? [profileIds] : profileIds) {
        const key = mutationKey(profileKind, id);
        if (store.uncertain.has(key)) {
          throw new UserProfileMutationUnsettledError("uncertain");
        }
        if (store.pending.get(key)?.size) {
          throw new UserProfileMutationUnsettledError("pending");
        }
      }
      if (!subjectIsSettled()) {
        throw new UserProfileMutationUnsettledError("pending");
      }
    },
    bind(profileIds: string | readonly string[]): (() => boolean) | undefined {
      admission.assertCurrent();
      if (
        changes.authorityStores.get(admission.identity.key) !== store ||
        currentRevision() !== revision ||
        !subjectIsSettled()
      ) {
        return undefined;
      }
      const profiles = (typeof profileIds === "string" ? [profileIds] : profileIds).map((id) => ({
        id,
        key: mutationKey(profileKind, id),
        revision: profileRevisions.get(id),
      }));
      if (profiles.some(({ key }) => store.uncertain.has(key))) {
        throw new UserProfileMutationUnsettledError("uncertain");
      }
      if (profiles.some(({ key }) => store.pending.get(key)?.size)) {
        return undefined;
      }
      const identity = subject === undefined ? undefined : store.channelIdentities.get(subject);
      return () => {
        try {
          admission.assertCurrent();
          return (
            changes.authorityStores.get(admission.identity.key) === store &&
            profiles.every(
              (profile) =>
                profileRevisions.get(profile.id) === profile.revision &&
                !store.uncertain.has(profile.key) &&
                !store.pending.get(profile.key)?.size,
            ) &&
            (subject === undefined || store.channelIdentities.get(subject) === identity) &&
            subjectIsSettled()
          );
        } catch {
          return false;
        }
      };
    },
  };
}

export function onUserProfileEmailBindingChanged(
  listener: (change: EmailBindingChange) => void,
): () => void {
  return registerListener(changes.bindingListeners, listener);
}

/** Native writer facts become visible with the commit, before profile observers. */
export function stageUserProfileEmailBindingChange(
  db: DatabaseSync,
  email: string,
  binding: UserProfileEmailBinding | null,
): void {
  stageSqliteTransactionState(db, {
    stage: () => {},
    rollback: () => {},
    commit: () => {
      changes.bindingRevision += 1;
      for (const listener of changes.bindingListeners) {
        listener({ db, email, binding });
      }
    },
  });
}

export function readUserProfileEmailBindingRevision(): number {
  return changes.bindingRevision;
}

export function readUserProfileVersion(): number {
  return changes.version;
}

export function readUserProfileAliasRevision(): number {
  return changes.aliasRevision;
}

/** Publish only after a committed merge/unmerge; cosmetic profile updates preserve access. */
export function publishUserProfileAliasChange(): void {
  changes.aliasRevision += 1;
}

export function onUserProfilesChanged(listener: () => void): () => void {
  return registerListener(changes.listeners, listener);
}

/** No profile data crosses this notification; readers reapply their own visibility policy. */
export function emitUserProfilesChanged(): void {
  changes.version += 1;
  notifyListeners(changes.listeners, undefined);
  sessionChanges.emit({ all: true, scope: "profiles" });
}
