import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import type { OpenClawStateDatabaseReadAdmission } from "./openclaw-state-db-async-lifecycle.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  registerOpenClawStateDatabaseLifecycleListener,
  registerOpenClawStateDatabaseAsyncResource,
} from "./openclaw-state-db-cache.js";
import { readProfileAuthority, type ProfileAuthorityDescriptor } from "./user-profile-authority.js";
import type { UserProfileMutationChanges } from "./user-profile-mutation.js";
import type { UserProfileEmailBinding, UserProfilesDatabase } from "./user-profiles.types.js";

type EmailBindingChange = {
  db: EngineConnection;
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

type ProfileAuthorityCell = Int32Array<SharedArrayBuffer>;
type ProfileAuthorityKind =
  | "profiles"
  | "profileIdentities"
  | "modelAccountLinks"
  | "channelIdentities";
type ProfileAuthorityBinding = (() => boolean) & {
  readonly transferable: ProfileAuthorityDescriptor;
};
type ProfileAuthorityStore = {
  admission: OpenClawStateDatabaseReadAdmission;
  identityKey: string;
  lifetime: ProfileAuthorityDescriptor["lifetime"];
  generation: Int32Array<SharedArrayBuffer>;
  revision: number;
  identityRevision: number;
  profiles: Map<string, ProfileAuthorityCell>;
  profileIdentities: Map<string, ProfileAuthorityCell>;
  modelAccountLinks: Map<string, ProfileAuthorityCell>;
  channelIdentities: Map<string, ProfileAuthorityCell>;
  pending: Map<string, Set<Promise<void>>>;
};

// The native SDK module identity owns these publications across plugin callers.
const changes = {
  version: 0,
  aliasRevision: 0,
  bindingRevision: 0,
  bindingListeners: new Set<(change: EmailBindingChange) => void>(),
  listeners: new Set<() => void>(),
  authorityStores: new Map<string, ProfileAuthorityStore>(),
  authorityHandles: new WeakMap<EngineConnection, ProfileAuthorityStore>(),
  authorityLifecycleRegistered: false,
};

// Coordination survives first creation; authority still depends on the captured identity and lifetime.
function isAuthorityStoreCurrent(store: ProfileAuthorityStore): boolean {
  if (
    store.admission.identity.key !== store.identityKey ||
    Atomics.load(new BigInt64Array(store.lifetime.revision), 0) !== store.lifetime.epoch
  ) {
    Atomics.store(store.generation, 0, 0);
    return false;
  }
  return changes.authorityStores.get(store.admission.coordinationKey) === store;
}

function authorityStore(admission: OpenClawStateDatabaseReadAdmission): ProfileAuthorityStore {
  let store = changes.authorityStores.get(admission.coordinationKey);
  if (store && !isAuthorityStoreCurrent(store)) {
    store = undefined;
  }
  if (!store) {
    const lifetime = admission.captureIntegrity?.()?.lifetime;
    if (!lifetime) {
      throw new Error("Profile authority requires canonical admission lifetime");
    }
    const generation = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
    Atomics.store(generation, 0, 1);
    store = {
      admission,
      identityKey: admission.identity.key,
      lifetime: { revision: lifetime.revision, epoch: lifetime.epoch },
      generation,
      revision: 0,
      identityRevision: 0,
      profiles: new Map(),
      profileIdentities: new Map(),
      modelAccountLinks: new Map(),
      channelIdentities: new Map(),
      pending: new Map(),
    };
    changes.authorityStores.set(admission.coordinationKey, store);
  }
  return store;
}

function retireAuthorityStores(identityKey?: string): void {
  for (const [key, store] of changes.authorityStores) {
    if (!identityKey || store.admission.identity.key === identityKey) {
      // A late service registration keeps this retired buffer, never a replacement generation.
      Atomics.store(store.generation, 0, 0);
      changes.authorityStores.delete(key);
    }
  }
}

function observeAuthorityLifecycle(): void {
  if (changes.authorityLifecycleRegistered) {
    return;
  }
  changes.authorityLifecycleRegistered = true;
  registerOpenClawStateDatabaseAsyncResource({
    async close(identity) {
      retireAuthorityStores(identity?.key);
    },
  });
  registerOpenClawStateDatabaseLifecycleListener((event) => {
    if (event.kind === "opened") {
      changes.authorityHandles.set(
        event.database.db,
        authorityStore(captureOpenClawStateDatabaseReadAdmission(event.database.path)),
      );
    } else if (event.identity) {
      retireAuthorityStores(event.identity.key);
    }
  });
}

function authorityCell(store: ProfileAuthorityStore, kind: ProfileAuthorityKind, id: string) {
  let cell = store[kind].get(id);
  if (!cell) {
    cell = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
    store[kind].set(id, cell);
  }
  return cell;
}

function updateAuthorityStore(store: ProfileAuthorityStore, update: () => void): void {
  // Retire rather than reuse a revision observed by another thread.
  if (Atomics.load(store.generation, 1) >= 0x7fff_fffc) {
    Atomics.store(store.generation, 0, 0);
    return;
  }
  Atomics.add(store.generation, 1, 1);
  try {
    update();
  } finally {
    Atomics.add(store.generation, 1, 1);
  }
}

function advanceAuthorityCell(store: ProfileAuthorityStore, cell: ProfileAuthorityCell): void {
  if (Atomics.load(cell, 0) === 0x7fff_ffff) {
    Atomics.store(store.generation, 0, 0);
  } else {
    Atomics.add(cell, 0, 1);
  }
}

function authorityDescriptor(
  store: ProfileAuthorityStore,
  cells: readonly ProfileAuthorityCell[],
  bound = false,
): ProfileAuthorityDescriptor {
  return {
    generation: store.generation.buffer,
    lifetime: store.lifetime,
    entries: cells.map((cell) => ({
      state: cell.buffer,
      ...(bound ? { revision: Atomics.load(cell, 0) } : {}),
    })),
  };
}

function authorityBinding(
  admission: OpenClawStateDatabaseReadAdmission,
  store: ProfileAuthorityStore,
  descriptor: ProfileAuthorityDescriptor,
): ProfileAuthorityBinding {
  return Object.assign(
    () => {
      try {
        admission.assertCurrent();
        return isAuthorityStoreCurrent(store) && readProfileAuthority(descriptor) === "current";
      } catch {
        return false;
      }
    },
    { transferable: descriptor },
  );
}

/** Authority revisions belong to the profile writer, independently of display notifications. */
export function publishUserProfileAuthorityChange(
  db: EngineConnection,
  ...profileIds: string[]
): void {
  // Native and worker mutations retire recovery custody in their original transaction.
  const schema = profileIds.length ? getAdmittedSqliteSchemaFacts(db) : undefined;
  if (profileIds.length && !schema) {
    throw new Error("Profile authority mutation requires admitted schema facts");
  }
  if (schema && schema.userVersion >= 19 && schema.tables.has("user_profile_identities")) {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<UserProfilesDatabase>(db)
        .updateTable("user_profile_identities")
        .set({ authorization_id: null, authorization_basis_json: null })
        .where("profile_id", "in", profileIds),
    );
  }
  publishAuthorityStoreChange(db, "profiles", profileIds);
}

