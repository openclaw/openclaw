import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { ok, type Result } from "@openclaw/normalization-core/result";
import {
  deferSqlitePostCommitPublication,
  stageSqliteTransactionState,
} from "../infra/sqlite-post-commit.js";
import {
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import {
  registerOpenClawStateDatabaseLifecycleListener,
  requireOpenClawStateDatabaseIdentity,
} from "./openclaw-state-db-cache.js";
import {
  executeExistingOpenClawStateRead,
  withExistingOpenClawStateDatabaseReadOnly,
} from "./openclaw-state-db-readonly.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import {
  captureUserProfileAuthorityRead,
  emitUserProfilesChanged,
  onUserProfileEmailBindingChanged,
  readUserProfileEmailBindingRevision,
  readUserProfileVersion,
} from "./user-profile-events.js";
import {
  profileCatalogPath,
  projectHasMultipleSessionSharingIdentities,
  selectHasMultipleSessionSharingIdentities,
  selectUserProfileIdentityInDatabase,
  selectUserProfileDisplaysInDatabase,
  selectUserProfileReferenceInDatabase,
} from "./user-profile-identity.read.js";
import type { UserProfileEmailBindingChange } from "./user-profile-mutation.js";
import {
  applyUserProfileEmailBinding,
  bindPreparedUserProfileIdentity,
  projectUserProfileDisplay,
  projectCatalogUserProfileIdentity,
  matchUserProfileReference,
  resolveCatalogProfile,
  selectResolvedUserProfile,
  userProfileDisplaySelection,
  selectProfileDisplayEntries,
  userProfilesDb,
} from "./user-profiles-internal.js";
import { UserProfileNotFoundError } from "./user-profiles-schema.js";
import type {
  PreparedUserProfileIdentity,
  ProfileDisplayRow,
  UserProfileEmailBinding,
  UserProfileEmailBindingIndex,
} from "./user-profiles.types.js";

export { projectUserProfileDisplay } from "./user-profiles-internal.js";
export { readCurrentUserProfileAliases } from "./user-profile-identity.read.js";

export const hasMultipleSessionSharingIdentities = (options: OpenClawStateDatabaseOptions = {}) =>
  readProfileCatalog(
    options,
    projectHasMultipleSessionSharingIdentities,
    selectHasMultipleSessionSharingIdentities,
  ) ?? false;

/** Exact durable identity facts; never use display-reference prefix matching for authority. */
export function readUserProfileIdentity(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  return readProfileCatalog(
    options,
    (resident) => projectCatalogUserProfileIdentity(resident, profileId),
    (db) => selectUserProfileIdentityInDatabase(db, profileId),
  );
}

/** Existing one-hop aliases are identity facts; this read never creates profile storage. */
export function readUserProfileAliases(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): ReadonlySet<string> {
  return new Set([profileId, ...(readUserProfileIdentity(profileId, options)?.aliases ?? [])]);
}

/** Gateway readers already retain this catalog with their session projection. */
export function readResidentUserProfileId(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): string | undefined {
  const catalog = profileCatalogs.get(profileCatalogPath(options));
  if (!catalog?.valid) {
    throw new Error("User profile catalog is not ready");
  }
  return resolveCatalogProfile(catalog.rows, profileId)?.id;
}

