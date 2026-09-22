import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual, toUSVString } from "node:util";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  deferSqlitePostCommitPublication,
  stageSqliteTransactionState,
} from "../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import {
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "./openclaw-state-db-cache.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { emitUserProfilesChanged } from "./user-profile-events.js";
import { selectUserProfileGitHubIdentities } from "./user-profile-github-identity.js";
import {
  selectResolvedUserProfile,
  selectResolvedUserProfileMetadataById,
  normalizeUserProfileAvatarMime,
  userProfileDisplaySelection,
  selectProfileDisplayEntries,
  userProfilesDb,
} from "./user-profiles-internal.js";
import {
  ensureUserProfilesSchema,
  UserProfileNotFoundError,
  hasEnsuredUserProfileRoleSchema,
} from "./user-profiles-schema.js";
import type { ProfileDisplayRow, UserProfileDisplay } from "./user-profiles.types.js";

export function listUserProfilesSync(options: OpenClawStateDatabaseOptions = {}) {
  ensureUserProfilesSchema(options);
  const database = openOpenClawStateDatabase(options);
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const kysely = userProfilesDb(database.db);
      const profiles = executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("user_profiles")
          .select([
            ...userProfileDisplaySelection,
            "created_at",
            // The native role writer can add this column after a worker has opened.
            ...(hasEnsuredUserProfileRoleSchema(database.db) ||
            tableHasColumn(database.db, "user_profiles", "role")
              ? (["role"] as const)
              : []),
          ])
          .orderBy("created_at", "asc")
          .orderBy("id", "asc"),
      ).rows;
      const emails = executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("user_profile_emails")
          .select(["profile_id", "email"])
          .orderBy("email", "asc"),
      ).rows;
      const githubIdentities = selectUserProfileGitHubIdentities(database.db);
      const emailsByProfile = new Map<string, string[]>(profiles.map(({ id }) => [id, []]));
      for (const { profile_id, email } of emails) {
        emailsByProfile.get(profile_id)?.push(email);
      }
      return profiles.map((profile) =>
        Object.assign(
          {
            id: profile.id,
            displayName: profile.display_name,
            avatarMime: normalizeUserProfileAvatarMime(profile.avatar_mime),
            mergedInto: profile.merged_into,
            createdAt: profile.created_at,
            updatedAt: profile.updated_at,
            emails: emailsByProfile.get(profile.id) ?? [],
            githubIdentity: githubIdentities.get(profile.id) ?? null,
            hasAvatar: profile.has_avatar === 1,
          },
          profile.role ? { role: profile.role } : {},
        ),
      );
    },
    { databaseLabel: database.path, operationLabel: "user-profiles.list" },
  );
}

/** Disclosure scopes need current aliases, never the resident display catalog. */
export function readCurrentUserProfileAliases(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): ReadonlySet<string> {
  ensureUserProfilesSchema(options);
  const database = openOpenClawStateDatabase(options);
  return runSqliteDeferredTransactionSync(database.db, () => {
    const canonicalId =
      selectResolvedUserProfileMetadataById(database.db, profileId)?.id ?? profileId;
    const aliases = executeSqliteQuerySync(
      database.db,
      userProfilesDb(database.db)
        .selectFrom("user_profiles")
        .select("id")
        .where("merged_into", "=", canonicalId),
    ).rows;
    return new Set([canonicalId, ...aliases.map((row) => row.id)]);
  });
}

/** True when session-sharing policy can distinguish at least two durable people. */
export function hasMultipleSessionSharingIdentities(
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  ensureUserProfilesSchema(options);
  const { db } = openOpenClawStateDatabase(options);
  const profiles = executeSqliteQuerySync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profiles")
      .select("id")
      .where("merged_into", "is", null)
      .where("id", "!=", GATEWAY_OWNER_PROFILE_ID)
      .limit(2),
  ).rows;
  return profiles.length >= 2;
}