/** Only changed merge pointers invalidate account selection; roles and login grants do not. */
export function publishUserProfileIdentityChange(
  db: EngineConnection,
  ...profileIds: string[]
): void {
  publishAuthorityStoreChange(db, "profileIdentities", profileIds);
}

/** Default-link changes do not revoke explicit selections or saved session account pins. */
export function publishUserProfileModelAccountLinksChange(
  db: EngineConnection,
  ...profileIds: string[]
): void {
  publishAuthorityStoreChange(db, "modelAccountLinks", profileIds);
}

/** A retained catalog assertion consumes only the canonical writer’s committed facts. */
export function captureUserProfileModelAccountLinksAuthority(
  admission: OpenClawStateDatabaseReadAdmission,
  profileId: string,
): ProfileAuthorityBinding {
  observeAuthorityLifecycle();
  admission.assertCurrent();
  const store = authorityStore(admission);
  return authorityBinding(
    admission,
    store,
    authorityDescriptor(
      store,
      [
        authorityCell(store, "modelAccountLinks", profileId),
        authorityCell(store, "profileIdentities", profileId),
        // A merge may add default links without changing the target's identity.
        authorityCell(store, "profiles", profileId),
      ],
      true,
    ),
  );
}

const mutationKey = (kind: "profile" | "identity" | "channel" | "modelAccountLinks", id: string) =>
  JSON.stringify([kind, id]);