/** Committed canonical row identity is the revision of catalog-derived avatar facts. */
export function readResidentUserProfileRevision(profileId: string, pathname: string) {
  const catalog = profileCatalogs.get(pathname);
  return catalog?.valid ? resolveCatalogProfile(catalog.rows, profileId) : undefined;
}
type ProfileCatalog = {
  rows: Map<string, ProfileDisplayRow>;
  identity: DatabasePathIdentity;
  valid: boolean;
  leases: Set<symbol>;
  asyncOnly?: boolean;
};
const profileCatalogs = new Map<string, ProfileCatalog>();
type ProfileMutationPublication = {
  identity: DatabasePathIdentity;
  before: Map<string, ProfileDisplayRow | undefined>;
  emailBindings: Map<string, UserProfileEmailBinding | null>;
  supersededBindings: Set<string>;
  witnesses: Map<
    Map<string, ProfileDisplayRow>,
    {
      rows: Map<string, ProfileDisplayRow | undefined>;
      late: boolean;
      bindings?: {
        index: UserProfileEmailBindingIndex;
        values: Map<string, UserProfileEmailBinding | undefined>;
        late: boolean;
      };
    }
  >;
  catalogs: Map<ProfileCatalog, symbol>;
};
const profileMutationPublications = new Set<ProfileMutationPublication>();
let stopCatalogEvents: (() => void) | undefined;
let stopBindingEvents: (() => void) | undefined;
let profileCatalogHandles = new WeakMap<DatabaseSync, Map<string, ProfileDisplayRow>>();
const profileBindings = new WeakMap<Map<string, ProfileDisplayRow>, UserProfileEmailBindingIndex>();

function supersedeBindingPublications(
  identity: DatabasePathIdentity,
  email: string,
  current?: ProfileMutationPublication,
): void {
  if (current && !profileMutationPublications.has(current)) {
    return;
  }
  for (const publication of profileMutationPublications) {
    // Native commits supersede every waiter; worker receipts supersede only earlier admissions.
    if (publication === current) {
      break;
    }
    if (publication.identity.key === identity.key && publication.emailBindings.has(email)) {
      publication.supersededBindings.add(email);
    }
  }
}

function applyCatalogEmailBinding(
  rows: Map<string, ProfileDisplayRow>,
  email: string,
  binding: UserProfileEmailBinding | null,
): void {
  const bindings = profileBindings.get(rows);
  if (!bindings) {
    return;
  }
  const previous = applyUserProfileEmailBinding(bindings, email, binding);
  for (const id of new Set([previous, binding?.profileId])) {
    const row = id && rows.get(id);
    if (row) {
      rows.set(row.id, { ...row });
    }
  }
}

function observeEmailBindings(): void {
  stopBindingEvents ??= onUserProfileEmailBindingChanged(({ db, email, binding }) => {
    supersedeBindingPublications(requireOpenClawStateDatabaseIdentity({ db }), email);
    const rows = profileCatalogHandles.get(db);
    if (rows) {
      applyCatalogEmailBinding(rows, email, binding);
    }
  });
}

function readProfileCatalog<T>(
  options: OpenClawStateDatabaseOptions,
  resident: (rows: Map<string, ProfileDisplayRow>) => T,
  stored: (db: DatabaseSync) => T,
): T | undefined {
  const catalog = profileCatalogs.get(profileCatalogPath(options));
  return catalog
    ? resident(catalog.rows)
    : withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) => (tableExists(db, "user_profiles") ? stored(db) : undefined),
        options,
      );
}

function loadProfileCatalog(
  catalog: ProfileCatalog,
  db: DatabaseSync,
  identity: DatabasePathIdentity,
) {
  if (!catalog.valid || catalog.identity.key !== identity.key) {
    const shared = [...profileCatalogs.values()].find(
      (candidate) => candidate.valid && candidate.identity.key === identity.key,
    );
    catalog.rows =
      shared?.rows ??
      new Map(tableExists(db, "user_profiles") ? selectProfileDisplayEntries(db) : []);
    Object.assign(catalog, { identity, valid: true });
    for (const publication of profileMutationPublications) {
      retainProfileMutationPublicationCatalog(publication, catalog, true);
    }
    return true;
  }
  return false;
}

function retainProfileMutationPublicationCatalog(
  publication: ProfileMutationPublication,
  catalog: ProfileCatalog,
  late: boolean,
) {
  if (!catalog.valid || catalog.identity.key !== publication.identity.key) {
    return;
  }
  if (!publication.catalogs.has(catalog)) {
    const lease = Symbol("pending profile mutation publication");
    publication.catalogs.set(catalog, lease);
    catalog.leases.add(lease);
  }
  let witness = publication.witnesses.get(catalog.rows);
  if (!witness) {
    witness = {
      rows: new Map([...publication.before.keys()].map((id) => [id, catalog.rows.get(id)])),
      late,
    };
    publication.witnesses.set(catalog.rows, witness);
  }
  const bindings = profileBindings.get(catalog.rows);
  if (bindings && !witness.bindings) {
    witness.bindings = {
      index: bindings,
      values: new Map(
        [...publication.emailBindings.keys()].map((email) => [email, bindings.byEmail.get(email)]),
      ),
      late,
    };
  }
}