/** Exact durable identity facts; never use display-reference prefix matching for authority. */
export function readUserProfileIdentity(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  return readProfileCatalog(
    options,
    (resident) => {
      const profile = resolveCatalogProfile(resident, profileId);
      return (
        profile && {
          profileId: profile.id,
          role: profile.role ?? null,
          aliases: new Set(
            [...resident.values()]
              .filter((row) => row.id === profile.id || row.merged_into === profile.id)
              .map((row) => row.id),
          ),
        }
      );
    },
    (db) => {
      const profile = selectResolvedUserProfileMetadataById(db, profileId);
      return (
        profile && {
          profileId: profile.id,
          role: profile.role ?? null,
          aliases: new Set(
            executeSqliteQuerySync(
              db,
              userProfilesDb(db)
                .selectFrom("user_profiles")
                .select("id")
                .where((eb) =>
                  eb.or([eb("id", "=", profile.id), eb("merged_into", "=", profile.id)]),
                ),
            ).rows.map((row) => row.id),
          ),
        }
      );
    },
  );
}

/** Existing one-hop aliases are identity facts; this read never creates profile storage. */
export function readUserProfileAliases(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): ReadonlySet<string> {
  return new Set([profileId, ...(readUserProfileIdentity(profileId, options)?.aliases ?? [])]);
}

function resolveCatalogProfile(rows: Map<string, ProfileDisplayRow>, id: string) {
  const raw = rows.get(id);
  return rows.get(raw?.merged_into ?? id) ?? raw;
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
type ProfileCatalog = {
  rows: Map<string, ProfileDisplayRow>;
  identity: DatabasePathIdentity;
  valid: boolean;
  leases: Set<symbol>;
};
const profileCatalogs = new Map<string, ProfileCatalog>();
type ProfileMutationPublication = {
  identity: DatabasePathIdentity;
  before: Map<string, ProfileDisplayRow | undefined>;
  witnesses: Map<
    Map<string, ProfileDisplayRow>,
    { rows: Map<string, ProfileDisplayRow | undefined>; late: boolean }
  >;
  catalogs: Map<ProfileCatalog, symbol>;
};
const profileMutationPublications = new Set<ProfileMutationPublication>();
let stopCatalogEvents: (() => void) | undefined;
let profileCatalogHandles = new WeakMap<DatabaseSync, Map<string, ProfileDisplayRow>>();
const profileCatalogPath = (options: OpenClawStateDatabaseOptions) =>
  path.resolve(options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env));

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
  if (!publication.witnesses.has(catalog.rows)) {
    publication.witnesses.set(catalog.rows, {
      rows: new Map([...publication.before.keys()].map((id) => [id, catalog.rows.get(id)])),
      late,
    });
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
  if (profileCatalogs.size === 0) {
    stopCatalogEvents?.();
    stopCatalogEvents = undefined;
    profileCatalogHandles = new WeakMap();
  }
}

