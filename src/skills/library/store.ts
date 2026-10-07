import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SelectQueryBuilder } from "kysely";
import {
  SKILL_LIBRARY_MAX_SELECTIONS,
  type SkillLibraryEntry,
  type SkillsLibraryListParams,
  type SkillsLibraryListResult,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { authorizeOperatorScopesForRequiredScope } from "../../gateway/method-scopes.js";
import { resolveOperatorRolePolicyForAssignment } from "../../gateway/operator-role-policy.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { selectStoredGitHubIdentities } from "../../state/user-profile-github-identity.js";
import { selectUserProfileDisplaysInDatabase } from "../../state/user-profile-identity.read.js";
import {
  selectResolvedUserProfile,
  selectResolvedUserProfileMetadataById,
  userProfilesDb,
} from "../../state/user-profiles-internal.js";
import { chunkItems } from "../../utils/chunk-items.js";
import { SkillLibraryError } from "../skill-library-error.js";
import { managedSkillCommandName } from "./command-name.js";

export type SkillLibraryAuthority = {
  /** Host-authenticated profile only. Neither session attribution nor model arguments qualify. */
  profileId?: string;
  namespace?: "personal";
  scopes: readonly string[];
  getConfig: () => OpenClawConfig;
  /** Must revalidate the admitted run/placement and request owner, synchronously at commit. */
  assertCurrent: () => void;
  /** Additional pure, synchronous admission for client bytes; must not perform database reads. */
  assertFileMutationAllowed?: () => void;
  /** Worker-local profile dependencies bound to the host identity owner before disclosure. */
  profileDependencies?: Set<string>;
};
export type SkillLibraryRevisionRow = StateDatabase["skill_library_revisions"];
export type SkillLibraryDatabase = Pick<
  StateDatabase,
  | "skill_library_entries"
  | "skill_library_revisions"
  | "skill_library_events"
  | "skill_library_uploads"
>;
export const skillLibraryDb = (db: DatabaseSync) => getNodeSqliteKysely<SkillLibraryDatabase>(db);
const ensured = new WeakSet<DatabaseSync>();

export function ensureSkillLibrarySchema(
  options: OpenClawStateDatabaseOptions,
  admit: (stage: "transaction" | "commit") => void,
): void {
  const { db } = openOpenClawStateDatabase(options);
  if (ensured.has(db)) {
    return;
  }
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
    "CREATE TABLE IF NOT EXISTS skill_library_entries (",
  );
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf("-- End profile-owned skill library.", start);
  if (start < 0 || end < start) {
    throw new Error("Canonical skill library schema missing.");
  }
  runOpenClawStateWriteTransaction(
    ({ db: transactionDb }) => {
      admit("transaction");
      transactionDb.exec(OPENCLAW_STATE_SCHEMA_SQL.slice(start, end)); // sqlite-allow-raw -- canonical first-use additive DDL.
      admit("commit");
    },
    options,
    { operationLabel: "skills.library.schema" },
  );
  ensured.add(db);
}

export function readSkillLibraryStore<T>(
  read: (db: DatabaseSync) => T,
  options: OpenClawStateDatabaseOptions,
): T | undefined {
  if (options.database) {
    return tableExists(options.database.db, "skill_library_entries")
      ? read(options.database.db)
      : undefined;
  }
  return withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) => (tableExists(db, "skill_library_entries") ? read(db) : undefined),
    options,
  );
}

