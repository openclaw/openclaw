import type { DatabaseSync } from "node:sqlite";
import {
  SKILL_LIBRARY_MAX_SELECTIONS,
  type SkillLibrarySelection,
  type SkillsLibraryActivateParams,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { SkillLibraryError } from "../skill-library-error.js";
import type { SkillLibraryReadInput, SkillLibraryReadOutput } from "./read.contract.js";
import {
  hydrateSkillLibraryWorkerAuthority,
  listSkillLibraryInDatabase,
  readSkillLibraryMetadataInDatabase,
  resolveSkillLibraryPresentationInDatabase,
} from "./service.kernel.js";
import {
  projectSkillLibraryEntry,
  requireSkillLibraryEntry,
  requireSkillLibraryProfile,
  requireSkillLibraryUpload,
  selectSkillLibraryRevisionMetadata,
  selectSkillLibraryRow,
  type SkillLibraryAuthority,
} from "./store.js";

function seed(db: DatabaseSync, authority: SkillLibraryAuthority): SkillLibrarySelection[] {
  if (!authority.profileId || !tableExists(db, "skill_library_entries")) {
    return [];
  }
  const { entries, profileId } = listSkillLibraryInDatabase(db, authority);
  return entries
    .filter(
      (entry) =>
        entry.enabled &&
        (entry.ownerProfileId === profileId || entry.ownerProfileId === null || entry.shared),
    )
    .toSorted(
      (a, b) =>
        Number(b.ownerProfileId === profileId) - Number(a.ownerProfileId === profileId) ||
        (a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0),
    )
    .slice(0, SKILL_LIBRARY_MAX_SELECTIONS)
    .map(({ skillId, revision, name, ownerProfileId }) => ({
      skillId,
      revision,
      name,
      ownerProfileId,
    }));
}

function change(
  db: DatabaseSync,
  authority: SkillLibraryAuthority,
  current: readonly SkillLibrarySelection[],
  params: SkillsLibraryActivateParams,
) {
  const next = new Map(current.map((item) => [item.skillId, item]));
  const ids = params.skillId ? [params.skillId] : current.map((item) => item.skillId);
  for (const skillId of ids) {
    const entry = requireSkillLibraryEntry(db, skillId, authority);
    if (entry.removed) {
      throw new SkillLibraryError(
        "NOT_FOUND",
        "Removed skill cannot be selected. Existing pinned selections remain available.",
      );
    }
    const revision = params.revision ?? entry.revision;
    if (!selectSkillLibraryRevisionMetadata(db, skillId, revision)) {
      throw new SkillLibraryError("NOT_FOUND", "Skill revision not found.");
    }
    next.set(skillId, {
      skillId,
      revision,
      name: entry.name,
      ownerProfileId: entry.ownerProfileId,
    });
  }
  if (next.size > SKILL_LIBRARY_MAX_SELECTIONS) {
    throw new SkillLibraryError("LIMIT", "A session can select at most 64 library skills.");
  }
  return [...next.values()].toSorted((a, b) =>
    a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0,
  );
}

export const skillLibraryReadOperations = {
  "skillLibrary.read": (input: SkillLibraryReadInput, db: DatabaseSync): SkillLibraryReadOutput => {
    const profileIds = new Set<string>();
    const authority = hydrateSkillLibraryWorkerAuthority(input.authority, profileIds);
    const value = runSqliteDeferredTransactionSync(db, () => {
      if (
        !["profile", "presentation", "list", "seed"].includes(input.kind) &&
        !tableExists(db, "skill_library_entries")
      ) {
        if (input.kind === "pins" && !input.params.length) {
          return [];
        }
        throw new SkillLibraryError("NOT_FOUND", "Skill not found in your accessible library.");
      }
      switch (input.kind) {
        case "presentation":
          return resolveSkillLibraryPresentationInDatabase(db, authority);
        case "list":
          return listSkillLibraryInDatabase(db, authority, input.params);
        case "profile":
          return requireSkillLibraryProfile(db, authority);
        case "entry":
          return requireSkillLibraryEntry(db, input.params.skillId, authority, input.params.write);
        case "read":
          return readSkillLibraryMetadataInDatabase(
            db,
            authority,
            input.params.skillId,
            input.params.revision,
            input.params.selectedRevision,
          );
        case "upload":
          return requireSkillLibraryUpload(db, input.params.uploadId, authority);
        case "seed":
          return seed(db, authority);
        case "change":
          return change(db, authority, input.params.current, input.params.params);
        case "pins":
          break;
      }
      return input.params.map((pin) => {
        const row = selectSkillLibraryRow(db, pin.skillId);
        const entry = row && projectSkillLibraryEntry(db, row, authority, pin.revision, true);
        if (!entry) {
          throw new SkillLibraryError(
            "NOT_FOUND",
            "A pinned skill revision is unavailable. Restore the library or detach it explicitly.",
          );
        }
        return {
          ...pin,
          slug: entry.slug,
          description: entry.description,
          ownerLabel: entry.ownerLabel,
        };
      });
    });
    return {
      type: "skillLibrary.read",
      kind: input.kind,
      value,
      profileIds: [...profileIds],
    } as SkillLibraryReadOutput; // SAFETY: Each input.kind selects its matching result above.
  },
};
