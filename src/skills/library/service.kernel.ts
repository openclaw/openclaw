import type { DatabaseSync } from "node:sqlite";
import type {
  SkillsLibraryListParams,
  SkillsLibraryListResult,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { selectHasMultipleSessionSharingIdentities } from "../../state/user-profile-identity.read.js";
import { SkillLibraryError } from "../skill-library-error.js";
import type { SkillLibraryWorkerAuthority } from "./read.contract.js";
import { skillLibraryReceipt } from "./receipt.js";
import {
  projectSkillLibraryList,
  assertSkillLibraryNameAvailable,
  assertSkillLibraryRevision,
  recordSkillLibraryEvent,
  requireSkillLibraryProfile,
  requireSkillLibraryUploadMetadata,
  selectSkillLibraryRevisionMetadata,
  selectSkillLibraryEntries,
  requireSkillLibraryEntry,
  resolveSkillLibraryActor,
  selectSkillLibraryRevision,
  skillLibraryDb,
  type SkillLibraryAuthority,
} from "./store.js";
import type { SkillLibraryPublishInput, SkillLibraryMutateInput } from "./store.worker-contract.js";

export function hydrateSkillLibraryWorkerAuthority(
  input: SkillLibraryWorkerAuthority,
  profileDependencies?: Set<string>,
): SkillLibraryAuthority {
  return { ...input, profileDependencies, getConfig: () => input.config, assertCurrent() {} };
}

export function resolveSkillLibraryPresentationInDatabase(
  db: DatabaseSync,
  authority: SkillLibraryAuthority,
  actor = resolveSkillLibraryActor(db, authority),
): Pick<
  SkillsLibraryListResult,
  "profileId" | "multipleProfiles" | "defaultTarget" | "canManageWorkspace"
> {
  const multipleProfiles =
    tableExists(db, "user_profiles") && selectHasMultipleSessionSharingIdentities(db);
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
  const actor = resolveSkillLibraryActor(db, authority);
  return projectSkillLibraryList(
    {
      entries: tableExists(db, "skill_library_entries")
        ? selectSkillLibraryEntries(db, authority, {}, actor)
        : [],
      ...resolveSkillLibraryPresentationInDatabase(db, authority, actor),
    },
    params,
  );
}

export function readSkillLibraryMetadataInDatabase(
  db: DatabaseSync,
  authority: SkillLibraryAuthority,
  skillId: string,
  revision?: string,
  selectedRevision?: string,
) {
  if (selectedRevision && revision !== selectedRevision) {
    throw new SkillLibraryError(
      "FORBIDDEN",
      "Only the session's exact selected revision can be read.",
    );
  }
  const entry = selectedRevision
    ? selectSkillLibraryEntries(db, authority, {
        skillId,
        revision: selectedRevision,
        selectedBySession: true,
      })[0]
    : requireSkillLibraryEntry(db, skillId, authority);
  if (!entry) {
    throw new SkillLibraryError("NOT_FOUND", "Selected revision is unavailable.");
  }
  const chosenRevision = revision ?? entry.revision;
  const metadata = selectSkillLibraryRevision(db, skillId, chosenRevision);
  if (!metadata) {
    throw new SkillLibraryError("NOT_FOUND", "Skill revision not found.");
  }
  return {
    manifestJson: metadata.files_json,
    entry: {
      ...entry,
      revision: chosenRevision,
      description: metadata.description,
      canEdit: !selectedRevision && entry.canEdit,
    },
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

export function publishSkillLibraryInDatabase(db: DatabaseSync, input: SkillLibraryPublishInput) {
  const { params, skillId, bundle, uploadId } = input;
  const authority = hydrateSkillLibraryWorkerAuthority(input.authority);
  const actor = requireSkillLibraryProfile(db, authority);
  if (uploadId) {
    const upload = requireSkillLibraryUploadMetadata(db, uploadId, authority);
    if (upload.slug !== params.slug) {
      throw new SkillLibraryError("NOT_FOUND", "Upload slug changed; start the import again.");
    }
    if (upload.published_skill_id) {
      return skillLibraryReceipt(
        requireSkillLibraryEntry(db, upload.published_skill_id, authority),
        "unchanged",
      );
    }
  }
  const current = params.skillId
    ? requireSkillLibraryEntry(db, skillId, authority, true)
    : undefined;
  if (current) {
    assertSkillLibraryRevision(current, params.expectedRevision);
  }
  const owner = current ? current.ownerProfileId : actor;
  assertSkillLibraryNameAvailable(db, owner, params.slug, skillId);
  if (current?.revision === bundle.revision && current.slug === params.slug) {
    return skillLibraryReceipt(current, "unchanged");
  }
  const now = Date.now();
  const kysely = skillLibraryDb(db);
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("skill_library_revisions")
      .values({
        skill_id: skillId,
        revision: bundle.revision,
        description: bundle.description,
        files_json: bundle.filesJson,
        created_at: now,
      })
      .onConflict((conflict) => conflict.columns(["skill_id", "revision"]).doNothing()),
  );
  if (current) {
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("skill_library_entries")
        .set({ slug: params.slug, current_revision: bundle.revision, updated_at: now })
        .where("skill_id", "=", skillId),
    );
  } else {
    executeSqliteQuerySync(
      db,
      kysely.insertInto("skill_library_entries").values({
        skill_id: skillId,
        owner_profile_id: actor,
        author_profile_id: actor,
        slug: params.slug,
        current_revision: bundle.revision,
        shared: 0,
        enabled: 1,
        removed: 0,
        created_at: now,
        updated_at: now,
      }),
    );
  }
  recordSkillLibraryEvent(db, skillId, bundle.revision, current ? "save" : "create", actor);
  if (uploadId) {
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("skill_library_uploads")
        .set({ published_skill_id: skillId })
        .where("upload_id", "=", uploadId),
    );
  }
  return skillLibraryReceipt(requireSkillLibraryEntry(db, skillId, authority));
}