/** Capture under the worker's write transaction; native commits replace these row objects. */
export function retainUserProfileMutationPublication(
  identity: DatabasePathIdentity,
  before: Array<[string, ProfileDisplayRow | undefined]>,
) {
  const publication: ProfileMutationPublication = {
    identity,
    before: new Map(before),
    witnesses: new Map(),
    catalogs: new Map(),
  };
  profileMutationPublications.add(publication);
  for (const catalog of profileCatalogs.values()) {
    retainProfileMutationPublicationCatalog(publication, catalog, false);
  }
  const publish = (after: Map<string, ProfileDisplayRow | undefined>, committed: boolean) => {
    let changed = false;
    for (const catalog of publication.catalogs.keys()) {
      const witness = publication.witnesses.get(catalog.rows);
      if (!catalog.valid || catalog.identity.key !== identity.key || !witness) {
        continue;
      }
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
    }
    if (
      changed ||
      (committed &&
        [...publication.before].some(
          ([id, previous]) => after.has(id) && !isDeepStrictEqual(previous, after.get(id)),
        ))
    ) {
      emitUserProfilesChanged();
    }
  };
  return {
    reconcile(this: void, after: Array<[string, ProfileDisplayRow | undefined]>) {
      publish(new Map(after), true);
    },
    invalidate(this: void) {
      publish(new Map([...publication.before.keys()].map((id) => [id, undefined])), false);
    },
    release(this: void) {
      profileMutationPublications.delete(publication);
      for (const [catalog, lease] of publication.catalogs) {
        releaseProfileCatalog(catalog, lease);
      }
      publication.catalogs.clear();
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
        changed = loadProfileCatalog(current, event.database.db, event.identity) || changed;
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
  const lease = Symbol("profile catalog lease");
  catalog.leases.add(lease);
  return () => releaseProfileCatalog(catalog, lease);
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

export function projectUserProfileDisplay(
  profile: Omit<ProfileDisplayRow, "role">,
): UserProfileDisplay {
  const avatarMime = normalizeUserProfileAvatarMime(profile.avatar_mime);
  return {
    id: profile.id,
    displayName: profile.display_name,
    avatarRevision:
      profile.avatar_sha256 && avatarMime
        ? `${profile.avatar_sha256}-${avatarMime.slice("image/".length)}`
        : String(profile.updated_at),
    hasAvatar: profile.has_avatar === 1,
  };
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
        const profiles = userProfilesDb(db).selectFrom("user_profiles");
        const rows = executeSqliteQuerySync(
          db,
          profiles
            .select(userProfileDisplaySelection)
            .where((eb) =>
              eb.or([
                eb("id", "in", ids),
                eb(
                  "id",
                  "in",
                  profiles
                    .select("merged_into")
                    .where("id", "in", ids)
                    .where("merged_into", "!=", ""),
                ),
              ]),
            ),
        ).rows;
        if (
          rows.some(
            (row) =>
              typeof row.id !== "string" ||
              (row.merged_into !== null && typeof row.merged_into !== "string"),
          )
        ) {
          // Native BLOB keys compare by value in SQLite, not by Map object identity.
          return project((id) =>
            selectResolvedUserProfile(db, id, profiles.select(userProfileDisplaySelection)),
          );
        }
        const byId = new Map(rows.map((row) => [row.id, row]));
        return project((id) => {
          // Match native text binding before indexing the returned SQLite rows.
          const raw = byId.get(toUSVString(id));
          return raw?.merged_into ? (byId.get(raw.merged_into) ?? raw) : raw;
        });
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
  const finish = (exact: string | undefined, readMatches: (prefix: string) => string[]) => {
    if (exact !== undefined || !/^[0-9a-f]{8,32}$/.test(reference)) {
      return ok<string | undefined, "ambiguous">(exact);
    }
    const prefix = [0, 8, 12, 16, 20]
      .map((start, index, offsets) => reference.slice(start, offsets[index + 1]))
      .filter(Boolean)
      .join("-");
    const matches = new Set(readMatches(prefix));
    return matches.size > 1
      ? err<string | undefined, "ambiguous">("ambiguous")
      : ok<string | undefined, "ambiguous">(matches.values().next().value);
  };
  return (
    readProfileCatalog(
      options,
      (resident) => {
        const allowed = (row: ProfileDisplayRow) =>
          !allowedProfileIds || allowedProfileIds.has(row.merged_into ?? row.id);
        const raw = resident.get(reference);
        return finish(
          raw && allowed(raw) ? resolveCatalogProfile(resident, reference)?.id : undefined,
          (prefix) =>
            [...resident.values()]
              .filter((row) => allowed(row) && row.id.toLowerCase().startsWith(prefix))
              .map((row) => row.merged_into ?? row.id),
        );
      },
      (db) => {
        let profiles = userProfilesDb(db).selectFrom("user_profiles");
        if (allowedProfileIds) {
          profiles = profiles.where((eb) =>
            eb(eb.fn.coalesce("merged_into", "id"), "in", [...allowedProfileIds]),
          );
        }
        return finish(
          selectResolvedUserProfile(db, reference, profiles.select(["id", "merged_into"]))?.id,
          (prefix) =>
            executeSqliteQuerySync(
              db,
              profiles
                .select((eb) => eb.fn.coalesce("merged_into", "id").as("id"))
                .where("id", "like", `${prefix}%`)
                .distinct()
                .limit(2),
            ).rows.map((row) => row.id),
        );
      },
    ) ?? ok(undefined)
  );
}