function releaseProfileCatalog(catalog: ProfileCatalog, lease: symbol) {
  if (catalog.leases.delete(lease) && catalog.leases.size === 0) {
    for (const [pathname, current] of profileCatalogs) {
      if (current === catalog) {
        profileCatalogs.delete(pathname);
      }
    }
  }
  stopUnusedProfileCatalogObservers();
}

function stopUnusedProfileCatalogObservers(): void {
  if (profileCatalogs.size === 0 && profileMutationPublications.size === 0) {
    stopCatalogEvents?.();
    stopCatalogEvents = undefined;
    stopBindingEvents?.();
    stopBindingEvents = undefined;
    profileCatalogHandles = new WeakMap();
  }
}

/** Capture under the worker's write transaction; native commits replace these row objects. */
export function retainUserProfileMutationPublication(
  identity: DatabasePathIdentity,
  before: Array<[string, ProfileDisplayRow | undefined]>,
  emailBindings: readonly UserProfileEmailBindingChange[] = [],
) {
  observeEmailBindings();
  const publication: ProfileMutationPublication = {
    identity,
    before: new Map(before),
    emailBindings: new Map(emailBindings.map((change) => [change.email, change.before])),
    supersededBindings: new Set(),
    witnesses: new Map(),
    catalogs: new Map(),
  };
  profileMutationPublications.add(publication);
  for (const catalog of profileCatalogs.values()) {
    retainProfileMutationPublicationCatalog(publication, catalog, false);
  }
  const publish = (
    after: Map<string, ProfileDisplayRow | undefined>,
    committed: boolean,
    bindings: readonly UserProfileEmailBindingChange[],
    settled?: () => void,
  ) => {
    let changed = false;
    for (const catalog of publication.catalogs.keys()) {
      const witness = publication.witnesses.get(catalog.rows);
      if (!catalog.valid || catalog.identity.key !== identity.key || !witness) {
        continue;
      }
      const rowsBefore = new Map(
        [...publication.before.keys()].map((id) => [id, catalog.rows.get(id)]),
      );
      for (const [profileId, previous] of publication.before) {
        if (!after.has(profileId)) {
          continue;
        }
        const row = witness.rows.get(profileId);
        const observed = after.get(profileId);
        if (
          catalog.rows.get(profileId) === row &&
          (!witness.late || isDeepStrictEqual(row, previous)) &&
          !isDeepStrictEqual(row, observed)
        ) {
          if (observed) {
            catalog.rows.set(profileId, observed);
          } else {
            catalog.rows.delete(profileId);
          }
          changed = true;
        }
      }
      const bindingWitness = witness.bindings;
      for (const change of bindings) {
        const index = profileBindings.get(catalog.rows);
        const previous = bindingWitness?.values.get(change.email);
        // A preceding receipt can install this exact before-binding after the witness was captured.
        const current = index?.byEmail.get(change.email);
        if (
          bindingWitness &&
          index === bindingWitness.index &&
          publication.emailBindings.has(change.email) &&
          !publication.supersededBindings.has(change.email) &&
          ((current === previous && !bindingWitness.late) ||
            isDeepStrictEqual(current ?? null, publication.emailBindings.get(change.email)))
        ) {
          applyCatalogEmailBinding(catalog.rows, change.email, change.after);
          changed = true;
        }
      }
      if (committed) {
        let later = false;
        for (const successor of profileMutationPublications) {
          if (successor === publication) {
            later = true;
            continue;
          }
          const next = successor.witnesses.get(catalog.rows);
          if (!later || successor.identity.key !== identity.key || !next) {
            continue;
          }
          // Only this publication's replacements can advance a later transaction's witness.
          for (const [id, previousRow] of rowsBefore) {
            const final = catalog.rows.get(id);
            if (
              final !== previousRow &&
              next.rows.get(id) === previousRow &&
              successor.before.has(id) &&
              isDeepStrictEqual(successor.before.get(id), final)
            ) {
              next.rows.set(id, final);
            }
          }
        }
      }
    }
    for (const change of bindings) {
      supersedeBindingPublications(identity, change.email, publication);
    }
    // The mutation owner supplies this only for its established native outcome.
    settled?.();
    if (
      changed ||
      bindings.length > 0 ||
      (committed &&
        [...publication.before].some(
          ([id, previous]) => after.has(id) && !isDeepStrictEqual(previous, after.get(id)),
        ))
    ) {
      emitUserProfilesChanged();
    }
  };
  return {
    reconcile(
      this: void,
      after: Array<[string, ProfileDisplayRow | undefined]>,
      bindings: readonly UserProfileEmailBindingChange[] = [],
      settled?: () => void,
    ) {
      publish(new Map(after), true, bindings, settled);
    },
    invalidate(this: void, settled?: () => void) {
      publish(
        new Map([...publication.before.keys()].map((id) => [id, undefined])),
        false,
        [],
        settled,
      );
    },
    release(this: void) {
      profileMutationPublications.delete(publication);
      for (const [catalog, lease] of publication.catalogs) {
        releaseProfileCatalog(catalog, lease);
      }
      publication.catalogs.clear();
      stopUnusedProfileCatalogObservers();
    },
  };
}