type AuthorityMutationEntry = { key: string; cell: ProfileAuthorityCell };

function fenceAuthorityEntries(
  store: ProfileAuthorityStore,
  entries: readonly AuthorityMutationEntry[],
  advance: boolean,
): { settle: (known: boolean) => void } {
  const pending = createDeferredCore();
  updateAuthorityStore(store, () => {
    for (const { key, cell } of entries) {
      if (advance) {
        advanceAuthorityCell(store, cell);
      }
      if (Atomics.load(cell, 1) !== 2) {
        Atomics.store(cell, 1, 1);
      }
      const mutations = store.pending.get(key) ?? new Set<Promise<void>>();
      store.pending.set(key, mutations);
      mutations.add(pending.promise);
    }
  });
  let settled = false;
  return {
    settle(known) {
      if (settled) {
        return;
      }
      settled = true;
      updateAuthorityStore(store, () => {
        for (const { key, cell } of entries) {
          const mutations = store.pending.get(key);
          mutations?.delete(pending.promise);
          if (mutations?.size === 0) {
            store.pending.delete(key);
          }
          if (!known) {
            Atomics.store(cell, 1, 2);
          } else if (Atomics.load(cell, 1) !== 2) {
            Atomics.store(cell, 1, mutations?.size ? 1 : 0);
          }
        }
      });
      pending.resolve();
    },
  };
}

/** Fence link readers until the original worker's native outcome is acknowledged. */
export function fenceUserProfileModelAccountLinks(
  admission: OpenClawStateDatabaseReadAdmission,
  profileId: string,
): { settle: (known: boolean) => void } {
  observeAuthorityLifecycle();
  admission.assertCurrent();
  const store = authorityStore(admission);
  const cell = authorityCell(store, "modelAccountLinks", profileId);
  const fence = fenceAuthorityEntries(
    store,
    [{ key: mutationKey("modelAccountLinks", profileId), cell }],
    true,
  );
  let settled = false;
  return {
    settle(known) {
      if (settled) {
        return;
      }
      settled = true;
      // Retire reads prepared while COMMIT or its acknowledgement was pending.
      updateAuthorityStore(store, () => advanceAuthorityCell(store, cell));
      fence.settle(known);
    },
  };
}

export function publishUserChannelIdentityAuthorityChange(
  db: EngineConnection,
  subject: string,
): void {
  publishAuthorityStoreChange(db, "channelIdentities", [subject]);
}

function publishAuthorityStoreChange(
  db: EngineConnection,
  kind: ProfileAuthorityKind,
  ids: string[],
): void {
  observeAuthorityLifecycle();
  const store = changes.authorityHandles.get(db);
  if (!store || ids.length === 0) {
    return;
  }
  const mutationKind = {
    profiles: "profile",
    profileIdentities: "identity",
    channelIdentities: "channel",
    modelAccountLinks: "modelAccountLinks",
  } as const;
  const entries = ids.map((id) => ({
    key: mutationKey(mutationKind[kind], id),
    cell: authorityCell(store, kind, id),
  }));
  let fence: ReturnType<typeof fenceAuthorityEntries> | undefined;
  const commit = () => {
    updateAuthorityStore(store, () => {
      if (kind === "profileIdentities") {
        store.identityRevision += 1;
      } else if (kind !== "modelAccountLinks") {
        store.revision += 1;
      }
      for (const { cell } of entries) {
        advanceAuthorityCell(store, cell);
      }
    });
    fence?.settle(true);
  };
  if (
    !stageSqliteTransactionState(db, {
      // Native callbacks keep their committed facts until the physical COMMIT attempt.
      prepareCommit: () => {
        fence ??= fenceAuthorityEntries(store, entries, false);
      },
      invalidate: () => fence?.settle(false),
      rollback: () => fence?.settle(true),
      commit,
    })
  ) {
    throw new Error("Profile authority publication requires a managed transaction");
  }
}

