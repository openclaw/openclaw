import type { DatabaseSync } from "node:sqlite";
import {
  SKILL_LIBRARY_MAX_SELECTIONS,
  type SkillsLibraryListParams,
  type SkillsLibraryListResult,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { selectHasMultipleSessionSharingIdentities } from "../../state/user-profile-identity.read.js";
import { SkillLibraryError } from "../skill-library-error.js";
import type { SkillLibraryWorkerAuthority } from "./read.contract.js";
import {
  projectSkillLibraryEntry,
  requireSkillLibraryEntry,
  resolveSkillLibraryActor,
  selectSkillLibraryRevision,
  selectSkillLibraryRow,
  skillLibraryDb,
  type SkillLibraryAuthority,
} from "./store.js";

export function hydrateSkillLibraryWorkerAuthority(
  input: SkillLibraryWorkerAuthority,
  profileDependencies?: Set<string>,
): SkillLibraryAuthority {
  return { ...input, profileDependencies, getConfig: () => input.config, assertCurrent() {} };
}

export function resolveSkillLibraryPresentationInDatabase(
  db: DatabaseSync,
  authority: SkillLibraryAuthority,
): Pick<
  SkillsLibraryListResult,
  "profileId" | "multipleProfiles" | "defaultTarget" | "canManageWorkspace"
> {
  const multipleProfiles =
    tableExists(db, "user_profiles") && selectHasMultipleSessionSharingIdentities(db);
  const actor = resolveSkillLibraryActor(db, authority);
  return {
    profileId: actor.profileId ?? null,
    multipleProfiles,
    defaultTarget:
      actor.profileId && (multipleProfiles || !actor.admin)
        ? "personal"
        : actor.admin
          ? "workspace"
          : "unavailable",
    canManageWorkspace: actor.admin,
  };
}

export function listSkillLibraryInDatabase(
  db: DatabaseSync,
  authority: SkillLibraryAuthority,
  params: SkillsLibraryListParams = {},
): SkillsLibraryListResult {
  const presentation = resolveSkillLibraryPresentationInDatabase(db, authority);
  const entries = tableExists(db, "skill_library_entries")
    ? executeSqliteQuerySync(
        db,
        skillLibraryDb(db)
          .selectFrom("skill_library_entries")
          .selectAll()
          .where("removed", "=", 0)
          .orderBy("slug")
          .orderBy("skill_id"),
      ).rows.flatMap((row) => {
        const entry = projectSkillLibraryEntry(db, row, authority);
        if (
          !entry ||
          (params.scope === "mine" &&
            (!presentation.profileId || entry.ownerProfileId !== presentation.profileId)) ||
          (params.scope === "team" && !entry.shared && entry.ownerProfileId !== null)
        ) {
          return [];
        }
        return [entry];
      })
    : [];
  return {
    entries,
    ...presentation,
    defaultSelectionLimit: SKILL_LIBRARY_MAX_SELECTIONS,
    ...(presentation.profileId &&
    entries.filter(
      (entry) =>
        entry.enabled &&
        (entry.ownerProfileId === presentation.profileId ||
          entry.ownerProfileId === null ||
          entry.shared),
    ).length > SKILL_LIBRARY_MAX_SELECTIONS
      ? {
          defaultSelectionNotice:
            "New sessions select up to 64 enabled skills, personal skills first and then stable ID order. In a session, detach a selected skill to make room and attach another from the library.",
        }
      : {}),
  };
}

function authorizeSkillLibraryReadInDatabase(
  db: DatabaseSync,
  authority: SkillLibraryAuthority,
  skillId: string,
  revision?: string,
  selectedRevision?: string,
) {
  if (!selectedRevision) {
    return requireSkillLibraryEntry(db, skillId, authority);
  }
  if (revision !== selectedRevision) {
    throw new SkillLibraryError(
      "FORBIDDEN",
      "Only the session's exact selected revision can be read.",
    );
  }
  const row = selectSkillLibraryRow(db, skillId);
  const entry = row && projectSkillLibraryEntry(db, row, authority, selectedRevision, true);
  if (!entry) {
    throw new SkillLibraryError("NOT_FOUND", "Selected revision is unavailable.");
  }
  return { ...entry, canEdit: false };
}

export function readSkillLibraryMetadataInDatabase(
  db: DatabaseSync,
  authority: SkillLibraryAuthority,
  skillId: string,
  revision?: string,
  selectedRevision?: string,
) {
  const entry = authorizeSkillLibraryReadInDatabase(
    db,
    authority,
    skillId,
    revision,
    selectedRevision,
  );
  const chosenRevision = revision ?? entry.revision;
  const metadata = selectSkillLibraryRevision(db, skillId, chosenRevision);
  if (!metadata) {
    throw new SkillLibraryError("NOT_FOUND", "Skill revision not found.");
  }
  return {
    manifestJson: metadata.files_json,
    entry: { ...entry, revision: chosenRevision, description: metadata.description },
    revisions: selectedRevision
      ? [{ revision: selectedRevision, createdAt: metadata.created_at }]
      : executeSqliteQuerySync(
          db,
          skillLibraryDb(db)
            .selectFrom("skill_library_revisions")
            .select(["revision", "created_at"])
            .where("skill_id", "=", skillId)
            .orderBy("created_at", "desc"),
        ).rows.map((row) => ({ revision: row.revision, createdAt: row.created_at })),
  };
}