export function retainUserProfilePublication(
  identity: DatabasePathIdentity,
  profileId: string,
  before: ProfileDisplayRow | undefined,
) {
  const publication = retainUserProfileMutationPublication(identity, [[profileId, before]]);
  return {
    reconcile(this: void, observed: ProfileDisplayRow | undefined) {
      publication.reconcile([[profileId, observed]]);
    },
    release: publication.release,
  };
}

function observeProfileCatalogs(refresh = false): void {
  observeEmailBindings();
  if (stopCatalogEvents && !refresh) {
    return;
  }
  stopCatalogEvents?.();
  stopCatalogEvents = registerOpenClawStateDatabaseLifecycleListener((event) => {
    let changed = false;
    for (const [locator, current] of profileCatalogs) {
      if (event.kind === "opened") {
        if (
          event.database.path !== locator &&
          event.identity.key !== current.identity.key &&
          event.identity.canonicalPath !== current.identity.canonicalPath
        ) {
          continue;
        }
        if (current.asyncOnly) {
          if (current.identity.key !== event.identity.key) {
            current.rows = new Map();
            current.identity = event.identity;
            current.valid = false;
            changed = true;
          }
        } else {
          changed = loadProfileCatalog(current, event.database.db, event.identity) || changed;
        }
        profileCatalogHandles.set(event.database.db, current.rows);
      } else if (
        event.kind !== "closed" &&
        (event.path === locator || event.identity?.key === current.identity.key)
      ) {
        current.rows.clear();
        current.valid = false;
        changed = true;
      }
    }
    if (changed) {
      emitUserProfilesChanged();
    }
  });
}

/** Retain exact identity and display/navigation facts; physical admission updates every locator before observers. */
export function retainUserProfileCatalog(options: OpenClawStateDatabaseOptions = {}): () => void {
  const pathname = profileCatalogPath(options);
  const catalog: ProfileCatalog = profileCatalogs.get(pathname) ?? {
    rows: new Map(),
    identity: readDatabasePathIdentitySync(pathname),
    valid: false,
    leases: new Set<symbol>(),
  };
  if (!profileCatalogs.has(pathname)) {
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => loadProfileCatalog(catalog, db, readDatabasePathIdentitySync(pathname)),
      { ...options, path: pathname },
    );
    profileCatalogs.set(pathname, catalog);
  }
  observeProfileCatalogs(true);
  const lease = Symbol("profile catalog lease");
  catalog.leases.add(lease);
  return () => releaseProfileCatalog(catalog, lease);
}

