import { isDeepStrictEqual } from "node:util";
import { ok, type Result } from "@openclaw/normalization-core/result";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import {
  deferSqlitePostCommitPublication,
  stageSqliteTransactionState,
} from "../infra/sqlite-post-commit.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import {
  registerOpenClawStateDatabaseLifecycleListener,
  requireOpenClawStateDatabaseIdentity,
} from "./openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import {
  captureUserProfileAuthorityRead,
  emitUserProfilesChanged,
  onUserProfileEmailBindingChanged,
  readUserProfileEmailBindingRevision,
  readUserProfileVersion,
} from "./user-profile-events.js";
import { selectProfileAccessEntries } from "./user-profile-github-identity.js";
import {
  profileCatalogPath,
  projectHasMultipleSessionSharingIdentities,
  projectUserProfileDisplayFacts,
  resolveUserProfileReferenceInCatalog,
} from "./user-profile-identity.read.js";
import type { UserProfileEmailBindingChange } from "./user-profile-mutation.js";
import {
  applyUserProfileEmailBinding,
  bindPreparedUserProfileIdentity,
  projectUserProfileDisplay,
  projectUserProfileSnapshot,
  projectCatalogUserProfileIdentity,
  resolveCatalogProfile,
  toUserProfile,
} from "./user-profiles-internal.js";
import { UserProfileNotFoundError } from "./user-profiles-schema.js";
import type {
  PreparedUserProfileIdentity,
  ProfileDisplayRow,
  UserProfileEmailBinding,
  UserProfileEmailBindingIndex,
} from "./user-profiles.types.js";

export { projectUserProfileDisplay } from "./user-profiles-internal.js";

/** Read the Gateway catalog installed by admission and committed profile writes. */
export const hasMultipleSessionSharingIdentities = (options: OpenClawStateDatabaseOptions = {}) =>
  readProfileCatalog(options, projectHasMultipleSessionSharingIdentities) ?? false;

/** Exact durable identity facts; never use display-reference prefix matching for authority. */
export function readUserProfileIdentity(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  return readProfileCatalog(options, (resident) =>
    projectCatalogUserProfileIdentity(resident, profileId),
  );
}

/** Existing one-hop aliases are identity facts; this read never creates profile storage. */
export const readUserProfileAliases = (
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): ReadonlySet<string> =>
  new Set([profileId, ...(readUserProfileIdentity(profileId, options)?.aliases ?? [])]);

function requireResidentProfileCatalog(options: OpenClawStateDatabaseOptions) {
  const catalog = profileCatalogs.get(profileCatalogPath(options));
  if (!catalog?.valid) {
    throw new Error("User profile catalog is not ready");
  }
  return catalog.rows;
}

/** Gateway policy consumes the catalog installed by profile admission and committed writes. */
export function readResidentUserProfileIdentity(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  return projectCatalogUserProfileIdentity(requireResidentProfileCatalog(options), profileId);
}

export function hasMultipleResidentSessionSharingIdentities(
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  return projectHasMultipleSessionSharingIdentities(requireResidentProfileCatalog(options));
}

/** Gateway readers already retain this catalog with their session projection. */
export function readResidentUserProfileId(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): string | undefined {
  return resolveCatalogProfile(requireResidentProfileCatalog(options), profileId)?.id;
}

/** Participant recording consumes the Gateway's prepared aliases without opening storage. */
export function readResidentUserProfileAliases(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): ReadonlySet<string> {
  const identity = readResidentUserProfileIdentity(profileId, options);
  return new Set([profileId, ...(identity?.aliases ?? [])]);
}

export function captureResidentUserProfileAccess(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  const pathname = profileCatalogPath(options);
  const catalog = profileCatalogs.get(pathname);
  const bindings = catalog && profileBindings.get(catalog.rows);
  if (!catalog?.valid || !bindings || !catalog.assertCurrent) {
    throw new Error("User profile catalog is not ready");
  }
  const { rows, assertCurrent: guard } = catalog;
  const assertCurrent = () => {
    if (profileCatalogs.get(pathname) !== catalog || catalog.rows !== rows) {
      throw new UserProfileNotFoundError(profileId);
    }
    guard(profileId);
    const profile = resolveCatalogProfile(rows, profileId);
    if (!profile) {
      throw new UserProfileNotFoundError(profileId);
    }
    guard(profile.id);
    return profile;
  };
  assertCurrent();
  return {
    assertCurrent,
    readCurrentFacts() {
      const profile = assertCurrent();
      return {
        profileId: profile.id,
        emails: [...(bindings.emailsByProfile.get(profile.id) ?? [])].toSorted(),
        ...(profile.githubAccountIds ? { githubAccountIds: [...profile.githubAccountIds] } : {}),
        assignedRole: profile.role ?? null,
        githubLogin: profile.githubLogin ?? null,
      };
    },
  };
}

