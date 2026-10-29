import { isDeepStrictEqual } from "node:util";
import { getChildLogger } from "../../logging/logger.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import { preserveCreationStamp } from "./session-entry-provenance.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Apply retained logical-node policy to an already normalized entry before writing it. */
export function applySessionEntryWritePolicy(
  agentId: string,
  sessionKey: string,
  entry: SessionEntry,
  initialEntry: SessionEntry,
  canonicalPreviousEntry: SessionEntry | undefined,
  options: {
    allowStoredAliases?: boolean;
    providerReviewMutation?: boolean;
    profileInvolvement?: SessionEntry["profileInvolvement"];
    previousEntry?: SessionEntry | null;
    consumePendingReset?: boolean;
  },
): { entry: SessionEntry; previousEntry: SessionEntry | undefined } {
  let normalizedEntry = initialEntry;
  if (
    canonicalPreviousEntry?.sessionId !== normalizedEntry.sessionId ||
    canonicalPreviousEntry.lifecycleRevision !== normalizedEntry.lifecycleRevision ||
    normalizedEntry.archivedAt !== undefined ||
    normalizedEntry.incognito
  ) {
    delete normalizedEntry.resumeAfterRestart;
  } else if (!Object.hasOwn(normalizedEntry, "resumeAfterRestart")) {
    // Public projections omit the shutdown marker; same-incarnation bookkeeping retains it.
    normalizedEntry = {
      ...normalizedEntry,
      ...(canonicalPreviousEntry.resumeAfterRestart
        ? { resumeAfterRestart: canonicalPreviousEntry.resumeAfterRestart }
        : {}),
    };
  }
  if (
    canonicalPreviousEntry?.sessionId === normalizedEntry.sessionId &&
    canonicalPreviousEntry.lifecycleRevision === normalizedEntry.lifecycleRevision &&
    canonicalPreviousEntry.compactionQualityDegraded
  ) {
    normalizedEntry = { ...normalizedEntry, compactionQualityDegraded: true };
  }
  if (!options.providerReviewMutation && !options.allowStoredAliases) {
    // Bookkeeping can carry a stale snapshot; only the review owner may clear its pause.
    normalizedEntry = {
      ...normalizedEntry,
      providerReview:
        canonicalPreviousEntry?.sessionId === normalizedEntry.sessionId &&
        canonicalPreviousEntry.lifecycleRevision === normalizedEntry.lifecycleRevision
          ? canonicalPreviousEntry.providerReview
          : undefined,
    };
  }
  if (normalizedEntry.providerReview?.sessionId !== normalizedEntry.sessionId) {
    delete normalizedEntry.providerReview;
  }
  if (canonicalPreviousEntry?.sandbox === "required") {
    if (
      normalizedEntry.sandbox !== "required" ||
      normalizedEntry.createdVia !== canonicalPreviousEntry.createdVia ||
      normalizedEntry.createdAt !== canonicalPreviousEntry.createdAt ||
      !isDeepStrictEqual(normalizedEntry.createdActor, canonicalPreviousEntry.createdActor)
    ) {
      getChildLogger({ subsystem: "session-sqlite" }).warn(
        "blocked role-required session creation provenance downgrade",
        { agentId, sessionKey },
      );
    }
  }
  // Doctor/import owners validate and select a whole creator stamp across aliases.
  // Preserve their selection unless this canonical node already owns required isolation;
  // ordinary writes cannot restamp a logical node's creator.
  if (!options.allowStoredAliases || canonicalPreviousEntry?.sandbox === "required") {
    normalizedEntry = preserveCreationStamp(normalizedEntry, canonicalPreviousEntry);
  }
  if (isIncognitoSessionKey(sessionKey) && normalizedEntry.createdAt === undefined) {
    // Pin timestamp-less creation once at the writer, never independently in
    // each Gateway observer. Existing legacy rows retain their known age.
    normalizedEntry = {
      ...normalizedEntry,
      createdAt: canonicalPreviousEntry?.updatedAt ?? Date.now(),
    };
  }
  // Personal choices follow the logical node through reset and relocation. A
  // fork has a different key; stale entry writers cannot replace committed choices.
  const involvement =
    options.profileInvolvement ??
    canonicalPreviousEntry?.profileInvolvement ??
    (entry.profileInvolvement?.key === sessionKey || options.allowStoredAliases
      ? entry.profileInvolvement
      : undefined);
  if (involvement) {
    normalizedEntry = {
      ...normalizedEntry,
      profileInvolvement: { ...involvement, key: sessionKey },
    };
  } else if (normalizedEntry.profileInvolvement) {
    const { profileInvolvement: _sourceInvolvement, ...forkEntry } = normalizedEntry;
    normalizedEntry = forkEntry;
  }
  const previousEntry =
    options.previousEntry === undefined
      ? canonicalPreviousEntry
      : (options.previousEntry ?? undefined);
  if (
    options.consumePendingReset !== true &&
    previousEntry?.updatedAt === 0 &&
    previousEntry.sessionId === normalizedEntry.sessionId &&
    previousEntry.lifecycleRevision === normalizedEntry.lifecycleRevision
  ) {
    // Same-lifecycle bookkeeping cannot cancel the one-time reset owed by legacy state.
    normalizedEntry.updatedAt = 0;
  }
  // The lifecycle-selected entry owns visibility copy-forward semantics.
  if (previousEntry && previousEntry.sessionId !== normalizedEntry.sessionId) {
    delete normalizedEntry.visibility;
  }
  return { entry: normalizedEntry, previousEntry };
}