async function acquireUserProfileCatalog(options: OpenClawStateDatabaseOptions = {}) {
  const context = captureOpenClawStateWorkerContext(options);
  const authority = await captureUserProfileAuthorityRead(context.admission);
  const pathname = context.admission.databasePath;
  let refreshObserver = false;
  let catalog =
    profileCatalogs.get(pathname) ??
    [...profileCatalogs.values()].find(
      (candidate) => candidate.valid && candidate.identity.key === context.admission.identity.key,
    );
  if (catalog) {
    profileCatalogs.set(pathname, catalog);
  }
  while (
    !catalog?.valid ||
    catalog.identity.key !== context.admission.identity.key ||
    !profileBindings.has(catalog.rows)
  ) {
    const profileRevision = readUserProfileVersion();
    const bindingRevision = readUserProfileEmailBindingRevision();
    const reply = await executeExistingOpenClawStateRead(
      { ...options, path: pathname },
      { type: "userProfiles.catalog" },
      { current: true },
    );
    context.admission.assertCurrent();
    if (reply && (!reply.ok || reply.type !== "userProfiles.catalog")) {
      throw new Error(reply.ok ? "Unexpected profile catalog reply" : reply.message);
    }
    if (
      profileRevision !== readUserProfileVersion() ||
      bindingRevision !== readUserProfileEmailBindingRevision()
    ) {
      catalog = profileCatalogs.get(pathname);
      continue;
    }
    catalog =
      profileCatalogs.get(pathname) ??
      [...profileCatalogs.values()].find(
        (candidate) => candidate.valid && candidate.identity.key === context.admission.identity.key,
      );
    if (
      catalog?.valid &&
      catalog.identity.key === context.admission.identity.key &&
      profileBindings.has(catalog.rows)
    ) {
      profileCatalogs.set(pathname, catalog);
      break;
    }
    if (!catalog?.valid || catalog.identity.key !== context.admission.identity.key) {
      if (catalog) {
        catalog.valid = false;
      }
      catalog = {
        rows: new Map(reply?.profiles ?? []),
        identity: context.admission.identity,
        valid: true,
        leases: new Set(),
        asyncOnly: true,
      };
      refreshObserver = true;
      profileCatalogs.set(pathname, catalog);
    }
    const bindings: UserProfileEmailBindingIndex = {
      byEmail: new Map(),
      byId: new Map(),
      emailsByProfile: new Map(),
    };
    for (const binding of reply?.emailBindings ?? []) {
      applyUserProfileEmailBinding(bindings, binding.email, binding);
    }
    profileBindings.set(catalog.rows, bindings);
    for (const publication of profileMutationPublications) {
      retainProfileMutationPublicationCatalog(publication, catalog, true);
    }
  }
  observeProfileCatalogs(refreshObserver);
  const retained = catalog;
  const identity = retained.identity.key;
  const rows = retained.rows;
  const bindings = profileBindings.get(rows)!;
  const lease = Symbol("prepared profile catalog");
  retained.leases.add(lease);
  let active = true;
  return {
    rows,
    bindings,
    assertCurrent(profileId: string) {
      context.admission.assertCurrent();
      if (
        !active ||
        !retained.valid ||
        context.admission.identity.key !== identity ||
        retained.identity.key !== identity ||
        retained.rows !== rows
      ) {
        throw new UserProfileNotFoundError(profileId);
      }
      authority.assertSettled(profileId);
    },
    release(this: void) {
      if (active) {
        active = false;
        releaseProfileCatalog(retained, lease);
      }
    },
  };
}

