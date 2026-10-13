import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { hasSqliteCommitReceiptCoverage } from "../../infra/sqlite-commit-receipt.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";

/** Validate the retained operation's entire scope before installing any of its facts. */
export function isSessionEntryReplacementReceiptUsable(
  publication: SessionEntryReplacementPublication,
  keys: readonly string[],
  databaseIdentity: string,
): boolean {
  if (
    !(publication.previous instanceof Map) ||
    !(publication.current instanceof Map) ||
    ![...publication.previous.values(), ...publication.current.values()].every(
      (entry) => isRecord(entry) && typeof entry.sessionId === "string",
    ) ||
    (publication.projection !== undefined && !(publication.projection instanceof Map)) ||
    !Array.isArray(publication.ageChanges) ||
    (publication.unavailableParticipantKeys !== undefined &&
      (!Array.isArray(publication.unavailableParticipantKeys) ||
        !publication.unavailableParticipantKeys.every((key) => typeof key === "string"))) ||
    ![
      publication.changedKeys,
      publication.membershipInvalidatedKeys,
      publication.sharingUnchangedKeys,
      publication.generationUnchangedKeys,
    ].every((values) => Array.isArray(values) && values.every((key) => typeof key === "string"))
  ) {
    return false;
  }
  const affected = new Set(publication.changedKeys);
  if (affected.size !== keys.length || !keys.every((key) => affected.has(key))) {
    return false;
  }
  // Existing typed publications remain supported; they do not certify coverage
  // for raw writers or any other domain. New envelopes must match this operation.
  if (publication.receipt === undefined) {
    return true;
  }
  const source = publication.source;
  if (
    !source ||
    source.identity !== databaseIdentity ||
    !hasSqliteCommitReceiptCoverage(publication.receipt, {
      source,
      domain: "session-entry-replacement",
      keys,
    })
  ) {
    return false;
  }
  for (const [key, fact] of publication.receipt.facts) {
    if (fact.kind === "absent") {
      if (publication.current.has(key) || !publication.previous.has(key)) {
        return false;
      }
    } else if (fact.kind === "postimage") {
      const value = fact.value;
      if (
        !isRecord(value) ||
        !isRecord(value.entry) ||
        !isDeepStrictEqual(value.entry, publication.current.get(key))
      ) {
        return false;
      }
      if (value.participantProjectionUnavailable === true) {
        if (
          !publication.unavailableParticipantKeys?.includes(key) ||
          value.projection !== undefined ||
          publication.projection?.has(key)
        ) {
          return false;
        }
        continue;
      }
      if (
        value.participantProjectionUnavailable !== undefined ||
        publication.unavailableParticipantKeys?.includes(key) ||
        !isRecord(value.projection)
      ) {
        return false;
      }
      const { membership, hasBoard, activitySummaryWatermark: watermark } = value.projection;
      if (
        !Array.isArray(membership) ||
        membership.length !== 5 ||
        membership[0] !== key ||
        (membership[1] !== null && typeof membership[1] !== "string") ||
        !Array.isArray(membership[2]) ||
        !membership[2].every((id) => typeof id === "string") ||
        !isRecord(membership[3]) ||
        membership[4] !== value.entry.sessionId ||
        typeof hasBoard !== "boolean" ||
        (watermark !== undefined &&
          (!isRecord(watermark) ||
            (watermark.generation !== null && typeof watermark.generation !== "string") ||
            (watermark.maxSeq !== null && typeof watermark.maxSeq !== "number"))) ||
        !isDeepStrictEqual(value.projection, publication.projection?.get(key))
      ) {
        return false;
      }
    }
  }
  return true;
}

/** Unknown coverage cannot certify identity merely because another map has a row. */
export function isSessionEntryReplacementFactKnown(
  publication: SessionEntryReplacementPublication,
  key: string,
): boolean {
  if (publication.receipt === undefined) {
    return true;
  }
  const fact = publication.receipt.facts.get(key);
  return publication.current.has(key) ? fact?.kind === "postimage" : fact?.kind === "absent";
}