/** Committed canonical row identity is the revision of catalog-derived avatar facts. */
export function readResidentUserProfileRevision(profileId: string, pathname: string) {
  const catalog = profileCatalogs.get(pathname);
  return catalog?.valid ? resolveCatalogProfile(catalog.rows, profileId) : undefined;
}

/** Catalog hydration and committed receipts retain the exact owner binding with its raw row. */
export function readResidentGatewayOwnerProfile(pathname: string) {
  const catalog = profileCatalogs.get(pathname);
  const owner = catalog?.valid ? catalog.rows.get(GATEWAY_OWNER_PROFILE_ID) : undefined;
  if (!owner || owner.merged_into || owner.gatewayOwnerCreatedAt === undefined) {
    return undefined;
  }
  return toUserProfile({ ...owner, created_at: owner.gatewayOwnerCreatedAt });
}

/** Existing authenticated email bindings use the same write-through catalog as role checks. */
export function readResidentUserProfileForEmail(email: string, pathname: string) {
  const catalog = profileCatalogs.get(pathname);
  const binding = catalog?.valid && profileBindings.get(catalog.rows)?.byEmail.get(email);
  if (!binding) {
    return undefined;
  }
  catalog.assertCurrent?.(binding.profileId);
  const profile = resolveCatalogProfile(catalog.rows, binding.profileId);
  if (profile) {
    catalog.assertCurrent?.(profile.id);
    return toUserProfile(profile);
  }
  return undefined;
}

/** Sharing pickers consume the session projection's committed display catalog. */
export function listResidentUserProfileDisplayFacts(options: OpenClawStateDatabaseOptions = {}) {
  const rows = requireResidentProfileCatalog(options);
  return projectUserProfileDisplayFacts(rows, profileBindings.get(rows)!);
}

/** Pass the prepared absolute database path for allocation-free checks of live owner state. */
export function isUserProfileCatalogReady(pathname = profileCatalogPath({})): boolean {
  const catalog = profileCatalogs.get(pathname);
  return Boolean(catalog?.valid && profileBindings.has(catalog.rows));
}
type ProfileCatalog = {
  rows: Map<string, ProfileDisplayRow>;
  identity: DatabasePathIdentity;
  valid: boolean;
  leases: Set<symbol>;
  assertCurrent?: (profileId: string) => void;
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
  catalogs: Set<ProfileCatalog>;
};
const profileMutationPublications = new Set<ProfileMutationPublication>();
let stopCatalogEvents: (() => void) | undefined;
let stopBindingEvents: (() => void) | undefined;
let profileCatalogHandles = new WeakMap<EngineConnection, Map<string, ProfileDisplayRow>>();
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
): T | undefined {
  const catalog = profileCatalogs.get(profileCatalogPath(options));
  return catalog?.valid ? resident(catalog.rows) : undefined;
}