/** Retain one off-thread preparation for a synchronous batch of current canonical identities. */
export async function prepareUserProfileCatalog(options: OpenClawStateDatabaseOptions = {}) {
  const catalog = await acquireUserProfileCatalog(options);
  return {
    readCurrentIdentity(this: void, profileId: string) {
      catalog.assertCurrent(profileId);
      const profile = projectCatalogUserProfileIdentity(catalog.rows, profileId);
      if (profile && profile.profileId !== profileId) {
        catalog.assertCurrent(profile.profileId);
      }
      return profile;
    },
    release: catalog.release,
  };
}

/** Prepare once off-thread; execution reads only committed facts retained by this owner. */
export async function prepareUserProfileIdentity(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): Promise<PreparedUserProfileIdentity> {
  return bindPreparedUserProfileIdentity(profileId, await acquireUserProfileCatalog(options));
}

/** Stage exact changed keys before commit so observers always see the whole committed catalog. */
export function stageUserProfileCatalogChange(db: DatabaseSync, profileIds: string[]): void {
  const catalog = profileCatalogHandles.get(db);
  if (catalog) {
    const rows = selectProfileDisplayEntries(db, profileIds);
    stageSqliteTransactionState(db, {
      stage: () => {},
      rollback: () => {},
      commit: () => rows.forEach(([id, row]) => catalog.set(id, row)),
    });
  }
}

export function publishUserProfilesChange(db: DatabaseSync, ...profileIds: string[]): void {
  stageUserProfileCatalogChange(db, profileIds);
  deferSqlitePostCommitPublication(db, emitUserProfilesChanged);
}

/** Reads merge-aware display data without loading avatar bytes. */
export function getUserProfileDisplay(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  const profile = readProfileCatalog(
    options,
    (resident) => resolveCatalogProfile(resident, profileId),
    (db) =>
      selectResolvedUserProfile(
        db,
        profileId,
        userProfilesDb(db).selectFrom("user_profiles").select(userProfileDisplaySelection),
      ),
  );
  if (!profile) {
    throw new UserProfileNotFoundError(profileId);
  }
  return projectUserProfileDisplay(profile);
}

/** Read a bounded display cohort and its one-hop merge targets without initializing storage. */
export function getUserProfileDisplays(
  profileIds: readonly string[],
  options: OpenClawStateDatabaseOptions = {},
): Map<string, ReturnType<typeof getUserProfileDisplay>> {
  const ids = [...new Set(profileIds)];
  if (ids.length === 0) {
    return new Map();
  }
  const project = (resolve: (id: string) => Omit<ProfileDisplayRow, "role"> | undefined) =>
    new Map(
      ids.flatMap((id) => {
        const profile = resolve(id);
        return profile ? [[id, projectUserProfileDisplay(profile)] as const] : [];
      }),
    );
  return (
    readProfileCatalog(
      options,
      (resident) => project((id) => resolveCatalogProfile(resident, id)),
      (db) => {
        const rows = selectUserProfileDisplaysInDatabase(db, ids);
        return project((id) => rows.get(id));
      },
    ) ?? new Map()
  );
}

/** Activity references are display navigation, never authentication identifiers. */
export function resolveUserProfileReference(
  reference: string,
  options: OpenClawStateDatabaseOptions & { allowedProfileIds?: ReadonlySet<string> } = {},
): Result<string | undefined, "ambiguous"> {
  const { allowedProfileIds } = options;
  if (allowedProfileIds?.size === 0) {
    return ok(undefined);
  }

  return (
    readProfileCatalog(
      options,
      (resident) => {
        const allowed = (row: ProfileDisplayRow) =>
          !allowedProfileIds || allowedProfileIds.has(row.merged_into ?? row.id);
        const raw = resident.get(reference);
        return matchUserProfileReference(
          reference,
          raw && allowed(raw) ? resolveCatalogProfile(resident, reference)?.id : undefined,
          (prefix) =>
            [...resident.values()]
              .filter((row) => allowed(row) && row.id.toLowerCase().startsWith(prefix))
              .map((row) => row.merged_into ?? row.id),
        );
      },
      (db) => selectUserProfileReferenceInDatabase(db, reference, allowedProfileIds),
    ) ?? ok(undefined)
  );
}
