import type { DatabaseSync } from "node:sqlite";
import {
  SKILL_LIBRARY_MAX_SELECTIONS,
  type SkillLibrarySelection,
  type SkillsLibraryActivateParams,
  type SkillsLibraryListParams,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { SkillLibraryError } from "./errors.js";
import type {
  SkillLibraryReadInput,
  SkillLibraryReadOutput,
  SkillLibraryReadQueries,
} from "./read.contract.js";
import {
  hydrateSkillLibraryWorkerAuthority,
  listSkillLibraryInDatabase,
  readSkillLibraryMetadataInDatabase,
  resolveSkillLibraryPresentationInDatabase,
} from "./service.kernel.js";
import {
  projectSkillLibraryEntry,
  requireSkillLibraryEntry,
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

const readers = {
  presentation: (db: DatabaseSync, a: SkillLibraryAuthority, _input: undefined) =>
    resolveSkillLibraryPresentationInDatabase(db, a),
  list: (db: DatabaseSync, a: SkillLibraryAuthority, input: SkillsLibraryListParams) =>
    listSkillLibraryInDatabase(db, a, input),
  read: (
    db: DatabaseSync,
    a: SkillLibraryAuthority,
    input: { skillId: string; revision?: string; selectedRevision?: string },
  ) =>
    readSkillLibraryMetadataInDatabase(
      db,
      a,
      input.skillId,
      input.revision,
      input.selectedRevision,
    ),
  seed: (db: DatabaseSync, a: SkillLibraryAuthority, _input: undefined) => seed(db, a),
  change: (
    db: DatabaseSync,
    a: SkillLibraryAuthority,
    input: { current: readonly SkillLibrarySelection[]; params: SkillsLibraryActivateParams },
  ) => change(db, a, input.current, input.params),
  pins: (db: DatabaseSync, a: SkillLibraryAuthority, input: readonly SkillLibrarySelection[]) =>
    input.map((pin) => {
      const row = selectSkillLibraryRow(db, pin.skillId);
      const entry = row && projectSkillLibraryEntry(db, row, a, pin.revision, true);
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
    }),
} satisfies {
  [K in keyof SkillLibraryReadQueries]: (
    db: DatabaseSync,
    authority: SkillLibraryAuthority,
    input: SkillLibraryReadQueries[K]["input"],
  ) => SkillLibraryReadQueries[K]["output"];
};
export const skillLibraryReadOperations = {
  "skillLibrary.read": (input: SkillLibraryReadInput, db: DatabaseSync): SkillLibraryReadOutput => {
    const profileIds = new Set<string>();
    const authority = hydrateSkillLibraryWorkerAuthority(input.authority, profileIds);
    // SAFETY: The mapped readers contract binds input and output to each query kind.
    const read = readers[input.kind] as (
      db: DatabaseSync,
      a: SkillLibraryAuthority,
      p: SkillLibraryReadInput["params"],
    ) => SkillLibraryReadOutput["value"];
    const value = runSqliteDeferredTransactionSync(db, () => {
      if (
        input.kind !== "presentation" &&
        input.kind !== "list" &&
        input.kind !== "seed" &&
        !tableExists(db, "skill_library_entries")
      ) {
        if (input.kind === "pins" && !input.params.length) {
          return [];
        }
        throw new SkillLibraryError("NOT_FOUND", "Skill not found in your accessible library.");
      }
      return read(db, authority, input.params);
    });
    return {
      type: "skillLibrary.read",
      kind: input.kind,
      value,
      profileIds: [...profileIds],
    } as SkillLibraryReadOutput; // SAFETY: The result came from the reader bound to input.kind.
  },
};