function retainProfileMutationPublicationCatalog(
  publication: ProfileMutationPublication,
  catalog: ProfileCatalog,
  late: boolean,
) {
  if (!catalog.valid || catalog.identity.key !== publication.identity.key) {
    return;
  }
  publication.catalogs.add(catalog);
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
      if (current.leases === catalog.leases) {
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
    catalogs: new Set(),
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
    for (const catalog of publication.catalogs) {
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
      publication.catalogs.clear();
      stopUnusedProfileCatalogObservers();
    },
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
        if (current.identity.key !== event.identity.key) {
          current.rows = new Map();
          current.identity = event.identity;
          current.valid = false;
          changed = true;
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
      const previous = catalog;
      if (catalog) {
        catalog.valid = false;
      }
      catalog = {
        rows: new Map(reply?.profiles ?? []),
        identity: context.admission.identity,
        valid: true,
        leases: catalog?.leases ?? new Set(),
      };
      refreshObserver = true;
      for (const [locator, current] of profileCatalogs) {
        if (current === previous) {
          profileCatalogs.set(locator, catalog);
        }
      }
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
  const lease = Symbol("profile catalog lease");
  retained.leases.add(lease);
  let active = true;
  const assertCurrent = (profileId: string) => {
    context.admission.assertCurrent();
    if (
      !retained.valid ||
      context.admission.identity.key !== identity ||
      retained.identity.key !== identity ||
      retained.rows !== rows
    ) {
      throw new UserProfileNotFoundError(profileId);
    }
    authority.assertSettled(profileId);
  };
  retained.assertCurrent = assertCurrent;
  return {
    rows,
    bindings,
    assertCurrent(profileId: string) {
      if (!active) {
        throw new UserProfileNotFoundError(profileId);
      }
      assertCurrent(profileId);
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
    hasMultipleSessionSharingIdentities(this: void) {
      return projectHasMultipleSessionSharingIdentities(catalog.rows);
    },
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

/** Lists share committed profile facts rather than reserving the shared-state writer. */
export async function readUserProfileSnapshot(
  githubAccountIds?: readonly number[],
  options: OpenClawStateDatabaseOptions = {},
) {
  const catalog = await acquireUserProfileCatalog(options);
  try {
    for (const row of catalog.rows.values()) {
      catalog.assertCurrent(row.id);
    }
    return projectUserProfileSnapshot(catalog.rows, catalog.bindings, githubAccountIds);
  } finally {
    catalog.release();
  }
}

/** Prepare once off-thread; execution reads only committed facts retained by this owner. */
export async function prepareUserProfileIdentity(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
  emailTargets?: readonly string[],
): Promise<PreparedUserProfileIdentity> {
  const capturedEmails = emailTargets?.slice();
  return bindPreparedUserProfileIdentity(
    profileId,
    await acquireUserProfileCatalog(options),
    capturedEmails,
  );
}

/** Stage exact changed keys before commit so observers always see the whole committed catalog. */
export function stageUserProfileCatalogChange(db: EngineConnection, profileIds: string[]): void {
  const catalog = profileCatalogHandles.get(db);
  if (catalog) {
    const rows = selectProfileAccessEntries(db, profileIds);
    stageSqliteTransactionState(db, {
      stage: () => {},
      rollback: () => {},
      commit: () => {
        for (const id of profileIds) {
          catalog.delete(id);
        }
        for (const [id, row] of rows) {
          catalog.set(id, row);
        }
      },
    });
  }
}

export function publishUserProfilesChange(db: EngineConnection, ...profileIds: string[]): void {
  stageUserProfileCatalogChange(db, profileIds);
  deferSqlitePostCommitPublication(db, emitUserProfilesChanged);
}

/** Reads the prepared Gateway catalog without opening storage or loading avatar bytes. */
export function getUserProfileDisplay(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  const profile = readProfileCatalog(options, (resident) =>
    resolveCatalogProfile(resident, profileId),
  );
  if (!profile) {
    throw new UserProfileNotFoundError(profileId);
  }
  return projectUserProfileDisplay(profile);
}

export function getResidentUserProfileDisplay(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  const profile = resolveCatalogProfile(requireResidentProfileCatalog(options), profileId);
  if (!profile) {
    throw new UserProfileNotFoundError(profileId);
  }
  return projectUserProfileDisplay(profile);
}

/** Transfer display facts and aliases at the owner's publication revision, never authority. */
export function captureResidentUserProfileDisplaySnapshot(
  options: OpenClawStateDatabaseOptions = {},
) {
  const rows = requireResidentProfileCatalog(options);
  return {
    revision: readUserProfileVersion(),
    displays: new Map(
      [...rows.keys()].map((id) => [
        id,
        projectUserProfileDisplay(resolveCatalogProfile(rows, id)!),
      ]),
    ),
  };
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

  const catalog = profileCatalogs.get(profileCatalogPath(options));
  if (!catalog?.valid) {
    throw new Error("User profile catalog is not ready");
  }
  return resolveUserProfileReferenceInCatalog(catalog.rows, reference, allowedProfileIds);
}