/** Close affected preparation before granting COMMIT; settlement, not delivery, reopens it. */
export function fenceUserProfileMutationAuthority(
  admission: OpenClawStateDatabaseReadAdmission,
  changed: UserProfileMutationChanges,
): { settle: (known: boolean) => void } {
  observeAuthorityLifecycle();
  admission.assertCurrent();
  const store = authorityStore(admission);
  const entries = [
    ...changed.profiles.map((id) => ({
      key: mutationKey("profile", id),
      cell: authorityCell(store, "profiles", id),
    })),
    ...changed.identities.map((id) => ({
      key: mutationKey("identity", id),
      cell: authorityCell(store, "profileIdentities", id),
    })),
    ...changed.channels.map((id) => ({
      key: mutationKey("channel", id),
      cell: authorityCell(store, "channelIdentities", id),
    })),
  ];
  if (changed.profiles.length || changed.channels.length) {
    store.revision += 1;
  }
  if (changed.identities.length) {
    store.identityRevision += 1;
  }
  return fenceAuthorityEntries(store, entries, true);
}

/** A read is qualified once; retained assertions inspect only owner-held memory. */
export async function captureUserProfileAuthorityRead(
  admission: OpenClawStateDatabaseReadAdmission,
  subject?: string,
  dependency: "authority" | "identity" = "authority",
) {
  observeAuthorityLifecycle();
  const store = authorityStore(admission);
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
  const subjectCell = (value: string | undefined) =>
    value === undefined ? [] : [authorityCell(store, "channelIdentities", value)];
  const subjectIsSettled = (value = subject) =>
    readProfileAuthority(authorityDescriptor(store, subjectCell(value))) === "current";
  if (!subjectIsSettled()) {
    throw new UserProfileMutationUnsettledError("pending");
  }
  const currentRevision = () =>
    dependency === "identity" ? store.identityRevision : store.revision;
  const profileRevisions = dependency === "identity" ? "profileIdentities" : "profiles";
  const profileCells = (profileIds: string | readonly string[]) =>
    (typeof profileIds === "string" ? [profileIds] : profileIds).map((id) =>
      authorityCell(store, profileRevisions, id),
    );
  const revision = currentRevision();
  return {
    transferSettled(
      profileIds: string | readonly string[],
      boundSubject = subject,
    ): ProfileAuthorityDescriptor {
      admission.assertCurrent();
      if (!isAuthorityStoreCurrent(store)) {
        throw new Error("Profile authority store changed");
      }
      return authorityDescriptor(store, [
        ...profileCells(profileIds),
        ...subjectCell(boundSubject),
      ]);
    },
    /** Current-fact readers tolerate settled changes, but never borrow an unknown mutation. */
    assertSettled(this: void, profileIds: string | readonly string[]): void {
      admission.assertCurrent();
      const status = readProfileAuthority(authorityDescriptor(store, profileCells(profileIds)));
      if (!isAuthorityStoreCurrent(store) || status === "revoked") {
        throw new Error("Profile authority store changed");
      }
      if (status !== "current") {
        throw new UserProfileMutationUnsettledError(status);
      }
      if (!subjectIsSettled()) {
        throw new UserProfileMutationUnsettledError("pending");
      }
    },
    bind(
      profileIds: string | readonly string[],
      boundSubject = subject,
    ): ProfileAuthorityBinding | undefined {
      admission.assertCurrent();
      if (
        !isAuthorityStoreCurrent(store) ||
        currentRevision() !== revision ||
        !subjectIsSettled()
      ) {
        return undefined;
      }
      const cells = profileCells(profileIds);
      const status = readProfileAuthority(authorityDescriptor(store, cells));
      if (status === "uncertain") {
        throw new UserProfileMutationUnsettledError("uncertain");
      }
      if (status !== "current" || !subjectIsSettled(boundSubject)) {
        return undefined;
      }
      return authorityBinding(
        admission,
        store,
        authorityDescriptor(store, [...cells, ...subjectCell(boundSubject)], true),
      );
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
  db: EngineConnection,
  email: string,
  binding: UserProfileEmailBinding | null,
): void {
  stageSqliteTransactionState(db, {
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
