import type { SessionEntry } from "../../config/sessions.js";
import { sqliteSessionEntriesEqual } from "../../config/sessions/session-accessor.sqlite-entry-equality.js";
import type { SessionEntryCanonicalReplacement } from "../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import type { SessionLabelOwnerIndex } from "../../config/sessions/session-entry-selection.js";
import { isSessionStatusModelPatchOrigin } from "../session-model-patch-origin.js";
import { hasSessionReadAccessChanged } from "../session-sharing-policy.js";
import type { MutationOutcome } from "./sessions-patch-types.js";

/** Select the canonical replacement and report no-op status selections without touching activity. */
export function prepareSessionPatchReplacement(params: {
  existingEntry: SessionEntry | undefined;
  projectedEntry: SessionEntry;
  primaryKey: string;
  canonicalKey: string;
  candidateKeys: string[];
  workingStore: Record<string, SessionEntry>;
  labelOwners: SessionLabelOwnerIndex;
  assertCurrent: () => void;
}): {
  replacement?: SessionEntryCanonicalReplacement;
  outcome: Extract<MutationOutcome, { ok: true }>;
} {
  const previousSessionKeys = params.candidateKeys.filter(
    (sessionKey) => sessionKey !== params.primaryKey && params.workingStore[sessionKey],
  );
  if (
    isSessionStatusModelPatchOrigin() &&
    params.existingEntry &&
    previousSessionKeys.length === 0 &&
    sqliteSessionEntriesEqual(params.existingEntry, {
      ...params.projectedEntry,
      updatedAt: params.existingEntry.updatedAt,
    })
  ) {
    params.assertCurrent();
    return {
      outcome: {
        ok: true,
        applied: false,
        accessChanged: false,
        entry: params.existingEntry,
      },
    };
  }
  return {
    replacement: {
      entry: params.projectedEntry,
      previousSessionKeys,
      sessionKey: params.primaryKey,
    },
    outcome: {
      ok: true,
      applied: true,
      accessChanged:
        params.primaryKey !== params.canonicalKey ||
        previousSessionKeys.length > 0 ||
        hasSessionReadAccessChanged(params.existingEntry, params.projectedEntry),
      entry: params.labelOwners.replaceEntry(
        params.candidateKeys,
        params.primaryKey,
        params.projectedEntry,
      ),
    },
  };
}