export function resolveSkillLibraryActor(db: DatabaseSync, authority: SkillLibraryAuthority) {
  authority.assertCurrent();
  const config = authority.getConfig();
  if (authority.profileId) {
    authority.profileDependencies?.add(authority.profileId);
  }
  const profile =
    authority.profileId && tableExists(db, "user_profiles")
      ? selectResolvedUserProfileMetadataById(db, authority.profileId)
      : undefined;
  if (authority.profileId && !profile) {
    throw new SkillLibraryError(
      "AUTHORITY_EXPIRED",
      "Your Gateway profile is no longer available. Sign in again before accessing the library.",
    );
  }
  if (profile) {
    authority.profileDependencies?.add(profile.id);
  }
  const ceiling = resolveOperatorRolePolicyForAssignment(
    profile?.id,
    profile?.role ?? null,
    config,
    profile && config.gateway?.roles?.assignments?.byGithubLogin
      ? (selectStoredGitHubIdentities(db, [profile.id]).get(profile.id)?.primary?.login ?? null)
      : null,
  )?.scopes;
  const permits = (scope: "operator.read" | "operator.write" | "operator.admin") =>
    authorizeOperatorScopesForRequiredScope(scope, [...authority.scopes]).allowed &&
    (!ceiling || authorizeOperatorScopesForRequiredScope(scope, ceiling).allowed);
  return {
    profileId: profile?.id,
    admin: permits("operator.admin"),
    read: permits("operator.read") || permits("operator.write"),
    write: Boolean(profile) && permits("operator.write"),
  };
}

export function requireSkillLibraryProfile(
  db: DatabaseSync,
  authority: SkillLibraryAuthority,
): string {
  const actor = resolveSkillLibraryActor(db, authority);
  if (!actor.profileId) {
    throw new SkillLibraryError(
      "IDENTITY_REQUIRED",
      "Sign in with a durable Gateway profile to use a personal skill library. Shared-token administrators can use workspace skills.",
    );
  }
  if (!actor.write) {
    throw new SkillLibraryError("FORBIDDEN", "Your current Gateway role cannot change skills.");
  }
  return actor.profileId;
}

function requireSelectedSkillLibraryUpload<
  T extends Pick<SkillLibraryDatabase["skill_library_uploads"], "owner_profile_id" | "expires_at">,
>(
  db: DatabaseSync,
  uploadId: string,
  authority: SkillLibraryAuthority,
  query: SelectQueryBuilder<SkillLibraryDatabase, "skill_library_uploads", T>,
) {
  const actor = requireSkillLibraryProfile(db, authority);
  const upload = executeSqliteQueryTakeFirstSync(db, query.where("upload_id", "=", uploadId));
  const owner = upload && selectSkillLibraryOwner(db, upload.owner_profile_id)?.id;
  if (upload) {
    authority.profileDependencies?.add(upload.owner_profile_id);
  }
  if (owner) {
    authority.profileDependencies?.add(owner);
  }
  if (!upload || upload.expires_at <= Date.now() || owner !== actor) {
    throw new SkillLibraryError(
      "NOT_FOUND",
      "Upload not found for your profile, or expired. Start a new import.",
    );
  }
  return upload;
}

export function requireSkillLibraryUpload(
  db: DatabaseSync,
  uploadId: string,
  authority: SkillLibraryAuthority,
) {
  return requireSelectedSkillLibraryUpload(
    db,
    uploadId,
    authority,
    skillLibraryDb(db).selectFrom("skill_library_uploads").selectAll(),
  );
}

export function requireSkillLibraryUploadMetadata(
  db: DatabaseSync,
  uploadId: string,
  authority: SkillLibraryAuthority,
) {
  return requireSelectedSkillLibraryUpload(
    db,
    uploadId,
    authority,
    skillLibraryDb(db)
      .selectFrom("skill_library_uploads")
      .select(["owner_profile_id", "expires_at", "slug", "published_skill_id"]),
  );
}

function skillLibraryRevisionQuery(db: DatabaseSync, skillId: string, revision: string) {
  return skillLibraryDb(db)
    .selectFrom("skill_library_revisions")
    .where("skill_id", "=", skillId)
    .where("revision", "=", revision);
}

export function selectSkillLibraryRevision(
  db: DatabaseSync,
  skillId: string,
  revision: string,
): SkillLibraryRevisionRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    skillLibraryRevisionQuery(db, skillId, revision).selectAll(),
  );
}

