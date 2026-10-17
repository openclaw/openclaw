import path from "node:path";
import { toUSVString } from "node:util";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import type { OpenClawStateReadCommand } from "./openclaw-state-read.types.js";
import { selectProfileAccessEntries } from "./user-profile-github-identity.js";
import {
  matchUserProfileReference,
  resolveCatalogProfile,
  projectUserProfileDisplay,
  projectCatalogUserProfileIdentity,
  projectUserProfileListItem,
  selectResolvedUserProfile,
  selectResolvedUserProfileMetadataById,
  userProfilesDb,
  userProfileDisplaySelection,
} from "./user-profiles-internal.js";
import type {
  ProfileDisplayRow,
  UserProfileEmailBinding,
  UserProfileIdentity,
  UserProfileEmailBindingIndex,
} from "./user-profiles.types.js";

export const profileCatalogPath = (options: OpenClawStateDatabaseOptions) =>
  path.resolve(options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env));

/** Worker hydration retains unknown legacy bindings without inventing their lifetime. */
export function readUserProfileEmailBindings(
  db: EngineConnection,
  profileIds?: string | readonly string[],
): UserProfileEmailBinding[] {
  if (
    (Array.isArray(profileIds) && profileIds.length === 0) ||
    !tableExists(db, "user_profile_emails")
  ) {
    return [];
  }
  const query = userProfilesDb(db)
    .selectFrom("user_profile_emails")
    .select(["email", "profile_id"])
    .select((eb) => [
      tableHasColumn(db, "user_profile_emails", "binding_id")
        ? "binding_id"
        : eb.val<string | null>(null).as("binding_id"),
    ])
    .orderBy("email", "asc");
  return executeSqliteQuerySync(
    db,
    profileIds === undefined
      ? query
      : typeof profileIds === "string"
        ? query.where("profile_id", "=", profileIds)
        : query.where("profile_id", "in", [...profileIds]),
  ).rows.map(({ email, profile_id, binding_id }) => ({
    email,
    profileId: profile_id,
    bindingId: binding_id,
  }));
}

/** Alias lookup is observational and never initializes profile storage. */
export function readUserProfileSnapshotCommand(
  db: EngineConnection,
  command: Extract<
    OpenClawStateReadCommand,
    { type: "userProfiles.reconcile" | "userProfiles.catalog" }
  >,
) {
  return runSqliteDeferredTransactionSync(db, () =>
    command.type === "userProfiles.reconcile"
      ? {
          type: command.type,
          profile: selectProfileAccessEntries(db, [command.profileId])[0]?.[1],
          emailBindings: readUserProfileEmailBindings(db, command.profileId),
        }
      : {
          type: command.type,
          profiles: tableExists(db, "user_profiles") ? selectProfileAccessEntries(db) : [],
          emailBindings: readUserProfileEmailBindings(db),
        },
  );
}

/** Select one canonical profile; private fields never require projecting the directory. */
export function readCatalogUserProfileAuthority(
  catalog: {
    rows: Map<string, ProfileDisplayRow>;
    bindings: UserProfileEmailBindingIndex;
    assertCurrent: (profileId: string) => void;
  },
  profileId: string,
  includeProfile: boolean,
) {
  catalog.assertCurrent(profileId);
  const { rows, bindings } = catalog;
  const profile = projectCatalogUserProfileIdentity(rows, profileId);
  if (!profile) {
    return undefined;
  }
  catalog.assertCurrent(profile.profileId);
  const row = rows.get(profile.profileId)!;
  return {
    ...profile,
    aliases: [
      profile.profileId,
      ...[...profile.aliases].filter((id) => id !== profile.profileId).toSorted(),
    ],
    display: projectUserProfileDisplay(row),
    ...(includeProfile ? { listItem: projectUserProfileListItem(row, bindings) } : {}),
  };
}

/** In-memory counterpart of the bounded SQL selector for the Gateway catalog. */
export function projectHasMultipleSessionSharingIdentities(
  rows: ReadonlyMap<string, ProfileDisplayRow>,
): boolean {
  let people = 0;
  for (const row of rows.values()) {
    if (!row.merged_into && row.id !== GATEWAY_OWNER_PROFILE_ID && ++people === 2) {
      return true;
    }
  }
  return false;
}

/** True when session-sharing policy can distinguish at least two durable people. */
export function selectHasMultipleSessionSharingIdentities(db: EngineConnection): boolean {
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

/** Exact canonical identity and aliases selected on the caller's admitted connection. */
export function selectUserProfileIdentityInDatabase(
  db: EngineConnection,
  profileId: string,
): UserProfileIdentity | undefined {
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
            .where((eb) => eb.or([eb("id", "=", profile.id), eb("merged_into", "=", profile.id)])),
        ).rows.map((row) => row.id),
      ),
    }
  );
}

/** Read display rows and their one-hop aliases without creating profile storage. */
export function selectUserProfileDisplaysInDatabase(
  db: EngineConnection,
  ids: readonly string[],
): Map<string, Omit<ProfileDisplayRow, "role" | "created_at"> | undefined> {
  const profiles = userProfilesDb(db).selectFrom("user_profiles");
  const rows = executeSqliteQuerySync(
    db,
    profiles.select(userProfileDisplaySelection).where((eb) =>
      eb.or([
        eb("id", "in", [...ids]),
        eb(
          "id",
          "in",
          profiles
            .select("merged_into")
            .where("id", "in", [...ids])
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
    const displays: Map<string, Omit<ProfileDisplayRow, "role" | "created_at"> | undefined> =
      new Map();
    for (const id of ids) {
      displays.set(
        id,
        selectResolvedUserProfile(db, id, profiles.select(userProfileDisplaySelection)),
      );
    }
    return displays;
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  return new Map(
    ids.map((id) => {
      // Match native text binding before indexing the returned SQLite rows.
      const raw = byId.get(toUSVString(id));
      return [id, raw?.merged_into ? (byId.get(raw.merged_into) ?? raw) : raw];
    }),
  );
}

/** Project a bounded display cohort from the resident Gateway catalog. */
export function projectUserProfileDisplays(
  ids: readonly string[],
  resolve: (id: string) => Omit<ProfileDisplayRow, "role" | "created_at"> | undefined,
) {
  return new Map(
    ids.flatMap((id) => {
      const profile = resolve(id);
      return profile ? [[id, projectUserProfileDisplay(profile)] as const] : [];
    }),
  );
}

/** Resolve display navigation against the resident Gateway catalog. */
export function resolveUserProfileReferenceInCatalog(
  rows: Map<string, ProfileDisplayRow>,
  reference: string,
  allowedProfileIds?: ReadonlySet<string>,
) {
  const allowed = (row: ProfileDisplayRow) =>
    !allowedProfileIds || allowedProfileIds.has(row.merged_into ?? row.id);
  const raw = rows.get(reference);
  return matchUserProfileReference(
    reference,
    raw && allowed(raw) ? resolveCatalogProfile(rows, reference)?.id : undefined,
    (prefix) =>
      [...rows.values()]
        .filter((row) => allowed(row) && row.id.toLowerCase().startsWith(prefix))
        .map((row) => row.merged_into ?? row.id),
  );
}