export function mutateSkillLibraryInDatabase(db: DatabaseSync, input: SkillLibraryMutateInput) {
  const { params } = input;
  const authority = hydrateSkillLibraryWorkerAuthority(input.authority);
  if (!tableExists(db, "skill_library_entries")) {
    throw new SkillLibraryError("NOT_FOUND", "Skill not found.");
  }
  const current = requireSkillLibraryEntry(db, params.skillId, authority, true);
  const actor = requireSkillLibraryProfile(db, authority);
  assertSkillLibraryRevision(current, params.expectedRevision);
  const changes: {
    shared?: number;
    owner_profile_id?: null;
    enabled?: number;
    removed?: number;
    current_revision?: string;
  } = {};
  switch (params.action) {
    case "share":
    case "unshare":
      if (params.action === "unshare" && current.ownerProfileId === null) {
        throw new SkillLibraryError(
          "FORBIDDEN",
          "Team-owned skills cannot become personal through unshare.",
        );
      }
      changes.shared = Number(params.action === "share");
      break;
    case "transfer":
      if (!resolveSkillLibraryActor(db, authority).admin) {
        throw new SkillLibraryError(
          "FORBIDDEN",
          "Transfer to team ownership requires a Gateway administrator.",
        );
      }
      assertSkillLibraryNameAvailable(db, null, current.slug, current.skillId);
      changes.owner_profile_id = null;
      changes.shared = 1;
      break;
    case "enable":
    case "disable":
      changes.enabled = Number(params.action === "enable");
      break;
    case "remove":
      changes.removed = 1;
      break;
    case "rollback":
      if (
        !params.revision ||
        !selectSkillLibraryRevisionMetadata(db, current.skillId, params.revision)
      ) {
        throw new SkillLibraryError(
          "NOT_FOUND",
          "Choose a published revision from this skill's history.",
        );
      }
      changes.current_revision = params.revision;
      break;
  }
  executeSqliteQuerySync(
    db,
    skillLibraryDb(db)
      .updateTable("skill_library_entries")
      .set({ ...changes, updated_at: Date.now() })
      .where("skill_id", "=", current.skillId),
  );
  recordSkillLibraryEvent(
    db,
    current.skillId,
    changes.current_revision ?? current.revision,
    params.action,
    actor,
  );
  return skillLibraryReceipt(
    requireSkillLibraryEntry(db, current.skillId, authority),
    params.action === "remove" ? "removed" : "published",
  );
}