export function selectSkillLibraryRevisionMetadata(
  db: DatabaseSync,
  skillId: string,
  revision: string,
) {
  return executeSqliteQueryTakeFirstSync(
    db,
    skillLibraryRevisionQuery(db, skillId, revision).select("description"),
  );
}

export function selectSkillLibraryOwner(db: DatabaseSync, profileId: string) {
  // Actor resolution stays separate because existing profile tables may omit its optional role.
  return selectResolvedUserProfile(
    db,
    profileId,
    userProfilesDb(db).selectFrom("user_profiles").select(["id", "display_name", "merged_into"]),
  );
}

function canonicalOwner(db: DatabaseSync, owner: string | null): string | null {
  return owner && tableExists(db, "user_profiles")
    ? (selectSkillLibraryOwner(db, owner)?.id ?? owner)
    : owner;
}

export function projectSkillLibraryList(
  {
    entries: catalog,
    profileId,
    defaultSelectionNotice: _notice,
    ...presentation
  }: Omit<SkillsLibraryListResult, "defaultSelectionLimit">,
  { scope }: SkillsLibraryListParams = {},
): SkillsLibraryListResult {
  const entries = catalog.filter(
    (entry) =>
      (scope !== "mine" || (profileId && entry.ownerProfileId === profileId)) &&
      (scope !== "team" || entry.shared || entry.ownerProfileId === null),
  );
  return {
    ...presentation,
    entries,
    profileId,
    defaultSelectionLimit: SKILL_LIBRARY_MAX_SELECTIONS,
    ...(profileId &&
    entries.filter(
      (entry) =>
        entry.enabled &&
        (entry.ownerProfileId === profileId || entry.ownerProfileId === null || entry.shared),
    ).length > SKILL_LIBRARY_MAX_SELECTIONS
      ? {
          defaultSelectionNotice:
            "New sessions select up to 64 enabled skills, personal skills first and then stable ID order. In a session, detach a selected skill to make room and attach another from the library.",
        }
      : {}),
  };
}

/** Prepared facts live only for this synchronous read in the caller's snapshot. */
export function selectSkillLibraryEntries(
  db: DatabaseSync,
  authority: SkillLibraryAuthority,
  params: {
    skillId?: string;
    revision?: string;
    enabledOnly?: boolean;
    selectedBySession?: boolean;
  } = {},
  actor = resolveSkillLibraryActor(db, authority),
): SkillLibraryEntry[] {
  let query = skillLibraryDb(db)
    .selectFrom("skill_library_entries as entry")
    .leftJoin("skill_library_revisions as revision", (join) =>
      join
        .onRef("revision.skill_id", "=", "entry.skill_id")
        .on((eb) =>
          eb("revision.revision", "=", params.revision ?? eb.ref("entry.current_revision")),
        ),
    )
    .selectAll("entry")
    .select(["revision.description", "revision.revision"]);
  query = params.skillId
    ? query.where("entry.skill_id", "=", params.skillId)
    : query.where("entry.removed", "=", 0);
  if (params.enabledOnly) {
    query = query.where("entry.enabled", "=", 1);
  }
  const rows = executeSqliteQuerySync(
    db,
    query.orderBy("entry.slug").orderBy("entry.skill_id"),
  ).rows;
  const ownerIds = [
    ...new Set(rows.flatMap((row) => (row.owner_profile_id ? [row.owner_profile_id] : []))),
  ];
  const readOwners = (ids: string[]) =>
    new Map(
      tableExists(db, "user_profiles")
        ? chunkItems(ids, 500).flatMap((batch) =>
            Array.from(selectUserProfileDisplaysInDatabase(db, batch)),
          )
        : [],
    );
  const owners = readOwners(ownerIds);
  // Canonical identity and display each retain their existing one-hop, missing-target fallback.
  const labels = readOwners([
    ...new Set([...owners.values()].flatMap((owner) => (owner?.merged_into ? [owner.id] : []))),
  ]);
  for (const id of ownerIds) {
    authority.profileDependencies?.add(id);
    authority.profileDependencies?.add(owners.get(id)?.id ?? id);
  }
  return rows.flatMap((row) => {
    const profile = row.owner_profile_id === null ? undefined : owners.get(row.owner_profile_id);
    const owner = profile?.id ?? row.owner_profile_id;
    if (
      !row.revision ||
      row.description === null ||
      !actor.read ||
      (!params.selectedBySession &&
        !actor.admin &&
        owner !== actor.profileId &&
        !row.shared &&
        owner !== null)
    ) {
      return [];
    }
    return [
      {
        skillId: row.skill_id,
        slug: row.slug,
        name: managedSkillCommandName(row.slug, row.skill_id),
        ownerLabel:
          owner === null ? "Team" : ((labels.get(owner) ?? profile)?.display_name ?? owner),
        description: row.description,
        ownerProfileId: owner,
        authorProfileId: row.author_profile_id,
        shared: row.shared === 1,
        enabled: row.enabled === 1,
        removed: row.removed === 1,
        revision: row.revision,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        canEdit:
          actor.write &&
          ((authority.namespace !== "personal" && actor.admin) ||
            (owner !== null && actor.profileId === owner)),
      },
    ];
  });
}

export function requireSkillLibraryEntry(
  db: DatabaseSync,
  skillId: string,
  authority: SkillLibraryAuthority,
  write = false,
  actor = resolveSkillLibraryActor(db, authority),
): SkillLibraryEntry {
  const [entry] = selectSkillLibraryEntries(db, authority, { skillId }, actor);
  if (!entry) {
    throw new SkillLibraryError("NOT_FOUND", "Skill not found in your accessible library.");
  }
  if (write && !entry.canEdit) {
    requireSkillLibraryProfile(db, authority);
    throw new SkillLibraryError(
      "FORBIDDEN",
      authority.namespace === "personal"
        ? "Personal authoring can change only your own skills. Use the administrator UI or CLI for team management."
        : "Only the skill's owner or a Gateway administrator can change it.",
    );
  }
  if (write && entry.removed) {
    throw new SkillLibraryError(
      "NOT_FOUND",
      "Removed skills cannot be edited or selected again; pinned revisions remain available to their sessions.",
    );
  }
  return entry;
}

export function assertSkillLibraryRevision(entry: SkillLibraryEntry, expected: string | null) {
  if (entry.revision !== expected) {
    throw new SkillLibraryError(
      "CONFLICT",
      "Skill changed. Read the current revision and review your edit before saving again.",
      entry.revision,
    );
  }
}

export function assertSkillLibraryNameAvailable(
  db: DatabaseSync,
  owner: string | null,
  slug: string,
  exceptId?: string,
) {
  const rows = executeSqliteQuerySync(
    db,
    skillLibraryDb(db)
      .selectFrom("skill_library_entries")
      .selectAll()
      .where("slug", "=", slug)
      .where("removed", "=", 0),
  ).rows;
  if (
    rows.some(
      (row) => row.skill_id !== exceptId && canonicalOwner(db, row.owner_profile_id) === owner,
    )
  ) {
    throw new SkillLibraryError(
      "NAME_CONFLICT",
      `A skill named "${slug}" already exists in this library. Choose a different slug; existing skills were preserved.`,
    );
  }
}

export function recordSkillLibraryEvent(
  db: DatabaseSync,
  skillId: string,
  revision: string,
  action: string,
  actorProfileId: string,
) {
  executeSqliteQuerySync(
    db,
    skillLibraryDb(db).insertInto("skill_library_events").values({
      event_id: randomUUID(),
      skill_id: skillId,
      revision,
      action,
      actor_profile_id: actorProfileId,
      created_at: Date.now(),
    }),
  );
}
